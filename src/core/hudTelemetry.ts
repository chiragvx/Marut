/**
 * src/core/hudTelemetry.ts — small geometry helpers `World` needs for the
 * HUD block (10-core-worker.md section 4.8): heading/pitch/roll extraction
 * (a cross-check against src/math's `Quat.toYawPitchRoll`, restated here so
 * this module's own tests do not depend on module 01 existing), the world
 * forward-vector formula (00-architecture.md section 3.1), and the ILS
 * localiser/glideslope deviation formula World evaluates itself for the HUD
 * block's ILS_LOC/ILS_GS fields.
 */

import { clamp, wrapAngleSigned, wrapAngleUnsigned } from '../math';
import type { IlsInfo, QuatLike, Vec3Like } from '../contracts/core';
import { ILS_GS_FULL_SCALE_DEG, ILS_LOC_FULL_SCALE_DEG } from '../contracts/core';

export interface HeadingPitchRoll {
  headingRad: number;
  pitchRad: number;
  rollRad: number;
}

/** `forwardWorld(heading) = (sin(heading), 0, -cos(heading))` — 00-architecture.md section 3.1. Allocation-free. */
export function forwardWorldInto(headingRad: number, out: Vec3Like): Vec3Like {
  out.x = Math.sin(headingRad);
  out.y = 0;
  out.z = -Math.cos(headingRad);
  return out;
}

/** `rightWorld(heading) = forwardWorld(heading + PI/2) = (cos(heading), 0, sin(heading))`. Used for line-abreast formation spawn offsets (10-core-worker.md section 4.2). */
export function rightWorldInto(headingRad: number, out: Vec3Like): Vec3Like {
  out.x = Math.cos(headingRad);
  out.y = 0;
  out.z = Math.sin(headingRad);
  return out;
}

const fwdScratch: Vec3Like = { x: 0, y: 0, z: 0 };
const rightScratch: Vec3Like = { x: 0, y: 0, z: 0 };

/** Rotates `v` by quaternion `q` (body->world), writing into `out`. Allocation-free, self-contained (does not depend on src/math's Quat.rotate so this file's own tests never need module 01). */
function rotateByQuat(q: Readonly<QuatLike>, v: Readonly<Vec3Like>, out: Vec3Like): Vec3Like {
  // out = q * v * conj(q), optimized form.
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const vx = v.x, vy = v.y, vz = v.z;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // out = v + qw*t + cross(q.xyz, t)
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/**
 * Heading/pitch/roll extraction, 10-core-worker.md section 4.8's exact
 * formula (cross-checked against `Quat.toYawPitchRoll`). Allocation-free
 * (uses module-level scratch vectors — this function is not reentrant, but
 * `World` only ever calls it synchronously from within `writeSnapshot`).
 */
export function extractHeadingPitchRoll(rot: Readonly<QuatLike>, out: HeadingPitchRoll): HeadingPitchRoll {
  const fwd = rotateByQuat(rot, { x: 1, y: 0, z: 0 }, fwdScratch);
  const pitchRad = Math.asin(clamp(fwd.y, -1, 1));
  const headingRad = Math.atan2(fwd.x, -fwd.z);
  const right = rotateByQuat(rot, { x: 0, y: 0, z: 1 }, rightScratch);
  const cosPitch = Math.cos(pitchRad);
  const rollRad =
    Math.abs(cosPitch) > 1e-6
      ? Math.atan2(-right.y / cosPitch, Math.cos(headingRad) * right.x + Math.sin(headingRad) * right.z)
      : 0;
  out.headingRad = wrapAngleUnsigned(headingRad);
  out.pitchRad = pitchRad;
  out.rollRad = rollRad;
  return out;
}

export interface IlsDeviationResult {
  loc: number;
  gs: number;
}

/** Reception cone of the localiser / glide slope (as src/contracts/airport.ts's ILS_*_VALID_*). */
const LOC_VALID_AZ_RAD = 0.610865;
const LOC_VALID_RANGE_M = 46300;
const GS_VALID_AZ_RAD = 0.139626;
const GS_VALID_RANGE_M = 18520;

/**
 * Localiser / glideslope deviation, normalised to [-1,1] via `ILS_LOC_FULL_SCALE_DEG` /
 * `ILS_GS_FULL_SCALE_DEG`. loc + = the aircraft is RIGHT of the course (looking along the
 * runway heading), gs + = above the glide path; both 0 outside the reception cone (behind the
 * localiser, off to the side, or out of range). Same geometry as src/airport/ils.ts (src/core does
 * not depend on src/airport's runtime). The localiser antenna is beyond the FAR end, so the
 * deviation is measured looking back from it toward the approach (an earlier version compared
 * the bearing to the aircraft with the runway heading itself, 180 deg off, which pinned the
 * needle at full scale). Allocation-free.
 */
export function computeIlsDeviation(playerPosWorld: Readonly<Vec3Like>, ils: Readonly<IlsInfo>, out: IlsDeviationResult): IlsDeviationResult {
  const h = ils.localiserHeadingRad;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const rx = Math.cos(h);
  const rz = Math.sin(h);
  const dxL = playerPosWorld.x - ils.localiserOriginPos.x;
  const dzL = playerPosWorld.z - ils.localiserOriginPos.z;
  const crossM = dxL * rx + dzL * rz;
  const distL = -(dxL * fx + dzL * fz);
  const locRad = Math.atan2(crossM, distL);
  const dxG = playerPosWorld.x - ils.glideslopeOriginPos.x;
  const dzG = playerPosWorld.z - ils.glideslopeOriginPos.z;
  const dyG = playerPosWorld.y - ils.glideslopeOriginPos.y;
  const distG = -(dxG * fx + dzG * fz);
  const valid =
    distL > 0 && distL <= LOC_VALID_RANGE_M && Math.abs(locRad) <= LOC_VALID_AZ_RAD &&
    distG > 0 && distG <= GS_VALID_RANGE_M && Math.abs(Math.atan2(crossM, distG)) <= GS_VALID_AZ_RAD;
  if (!valid) {
    out.loc = 0;
    out.gs = 0;
    return out;
  }
  out.loc = clamp((locRad * 180) / Math.PI / ILS_LOC_FULL_SCALE_DEG, -1, 1);
  const gsDevRad = Math.atan2(dyG, distG) - ils.glideslopeAngleRad;
  out.gs = clamp((gsDevRad * 180) / Math.PI / ILS_GS_FULL_SCALE_DEG, -1, 1);
  return out;
}
