/**
 * src/render/sunShadows.ts — directional sun shadows for the custom shaders.
 *
 * Every world material here is a hand-written ShaderMaterial, which three.js's built-in shadow
 * system cannot reach, so this module runs its own two-cascade shadow map:
 * - Each frame, casters (objects with CASTER_LAYER enabled: buildings, domes, 3D trees, the
 *   aircraft shadow proxies and, in hilly theatres on High/Ultra, the terrain) are rendered
 *   depth-only from the sun. Both boxes are centred on the player in light space and snapped to
 *   whole texels, so shadows do not shimmer as they follow.
 * - A wide cascade covers buildings and trees around you (trees cast on High/Ultra; below that they
 *   keep their painted shadows); a small near cascade (~80-100 m, 5-10 cm texels) draws only the
 *   aircraft, for a crisp aircraft shadow. Because the maps are aligned with the sun, the
 *   aircraft's shadow is always inside the near map, wherever on the ground it lands (up to ~3 km
 *   below).
 * - Receivers call `sunShadow(worldPos, NdotL)` (SUN_SHADOW_GLSL): hardware 2x2 PCF via comparison
 *   samplers plus a small Poisson kernel on higher tiers, with a slope-scaled bias. The wide
 *   cascade fades out at its edge, where the painted tree shadows (which fade in there) take over.
 *
 * Terrain casts only in hilly theatres (scene.ts): on flat ground it has nothing to shadow and only
 * risks acne.
 * Per tier (wide map size / half-size / PCF taps / terrain casts; near map size / half-size):
 *   low 1024 / 400 m / 1 / no, 512 / 40 m;  medium 2048 / 900 m / 4 / no, 1024 / 40 m;
 *   high 2048 / 1500 m / 4 / yes, 1024 / 45 m;  ultra 4096 / 2500 m / 12 / yes, 2048 / 50 m.
 */

import * as THREE from 'three';
import type { QualityTier, Vec3Like } from '../contracts/core';

/** three.js layer that shadow casters enable (the main camera only renders layer 0). */
export const CASTER_LAYER = 1;
/** Aircraft shadow proxies: drawn into both cascades (the near one draws ONLY these). */
export const AIRCRAFT_SHADOW_LAYER = 2;
/** Depth range of the shadow cameras along the sun direction, m. */
const DEPTH_RANGE_M = 8000;

interface TierShadow {
  size: number;
  halfM: number;
  taps: number;
  terrainCasts: boolean;
  treesCast: boolean;
  nearSize: number;
  nearHalfM: number;
}

export const SHADOW_TIERS: Readonly<Record<QualityTier, TierShadow>> = {
  low: { size: 1024, halfM: 400, taps: 1, terrainCasts: false, treesCast: false, nearSize: 512, nearHalfM: 40 },
  medium: { size: 2048, halfM: 900, taps: 4, terrainCasts: false, treesCast: false, nearSize: 1024, nearHalfM: 40 },
  high: { size: 2048, halfM: 1500, taps: 4, terrainCasts: true, treesCast: true, nearSize: 1024, nearHalfM: 45 },
  ultra: { size: 4096, halfM: 2500, taps: 12, terrainCasts: true, treesCast: true, nearSize: 2048, nearHalfM: 50 },
};

export interface SunShadowUniforms {
  [name: string]: { value: unknown };
  /** Wide cascade. */
  uShadowMap: { value: THREE.DepthTexture | null };
  /** Absolute world -> shadow clip space. */
  uShadowMatrix: { value: THREE.Matrix4 };
  /** x = enabled, y = texel size (UV), z = world metres per texel, w = PCF taps. */
  uShadowParams: { value: THREE.Vector4 };
  /** Near cascade around the player aircraft (same layout). */
  uShadowMapNear: { value: THREE.DepthTexture | null };
  uShadowMatrixNear: { value: THREE.Matrix4 };
  uShadowParamsNear: { value: THREE.Vector4 };
}

let shared: SunShadowUniforms | undefined;
export function getSunShadowUniforms(): SunShadowUniforms {
  if (!shared) {
    shared = {
      uShadowMap: { value: null },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uShadowParams: { value: new THREE.Vector4(0, 1 / 1024, 1, 1) },
      uShadowMapNear: { value: null },
      uShadowMatrixNear: { value: new THREE.Matrix4() },
      uShadowParamsNear: { value: new THREE.Vector4(0, 1 / 1024, 0.1, 1) },
    };
  }
  return shared;
}

const DEPTH_RANGE_GLSL = DEPTH_RANGE_M.toFixed(1);

/**
 * GLSL for receivers: `sunShadow(w, ndl)` = 1 in sunlight, 0 in full shadow. `w` = absolute world
 * position, `ndl` = dot(surface normal, sun direction) (for the slope bias). Uses the near cascade
 * where it covers the point, the wide one elsewhere.
 */
export const SUN_SHADOW_GLSL = /* glsl */ `
  uniform highp sampler2DShadow uShadowMap;
  uniform mat4 uShadowMatrix;
  uniform vec4 uShadowParams;
  uniform highp sampler2DShadow uShadowMapNear;
  uniform mat4 uShadowMatrixNear;
  uniform vec4 uShadowParamsNear;
  const vec2 SHADOW_POISSON[12] = vec2[12](
    vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
    vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893),
    vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));
  // Lit fraction from one cascade; 'edge' = how close to its border the point is (2 when outside).
  float shadowCascade(highp sampler2DShadow sm, mat4 M, vec4 P, vec3 w, float ndl, out float edge) {
    vec4 c = M * vec4(w, 1.0);
    vec3 p = c.xyz / c.w * 0.5 + 0.5;
    vec2 e = abs(p.xy - 0.5) * 2.0;
    edge = max(e.x, e.y);
    if (edge >= 1.0 || p.z >= 1.0) { edge = 2.0; return 1.0; }
    // Slope-scaled bias, in depth units.
    float tanT = sqrt(max(1.0 - ndl * ndl, 0.0)) / max(ndl, 0.15);
    float bias = (max(0.12, P.z * 0.4) + P.z * 1.5 * min(tanT, 6.0)) / ${DEPTH_RANGE_GLSL};
    float z = p.z - bias;
    int taps = int(P.w + 0.5);
    if (taps <= 1) return texture(sm, vec3(p.xy, z));
    float s = 0.0;
    float r = P.y * 1.6;
    for (int i = 0; i < 12; i++) {
      if (i >= taps) break;
      s += texture(sm, vec3(p.xy + SHADOW_POISSON[i] * r, z));
    }
    return s / float(taps);
  }
  float sunShadow(vec3 w, float ndl) {
    if (uShadowParams.x < 0.5) return 1.0;
    float eFar;
    float sFar = shadowCascade(uShadowMap, uShadowMatrix, uShadowParams, w, ndl, eFar);
    sFar = mix(sFar, 1.0, smoothstep(0.8, 1.0, eFar));
    if (uShadowParamsNear.x < 0.5) return sFar;
    float eNear;
    float sNear = shadowCascade(uShadowMapNear, uShadowMatrixNear, uShadowParamsNear, w, ndl, eNear);
    // The near map holds only the aircraft: combine with the wide one, fading out at its border.
    return min(sFar, mix(sNear, 1.0, smoothstep(0.8, 1.0, eNear)));
  }
`;

export interface SunShadows {
  /**
   * Render the shadow maps for this frame (before the main render). focusWorld = the player. Call it
   * every frame, even with `enabled` false: the maps must exist (be allocated) for receivers to draw.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, focusWorld: Readonly<Vec3Like>, originWorld: Readonly<Vec3Like>, sunDir: THREE.Vector3, enabled: boolean): void;
  setTier(tier: QualityTier): void;
  /** Whether terrain chunks should cast on the current tier. */
  terrainCasts(): boolean;
  /** Whether 3D trees should cast on the current tier. */
  treesCast(): boolean;
  /** Radius (m) around the player inside which real shadows exist (for fading the painted tree shadows). */
  radiusM(): number;
  dispose(): void;
}

interface Cascade {
  target: THREE.WebGLRenderTarget | undefined;
  allocated: boolean;
  size: number;
  halfM: number;
  map: { value: THREE.DepthTexture | null };
  matrix: { value: THREE.Matrix4 };
  params: { value: THREE.Vector4 };
}

export function createSunShadows(): SunShadows {
  const u = getSunShadowUniforms();
  let tier: TierShadow = SHADOW_TIERS.high;
  const far: Cascade = { target: undefined, allocated: false, size: 0, halfM: 0, map: u.uShadowMap, matrix: u.uShadowMatrix, params: u.uShadowParams };
  const near: Cascade = { target: undefined, allocated: false, size: 0, halfM: 0, map: u.uShadowMapNear, matrix: u.uShadowMatrixNear, params: u.uShadowParamsNear };
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, DEPTH_RANGE_M);
  const casterMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  const centre = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const originM = new THREE.Matrix4();
  // Wide-cascade refresh bookkeeping (see render()).
  let frame = 0;
  let farValid = false;
  const lastFarFocus = new THREE.Vector3();
  const lastSun = new THREE.Vector3();

  function makeTarget(size: number): THREE.WebGLRenderTarget {
    const depth = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
    depth.compareFunction = THREE.LessEqualCompare;
    depth.minFilter = THREE.LinearFilter;
    depth.magFilter = THREE.LinearFilter;
    return new THREE.WebGLRenderTarget(size, size, { depthTexture: depth, depthBuffer: true, type: THREE.UnsignedByteType });
  }

  function configure(c: Cascade, size: number, halfM: number): void {
    if (!c.target || c.size !== size) {
      c.target?.dispose();
      c.target = makeTarget(size);
      c.allocated = false;
    }
    c.size = size;
    c.halfM = halfM;
    // Receivers use comparison samplers, which must ALWAYS have a depth texture bound, even before
    // the first shadow render or while shadows are off (else the terrain fails to draw).
    c.map.value = c.target.depthTexture as THREE.DepthTexture;
  }

  /** A depth texture has no storage until first rendered into; receivers need it to exist. */
  function ensureAllocated(renderer: THREE.WebGLRenderer, c: Cascade): void {
    if (c.allocated || !c.target) return;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(c.target);
    renderer.clear(true, true, false);
    renderer.setRenderTarget(prev);
    c.allocated = true;
  }

  function renderCascade(renderer: THREE.WebGLRenderer, scene: THREE.Scene, c: Cascade, focus: Readonly<Vec3Like>, origin: Readonly<Vec3Like>, L: THREE.Vector3, taps: number): void {
    if (!c.target) return;
    // Light-space basis, then snap the centre to whole texels along it (no shimmer).
    right.set(0, 1, 0).cross(L);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    up.copy(L).cross(right).normalize();
    const texel = (2 * c.halfM) / c.size;
    centre.set(focus.x - origin.x, focus.y - origin.y, focus.z - origin.z);
    const a = Math.round(centre.dot(right) / texel) * texel;
    const b = Math.round(centre.dot(up) / texel) * texel;
    const d = centre.dot(L);
    centre.copy(right).multiplyScalar(a).addScaledVector(up, b).addScaledVector(L, d);
    cam.left = -c.halfM;
    cam.right = c.halfM;
    cam.top = c.halfM;
    cam.bottom = -c.halfM;
    cam.near = 1;
    cam.far = DEPTH_RANGE_M;
    cam.position.copy(centre).addScaledVector(L, DEPTH_RANGE_M * 0.5);
    cam.up.copy(up);
    cam.lookAt(centre);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    renderer.setRenderTarget(c.target);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    // Absolute world -> shadow clip = P * V * T(-origin).
    originM.makeTranslation(-origin.x, -origin.y, -origin.z);
    c.matrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(originM);
    c.params.value.set(1, 1 / c.size, texel, taps);
  }

  return {
    render(renderer, scene, focus, origin, sunDir, enabled) {
      ensureAllocated(renderer, far);
      ensureAllocated(renderer, near);
      const L = fwd.copy(sunDir).normalize();
      if (!enabled || L.y < 0.02) {
        far.params.value.x = 0;
        near.params.value.x = 0;
        farValid = false;
        return;
      }
      const prevOverride = scene.overrideMaterial;
      const prevBg = scene.background;
      const prevFog = scene.fog;
      const prevTarget = renderer.getRenderTarget();
      scene.overrideMaterial = casterMat;
      scene.background = null;
      scene.fog = null;
      // Wide: the static casters (buildings, trees, terrain). They never move and the map is stored
      // with its own matrix, so an older map is still correct: it only needs redrawing every few
      // frames, or once the player has moved a fair part of the box. Near: only the aircraft, every
      // frame (re-drawing the trees/buildings there would cost as much as the wide pass, since
      // instanced chunks are culled only as a whole).
      frame++;
      const moved = Math.hypot(focus.x - lastFarFocus.x, focus.y - lastFarFocus.y, focus.z - lastFarFocus.z);
      if (!farValid || frame % 4 === 0 || moved > tier.halfM * 0.12 || L.distanceToSquared(lastSun) > 1e-6) {
        cam.layers.set(CASTER_LAYER);
        renderCascade(renderer, scene, far, focus, origin, L, tier.taps);
        lastFarFocus.set(focus.x, focus.y, focus.z);
        lastSun.copy(L);
        farValid = true;
      }
      cam.layers.set(AIRCRAFT_SHADOW_LAYER);
      renderCascade(renderer, scene, near, focus, origin, L, Math.min(tier.taps, 4));
      renderer.setRenderTarget(prevTarget);
      scene.overrideMaterial = prevOverride;
      scene.background = prevBg;
      scene.fog = prevFog;
    },

    setTier(t) {
      tier = SHADOW_TIERS[t];
      configure(far, tier.size, tier.halfM);
      farValid = false;
      configure(near, tier.nearSize, tier.nearHalfM);
    },

    terrainCasts: () => tier.terrainCasts,
    treesCast: () => tier.treesCast,
    radiusM: () => tier.halfM,

    dispose() {
      far.target?.dispose();
      near.target?.dispose();
      casterMat.dispose();
      far.params.value.x = 0;
      near.params.value.x = 0;
    },
  };
}

/**
 * A solid stand-in for the aircraft's shadow (the visible aircraft is a wireframe): two thin
 * prisms from the wireframe's convex outlines, the planform (top view) and the profile (side view),
 * in body axes (x forward, y up, z side). Layer CASTER_LAYER only, so the main camera never draws it.
 */
export function buildAircraftShadowProxy(vertices: readonly (readonly [number, number, number])[]): THREE.BufferGeometry {
  const hull = (pts: [number, number][]): [number, number][] => {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: [number, number][] = [];
    for (const q of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
      lower.push(q);
    }
    const upper: [number, number][] = [];
    for (let i = p.length - 1; i >= 0; i--) {
      const q = p[i]!;
      while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
      upper.push(q);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  };
  const pos: number[] = [];
  // A prism: hull points (a, b) mapped to 3D by `to(a, b, s)` with s = -1 / +1 for the two faces.
  const prism = (h: [number, number][], to: (a: number, b: number, s: number) => [number, number, number]): void => {
    for (const s of [-1, 1]) {
      for (let i = 1; i + 1 < h.length; i++) pos.push(...to(h[0]![0], h[0]![1], s), ...to(h[i]![0], h[i]![1], s), ...to(h[i + 1]![0], h[i + 1]![1], s));
    }
    for (let i = 0; i < h.length; i++) {
      const a = h[i]!;
      const b = h[(i + 1) % h.length]!;
      pos.push(...to(a[0], a[1], -1), ...to(b[0], b[1], -1), ...to(b[0], b[1], 1), ...to(a[0], a[1], -1), ...to(b[0], b[1], 1), ...to(a[0], a[1], 1));
    }
  };
  prism(hull(vertices.map((v) => [v[0], v[2]])), (x, z, s) => [x, 0.15 * s, z]);
  prism(hull(vertices.map((v) => [v[0], v[1]])), (x, y, s) => [x, y, 0.55 * s]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
