/**
 * src/combat/irMissileSeeker.ts — IR seeker detection-range formula and the
 * IR-specific guidance-mode/seeker-gimbal transition used inside
 * stepProjectile (gunBallistics.ts). See docs/spec/07-combat.md sections
 * 4.6.2 and 4.6 for the exact formulas.
 */
import type { QuatLike, Vec3Like } from '../contracts/core';
import {
  IR_BASE_DETECT_RANGE_TAIL_ON_M,
  IR_BASE_DETECT_RANGE_HEAD_ON_M,
  IR_AFTERBURNER_RANGE_MULT,
  IR_SEEKER_GIMBAL_RATE_MAX_RAD_S,
  IR_SEEKER_TRACK_HALF_ANGLE_RAD,
  ProjectileGuidanceMode,
  type IrDetectionRangeM,
  type ProjectileState,
  type DetectableEntity,
  type IrSeekerProfile,
  type WeaponProfile,
} from '../contracts/combat';
import { Vec3, Quat, clamp, lerp } from '../math';

/**
 * Pure IR heat-signature detection-range formula. `aspectRad` is the aspect
 * angle at the TARGET between the target's tail and the line back to the
 * observer: 0 = target flying directly away (tail-on/hot, longest range),
 * PI = target approaching head-on (cold, shortest range).
 */
export const irDetectionRangeM: IrDetectionRangeM = (aspectRad, targetAfterburnerOn, seeker?: IrSeekerProfile) => {
  const t = clamp(aspectRad / Math.PI, 0, 1);
  const base = lerp(seeker?.detectRangeTailOnM ?? IR_BASE_DETECT_RANGE_TAIL_ON_M, seeker?.detectRangeHeadOnM ?? IR_BASE_DETECT_RANGE_HEAD_ON_M, t);
  return targetAfterburnerOn ? base * (seeker?.afterburnerRangeMult ?? IR_AFTERBURNER_RANGE_MULT) : base;
};

// Scratch (allocation-free).
const _relPos: Vec3Like = { x: 0, y: 0, z: 0 };
const _trueLosBody: Vec3Like = { x: 0, y: 0, z: 0 };

/**
 * Spherical step of a unit vector `current` toward unit vector `target`,
 * clamped to `maxAngleRad`. Alias-safe (reads `current`'s components into
 * locals before writing `out`, so `out === current` is fine).
 */
export function rotateTowards(current: Vec3Like, target: Readonly<Vec3Like>, maxAngleRad: number, out: Vec3Like): Vec3Like {
  const cx = current.x;
  const cy = current.y;
  const cz = current.z;
  const d = clamp(cx * target.x + cy * target.y + cz * target.z, -1, 1);
  const angle = Math.acos(d);
  if (angle <= maxAngleRad || angle < 1e-9) {
    out.x = target.x;
    out.y = target.y;
    out.z = target.z;
    return out;
  }
  const t = maxAngleRad / angle;
  const sinAngle = Math.sin(angle);
  const w1 = Math.sin((1 - t) * angle) / sinAngle;
  const w2 = Math.sin(t * angle) / sinAngle;
  const rx = cx * w1 + target.x * w2;
  const ry = cy * w1 + target.y * w2;
  const rz = cz * w1 + target.z * w2;
  const len = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
  out.x = rx / len;
  out.y = ry / len;
  out.z = rz / len;
  return out;
}

/**
 * IR-specific guidance-mode transition, called once per tick from
 * gunBallistics.ts's stepProjectile dispatcher for `kind === 'ir_missile'`.
 * Slews `projectile.seekerLosDirBody` toward the true target bearing (in
 * missile body frame) at up to IR_SEEKER_GIMBAL_RATE_MAX_RAD_S, then sets
 * `projectile.guidance` based on the resulting gimbal angle. Sticky once
 * 'lost' (never recovers). Allocation-free.
 */
export function updateIrGuidance(
  projectile: ProjectileState,
  missileRot: Readonly<QuatLike>,
  missilePos: Readonly<Vec3Like>,
  target: DetectableEntity | undefined,
  dtSec: number,
  profile?: WeaponProfile,
): void {
  if (projectile.guidance === ProjectileGuidanceMode.Lost) return;

  if (!target) {
    projectile.guidance = ProjectileGuidanceMode.Lost;
    return;
  }

  Vec3.sub(target.pos, missilePos, _relPos);
  Vec3.normalize(_relPos, _relPos);
  Quat.rotateInverse(missileRot, _relPos, _trueLosBody);

  const maxStepRad = (profile?.ir?.gimbalRateRadS ?? IR_SEEKER_GIMBAL_RATE_MAX_RAD_S) * dtSec;
  rotateTowards(projectile.seekerLosDirBody, _trueLosBody, maxStepRad, projectile.seekerLosDirBody);

  const gimbalAngle = Math.acos(clamp(projectile.seekerLosDirBody.x, -1, 1));
  projectile.guidance = gimbalAngle > (profile?.ir?.trackHalfAngleRad ?? IR_SEEKER_TRACK_HALF_ANGLE_RAD) ? ProjectileGuidanceMode.Lost : ProjectileGuidanceMode.IrHoming;

  projectile.lastKnownTargetPos.x = target.pos.x;
  projectile.lastKnownTargetPos.y = target.pos.y;
  projectile.lastKnownTargetPos.z = target.pos.z;
  projectile.lastKnownTargetVel.x = target.vel.x;
  projectile.lastKnownTargetVel.y = target.vel.y;
  projectile.lastKnownTargetVel.z = target.vel.z;
}
