/**
 * src/combat/lineOfSight.ts — terrain line of sight and ray-to-ground, for any sensor or weapon that
 * looks at or along the ground (SAM and ground radars masked by hills, a targeting pod's line of
 * sight and laser range, a bomb sight's impact point). Pure functions of a HeightSampler, so the sim
 * worker and the main thread get the same answer. Allocation-free.
 *
 * Both march the segment in fixed steps (a hill narrower than the step can be missed; the default
 * 40 m is well under the terrain's smallest ridges), capped at MAX_LOS_SAMPLES per call.
 */
import type { HeightSampler, Vec3Like } from '../contracts/core';

/** Sample cap per call: long lines use proportionally longer steps. */
export const MAX_LOS_SAMPLES = 1500;
export const DEFAULT_LOS_STEP_M = 40;

/**
 * True when the ground stays at least `marginM` below the straight line from `a` to `b`. The first
 * and last `endClearM` of the line are not tested, so an observer or target sitting on the ground
 * (a radar mast, a parked vehicle) still sees out over the ground right next to it.
 */
export function terrainLineOfSight(sampler: HeightSampler, a: Vec3Like, b: Vec3Like, marginM = 0, endClearM = 25, stepM = DEFAULT_LOS_STEP_M): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len <= 2 * endClearM) return true;
  const step = Math.max(stepM, len / MAX_LOS_SAMPLES);
  for (let d = endClearM; d <= len - endClearM; d += step) {
    const t = d / len;
    const y = a.y + dy * t;
    if (sampler.heightAt(a.x + dx * t, a.z + dz * t) + marginM > y) return false;
  }
  return true;
}

/**
 * Where a ray from `origin` along unit direction `dir` first meets the ground, within `maxRangeM`:
 * writes the point into `out` and returns the range (m), or returns -1 (out untouched) if it doesn't.
 * The crossing found by the march is refined by bisection to well under a metre.
 */
export function rayToGround(sampler: HeightSampler, origin: Vec3Like, dir: Vec3Like, maxRangeM: number, out: Vec3Like, stepM = DEFAULT_LOS_STEP_M): number {
  if (origin.y < sampler.heightAt(origin.x, origin.z)) return -1;
  const step = Math.max(stepM, maxRangeM / MAX_LOS_SAMPLES);
  let prev = 0;
  for (let d = step; ; d += step) {
    const r = Math.min(d, maxRangeM);
    const y = origin.y + dir.y * r;
    if (y <= sampler.heightAt(origin.x + dir.x * r, origin.z + dir.z * r)) {
      // Above ground at `prev`, at or below at `r`: bisect.
      let lo = prev, hi = r;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (origin.y + dir.y * mid <= sampler.heightAt(origin.x + dir.x * mid, origin.z + dir.z * mid)) hi = mid;
        else lo = mid;
      }
      out.x = origin.x + dir.x * hi;
      out.y = origin.y + dir.y * hi;
      out.z = origin.z + dir.z * hi;
      return hi;
    }
    if (r >= maxRangeM) return -1;
    prev = r;
  }
}
