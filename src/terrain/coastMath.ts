/**
 * src/terrain/coastMath.ts — coast shoreline and estuaries as exact, shared maths.
 *
 * Like riverMath.ts, these are evaluated identically on the CPU (terrain height, water collision)
 * and per pixel in the ground shader, so the sea and estuary edges are crisp at any mesh resolution
 * instead of following the ~260 m terrain grid:
 * - The shoreline is a table of 201 samples (x of the shore, and headland weight) every 1 km along
 *   z, linearly interpolated. The terrain and the shader use the same table (buildCoastProfile).
 * - Each estuary is a channel along a line from its mouth, meandering by a sum of two sines (zero
 *   at the mouth), wide at the sea and tapering exponentially inland, closing over its last 20%.
 */
import type { CoastProfile, EstuarySpec } from '../contracts/terrain';

export const ESTUARY_FLOATS = 16;
export const MAX_ESTUARIES = 4;

/** Catmull-Rom through samples a..d at fraction f of the b-c segment (a smooth curve, no kinks). */
export function catmullRom(a: number, b: number, c: number, d: number, f: number): number {
  const f2 = f * f;
  const f3 = f2 * f;
  return 0.5 * (2 * b + (c - a) * f + (2 * a - 5 * b + 4 * c - d) * f2 + (3 * b - a - 3 * c + d) * f3);
}

/** Smooth (Catmull-Rom) interpolation of the shoreline table at z: writes shore x and headland weight. Mirrored in the shader. */
export function shoreAt(t: Pick<CoastProfile, 'z0' | 'dz' | 'shoreX' | 'headland'>, z: number, out: { x: number; headland: number }): void {
  const n = t.shoreX.length;
  const fi = Math.max(0, Math.min(n - 1 - 1e-6, (z - t.z0) / t.dz));
  const i = Math.floor(fi);
  const f = fi - i;
  const i0 = Math.max(0, i - 1);
  const i3 = Math.min(n - 1, i + 2);
  out.x = catmullRom(t.shoreX[i0]!, t.shoreX[i]!, t.shoreX[i + 1]!, t.shoreX[i3]!, f);
  out.headland = Math.max(0, Math.min(1, catmullRom(t.headland[i0]!, t.headland[i]!, t.headland[i + 1]!, t.headland[i3]!, f)));
}

function hashPhase(seed: number, i: number, k: number): number {
  let h = (Math.imul(seed | 0, 0x7feb352d) ^ Math.imul(i + 1, 0x846ca68b) ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (((h ^ (h >>> 15)) >>> 0) / 4294967296) * Math.PI * 2;
}

/**
 * Packs one estuary: a = (mouthX, mouthZ, ux, uz), b = (length, mouthW, inlandW, taper),
 * c = (bankW, meanderAmp, k, p1), d = (p2, 0, 0, 0).
 */
export function packEstuary(e: EstuarySpec, index: number, seed: number, out: Float32Array, offset: number): void {
  out.set(
    [
      e.mouthX, e.mouthZ, Math.sin(e.headingRad), -Math.cos(e.headingRad),
      e.lengthM, e.mouthWidthM, e.inlandWidthM, e.taperM,
      e.bankWidthM, e.meanderAmpM, 2 * Math.PI * e.meanderFreq, hashPhase(seed, index, 1),
      hashPhase(seed, index, 2), 0, 0, 0,
    ],
    offset
  );
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Signed distance into the estuary's water, m (> 0 in water); very negative when far. Mirrors ESTUARY_GLSL. */
export function estuaryField(p: Float32Array | readonly number[], o: number, x: number, z: number): number {
  const px = x - p[o]!;
  const pz = z - p[o + 1]!;
  const ux = p[o + 2]!;
  const uz = p[o + 3]!;
  const u = px * ux + pz * uz;
  const L = p[o + 4]!;
  if (u < 0 || u > L) return -1e9;
  const v = px * -uz + pz * ux;
  const k = p[o + 10]!;
  const c = p[o + 9]! * (0.7 * Math.sin(k * u + p[o + 11]!) + 0.3 * Math.sin(2.3 * k * u + p[o + 12]!)) * smoothstep(0, 8000, u);
  const halfW = 0.5 * (p[o + 6]! + (p[o + 5]! - p[o + 6]!) * Math.exp(-u / p[o + 7]!)) * (1 - smoothstep(L * 0.8, L, u));
  return halfW - Math.abs(v - c);
}

export const ESTUARY_GLSL = /* glsl */ `
  uniform vec4 uEstuaries[${4 * MAX_ESTUARIES}];
  uniform int uEstuaryCount;
  float estuaryField(int i, vec2 p) {
    vec4 a = uEstuaries[i * 4];
    vec4 b = uEstuaries[i * 4 + 1];
    vec4 c = uEstuaries[i * 4 + 2];
    vec4 d = uEstuaries[i * 4 + 3];
    vec2 q = p - a.xy;
    float u = dot(q, a.zw);
    if (u < 0.0 || u > b.x) return -1e9;
    float v = dot(q, vec2(-a.w, a.z));
    float cc = c.y * (0.7 * sin(c.z * u + c.w) + 0.3 * sin(2.3 * c.z * u + d.x)) * smoothstep(0.0, 8000.0, u);
    float halfW = 0.5 * (b.z + (b.y - b.z) * exp(-u / b.w)) * (1.0 - smoothstep(b.x * 0.8, b.x, u));
    return halfW - abs(v - cc);
  }
  float estuariesAt(vec2 p) {
    float r = -1e9;
    for (int i = 0; i < ${MAX_ESTUARIES}; i++) {
      if (i >= uEstuaryCount) break;
      r = max(r, estuaryField(i, p));
    }
    return r;
  }
`;
