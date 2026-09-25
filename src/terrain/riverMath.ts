/**
 * src/terrain/riverMath.ts — braided rivers defined purely by maths (sums of sines), evaluated
 * identically on the CPU (terrain height, water collision, settlement placement) and per pixel in
 * the ground shader (RIVER_GLSL), so water edges are exact at any mesh resolution.
 *
 * One river, in its own frame (u along the axis from (x0, z0), v across it):
 * - Belt centre   cb(u) = A1 (0.7 sin(k1 u + p1) + 0.5 sin(0.41 k1 u + 1.7 p4))   the slow, irregular meander
 * - Main channel  cm(u) = cb + 0.40 F sin(2.7 k1 u + p2) + 0.10 F sin(6.3 k1 u + p3)
 *                 half width  0.5 W (1 + 0.3 sin(3.1 k1 u + p4))
 * - Two side channels  cj(u) = cb + 0.62 F sin(kj u + pj), 0.35 W wide, each present only where a
 *   gate sin(1.3 k1 u + pg + j pi) > 0.1 (width tapering in and out), so they split off from and
 *   rejoin the main channel around long islands.
 * - Sandbars: elongated lenses inside the channels, where a product of an along-flow and an
 *   across-flow sine exceeds a threshold.
 * - Belt (the sandy/scrubby active floodplain, "khadar"): |v - cb| < F.
 * All distances are in metres. Fields returned: water = signed distance into the nearest channel
 * (> 0 in water, sandbars excluded), belt = signed distance into the belt (> 0 inside), bar = 1
 * on a sandbar.
 */
import type { RiverSpec } from '../contracts/terrain';

/** Number of floats per river in the packed parameter block (4 x vec4). */
export const RIVER_FLOATS = 16;
export const MAX_RIVERS = 4;

function hashPhase(seed: number, i: number, k: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (((h ^ (h >>> 15)) >>> 0) / 4294967296) * Math.PI * 2;
}

/**
 * Packs one river: a = (x0, z0, ux, uz), b = (length or 1e9, W, F, A1), c = (k1, p1, p2, p3),
 * d = (p4, pb1, pb2, pg). W = channel width, F = belt half width, A1 = meander amplitude.
 */
export function packRiver(r: RiverSpec, index: number, seed: number, out: Float32Array, offset: number): void {
  const dx = r.x1 - r.x0;
  const dz = r.z1 - r.z0;
  const len = Math.hypot(dx, dz) || 1;
  const F = r.floodplainWidthM ?? r.widthM * 2;
  out.set(
    [
      r.x0, r.z0, dx / len, dz / len,
      r.endsAtEnd ? len : 1e9, r.widthM, F, r.meanderAmpM,
      2 * Math.PI * r.meanderFreq, hashPhase(seed, index, 1), hashPhase(seed, index, 2), hashPhase(seed, index, 3),
      hashPhase(seed, index, 4), hashPhase(seed, index, 5), hashPhase(seed, index, 6), hashPhase(seed, index, 7),
    ],
    offset
  );
}

export interface RiverField {
  water: number;
  belt: number;
  bar: number;
}

/** CPU evaluation; must mirror RIVER_GLSL exactly. */
export function riverField(p: Float32Array | readonly number[], o: number, x: number, z: number, out: RiverField): RiverField {
  const x0 = p[o]!, z0 = p[o + 1]!, ux = p[o + 2]!, uz = p[o + 3]!;
  const L = p[o + 4]!, W = p[o + 5]!, F = p[o + 6]!, A1 = p[o + 7]!;
  const k1 = p[o + 8]!, p1 = p[o + 9]!, p2 = p[o + 10]!, p3 = p[o + 11]!;
  const p4 = p[o + 12]!, pb1 = p[o + 13]!, pb2 = p[o + 14]!, pg = p[o + 15]!;
  const px = x - x0;
  const pz = z - z0;
  const u = px * ux + pz * uz;
  const v = px * -uz + pz * ux;
  out.water = -1e9;
  out.belt = -1e9;
  out.bar = 0;
  if (u < -2000) return out;
  // Taper everything to nothing over the last 3 km of a river that ends (a tributary's mouth).
  const endT = L > 1e8 ? 1 : Math.max(0, Math.min(1, (L - u) / 3000));
  if (endT <= 0) return out;
  const cb = A1 * (0.7 * Math.sin(k1 * u + p1) + 0.5 * Math.sin(0.41 * k1 * u + 1.7 * p4));
  const dv = v - cb;
  out.belt = F * (0.55 + 0.45 * endT) - Math.abs(dv);
  if (out.belt < -400) return out;
  const cm = 0.4 * F * Math.sin(2.7 * k1 * u + p2) + 0.1 * F * Math.sin(6.3 * k1 * u + p3);
  const hwMain = 0.5 * W * (1 + 0.3 * Math.sin(3.1 * k1 * u + p4)) * endT;
  let water = hwMain - Math.abs(dv - cm);
  for (let j = 0; j < 2; j++) {
    const gate = Math.sin(1.3 * k1 * u + pg + j * Math.PI) - 0.1;
    if (gate <= 0) continue;
    const kj = (j === 0 ? 1.9 : 2.3) * k1;
    const cj = 0.62 * F * Math.sin(kj * u + (j === 0 ? pb1 : pb2));
    const hw = 0.175 * W * Math.min(1, gate * 3) * endT;
    water = Math.max(water, hw - Math.abs(dv - cj));
  }
  // Sandbars: elongated along the flow, inside the channels.
  const barS = Math.sin(u * 0.0021 + p1 * 3.0) * Math.sin(dv * 0.013 + u * 0.0004 + p2);
  if (water > 12 && barS > 0.62) {
    out.bar = 1;
    water = Math.min(water, (0.62 - barS) * 400);
  }
  out.water = water;
  return out;
}

/**
 * GLSL mirror of riverField: `vec3 riverField(int i, vec2 p)` returns (water, belt, bar) for river i
 * of the uniform block uRivers[4 * MAX_RIVERS] (packed as packRiver).
 */
export const RIVER_GLSL = /* glsl */ `
  uniform vec4 uRivers[${4 * MAX_RIVERS}];
  uniform int uRiverCount;
  vec3 riverField(int i, vec2 p) {
    vec4 a = uRivers[i * 4];
    vec4 b = uRivers[i * 4 + 1];
    vec4 c = uRivers[i * 4 + 2];
    vec4 d = uRivers[i * 4 + 3];
    vec2 q = p - a.xy;
    float u = dot(q, a.zw);
    float v = dot(q, vec2(-a.w, a.z));
    if (u < -2000.0) return vec3(-1e9, -1e9, 0.0);
    float endT = b.x > 1e8 ? 1.0 : clamp((b.x - u) / 3000.0, 0.0, 1.0);
    if (endT <= 0.0) return vec3(-1e9, -1e9, 0.0);
    float W = b.y;
    float F = b.z;
    float k1 = c.x;
    float cb = b.w * (0.7 * sin(k1 * u + c.y) + 0.5 * sin(0.41 * k1 * u + 1.7 * d.x));
    float dv = v - cb;
    float belt = F * (0.55 + 0.45 * endT) - abs(dv);
    if (belt < -400.0) return vec3(-1e9, belt, 0.0);
    float cm = 0.4 * F * sin(2.7 * k1 * u + c.z) + 0.1 * F * sin(6.3 * k1 * u + c.w);
    float hwMain = 0.5 * W * (1.0 + 0.3 * sin(3.1 * k1 * u + d.x)) * endT;
    float water = hwMain - abs(dv - cm);
    for (int j = 0; j < 2; j++) {
      float gate = sin(1.3 * k1 * u + d.w + float(j) * 3.14159265) - 0.1;
      if (gate <= 0.0) continue;
      float kj = (j == 0 ? 1.9 : 2.3) * k1;
      float cj = 0.62 * F * sin(kj * u + (j == 0 ? d.y : d.z));
      float hw = 0.175 * W * min(1.0, gate * 3.0) * endT;
      water = max(water, hw - abs(dv - cj));
    }
    float bar = 0.0;
    float barS = sin(u * 0.0021 + c.y * 3.0) * sin(dv * 0.013 + u * 0.0004 + c.z);
    if (water > 12.0 && barS > 0.62) {
      bar = 1.0;
      water = min(water, (0.62 - barS) * 400.0);
    }
    return vec3(water, belt, bar);
  }
  // All rivers combined: max water, max belt, any bar.
  vec3 riversAt(vec2 p) {
    vec3 r = vec3(-1e9, -1e9, 0.0);
    for (int i = 0; i < ${MAX_RIVERS}; i++) {
      if (i >= uRiverCount) break;
      vec3 f = riverField(i, p);
      r = vec3(max(r.x, f.x), max(r.y, f.y), max(r.z, f.z));
    }
    return r;
  }
`;
