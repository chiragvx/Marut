/**
 * src/render/chunkFeatureRenderer.ts — draws the per-chunk scenery built by the terrain worker
 * (contracts/terrain.ts ChunkFeatures): ground decals (roads, canals, settlement ground), trees
 * (three low-poly kinds, instanced, with cheap ground shadows) and buildings (instanced boxes and
 * gurdwara domes).
 *
 * Decals sit exactly on the chunk's rendered triangles (see chunkFeatures.ts) and are pulled in
 * front of the terrain with a polygon offset, so they never z-fight or float. Trees fade out with
 * a screen-door dither between TREE_FADE_START_M and TREE_FADE_END_M, and each chunk's objects are
 * hidden entirely beyond that range, so distant chunks cost nothing but their decals.
 * Everything uses absolute world positions under one group that carries the floating origin.
 */

import * as THREE from 'three';
import type { Vec3Like } from '../contracts/core';
import { TREE_KIND_COUNT, type ChunkFeatures } from '../contracts/terrain';
import { DETAIL_GLSL, getDetailTexture } from './detailTextures';
import { CLOUD_SHADOW_GLSL, getCloudShadowUniforms } from './clouds';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';
import { CASTER_LAYER, SUN_SHADOW_GLSL, getSunShadowUniforms } from './sunShadows';

export const TREE_FADE_START_M = 3200;
export const TREE_FADE_END_M = 4500;
export const BUILDING_FADE_START_M = 9000;
export const BUILDING_FADE_END_M = 11000;

/** Uniforms shared by every feature material (fog, sun). */
export interface FeatureUniforms {
  uFogColor: { value: THREE.Color };
  uFogStart: { value: number };
  uFogEnd: { value: number };
  uSunDir: { value: THREE.Vector3 };
}

const COMMON_GLSL = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogStart;
  uniform float uFogEnd;
  uniform vec3 uSunDir;
  ${ATMOSPHERE_GLSL}
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  ${CLOUD_SHADOW_GLSL}
  ${SUN_SHADOW_GLSL}
  // Same hemisphere + sun lighting as the terrain (including cloud and sun shadows).
  vec3 lightGround(vec3 col, vec3 n, vec3 w) {
    float ndl = dot(n, normalize(uSunDir));
    float diff = max(ndl, 0.0) * cloudShadow(w) * sunShadow(w, ndl);
    vec3 ambient = mix(vec3(0.30, 0.27, 0.22), vec3(0.44, 0.47, 0.52), 0.5 + 0.5 * n.y);
    return col * (ambient + vec3(1.0, 0.97, 0.9) * 0.62 * diff);
  }
`;

// ---------------------------------------------------------------------------------------------
// Ground decals
// ---------------------------------------------------------------------------------------------

const DECAL_VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute vec4 aDecal; // across (-1..1), along (m), class, half width (m)
  varying vec4 vDecal;
  varying vec3 vWorld;
  varying float vDist;
  void main() {
    vDecal = aDecal;
    vWorld = position;
    vec4 mv = modelViewMatrix * vec4(atmCurve(position), 1.0);
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const DECAL_FS = /* glsl */ `
  precision highp float;
  ${COMMON_GLSL}
  ${DETAIL_GLSL}
  varying vec4 vDecal;
  varying vec3 vWorld;
  varying float vDist;

  // Coverage of a band |m - c| < w, antialiased by the pixel footprint pw.
  float band(float m, float c, float w, float pw) { return 1.0 - smoothstep(w, w + pw, abs(m - c)); }

  void main() {
    int cls = int(vDecal.z + 0.5);
    float hw = vDecal.w;
    float m = vDecal.x * hw;          // metres from the centreline (roads) / from the centre (discs)
    float am = abs(m);
    float along = vDecal.y;
    float pw = max(fwidth(m), 0.02);
    float detail = 1.0 - smoothstep(0.3, 1.2, pw);
    vec3 asphalt = vec3(0.30, 0.30, 0.31) * mix(vec3(1.0), detailAt(vWorld.xz, 3.0, 6.0, pw), 0.9);
    vec3 dust = vec3(0.56, 0.51, 0.42) * mix(vec3(1.0), detailAt(vWorld.xz, 1.0, 10.0, pw), 0.9);
    vec3 col;
    float alpha = 1.0;
    if (cls == 0) {
      // Divided highway: median, two carriageways, edge lines, lane dashes, dusty shoulders.
      col = mix(dust, asphalt, 1.0 - smoothstep(9.3, 9.3 + pw, am));
      col = mix(col, vec3(0.40, 0.42, 0.28), band(m, 0.0, 1.6, pw));
      float lines = band(am, 1.9, 0.12, pw) + band(am, 9.0, 0.12, pw) + band(am, 5.45, 0.08, pw) * step(9.0, mod(along, 12.0));
      col = mix(col, vec3(0.86), clamp(lines, 0.0, 1.0) * detail);
      alpha = 1.0 - smoothstep(hw - 1.5, hw, am);
    } else if (cls == 1) {
      col = mix(dust, asphalt, 1.0 - smoothstep(3.6, 3.6 + pw, am));
      float lines = band(am, 3.4, 0.1, pw) + band(m, 0.0, 0.08, pw) * step(6.0, mod(along, 10.0));
      col = mix(col, vec3(0.84), clamp(lines, 0.0, 1.0) * detail);
      alpha = 1.0 - smoothstep(hw - 0.8, hw, am);
    } else if (cls == 2 || cls == 3 || cls == 4) {
      // District, link and village roads: narrow, pale (concrete or dusty tar) with dusty verges
      // either side (the verge is what makes them read as pale lines from altitude).
      float core = hw - 2.0;
      vec3 surf = cls == 2 ? mix(asphalt, dust, 0.15) : mix(vec3(0.60, 0.58, 0.54) * mix(vec3(1.0), detailAt(vWorld.xz, 3.0, 6.0, pw), 0.6), dust, 0.2);
      vec3 verge = vec3(0.74, 0.70, 0.60) * mix(vec3(1.0), detailAt(vWorld.xz, 1.0, 10.0, pw), 0.6);
      col = mix(verge, surf, 1.0 - smoothstep(core - 0.3 * vnoise(vWorld.xz / 2.0), core + pw, am));
      alpha = 1.0 - smoothstep(hw - 0.8, hw + 0.2, am);
    } else if (cls == 5) {
      // Canal (and village pond): lined water in the middle, earthen banks with a path.
      float water = 1.0 - smoothstep(0.46 * hw, 0.46 * hw + pw, am);
      vec3 w = vec3(0.26, 0.32, 0.27) + 0.03 * vnoise(vWorld.xz / 5.0);
      col = mix(mix(dust, vec3(0.62, 0.60, 0.55), band(am, 0.49 * hw, 0.5, pw)), w, water);
      alpha = 1.0 - smoothstep(hw - 1.0, hw, am);
    } else if (cls == 8) {
      // Grove: tree canopy seen from above (the 3D trees stand on it up close; it carries the grove
      // at any distance).
      float rim = vDecal.x;
      float clumps = vnoise(vWorld.xz / 9.0) * 0.6 + vnoise(vWorld.xz / 31.0) * 0.4;
      col = mix(vec3(0.12, 0.18, 0.10), vec3(0.20, 0.27, 0.14), clumps);
      alpha = (1.0 - smoothstep(0.6, 1.0, rim + 0.3 * (vnoise(vWorld.xz / 40.0) - 0.5))) * smoothstep(0.25, 0.45, clumps + 0.15);
    } else {
      // Village ground: pale grey built-up ground and roofs, mottled with dark tree canopy.
      float rim = vDecal.x;
      col = vec3(0.60, 0.59, 0.55) * (0.88 + 0.24 * vnoise(vWorld.xz / 14.0)) * mix(vec3(1.0), detailAt(vWorld.xz, 1.0, 10.0, pw), 0.7);
      // A few dark tree clumps, more towards the edge of the cluster.
      float trees = smoothstep(0.62, 0.75, vnoise(vWorld.xz / 45.0) * 0.75 + vnoise(vWorld.xz / 15.0) * 0.25 + 0.25 * rim);
      col = mix(col, vec3(0.17, 0.23, 0.13), trees * 0.8);
      alpha = 1.0 - smoothstep(0.7, 1.0, rim + 0.2 * (vnoise(vWorld.xz / 60.0) - 0.5));
    }
    col = lightGround(col, vec3(0.0, 1.0, 0.0), vWorld);
    gl_FragColor = vec4(atmApply(col, vWorld), alpha);
  }
`;

// ---------------------------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------------------------

const TREE_VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute float aFoliage; // 1 for foliage, 0 for trunk
  varying vec3 vNormalW;
  varying vec3 vTint;
  varying float vFoliage;
  varying float vH;
  varying float vDist;
  varying vec3 vWorld;
  void main() {
    vec4 wp = vec4(position, 1.0);
    vec3 n = normal;
    #ifdef USE_INSTANCING
      wp = instanceMatrix * wp;
      n = mat3(instanceMatrix) * n;
    #endif
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor;
    #else
      vTint = vec3(1.0);
    #endif
    vNormalW = normalize(n);
    vFoliage = aFoliage;
    vH = position.y;
    vWorld = wp.xyz;
    vec4 mv = modelViewMatrix * vec4(atmCurve(wp.xyz), 1.0);
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

function treeFragment(foliage: string, trunk: string): string {
  return /* glsl */ `
  precision highp float;
  ${COMMON_GLSL}
  uniform float uFadeStart;
  uniform float uFadeEnd;
  varying vec3 vNormalW;
  varying vec3 vTint;
  varying float vFoliage;
  varying float vH;
  varying float vDist;
  varying vec3 vWorld;
  void main() {
    // Screen-door fade with distance (no sorting, no blending).
    float fade = smoothstep(uFadeStart, uFadeEnd, vDist);
    if (hash12(floor(gl_FragCoord.xy)) < fade) discard;
    vec3 n = normalize(vNormalW);
    vec3 L = normalize(uSunDir);
    vec3 col;
    if (vFoliage > 0.5) {
      col = ${foliage} * vTint;
      // Leafy clumps: break up the facets, darker inside and underneath the crown.
      col *= 0.8 + 0.4 * vnoise(vWorld.xz * 0.9 + vWorld.y * 0.7);
      float wrap = max(dot(n, L) * 0.6 + 0.4, 0.0) * mix(0.45, 1.0, cloudShadow(vWorld));
      float self = mix(0.55, 1.0, clamp(vH * 1.2 - 0.1, 0.0, 1.0));
      col *= (vec3(0.36, 0.38, 0.40) + vec3(0.95, 0.92, 0.82) * 0.75 * wrap) * self;
    } else {
      col = ${trunk};
      col *= vec3(0.40) + 0.6 * max(dot(n, L), 0.0) * cloudShadow(vWorld);
    }
    gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
  }
`;
}

const TREE_SHADOW_VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  varying vec2 vQ;
  varying float vDist;
  uniform vec3 uSunDir;
  void main() {
    vQ = position.xy; // quad corners in -1..1
    vec3 base = vec3(0.0);
    float sy = 1.0;
    float sxz = 1.0;
    #ifdef USE_INSTANCING
      base = instanceMatrix[3].xyz;
      sy = length(instanceMatrix[1].xyz);
      sxz = length(instanceMatrix[0].xyz);
    #endif
    vec3 L = normalize(uSunDir);
    vec2 dir = -L.xz / max(length(L.xz), 1e-3);
    float reach = sy * 0.6 * length(L.xz) / max(L.y, 0.2);
    vec2 side = vec2(-dir.y, dir.x);
    vec2 c = base.xz + dir * reach;
    float along = sxz * 0.5 + reach * 0.5;
    vec2 xz = c + dir * position.x * along + side * position.y * sxz * 0.5;
    vec4 wp = vec4(atmCurve(vec3(xz.x, base.y + 0.12, xz.y)), 1.0);
    vec4 mv = modelViewMatrix * wp;
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const TREE_SHADOW_FS = /* glsl */ `
  precision highp float;
  uniform float uFadeStart;
  uniform float uFadeEnd;
  uniform float uRealShadowR; // real sun shadows cover this radius (0 = none): painted shadows fade in beyond it
  varying vec2 vQ;
  varying float vDist;
  void main() {
    float r2 = dot(vQ, vQ);
    if (r2 > 1.0) discard;
    float real = uRealShadowR > 0.0 ? 1.0 - smoothstep(uRealShadowR * 0.65, uRealShadowR * 0.9, vDist) : 0.0;
    float a = 0.38 * (1.0 - r2) * (1.0 - smoothstep(uFadeStart, uFadeEnd, vDist)) * (1.0 - real);
    gl_FragColor = vec4(0.05, 0.06, 0.04, a);
  }
`;

// ---------------------------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------------------------

const BUILDING_VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  varying vec3 vNormalW;
  varying vec3 vTint;
  varying vec3 vLocal; // metres from the building's base corner, in its own axes
  varying float vDist;
  varying float vRoof;
  varying vec3 vWorld;
  void main() {
    vec4 wp = vec4(position, 1.0);
    vec3 n = normal;
    vec3 scale = vec3(1.0);
    #ifdef USE_INSTANCING
      wp = instanceMatrix * wp;
      n = mat3(instanceMatrix) * n;
      scale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    #endif
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor;
    #else
      vTint = vec3(0.9);
    #endif
    vNormalW = normalize(n);
    vRoof = step(0.5, normal.y);
    vLocal = (position + vec3(0.5, 0.0, 0.5)) * scale;
    vWorld = wp.xyz;
    vec4 mv = modelViewMatrix * vec4(atmCurve(wp.xyz), 1.0);
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const BUILDING_FS = /* glsl */ `
  precision highp float;
  ${COMMON_GLSL}
  uniform float uFadeStart;
  uniform float uFadeEnd;
  varying vec3 vNormalW;
  varying vec3 vTint;
  varying vec3 vLocal;
  varying float vDist;
  varying float vRoof;
  varying vec3 vWorld;
  void main() {
    float fade = smoothstep(uFadeStart, uFadeEnd, vDist);
    if (hash12(floor(gl_FragCoord.xy)) < fade) discard;
    vec3 n = normalize(vNormalW);
    vec3 col = vTint;
    if (vRoof > 0.5) {
      // Flat roofs: weathered concrete, a little of the wall colour, the odd black water tank.
      col = mix(vec3(0.46, 0.44, 0.41), vTint, 0.25);
    } else {
      // Windows (and a door-height plinth) close up: 3.3 m floors, windows every ~3 m.
      float u = abs(n.x) > 0.5 ? vLocal.z : vLocal.x;
      vec2 cell = vec2(fract(u / 3.0), fract(vLocal.y / 3.3));
      float win = step(0.3, cell.x) * step(cell.x, 0.7) * step(0.35, cell.y) * step(cell.y, 0.75) * step(1.0, vLocal.y);
      float near = 1.0 - smoothstep(600.0, 1500.0, vDist);
      col = mix(col, vec3(0.12, 0.13, 0.15), win * near * 0.85);
    }
    col = lightGround(col, n, vWorld);
    gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
  }
`;

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/** Marks every vertex of `g` as foliage (1) or trunk (0) via the aFoliage attribute. */
function markFoliage(g: THREE.BufferGeometry, foliage: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  g.setAttribute('aFoliage', new THREE.BufferAttribute(new Float32Array(n).fill(foliage), 1));
  return g;
}

/** Soft, round shading: normals point away from `centre`. */
function sphericalNormals(g: THREE.BufferGeometry, cx: number, cy: number, cz: number, squashY = 1): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const nrm = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) - cx;
    const y = (p.getY(i) - cy) * squashY;
    const z = p.getZ(i) - cz;
    const l = Math.hypot(x, y, z) || 1;
    nrm[i * 3] = x / l;
    nrm[i * 3 + 1] = y / l;
    nrm[i * 3 + 2] = z / l;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Minimal merge (position/normal/aFoliage, non-indexed) to avoid pulling in BufferGeometryUtils.
  const geoms = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of geoms) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const fol = new Float32Array(n);
  let o = 0;
  for (const g of geoms) {
    pos.set(g.getAttribute('position').array as Float32Array, o * 3);
    nor.set(g.getAttribute('normal').array as Float32Array, o * 3);
    fol.set(g.getAttribute('aFoliage').array as Float32Array, o);
    o += g.getAttribute('position').count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('aFoliage', new THREE.BufferAttribute(fol, 1));
  return out;
}

/** Deterministically jitters vertex positions (for irregular crowns), keeping shared vertices together. */
function lumpy(g: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed) * 43758.5453;
    const f = 1 + amount * ((h - Math.floor(h)) - 0.5);
    p.setXYZ(i, x * f, y * f, z * f);
  }
  return g;
}

function trunk(height: number, radius: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius * 0.7, radius, height, 5, 1, true);
  g.translate(0, height / 2, 0);
  return markFoliage(g, 0);
}

/** Unit-height models (1 m tall, ~1 m wide); instance matrices scale them to real trees. */
function makeTreeGeometries(): THREE.BufferGeometry[] {
  // Poplar: a tall narrow spindle on a short trunk.
  const prof = [
    new THREE.Vector2(0.0, 0.12),
    new THREE.Vector2(0.32, 0.25),
    new THREE.Vector2(0.5, 0.5),
    new THREE.Vector2(0.42, 0.75),
    new THREE.Vector2(0.14, 0.95),
    new THREE.Vector2(0.0, 1.0),
  ];
  const poplarCrown = sphericalNormals(markFoliage(lumpy(new THREE.LatheGeometry(prof, 7), 0.12, 1), 1), 0, 0.55, 0, 0.35);
  const poplar = merge([trunk(0.2, 0.03), poplarCrown]);

  // Eucalyptus: a tall pale trunk and two loose blobs of foliage high up.
  const e1 = new THREE.IcosahedronGeometry(0.42, 0);
  e1.scale(1, 0.8, 1);
  e1.translate(0.08, 0.66, 0);
  const e2 = new THREE.IcosahedronGeometry(0.32, 0);
  e2.translate(-0.12, 0.86, 0.05);
  const eu = merge([
    trunk(0.55, 0.035),
    sphericalNormals(markFoliage(lumpy(e1, 0.3, 2), 1), 0.08, 0.66, 0),
    sphericalNormals(markFoliage(lumpy(e2, 0.3, 3), 1), -0.12, 0.86, 0.05),
  ]);
  // Broadleaf (peepal, neem, shisham, kikar): a broad, flattened lumpy dome.
  const b1 = new THREE.IcosahedronGeometry(0.5, 1);
  b1.scale(1, 0.62, 1);
  b1.translate(0, 0.62, 0);
  const broad = merge([trunk(0.35, 0.05), sphericalNormals(markFoliage(lumpy(b1, 0.22, 4), 1), 0, 0.6, 0)]);
  return [poplar, eu, broad];
}

const TREE_FOLIAGE = ['vec3(0.24, 0.36, 0.14)', 'vec3(0.33, 0.39, 0.26)', 'vec3(0.20, 0.31, 0.12)'] as const;
const TREE_TRUNK = ['vec3(0.40, 0.36, 0.30)', 'vec3(0.72, 0.68, 0.60)', 'vec3(0.30, 0.25, 0.20)'] as const;

// ---------------------------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------------------------

interface ChunkEntry {
  group: THREE.Group;
  objects: THREE.Object3D[];
  treeObjects: THREE.Object3D[];
  cx: number;
  cz: number;
  half: number;
  disposables: THREE.BufferGeometry[];
}

export interface ChunkFeatureRenderer {
  ingest(key: string, features: ChunkFeatures, centreX: number, centreZ: number, halfSizeM: number): void;
  evict(key: string): void;
  /** Per frame: floating origin and distance-based visibility of trees/buildings. */
  update(originWorld: Readonly<Vec3Like>, cameraWorld: Readonly<Vec3Like>): void;
  /**
   * Radius of real sun shadows around the camera (0 = none) and whether trees cast into them. When
   * trees cast, their painted shadows step aside inside that radius.
   */
  setRealShadowRadius(m: number, treesCast: boolean): void;
  readonly uniforms: FeatureUniforms;
  dispose(): void;
}

export function createChunkFeatureRenderer(root: THREE.Object3D): ChunkFeatureRenderer {
  const uniforms: FeatureUniforms = {
    uFogColor: { value: new THREE.Color(0xbcd4e8) },
    uFogStart: { value: 1500 },
    uFogEnd: { value: 5000 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, -0.3) },
  };
  const shadowU = { ...getCloudShadowUniforms(), ...getAtmosphereUniforms(), ...getSunShadowUniforms() };
  const realShadowR = { value: 0 };
  const decalMat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, ...shadowU, uDetail: { value: getDetailTexture() } },
    vertexShader: DECAL_VS,
    fragmentShader: DECAL_FS,
    // Ribbons and fans are built without regard to winding; they are only ever seen from above.
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const treeGeoms = makeTreeGeometries();
  const fade = { uFadeStart: { value: TREE_FADE_START_M }, uFadeEnd: { value: TREE_FADE_END_M } };
  const treeMats = treeGeoms.map(
    (_, k) => new THREE.ShaderMaterial({ uniforms: { ...uniforms, ...shadowU, ...fade }, vertexShader: TREE_VS, fragmentShader: treeFragment(TREE_FOLIAGE[k]!, TREE_TRUNK[k]!) })
  );
  const shadowQuad = new THREE.PlaneGeometry(2, 2);
  const shadowMat = new THREE.ShaderMaterial({
    uniforms: { uSunDir: uniforms.uSunDir, ...getAtmosphereUniforms(), ...fade, uRealShadowR: realShadowR },
    vertexShader: TREE_SHADOW_VS,
    fragmentShader: TREE_SHADOW_FS,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -8,
  });
  const boxGeom = new THREE.BoxGeometry(1, 1, 1);
  boxGeom.translate(0, 0.5, 0);
  const domeGeom = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const bFade = { uFadeStart: { value: BUILDING_FADE_START_M }, uFadeEnd: { value: BUILDING_FADE_END_M } };
  const buildingMat = new THREE.ShaderMaterial({ uniforms: { ...uniforms, ...shadowU, ...bFade }, vertexShader: BUILDING_VS, fragmentShader: BUILDING_FS });

  const chunks = new Map<string, ChunkEntry>();
  let treesCast = false;
  const setCast = (o: THREE.Object3D, on: boolean): void => {
    if (on) o.layers.enable(CASTER_LAYER);
    else o.layers.disable(CASTER_LAYER);
  };
  const scratch = new THREE.Vector3();

  function instanced(geom: THREE.BufferGeometry, mat: THREE.Material, matrices: Float32Array, bound: THREE.Sphere, colors?: Float32Array): THREE.InstancedMesh | undefined {
    const count = matrices.length / 16;
    if (count === 0) return undefined;
    const mesh = new THREE.InstancedMesh(geom, mat, count);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(matrices, 16);
    if (colors && colors.length === count * 3) mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    // Bounds from the chunk square (instances never leave it by more than a village radius) rather
    // than computeBoundingSphere, which walks every instance (a hitch for a 30k-building city chunk).
    mesh.boundingSphere = bound;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  return {
    uniforms,

    ingest(key, f, centreX, centreZ, halfSizeM) {
      this.evict(key);
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      const entry: ChunkEntry = { group, objects: [], treeObjects: [], cx: centreX, cz: centreZ, half: halfSizeM, disposables: [] };
      const y0 = f.decalPositions.length > 1 ? f.decalPositions[1]! : 0;
      const bound = new THREE.Sphere(new THREE.Vector3(centreX, y0, centreZ), halfSizeM * 1.42 + 600);

      if (f.decalIndices.length > 0) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(f.decalPositions, 3));
        g.setAttribute('aDecal', new THREE.BufferAttribute(f.decalAttribs, 4));
        g.setIndex(new THREE.BufferAttribute(f.decalIndices, 1));
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, decalMat);
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = 1;
        group.add(mesh);
        entry.disposables.push(g);
      }
      for (let k = 0; k < TREE_KIND_COUNT; k++) {
        const m = f.treeMatrices[k];
        if (!m || m.length === 0) continue;
        const trees = instanced(treeGeoms[k]!, treeMats[k]!, m, bound, f.treeColors[k]);
        if (!trees) continue;
        // Ground shadows share the trees' instance matrices (no extra memory).
        const shadows = new THREE.InstancedMesh(shadowQuad, shadowMat, trees.count);
        shadows.instanceMatrix = trees.instanceMatrix;
        shadows.frustumCulled = false;
        shadows.matrixAutoUpdate = false;
        shadows.renderOrder = 2;
        setCast(trees, treesCast);
        group.add(trees, shadows);
        entry.treeObjects.push(trees, shadows);
      }
      const bld = instanced(boxGeom, buildingMat, f.buildingMatrices, bound, f.buildingColors);
      if (bld) {
        bld.layers.enable(CASTER_LAYER);
        group.add(bld);
        entry.objects.push(bld);
      }
      const domes = instanced(domeGeom, buildingMat, f.domeMatrices, bound);
      if (domes) {
        domes.layers.enable(CASTER_LAYER);
        group.add(domes);
        entry.objects.push(domes);
      }
      root.add(group);
      chunks.set(key, entry);
    },

    evict(key) {
      const e = chunks.get(key);
      if (!e) return;
      root.remove(e.group);
      for (const g of e.disposables) g.dispose();
      for (const o of [...e.objects, ...e.treeObjects]) (o as THREE.InstancedMesh).dispose?.();
      chunks.delete(key);
    },

    setRealShadowRadius(m, cast) {
      realShadowR.value = cast ? m : 0;
      treesCast = cast;
      for (const e of chunks.values()) {
        for (const o of e.treeObjects) if ((o as THREE.InstancedMesh).material !== shadowMat) setCast(o, cast);
      }
    },

    update(origin, cam) {
      for (const e of chunks.values()) {
        e.group.position.set(-origin.x, -origin.y, -origin.z);
        e.group.updateMatrix();
        e.group.updateMatrixWorld(true);
        // Horizontal distance from the camera to the chunk square.
        const dx = Math.max(Math.abs(cam.x - e.cx) - e.half, 0);
        const dz = Math.max(Math.abs(cam.z - e.cz) - e.half, 0);
        scratch.set(dx, 0, dz);
        const d = Math.hypot(scratch.length(), Math.max(cam.y - 300, 0));
        for (const o of e.treeObjects) o.visible = d < TREE_FADE_END_M;
        for (const o of e.objects) o.visible = d < BUILDING_FADE_END_M;
      }
    },

    dispose() {
      for (const k of [...chunks.keys()]) this.evict(k);
      decalMat.dispose();
      for (const m of treeMats) m.dispose();
      for (const g of treeGeoms) g.dispose();
      shadowQuad.dispose();
      shadowMat.dispose();
      boxGeom.dispose();
      domeGeom.dispose();
      buildingMat.dispose();
    },
  };
}
