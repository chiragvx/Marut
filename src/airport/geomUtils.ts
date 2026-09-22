/**
 * src/airport/geomUtils.ts — small internal geometry helpers shared by
 * validator.ts and surfaceIndex.ts. Not part of the public contract surface
 * (see 00-architecture.md section 11's "extra internal helper" allowance).
 * Both functions are pure and allocate no objects (only primitive locals),
 * so they are safe to call from AirportSurfaceIndex.frictionAt, which
 * 05-airport.md section 4.6/6 documents as allocation-free.
 */

import type { WorldPoint2 } from '../contracts/airport';

/**
 * Standard ray-casting point-in-polygon parity test (05-airport.md section
 * 4.5). `poly` must not repeat its first point at the end.
 */
export function pointInPolygon(x: number, z: number, poly: readonly WorldPoint2[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n;
    const pi = poly[i]!;
    const pj = poly[j]!;
    if (pi.worldZ > z !== pj.worldZ > z) {
      const xCross = ((pj.worldX - pi.worldX) * (z - pi.worldZ)) / (pj.worldZ - pi.worldZ) + pi.worldX;
      if (x < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from (px,pz) to the XZ-plane segment (ax,az)-(bx,bz). */
export function pointToSegmentDistanceXZ(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const abLenSq = abx * abx + abz * abz;
  let t = abLenSq === 0 ? 0 : ((px - ax) * abx + (pz - az) * abz) / abLenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + abx * t;
  const cz = az + abz * t;
  return Math.hypot(px - cx, pz - cz);
}
