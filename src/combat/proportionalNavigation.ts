/**
 * src/combat/proportionalNavigation.ts — shared true-PN lateral-acceleration
 * formula used by both missile kinds inside stepProjectile.
 * See docs/spec/07-combat.md section 4.7 for the derivation and worked example.
 */
import type { Vec3Like } from '../contracts/core';
import type { ComputePnAccel } from '../contracts/combat';

/**
 * True PN in 3D. Returns (0,0,0) when not closing (Vc <= 0) — PN is
 * undefined/inapplicable in that case. Result is clamped to magnitude
 * `maxAccelMps2`. Allocation-free (writes into `out`).
 */
export const computePnAccel: ComputePnAccel = (
  missilePos: Vec3Like,
  missileVel: Vec3Like,
  targetPos: Vec3Like,
  targetVel: Vec3Like,
  gain: number,
  maxAccelMps2: number,
  out: Vec3Like,
): Vec3Like => {
  const rx = targetPos.x - missilePos.x;
  const ry = targetPos.y - missilePos.y;
  const rz = targetPos.z - missilePos.z;
  const rdx = targetVel.x - missileVel.x;
  const rdy = targetVel.y - missileVel.y;
  const rdz = targetVel.z - missileVel.z;

  const rLenSq = rx * rx + ry * ry + rz * rz;
  const rLen = Math.sqrt(rLenSq);
  if (rLen < 1e-9) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }

  const rux = rx / rLen;
  const ruy = ry / rLen;
  const ruz = rz / rLen;

  const Vc = -(rdx * rux + rdy * ruy + rdz * ruz);
  if (Vc <= 0) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }

  // omega = cross(r, rDot) / dot(r, r)
  const crossX = ry * rdz - rz * rdy;
  const crossY = rz * rdx - rx * rdz;
  const crossZ = rx * rdy - ry * rdx;
  const omx = crossX / rLenSq;
  const omy = crossY / rLenSq;
  const omz = crossZ / rLenSq;

  // aCmd = N * Vc * cross(omega, rUnit)
  const ax = omy * ruz - omz * ruy;
  const ay = omz * rux - omx * ruz;
  const az = omx * ruy - omy * rux;

  let cx = gain * Vc * ax;
  let cy = gain * Vc * ay;
  let cz = gain * Vc * az;

  const mag = Math.sqrt(cx * cx + cy * cy + cz * cz);
  if (mag > maxAccelMps2 && mag > 1e-12) {
    const scale = maxAccelMps2 / mag;
    cx *= scale;
    cy *= scale;
    cz *= scale;
  }

  out.x = cx;
  out.y = cy;
  out.z = cz;
  return out;
};
