/**
 * src/hud/mathInternal.ts
 *
 * Private helpers: `lerp`, `clamp`, `nlerpHud` (a second, independent copy of
 * src/render/mathInternal.ts's `quatNlerp` formula — 08-render.md section 1
 * / section 9 item 7: src/hud cannot import src/render, so it re-implements
 * the same tiny set of formulas). Also a private `rotateVecByQuat` used by
 * the radar scope to derive forward/right world vectors from the player's
 * interpolated rotation.
 */

import type { QuatLike, Vec3Like } from '../contracts/core';

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

export function lerp3(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>, t: number, out: Vec3Like): Vec3Like {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/** Identical formula to src/render/mathInternal.ts#quatNlerp (independent copy). */
export function nlerpHud(a: Readonly<QuatLike>, b: Readonly<QuatLike>, t: number, out: QuatLike): QuatLike {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  if (a.x * bx + a.y * by + a.z * bz + a.w * bw < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  const x = a.x + (bx - a.x) * t;
  const y = a.y + (by - a.y) * t;
  const z = a.z + (bz - a.z) * t;
  const w = a.w + (bw - a.w) * t;
  const len = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  out.w = w / len;
  return out;
}

/** Body->world rotation `out = q * v * conj(q)`, allocation-free. Safe when `out` aliases `v`. */
export function rotateVecByQuat(q: Readonly<QuatLike>, v: Readonly<Vec3Like>, out: Vec3Like): Vec3Like {
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;
  const vx = v.x;
  const vy = v.y;
  const vz = v.z;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

export function vec3Dot(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
