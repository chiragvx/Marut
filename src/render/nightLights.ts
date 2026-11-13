/**
 * src/render/nightLights.ts — point lights seen at night: runway edge, threshold and approach
 * lights, and (from chunkFeatureRenderer.ts) the lights of towns and villages.
 *
 * Every light is a camera-facing disc the size of its lens, never smaller than a pixel or two on
 * screen (a light stays a visible point however far away it is): a crisp, evenly lit lens with a
 * one-pixel anti-aliased edge and no glow or halo round it, as the eye sees a lamp in clear air.
 * Additively blended, hidden by terrain (depth-tested) and dimmed by haze and fog. They cost one
 * instanced draw per group.
 *
 * Runway and taxiway lights also stand on the ground as fittings: an elevated edge light (yellow
 * flange, post and housing, a steel clamp ring, a ribbed glass dome tinted the light's colour).
 * Close up the dome itself is lit; beyond ~100 m, where the fitting is under two pixels, the lens
 * disc takes over.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AirportNavDb, Vec3Like } from '../contracts/core';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';

/** Shared by all light sprites: `lightSprite(worldPos, sizeM, minPx)` places the quad corner. */
export const LIGHT_SPRITE_VS_GLSL = /* glsl */ `
  uniform vec2 uViewport;
  uniform vec3 uOrigin;
  varying vec2 vQ;       // px from the lamp's centre
  varying float vRadPx; // the lens's radius on screen, px
  varying float vBright;
  // Corner of a camera-facing quad around world point w for a lens sizeM across, but never smaller
  // than minPx pixels; the quad is a pixel wider all round for the anti-aliased edge.
  vec4 lightSprite(vec3 w, float sizeM, float minPx) {
    vec4 clip = projectionMatrix * viewMatrix * vec4(atmCurve(w) - uOrigin, 1.0);
    float px = max(minPx, sizeM * projectionMatrix[1][1] * 0.5 * uViewport.y / max(clip.w, 1.0));
    float half_ = 0.5 * px + 1.0;
    clip.xy += position.xy * 2.0 * half_ / uViewport * clip.w;
    vQ = position.xy * half_;
    vRadPx = 0.5 * px;
    // Fog and haze swallow the lights (less than surfaces: they are bright).
    vBright = pow(atmTransmittance(w), 0.6);
    return clip;
  }
`;

export const LIGHT_SPRITE_FS = /* glsl */ `
  precision highp float;
  uniform float uIntensity;
  varying vec2 vQ;
  varying float vRadPx;
  varying float vBright;
  varying vec3 vCol;
  void main() {
    // An evenly lit lens with a one-pixel anti-aliased rim: no glow beyond it.
    float cov = clamp(vRadPx + 0.5 - length(vQ), 0.0, 1.0);
    if (cov <= 0.0) discard;
    gl_FragColor = vec4(vCol * cov * vBright * uIntensity, 1.0);
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
  uniform float uSizeM; // lens diameter
  uniform float uMinPx;
  uniform float uNearFadeM; // closer than this the fitting's own lit dome shows the light
  varying vec3 vCol;
  void main() {
    vCol = iCol;
    if (dot(iDir, iDir) > 0.5) {
      vCol = dot(uAtmCamPos - iPos, iDir) > 0.0 ? vec3(0.25, 1.0, 0.4) : vec3(1.0, 0.18, 0.12);
    }
    gl_Position = lightSprite(iPos, uSizeM, uMinPx);
    vBright *= smoothstep(0.45 * uNearFadeM, uNearFadeM, distance(uAtmCamPos, iPos));
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
    // A PAPI unit's lens is ~0.3 m but very bright: a little larger minimum so it reads from afar.
    gl_Position = lightSprite(iPos, 0.35, 2.5);
  }
`;

// ---------------------------------------------------------------------------------------------
// Light fittings (elevated edge lights)
// ---------------------------------------------------------------------------------------------

/** Height of the dome's centre (where the light point sits) above the ground, m. */
const FIXTURE_LAMP_H = 0.36;
const FIXTURE_DRAW_M = 1500;

/**
 * One elevated edge light, turned on a lathe, its base at y = 0; aPart 0: yellow paint, 1: steel
 * clamp ring, 2: glass dome. (Dimensions from a typical fitting, a touch oversized to read.)
 */
function buildFixtureGeometry(): THREE.BufferGeometry {
  const SEG = 12;
  const lathe = (pts: [number, number][], part: number): THREE.BufferGeometry => {
    const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), SEG).toNonIndexed();
    g.deleteAttribute('uv');
    g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(part), 1));
    return g;
  };
  // Profiles run bottom to top: (radius, height), m.
  const paint = lathe([[0.0, 0.0], [0.1, 0.0], [0.1, 0.018], [0.07, 0.022], [0.026, 0.026], [0.026, 0.17], [0.034, 0.175], [0.034, 0.2], [0.05, 0.215], [0.066, 0.245], [0.066, 0.262]], 0);
  const ring = lathe([[0.064, 0.258], [0.073, 0.262], [0.073, 0.282], [0.064, 0.286]], 1);
  const dome: [number, number][] = [[0.062, 0.284], [0.064, 0.33]];
  for (let i = 1; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2);
    dome.push([i === 8 ? 0 : 0.064 * Math.cos(a), 0.33 + 0.1 * Math.sin(a)]);
  }
  const glass = lathe(dome, 2);
  const g = mergeGeometries([paint, ring, glass])!;
  paint.dispose();
  ring.dispose();
  glass.dispose();
  return g;
}

const FIXTURE_VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute float aPart;
  attribute vec3 iPos;
  attribute vec3 iCol;
  attribute vec3 iDir;
  uniform vec3 uOrigin;
  varying vec3 vWorld;
  varying vec3 vN;
  varying vec3 vCol;
  varying float vPart;
  varying float vLocalY;
  void main() {
    vec3 base = iPos - vec3(0.0, ${FIXTURE_LAMP_H.toFixed(3)}, 0.0);
    if (distance(uAtmCamPos, base) > ${FIXTURE_DRAW_M.toFixed(1)}) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vCol = iCol;
    if (dot(iDir, iDir) > 0.5) {
      vCol = dot(uAtmCamPos - iPos, iDir) > 0.0 ? vec3(0.25, 1.0, 0.4) : vec3(1.0, 0.18, 0.12);
    }
    vWorld = base + position;
    vN = normal;
    vPart = aPart;
    vLocalY = position.y;
    gl_Position = projectionMatrix * viewMatrix * vec4(atmCurve(vWorld) - uOrigin, 1.0);
  }
`;

const FIXTURE_FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  uniform float uIntensity;
  varying vec3 vWorld;
  varying vec3 vN;
  varying vec3 vCol;
  varying float vPart;
  varying float vLocalY;
  void main() {
    vec3 n = normalize(vN);
    vec3 V = normalize(uAtmCamPos - vWorld);
    vec3 L = normalize(uAtmSunDir);
    vec3 H = normalize(L + V);
    float diff = max(dot(n, L), 0.0);
    vec3 amb = mix(uAtmAmbGround, uAtmAmbSky, 0.5 + 0.5 * n.y);
    float fres = pow(1.0 - max(dot(n, V), 0.0), 4.0);
    vec3 tint = vCol / max(max(vCol.r, vCol.g), max(vCol.b, 1e-3));
    // The lit dome lights its own housing a little.
    vec3 selfLit = tint * uIntensity * 0.35 * smoothstep(0.18, 0.26, vLocalY);
    vec3 col;
    if (vPart < 0.5) {
      // Yellow enamel, weathered darker towards the ground.
      vec3 paint = mix(vec3(0.42, 0.3, 0.05), vec3(0.86, 0.62, 0.06), smoothstep(0.0, 0.08, vLocalY));
      col = paint * (amb + uAtmSunCol * diff + selfLit) + uAtmSunCol * pow(max(dot(n, H), 0.0), 40.0) * 0.25 * diff;
    } else if (vPart < 1.5) {
      // Steel clamp ring.
      col = vec3(0.5, 0.51, 0.52) * (amb + uAtmSunCol * diff + selfLit) + uAtmSunCol * pow(max(dot(n, H), 0.0), 60.0) * 0.8 * diff + amb * fres;
    } else {
      // Ribbed (Fresnel-lens) glass dome tinted the light's colour; lit from inside when on.
      float rib = 0.5 + 0.5 * sin(vLocalY * 900.0);
      vec3 glass = tint * 0.18 * (amb + uAtmSunCol * diff * 0.6);
      vec3 spec = uAtmSunCol * pow(max(dot(n, H), 0.0), 90.0) * (0.6 + 0.6 * rib) * diff;
      vec3 refl = mix(uAtmAmbGround, uAtmAmbSky, 0.5 + 0.5 * reflect(-V, n).y) * (0.08 + 0.5 * fres);
      // The lamp: brightest where the dome faces the eye, white-hot at the core.
      float facing = max(dot(n, V), 0.0);
      vec3 lamp = mix(tint, vec3(1.0), 0.35 * facing) * (0.55 + 0.45 * rib) * (0.5 + 1.1 * facing) * uIntensity * 1.6;
      col = glass + spec + refl + lamp;
    }
    gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
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
  // Lens diameters: runway and taxiway fittings ~0.13 m (the dome), an apron
  // floodlight bank ~1 m.
  // (Runway and taxiway lenses hand over to their fittings' lit domes within ~100 m.)
  const lens = (sizeM: number, minPx: number, nearFadeM = 0): Record<string, THREE.IUniform> => ({ uSizeM: { value: sizeM }, uMinPx: { value: minPx }, uNearFadeM: { value: nearFadeM } });
  const mat = lightSpriteMaterial(RUNWAY_VS, lens(0.13, 1.8, 100));
  let mesh: THREE.Mesh | undefined;
  let geom: THREE.InstancedBufferGeometry | undefined;
  // Taxiway edge lights and floodlights share the runway-light shader (own brightness each).
  const taxiMat = lightSpriteMaterial(RUNWAY_VS, lens(0.13, 1.5, 100));
  const floodMat = lightSpriteMaterial(RUNWAY_VS, lens(1.0, 1.8));
  const papiMat = lightSpriteMaterial(PAPI_VS, {});
  const aidMeshes: THREE.Mesh[] = [];
  // The fittings: one instanced draw for the runways', one for the taxiways'.
  const fixtureGeom = buildFixtureGeometry();
  const fixtureMat = (): THREE.ShaderMaterial =>
    new THREE.ShaderMaterial({ uniforms: { ...getAtmosphereUniforms(), uOrigin: { value: new THREE.Vector3() }, uIntensity: { value: 0 } }, vertexShader: FIXTURE_VS, fragmentShader: FIXTURE_FS });
  const runwayFixMat = fixtureMat();
  const taxiFixMat = fixtureMat();
  let runwayFix: THREE.Mesh | undefined;
  let taxiFix: THREE.Mesh | undefined;
  const fixtures = (src: THREE.InstancedBufferGeometry, m: THREE.ShaderMaterial): THREE.Mesh => {
    const g = new THREE.InstancedBufferGeometry();
    for (const name of ['position', 'normal', 'aPart']) g.setAttribute(name, fixtureGeom.getAttribute(name));
    for (const name of ['iPos', 'iCol', 'iDir']) g.setAttribute(name, src.getAttribute(name));
    g.instanceCount = src.instanceCount;
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    root.add(mesh);
    return mesh;
  };
  const dropFixtures = (m: THREE.Mesh | undefined): undefined => {
    if (m) {
      root.remove(m);
      m.geometry.dispose();
    }
    return undefined;
  };

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
        pos.push(x, y + FIXTURE_LAMP_H, z);
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
      runwayFix = dropFixtures(runwayFix);
      if (n > 0) runwayFix = fixtures(geom, runwayFixMat);
    },

    setAids(list) {
      for (const m of aidMeshes) {
        root.remove(m);
        m.geometry.dispose();
      }
      aidMeshes.length = 0;
      taxiFix = dropFixtures(taxiFix);
      const taxi: number[] = [];
      const flood: number[] = [];
      const papiPos: number[] = [];
      const papiDir: number[] = [];
      const papiAng: number[] = [];
      for (const a of list) {
        for (const [x, z] of a.taxiEdgeLights) taxi.push(x, a.groundY + FIXTURE_LAMP_H, z);
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
      if (taxi.length) {
        const m = spriteMesh(quad, taxiMat, { iPos: [Float32Array.from(taxi), 3], iCol: [fill(n(taxi), [0.25, 0.45, 1.6]), 3], iDir: [new Float32Array(taxi.length), 3] }, n(taxi));
        add(m);
        taxiFix = fixtures(m.geometry as THREE.InstancedBufferGeometry, taxiFixMat);
      }
      if (flood.length) add(spriteMesh(quad, floodMat, { iPos: [Float32Array.from(flood), 3], iCol: [fill(n(flood), [2.2, 1.8, 1.2]), 3], iDir: [new Float32Array(flood.length), 3] }, n(flood)));
      if (papiPos.length) add(spriteMesh(quad, papiMat, { iPos: [Float32Array.from(papiPos), 3], iDir: [Float32Array.from(papiDir), 3], iAngle: [Float32Array.from(papiAng), 1] }, n(papiPos)));
    },

    update(intensity, origin) {
      for (const m of [mat, taxiMat, floodMat, papiMat, runwayFixMat, taxiFixMat]) (m.uniforms['uOrigin']!.value as THREE.Vector3).set(origin.x, origin.y, origin.z);
      // (The fittings are drawn by day too; their domes light with the lights.)
      runwayFixMat.uniforms['uIntensity']!.value = intensity;
      taxiFixMat.uniforms['uIntensity']!.value = intensity;
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
      dropFixtures(runwayFix);
      dropFixtures(taxiFix);
      fixtureGeom.dispose();
      runwayFixMat.dispose();
      taxiFixMat.dispose();
      mat.dispose();
      taxiMat.dispose();
      floodMat.dispose();
      papiMat.dispose();
    },
  };
}
