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

export interface RunwayLights {
  setNavDb(navDb: AirportNavDb): void;
  /** Per frame: brightness 0..1 (0 hides them). */
  update(intensity: number, originWorld: Readonly<Vec3Like>): void;
  dispose(): void;
}

const EDGE_SPACING_M = 60;
const APPROACH_LEN_M = 900;
const APPROACH_SPACING_M = 30;

export function createRunwayLights(root: THREE.Object3D): RunwayLights {
  const quad = new THREE.PlaneGeometry(2, 2);
  const mat = lightSpriteMaterial(RUNWAY_VS, {});
  let mesh: THREE.Mesh | undefined;
  let geom: THREE.InstancedBufferGeometry | undefined;

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

    update(intensity, origin) {
      if (!mesh) return;
      mesh.visible = intensity > 0.01;
      mat.uniforms['uIntensity']!.value = intensity;
      (mat.uniforms['uOrigin']!.value as THREE.Vector3).set(origin.x, origin.y, origin.z);
    },

    dispose() {
      if (mesh) root.remove(mesh);
      geom?.dispose();
      quad.dispose();
      mat.dispose();
    },
  };
}
