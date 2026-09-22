/**
 * src/combat/hitDetection.ts — swept segment-vs-ellipsoid hit test and
 * point-to-segment closest-approach helper. See docs/spec/07-combat.md
 * section 4.9 for the exact algorithm and worked example.
 */
import type { Vec3Like, QuatLike } from '../contracts/core';
import type { EllipsoidHitResult, SegmentHitsEllipsoid, ClosestApproachOnSegment } from '../contracts/combat';
import { Vec3, Quat, clamp } from '../math';

// Module-scope scratch (allocation-free per call).
const _relStart: Vec3Like = { x: 0, y: 0, z: 0 };
const _relEnd: Vec3Like = { x: 0, y: 0, z: 0 };
const _localStart: Vec3Like = { x: 0, y: 0, z: 0 };
const _localEnd: Vec3Like = { x: 0, y: 0, z: 0 };
const _scaledStart: Vec3Like = { x: 0, y: 0, z: 0 };
const _scaledEnd: Vec3Like = { x: 0, y: 0, z: 0 };
const _d: Vec3Like = { x: 0, y: 0, z: 0 };
const _segDir: Vec3Like = { x: 0, y: 0, z: 0 };
const _toPoint: Vec3Like = { x: 0, y: 0, z: 0 };
const _closest: Vec3Like = { x: 0, y: 0, z: 0 };

/**
 * Swept segment-vs-ellipsoid test. Transforms both segment endpoints into
 * the target's body frame, scales by the (inverse) semi-axes, and reduces
 * to a standard unit-sphere/segment intersection. Mutates and returns `out`.
 */
export const segmentHitsEllipsoid: SegmentHitsEllipsoid = (
  segStartWorld: Vec3Like,
  segEndWorld: Vec3Like,
  targetPos: Vec3Like,
  targetRot: QuatLike,
  ellipsoidSemiAxesBodyM: Vec3Like,
  out: EllipsoidHitResult,
): EllipsoidHitResult => {
  Vec3.sub(segStartWorld, targetPos, _relStart);
  Quat.rotateInverse(targetRot, _relStart, _localStart);
  _scaledStart.x = _localStart.x / ellipsoidSemiAxesBodyM.x;
  _scaledStart.y = _localStart.y / ellipsoidSemiAxesBodyM.y;
  _scaledStart.z = _localStart.z / ellipsoidSemiAxesBodyM.z;

  Vec3.sub(segEndWorld, targetPos, _relEnd);
  Quat.rotateInverse(targetRot, _relEnd, _localEnd);
  _scaledEnd.x = _localEnd.x / ellipsoidSemiAxesBodyM.x;
  _scaledEnd.y = _localEnd.y / ellipsoidSemiAxesBodyM.y;
  _scaledEnd.z = _localEnd.z / ellipsoidSemiAxesBodyM.z;

  Vec3.sub(_scaledEnd, _scaledStart, _d);
  const a = Vec3.dot(_d, _d);
  const b = 2 * Vec3.dot(_scaledStart, _d);
  const c = Vec3.dot(_scaledStart, _scaledStart) - 1;
  const disc = b * b - 4 * a * c;

  if (disc < 0 || a <= 1e-9) {
    out.hit = false;
    out.tEntry = NaN;
    return out;
  }

  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b - sqrtDisc) / (2 * a);
  const t2 = (-b + sqrtDisc) / (2 * a);
  const hit = t1 <= 1 && t2 >= 0;
  out.hit = hit;
  out.tEntry = hit ? (c < 0 ? 0 : clamp(t1, 0, 1)) : NaN;
  return out;
};

/** Minimum distance, m, from `targetPos` to the segment `segStartWorld -> segEndWorld`. */
export const closestApproachOnSegment: ClosestApproachOnSegment = (
  segStartWorld: Vec3Like,
  segEndWorld: Vec3Like,
  targetPos: Vec3Like,
): number => {
  Vec3.sub(segEndWorld, segStartWorld, _segDir);
  const lenSq = Vec3.dot(_segDir, _segDir);
  if (lenSq < 1e-12) {
    return Vec3.distance(segStartWorld, targetPos);
  }
  Vec3.sub(targetPos, segStartWorld, _toPoint);
  const t = clamp(Vec3.dot(_toPoint, _segDir) / lenSq, 0, 1);
  Vec3.scale(_segDir, t, _closest);
  Vec3.add(segStartWorld, _closest, _closest);
  return Vec3.distance(_closest, targetPos);
};
