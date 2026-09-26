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

import { TOWN_3D_FADE_END_M, TOWN_3D_FADE_START_M } from './townLayer';
import * as THREE from 'three';
import type { Vec3Like } from '../contracts/core';
import { BUILDING_TILE_M, TREE_KIND_COUNT, TreeKind, type ChunkFeatures } from '../contracts/terrain';
import { DETAIL_GLSL, getDetailTexture } from './detailTextures';
import { CLOUD_SHADOW_GLSL, getCloudShadowUniforms } from './clouds';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';
import { CASTER_LAYER, SUN_SHADOW_GLSL, getSunShadowUniforms } from './sunShadows';
import { LIGHT_SPRITE_VS_GLSL, lightSpriteMaterial } from './nightLights';

export const TREE_FADE_START_M = 3200;
export const TREE_FADE_END_M = 4500;
/** 3D buildings shrink away over this range; the terrain's town layer draws them flat beyond (townLayer.ts). */
export const BUILDING_FADE_START_M = TOWN_3D_FADE_START_M;
export const BUILDING_FADE_END_M = TOWN_3D_FADE_END_M;
/** Town lights at night show out to here (further than the buildings: lights carry). */
export const TOWN_LIGHT_RANGE_M = TOWN_3D_FADE_END_M;

/**
 * Night lights of towns and villages: one light per building (about 70% lit; mostly warm
 * incandescent/sodium, some cool white), on the side facing the camera, at window height. Shares
 * the buildings' instance matrices.
 */
const TOWN_LIGHT_VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  ${LIGHT_SPRITE_VS_GLSL}
  varying vec3 vCol;
  void main() {
    vec3 base = instanceMatrix[3].xyz;
    vec3 p3 = fract(floor(base.xzx * 0.5) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    float h = fract((p3.x + p3.y) * p3.z);
    if (h > 0.7) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vCol = vec3(0.0);
      return;
    }
    float fade = 1.0 - smoothstep(${TOWN_3D_FADE_START_M.toFixed(1)}, ${TOWN_3D_FADE_END_M.toFixed(1)}, distance(uAtmCamPos, base));
    if (fade <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vCol = vec3(0.0);
      return;
    }
    float hgt = length(instanceMatrix[1].xyz);
    float wid = length(instanceMatrix[0].xyz);
    vec2 toCam = normalize(uAtmCamPos.xz - base.xz + vec2(1e-3, 0.0));
    vec3 w = base + vec3(toCam.x * wid * 0.6, min(hgt * 0.45, 3.5), toCam.y * wid * 0.6);
    vCol = (h < 0.55 ? vec3(1.0, 0.66, 0.3) : vec3(0.82, 0.88, 1.0)) * 1.7 * fade;
    gl_Position = lightSprite(w, 1.2, 2.1);
  }
`;

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
    vec3 ambient = mix(uAtmAmbGround, uAtmAmbSky, 0.5 + 0.5 * n.y);
    return col * (1.0 - 0.25 * uAtmWet) * (ambient + uAtmSunCol * diff);
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
    // Street lights on the main roads at night: a lamp every 35 m (on the median of divided
    // highways, on alternating kerbs elsewhere), a bright head and a pool of sodium light on the
    // road, each widened by the pixel's footprint so distant lamps average out instead of sparkling.
    if (uAtmLights > 0.01 && cls <= 2) {
      float k = floor(along / 35.0 + 0.5);
      float side = cls == 0 ? 0.0 : (mod(k, 2.0) < 0.5 ? 1.0 : -1.0) * (hw - 2.2);
      vec2 d = vec2(m - side, along - k * 35.0);
      float wb = pw * pw / 12.0;
      float r2 = dot(d, d);
      float g = 0.35 * 36.0 / (36.0 + wb) * exp(-0.5 * r2 / (36.0 + wb)) + 1.6 * 0.36 / (0.36 + wb) * exp(-0.5 * r2 / (0.36 + wb));
      col += vec3(1.0, 0.58, 0.24) * (0.9 * g * uAtmLights);
    }
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
      col *= (uAtmAmbSky * 0.8 + uAtmSunCol * 1.15 * wrap) * self;
    } else {
      col = ${trunk};
      col *= uAtmAmbSky * 0.88 + uAtmSunCol * 0.97 * max(dot(n, L), 0.0) * cloudShadow(vWorld);
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
  uniform float uFadeStart;
  uniform float uFadeEnd;
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
      // Far buildings shrink into the ground (towards their base) rather than dithering out: a
      // screen-door fade on few-pixel boxes shimmered. The terrain's town layer takes over.
      float keep = 1.0 - smoothstep(uFadeStart, uFadeEnd, distance(uAtmCamPos, instanceMatrix[3].xyz));
      wp = instanceMatrix * vec4(position * keep, 1.0);
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
  uniform float uTiled; // 1 = Goan gabled houses: terracotta tile roofs
  varying vec3 vNormalW;
  varying vec3 vTint;
  varying vec3 vLocal;
  varying float vDist;
  varying float vRoof;
  varying vec3 vWorld;
  void main() {
    vec3 n = normalize(vNormalW);
    vec3 col = vTint;
    if (vRoof > 0.5 && uTiled > 0.5) {
      // Mangalore-tile roofs: terracotta, weathered darker on some houses, tile courses close up.
      float seed = fract(sin(dot(floor(vWorld.xz / 9.0), vec2(12.9898, 78.233))) * 43758.5453);
      col = mix(vec3(0.66, 0.31, 0.19), vec3(0.42, 0.24, 0.18), seed * 0.8);
      float course = 1.0 - smoothstep(600.0, 1200.0, vDist);
      col *= 1.0 - 0.12 * step(0.75, fract(vLocal.y / 0.35)) * course;
    } else if (vRoof > 0.5) {
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
  // Minimal merge (position/normal/aFoliage) to avoid pulling in BufferGeometryUtils.
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
  // Weld identical vertices and index the triangles: trees are drawn by the ten thousand and are
  // vertex-bound, so letting the GPU's vertex cache reuse shared corners (a crown vertex is shared
  // by ~6 triangles) cuts the vertex work several times over.
  const key = new Map<string, number>();
  const wPos: number[] = [];
  const wNor: number[] = [];
  const wFol: number[] = [];
  const index = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const k = [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!, nor[i * 3]!, nor[i * 3 + 1]!, nor[i * 3 + 2]!, fol[i]!].map((v) => Math.round(v * 1e4)).join(',');
    let j = key.get(k);
    if (j === undefined) {
      j = wFol.length;
      key.set(k, j);
      wPos.push(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
      wNor.push(nor[i * 3]!, nor[i * 3 + 1]!, nor[i * 3 + 2]!);
      wFol.push(fol[i]!);
    }
    index[i] = j;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(wNor, 3));
  out.setAttribute('aFoliage', new THREE.Float32BufferAttribute(wFol, 1));
  out.setIndex(new THREE.BufferAttribute(index, 1));
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

/**
 * A gabled house, unit size: walls from y = 0 to 1 (x, z in -0.5..0.5), and a pitched roof with its
 * ridge along z rising to y = 1.45, overhanging the walls a little. Scaled per instance to a real house.
 */
function makeHouseGeometry(): THREE.BufferGeometry {
  const walls = new THREE.BoxGeometry(1, 1, 1);
  walls.translate(0, 0.5, 0);
  const o = 0.56; // eave overhang (half width + overhang)
  const e = 0.54; // gable overhang along z
  const ridge = 1.45;
  const eave = 0.97;
  const p: number[] = [
    // left slope
    -o, eave, -e, 0, ridge, -e, 0, ridge, e,
    -o, eave, -e, 0, ridge, e, -o, eave, e,
    // right slope
    o, eave, e, 0, ridge, e, 0, ridge, -e,
    o, eave, e, 0, ridge, -e, o, eave, -e,
    // gable triangles (walls)
    -0.5, 1, 0.5, 0.5, 1, 0.5, 0, ridge, 0.5,
    0.5, 1, -0.5, -0.5, 1, -0.5, 0, ridge, -0.5,
  ];
  const roof = new THREE.BufferGeometry();
  roof.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  roof.computeVertexNormals();
  const w = walls.toNonIndexed();
  const n = w.getAttribute('position').count + roof.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  pos.set(w.getAttribute('position').array as Float32Array, 0);
  nor.set(w.getAttribute('normal').array as Float32Array, 0);
  pos.set(roof.getAttribute('position').array as Float32Array, w.getAttribute('position').count * 3);
  nor.set(roof.getAttribute('normal').array as Float32Array, w.getAttribute('position').count * 3);
  walls.dispose();
  roof.dispose();
  w.dispose();
  // The walls' top (under the roof) and bottom (in the ground) never show: drop them.
  return weld(pos, nor, (ny) => Math.abs(ny) < 0.5, w.getAttribute('position').count);
}

/**
 * Indexed geometry from a triangle soup, sharing vertices with equal position and normal (tens of
 * thousands of instanced buildings are vertex-bound). Wall-part triangles (index < wallVerts) are
 * kept only where keepWall(normal y) holds.
 */
function weld(pos: Float32Array, nor: Float32Array, keepWall: (ny: number) => boolean, wallVerts: number): THREE.BufferGeometry {
  const map = new Map<string, number>();
  const P: number[] = [];
  const N: number[] = [];
  const idx: number[] = [];
  for (let t = 0; t < pos.length / 9; t++) {
    const v0 = t * 3;
    if (v0 < wallVerts && !keepWall(nor[v0 * 3 + 1]!)) continue;
    for (let k = 0; k < 3; k++) {
      const v = v0 + k;
      const key = [0, 1, 2, 3, 4, 5].map((c) => (c < 3 ? pos[v * 3 + c]! : nor[v * 3 + c - 3]!).toFixed(4)).join(',');
      let i = map.get(key);
      if (i === undefined) {
        i = P.length / 3;
        map.set(key, i);
        P.push(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
        N.push(nor[v * 3]!, nor[v * 3 + 1]!, nor[v * 3 + 2]!);
      }
      idx.push(i);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setIndex(idx);
  return g;
}

/** A unit box standing on y = 0, without its (never seen) bottom face. */
function makeBlockGeometry(): THREE.BufferGeometry {
  const b = new THREE.BoxGeometry(1, 1, 1);
  b.translate(0, 0.5, 0);
  const s = b.toNonIndexed();
  b.dispose();
  const g = weld(s.getAttribute('position').array as Float32Array, s.getAttribute('normal').array as Float32Array, (ny) => ny > -0.5, s.getAttribute('position').count);
  s.dispose();
  return g;
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
  // Coconut palm: a slender, slightly leaning trunk and a crown of arching, drooping fronds. Kept to
  // 36 triangles: palms are the most numerous tree on the coast (~20k within the tree range).
  const tr = new THREE.CylinderGeometry(0.02, 0.03, 0.86, 4, 1, true);
  tr.translate(0, 0.43, 0);
  const tp = tr.getAttribute('position');
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i);
    tp.setX(i, tp.getX(i) + 0.07 * (y / 0.86) * (y / 0.86));
  }
  tr.computeVertexNormals();
  markFoliage(tr, 0);
  const fronds: number[] = [];
  const cx = 0.07;
  const cy = 0.86;
  const NF = 7;
  for (let f = 0; f < NF; f++) {
    const a = (f / NF) * Math.PI * 2 + 0.4 * Math.sin(f * 2.3);
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const sx = -dz;
    const sz = dx;
    const pts: [number, number, number][] = [];
    const segs = 2;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const r = 0.5 * t;
      const y = cy + 0.06 * t - 0.2 * t * t;
      const w = 0.11 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05));
      pts.push([cx + dx * r + sx * w, y, dx * 0 + dz * r + sz * w], [cx + dx * r - sx * w, y, dz * r - sz * w]);
    }
    for (let k = 0; k < segs; k++) {
      const a0 = pts[k * 2]!, b0 = pts[k * 2 + 1]!, a1 = pts[k * 2 + 2]!, b1 = pts[k * 2 + 3]!;
      fronds.push(...a0, ...b0, ...a1, ...b0, ...b1, ...a1);
    }
  }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(fronds, 3));
  const palm = merge([tr, sphericalNormals(markFoliage(fg, 1), cx, cy - 0.1, 0, 0.6)]);
  return [poplar, eu, broad, palm];
}

const TREE_FOLIAGE = ['vec3(0.24, 0.36, 0.14)', 'vec3(0.33, 0.39, 0.26)', 'vec3(0.20, 0.31, 0.12)', 'vec3(0.34, 0.44, 0.16)'] as const;
const TREE_TRUNK = ['vec3(0.40, 0.36, 0.30)', 'vec3(0.72, 0.68, 0.60)', 'vec3(0.30, 0.25, 0.20)', 'vec3(0.52, 0.46, 0.38)'] as const;

// ---------------------------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------------------------

interface ChunkEntry {
  group: THREE.Group;
  objects: THREE.Object3D[];
  treeObjects: THREE.Object3D[];
  lightObjects: THREE.Object3D[];
  /** Buildings per tile (kind 0 flat-roofed boxes, 1 gabled houses); the meshes exist only while the tile is in range. */
  tiles: BuildingTile[];
  cx: number;
  cz: number;
  half: number;
  disposables: THREE.BufferGeometry[];
}

interface BuildingTile {
  kind: 0 | 1;
  M: Float32Array;
  C: Float32Array | undefined;
  cx: number;
  cz: number;
  y: number;
  mesh?: THREE.InstancedMesh;
  lights?: THREE.InstancedMesh;
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
  /** Town lights: brightness 0..1 (0 = daytime, off). */
  setNightLights(level: number): void;
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
  /** Radius of real sun shadows (0 = none): only building tiles inside it cast. */
  let shadowR = 0;
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
    (_, k) => new THREE.ShaderMaterial({ uniforms: { ...uniforms, ...shadowU, ...fade }, vertexShader: TREE_VS, fragmentShader: treeFragment(TREE_FOLIAGE[k]!, TREE_TRUNK[k]!), side: k === TreeKind.Palm ? THREE.DoubleSide : THREE.FrontSide })
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
  const houseGeom = makeHouseGeometry();
  const boxGeom = makeBlockGeometry();
  const domeGeom = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const bFade = { uFadeStart: { value: BUILDING_FADE_START_M }, uFadeEnd: { value: BUILDING_FADE_END_M } };
  const buildingMat = new THREE.ShaderMaterial({ uniforms: { ...uniforms, ...shadowU, ...bFade, uTiled: { value: 0 } }, vertexShader: BUILDING_VS, fragmentShader: BUILDING_FS });
  const houseMat = new THREE.ShaderMaterial({ uniforms: { ...uniforms, ...shadowU, ...bFade, uTiled: { value: 1 } }, vertexShader: BUILDING_VS, fragmentShader: BUILDING_FS });

  const chunks = new Map<string, ChunkEntry>();
  const lightQuad = new THREE.PlaneGeometry(2, 2);
  const townLightMat = lightSpriteMaterial(TOWN_LIGHT_VS, {});
  let lightsOn = false;
  let treesCast = false;
  const setCast = (o: THREE.Object3D, on: boolean): void => {
    if (on) o.layers.enable(CASTER_LAYER);
    else o.layers.disable(CASTER_LAYER);
  };
  const scratch = new THREE.Vector3();

  function makeTile(e: ChunkEntry, t: BuildingTile): void {
    const sphere = new THREE.Sphere(new THREE.Vector3(t.cx, t.y, t.cz), BUILDING_TILE_M * 0.75 + 250);
    const mesh = instanced(t.kind === 0 ? boxGeom : houseGeom, t.kind === 0 ? buildingMat : houseMat, t.M, sphere, t.C)!;
    mesh.updateMatrixWorld();
    e.group.add(mesh);
    t.mesh = mesh;
  }

  function dropTile(e: ChunkEntry, t: BuildingTile): void {
    if (t.lights) {
      e.group.remove(t.lights);
      t.lights.dispose();
      t.lights = undefined;
    }
    if (t.mesh) {
      e.group.remove(t.mesh);
      t.mesh.dispose();
      t.mesh = undefined;
    }
  }

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
      const entry: ChunkEntry = { group, objects: [], treeObjects: [], lightObjects: [], tiles: [], cx: centreX, cz: centreZ, half: halfSizeM, disposables: [] };
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
      const domes = instanced(domeGeom, buildingMat, f.domeMatrices, bound);
      if (domes) {
        domes.layers.enable(CASTER_LAYER);
        group.add(domes);
        entry.objects.push(domes);
      }
      // Buildings come sorted by BUILDING_TILE_M tile (the worker groups them). A tile is only data
      // here: its instanced mesh is made when the tile comes within building range and dropped when
      // it leaves (update), so the scene holds a few dozen building meshes, not one per tile of every
      // chunk out to 25 km (thousands of objects to walk, update and draw per pass).
      const tileOf = (M: Float32Array, i: number): number => Math.floor(M[i * 16 + 12]! / BUILDING_TILE_M) * 100003 + Math.floor(M[i * 16 + 14]! / BUILDING_TILE_M);
      for (const [kind, M, C] of [
        [0, f.buildingMatrices, f.buildingColors],
        [1, f.houseMatrices, f.houseColors],
      ] as const) {
        const n = M.length / 16;
        for (let a = 0; a < n; ) {
          const t = tileOf(M, a);
          let b = a + 1;
          while (b < n && tileOf(M, b) === t) b++;
          entry.tiles.push({
            kind,
            M: M.subarray(a * 16, b * 16),
            C: C.length === n * 3 ? C.subarray(a * 3, b * 3) : undefined,
            cx: (Math.floor(M[a * 16 + 12]! / BUILDING_TILE_M) + 0.5) * BUILDING_TILE_M,
            cz: (Math.floor(M[a * 16 + 14]! / BUILDING_TILE_M) + 0.5) * BUILDING_TILE_M,
            y: y0,
          });
          a = b;
        }
      }
      root.add(group);
      chunks.set(key, entry);
    },

    evict(key) {
      const e = chunks.get(key);
      if (!e) return;
      root.remove(e.group);
      for (const g of e.disposables) g.dispose();
      for (const o of [...e.objects, ...e.treeObjects, ...e.lightObjects]) (o as THREE.InstancedMesh).dispose?.();
      for (const t of e.tiles) dropTile(e, t);
      chunks.delete(key);
    },

    setNightLights(level) {
      townLightMat.uniforms['uIntensity']!.value = level;
      lightsOn = level > 0.01;
    },

    setRealShadowRadius(m, cast) {
      realShadowR.value = cast ? m : 0;
      shadowR = m;
      treesCast = cast;
      for (const e of chunks.values()) {
        for (const o of e.treeObjects) if ((o as THREE.InstancedMesh).material !== shadowMat) setCast(o, cast);
      }
    },

    update(origin, cam) {
      (townLightMat.uniforms['uOrigin']!.value as THREE.Vector3).set(origin.x, origin.y, origin.z);
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
        for (const o of e.lightObjects) o.visible = lightsOn && d < TOWN_LIGHT_RANGE_M;
        for (const t of e.tiles) {
          const tdx = Math.max(Math.abs(cam.x - t.cx) - 0.5 * BUILDING_TILE_M, 0);
          const tdz = Math.max(Math.abs(cam.z - t.cz) - 0.5 * BUILDING_TILE_M, 0);
          const td = Math.hypot(tdx, tdz, Math.max(cam.y - 300, 0));
          // Made on entering range, dropped a little further out (hysteresis: no churn at the edge).
          if (td < BUILDING_FADE_END_M) {
            if (!t.mesh) makeTile(e, t);
            t.mesh!.visible = true;
            setCast(t.mesh!, td < shadowR);
          } else if (t.mesh) {
            if (td > BUILDING_FADE_END_M + 800) dropTile(e, t);
            else t.mesh.visible = false;
          }
          if (t.mesh) {
            const lit = lightsOn && td < TOWN_LIGHT_RANGE_M;
            if (lit && !t.lights) {
              t.lights = new THREE.InstancedMesh(lightQuad, townLightMat, t.mesh.count);
              t.lights.instanceMatrix = t.mesh.instanceMatrix;
              t.lights.frustumCulled = false;
              t.lights.matrixAutoUpdate = false;
              t.lights.renderOrder = 15;
              e.group.add(t.lights);
            }
            if (t.lights) t.lights.visible = lit;
          }
        }
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
      houseGeom.dispose();
      houseMat.dispose();
      lightQuad.dispose();
      townLightMat.dispose();
      domeGeom.dispose();
      buildingMat.dispose();
    },
  };
}
