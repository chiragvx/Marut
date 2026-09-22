/**
 * src/render/mathInternal.ts
 *
 * Private, allocation-free vector/quaternion/scalar helpers for src/render.
 * Per 00-architecture.md section 10, src/render may import ONLY from
 * src/contracts/* — it may NOT import src/math/*, so this file is this
 * module's own small, private copy of the handful of formulas it needs that
 * are not Three.js scene-graph operations (08-render.md section 1/2). This
 * file is intentionally NOT exported outside src/render (src/hud keeps an
 * independent copy in src/hud/mathInternal.ts — see 08-render.md section 9
 * item 7).
 *
 * Every function here takes an `out` parameter (last argument), writes it
 * unconditionally, returns it, and is safe when `out` aliases an input.
 */

import type { QuatLike, Vec3Like } from '../contracts/core';

/** Scalar lerp, unclamped. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clamps `x` into `[min, max]`. */
export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

/** `out = a + (b - a) * t`, component-wise, unclamped. 08-render.md section 4.1. */
export function lerp3(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>, t: number, out: Vec3Like): Vec3Like {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/** Normalized linear interpolation with shortest-path fix. 08-render.md section 4.1 (exact formula). */
export function quatNlerp(a: Readonly<QuatLike>, b: Readonly<QuatLike>, t: number, out: QuatLike): QuatLike {
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

/**
 * Body->world rotation, `out = q * v * conj(q)`, allocation-free optimized
 * form (same algebraic identity contracts/math.ts's `Quat.rotate` uses).
 * Safe when `out` aliases `v`.
 */
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

/** Builds `out = axisAngle(axis, angleRad)`. PRECONDITION: `axis` is unit length. */
export function axisAngleQuat(axis: Readonly<Vec3Like>, angleRad: number, out: QuatLike): QuatLike {
  const half = angleRad * 0.5;
  const s = Math.sin(half);
  out.x = axis.x * s;
  out.y = axis.y * s;
  out.z = axis.z * s;
  out.w = Math.cos(half);
  return out;
}

/**
 * Rodrigues' rotation formula: rotates `v` about unit `axis` by `angleRad`.
 * `out = v*cos(theta) + cross(axis,v)*sin(theta) + axis*dot(axis,v)*(1-cos(theta))`.
 * 08-render.md section 4.4 (wireframe articulation) — exact formula. Safe
 * when `out` aliases `v`.
 */
export function rotateVecByAxisAngle(v: Readonly<Vec3Like>, axis: Readonly<Vec3Like>, angleRad: number, out: Vec3Like): Vec3Like {
  const vx = v.x;
  const vy = v.y;
  const vz = v.z;
  let ax = axis.x;
  let ay = axis.y;
  let az = axis.z;
  const axisLenSq = ax * ax + ay * ay + az * az;
  if (Math.abs(axisLenSq - 1) > 1e-6 && axisLenSq > 0) {
    const invLen = 1 / Math.sqrt(axisLenSq);
    ax *= invLen;
    ay *= invLen;
    az *= invLen;
  }
  const cosT = Math.cos(angleRad);
  const sinT = Math.sin(angleRad);
  const crossX = ay * vz - az * vy;
  const crossY = az * vx - ax * vz;
  const crossZ = ax * vy - ay * vx;
  const dot = ax * vx + ay * vy + az * vz;
  const oneMinusCos = 1 - cosT;
  out.x = vx * cosT + crossX * sinT + ax * dot * oneMinusCos;
  out.y = vy * cosT + crossY * sinT + ay * dot * oneMinusCos;
  out.z = vz * cosT + crossZ * sinT + az * dot * oneMinusCos;
  return out;
}

/** Euclidean length of `v`. */
export function vec3Length(v: Readonly<Vec3Like>): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** `out = v / |v|`. If `|v| === 0`, writes `(0,0,0)` (never NaN). */
export function vec3Normalize(v: Readonly<Vec3Like>, out: Vec3Like): Vec3Like {
  const len = vec3Length(v);
  if (len === 0) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  out.x = v.x / len;
  out.y = v.y / len;
  out.z = v.z / len;
  return out;
}

export function vec3Dot(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vec3Distance(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * One step of exponential-smoothing (first-order-lag) easing, time constant
 * `tauSec`. Identical discretization to contracts/math.ts's `LowPassStep`
 * (re-implemented locally per this file's own no-src/math rule). If
 * `tauSec <= 0`, returns `target` exactly.
 */
export function expSmooth(prev: number, target: number, tauSec: number, dtSec: number): number {
  if (tauSec <= 0) return target;
  const alpha = 1 - Math.exp(-dtSec / tauSec);
  return prev + (target - prev) * alpha;
}
