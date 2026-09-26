/**
 * src/render/nightLights.ts — point lights seen at night: runway edge, threshold and approach
 * lights, and (from chunkFeatureRenderer.ts) the lights of towns and villages.
 *
 * Every light is a small camera-facing sprite with a fixed minimum size on screen (a light stays a
 * visible point however far away it is), additively blended, hidden by terrain (depth-tested) and
 * dimmed by haze and fog. They cost one instanced draw per group.
 */
import * as THREE from 'three';
import type { AirportNavDb, Vec3Like } from '../contracts/core';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';

/** Shared by all light sprites: `lightSprite(worldPos, sizeM, minPx)` places the quad corner. */
export const LIGHT_SPRITE_VS_GLSL = /* glsl */ `
  uniform vec2 uViewport;
  uniform vec3 uOrigin;
  varying vec2 vQ;
  varying float vBright;
  // Corner of a camera-facing sprite around world point w: sizeM across in the world, but never
  // smaller than minPx pixels.
  vec4 lightSprite(vec3 w, float sizeM, float minPx) {
    vec4 clip = projectionMatrix * viewMatrix * vec4(atmCurve(w) - uOrigin, 1.0);
    float px = max(minPx, sizeM * projectionMatrix[1][1] * 0.5 * uViewport.y / max(clip.w, 1.0));
    clip.xy += position.xy * px / uViewport * clip.w;
    vQ = position.xy;
    // Fog and haze swallow the lights (less than surfaces: they are bright).
    vBright = pow(atmTransmittance(w), 0.6);
    return clip;
  }
`;

export const LIGHT_SPRITE_FS = /* glsl */ `
  precision highp float;
  uniform float uIntensity;
  varying vec2 vQ;
  varying float vBright;
  varying vec3 vCol;
  void main() {
    float r2 = dot(vQ, vQ);
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 5.0);
    gl_FragColor = vec4(vCol * core * vBright * uIntensity, 1.0);
  }
`;

export function lightSpriteMaterial(vertexShader: string, extraUniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...getAtmosphereUniforms(),
      uViewport: SHARED_VIEWPORT,
      uOrigin: { value: new THREE.Vector3() },
      uIntensity: { value: 0 },
      ...extraUniforms,
    },
    vertexShader,
    fragmentShader: LIGHT_SPRITE_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Viewport size in pixels, shared by every light material (set by scene.ts on resize). */
const SHARED_VIEWPORT = { value: new THREE.Vector2(1920, 1080) };
export function setLightViewport(w: number, h: number): void {
  SHARED_VIEWPORT.value.set(w, h);
}

// ---------------------------------------------------------------------------------------------
// Runway lights
// ---------------------------------------------------------------------------------------------

const RUNWAY_VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  ${LIGHT_SPRITE_VS_GLSL}
  attribute vec3 iPos;
  attribute vec3 iCol;
  attribute vec3 iDir; // threshold lights: the approach side (green from there, red from the runway)
  varying vec3 vCol;
  void main() {
    vCol = iCol;
    if (dot(iDir, iDir) > 0.5) {
      vCol = dot(uAtmCamPos - iPos, iDir) > 0.0 ? vec3(0.25, 1.0, 0.4) : vec3(1.0, 0.18, 0.12);
    }
    gl_Position = lightSprite(iPos, 1.2, 2.6);
  }
`;

const PAPI_VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  ${LIGHT_SPRITE_VS_GLSL}
  attribute vec3 iPos;
  attribute vec3 iDir;   // horizontal direction towards the approach
  attribute float iAngle; // this lamp's glide angle, rad
  varying vec3 vCol;
  void main() {
    vec3 d = uAtmCamPos - iPos;
    float horiz = dot(d.xz, iDir.xz);
    if (horiz <= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vCol = vec3(0.0);
      return;
    }
    // White above this lamp's angle, red below; bright enough to read by day.
    vCol = atan(d.y, horiz) > iAngle ? vec3(2.6, 2.5, 2.3) : vec3(2.8, 0.25, 0.15);
    gl_Position = lightSprite(iPos, 2.0, 5.0);
  }
`;

/** Airfield aids to light (src/airport/airfieldAids.ts, per base). */
export interface LightAids {
  groundY: number;
  taxiEdgeLights: readonly (readonly [number, number])[];
  floodlights: readonly (readonly [number, number])[];
  papi: readonly { x: number; z: number; approachX: number; approachZ: number; angleRad: number }[];
}

export interface RunwayLights {
  setNavDb(navDb: AirportNavDb): void;
  /** Taxiway edge lights, apron floodlights and PAPIs for the mission's bases. */
  setAids(aids: readonly LightAids[]): void;
  /** Per frame: brightness 0..1 (0 hides them). */
  update(intensity: number, originWorld: Readonly<Vec3Like>): void;
  dispose(): void;
}

function spriteMesh(quad: THREE.PlaneGeometry, mat: THREE.ShaderMaterial, attrs: Record<string, [Float32Array, number]>, count: number): THREE.Mesh {
  const geom = new THREE.InstancedBufferGeometry();
  geom.index = quad.index;
  geom.setAttribute('position', quad.getAttribute('position'));
  for (const [name, [arr, size]] of Object.entries(attrs)) geom.setAttribute(name, new THREE.InstancedBufferAttribute(arr, size));
  geom.instanceCount = count;
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 15;
  return mesh;
}

const EDGE_SPACING_M = 60;
const APPROACH_LEN_M = 900;
const APPROACH_SPACING_M = 30;

export function createRunwayLights(root: THREE.Object3D): RunwayLights {
  const quad = new THREE.PlaneGeometry(2, 2);
  const mat = lightSpriteMaterial(RUNWAY_VS, {});
  let mesh: THREE.Mesh | undefined;
  let geom: THREE.InstancedBufferGeometry | undefined;
  // Taxiway edge lights and floodlights share the runway-light shader (own brightness each).
  const taxiMat = lightSpriteMaterial(RUNWAY_VS, {});
  const floodMat = lightSpriteMaterial(RUNWAY_VS, {});
  const papiMat = lightSpriteMaterial(PAPI_VS, {});
  const aidMeshes: THREE.Mesh[] = [];

  return {
    setNavDb(navDb) {
      if (mesh) {
        root.remove(mesh);
        geom?.dispose();
      }
      const pos: number[] = [];
      const col: number[] = [];
      const dir: number[] = [];
      const seen = new Set<string>();
      const add = (x: number, y: number, z: number, c: readonly [number, number, number], d: readonly [number, number, number] = [0, 0, 0]): void => {
        const key = `${Math.round(x)},${Math.round(z)},${d[0] !== 0 || d[2] !== 0 ? 1 : 0}`;
        if (seen.has(key)) return;
        seen.add(key);
        pos.push(x, y + 0.6, z);
        col.push(...c);
        dir.push(...d);
      };
      const WHITE = [1.0, 0.95, 0.85] as const;
      const APPROACH = [1.0, 0.97, 0.9] as const;
      for (const ap of navDb.listAirports()) {
        for (const r of ap.runways) {
          const fx = Math.sin(r.headingRad);
          const fz = -Math.cos(r.headingRad);
          const lx = Math.cos(r.headingRad);
          const lz = Math.sin(r.headingRad);
          const t = r.thresholdPos;
          const hw = r.widthM / 2 + 1.5;
          // Edge lights, both sides, the whole length.
          for (let s = 0; s <= r.lengthM + 0.1; s += EDGE_SPACING_M) {
            for (const side of [-1, 1]) add(t.x + fx * s + lx * hw * side, t.y, t.z + fz * s + lz * hw * side, WHITE);
          }
          // Threshold bar: green to aircraft approaching, red to those on the runway.
          for (let a = -hw; a <= hw + 0.1; a += 3) add(t.x + lx * a - fx * 1.5, t.y, t.z + lz * a - fz * 1.5, WHITE, [-fx, 0, -fz]);
          // Approach lights: a centreline out to 900 m with a crossbar at 300 m.
          for (let s = APPROACH_SPACING_M; s <= APPROACH_LEN_M; s += APPROACH_SPACING_M) add(t.x - fx * s, t.y, t.z - fz * s, APPROACH);
          for (let a = -15; a <= 15; a += 2.5) add(t.x - fx * 300 + lx * a, t.y, t.z - fz * 300 + lz * a, APPROACH);
        }
      }
      const n = pos.length / 3;
      geom = new THREE.InstancedBufferGeometry();
      geom.index = quad.index;
      geom.setAttribute('position', quad.getAttribute('position'));
      geom.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(pos), 3));
      geom.setAttribute('iCol', new THREE.InstancedBufferAttribute(new Float32Array(col), 3));
      geom.setAttribute('iDir', new THREE.InstancedBufferAttribute(new Float32Array(dir), 3));
      geom.instanceCount = n;
      mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 15;
      mesh.visible = false;
      root.add(mesh);
    },

    setAids(list) {
      for (const m of aidMeshes) {
        root.remove(m);
        m.geometry.dispose();
      }
      aidMeshes.length = 0;
      const taxi: number[] = [];
      const flood: number[] = [];
      const papiPos: number[] = [];
      const papiDir: number[] = [];
      const papiAng: number[] = [];
      for (const a of list) {
        for (const [x, z] of a.taxiEdgeLights) taxi.push(x, a.groundY + 0.35, z);
        for (const [x, z] of a.floodlights) flood.push(x, a.groundY + 21, z);
        for (const p of a.papi) {
          papiPos.push(p.x, a.groundY + 0.8, p.z);
          papiDir.push(p.approachX, 0, p.approachZ);
          papiAng.push(p.angleRad);
        }
      }
      const add = (m: THREE.Mesh): void => {
        root.add(m);
        aidMeshes.push(m);
      };
      const n = (arr: number[]): number => arr.length / 3;
      const fill = (count: number, rgb: [number, number, number]): Float32Array => {
        const c = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) c.set(rgb, i * 3);
        return c;
      };
      if (taxi.length) add(spriteMesh(quad, taxiMat, { iPos: [Float32Array.from(taxi), 3], iCol: [fill(n(taxi), [0.25, 0.45, 1.6]), 3], iDir: [new Float32Array(taxi.length), 3] }, n(taxi)));
      if (flood.length) add(spriteMesh(quad, floodMat, { iPos: [Float32Array.from(flood), 3], iCol: [fill(n(flood), [2.2, 1.8, 1.2]), 3], iDir: [new Float32Array(flood.length), 3] }, n(flood)));
      if (papiPos.length) add(spriteMesh(quad, papiMat, { iPos: [Float32Array.from(papiPos), 3], iDir: [Float32Array.from(papiDir), 3], iAngle: [Float32Array.from(papiAng), 1] }, n(papiPos)));
    },

    update(intensity, origin) {
      for (const m of [mat, taxiMat, floodMat, papiMat]) (m.uniforms['uOrigin']!.value as THREE.Vector3).set(origin.x, origin.y, origin.z);
      // Taxiway lights with the runway lights (night, poor visibility); floodlights at night only
      // (their mesh is dimmed by the same value); the PAPI always.
      taxiMat.uniforms['uIntensity']!.value = intensity;
      floodMat.uniforms['uIntensity']!.value = Math.max(0, (getAtmosphereUniforms().uAtmLights.value as number) - 0.05);
      papiMat.uniforms['uIntensity']!.value = 1;
      for (const m of aidMeshes) m.visible = (m.material as THREE.ShaderMaterial).uniforms['uIntensity']!.value > 0.01;
      if (!mesh) return;
      mesh.visible = intensity > 0.01;
      mat.uniforms['uIntensity']!.value = intensity;
    },

    dispose() {
      if (mesh) root.remove(mesh);
      geom?.dispose();
      for (const m of aidMeshes) m.geometry.dispose();
      quad.dispose();
      mat.dispose();
      taxiMat.dispose();
      floodMat.dispose();
      papiMat.dispose();
    },
  };
}
