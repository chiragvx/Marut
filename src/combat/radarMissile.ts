/**
 * src/combat/radarMissile.ts — radar-missile-specific guidance-mode
 * transition used inside stepProjectile (gunBallistics.ts).
 * See docs/spec/07-combat.md section 4.6.1.
 */
import type { QuatLike, Vec3Like } from '../contracts/core';
import {
  RADAR_MISSILE_ACTIVE_SEEKER_RANGE_M,
  RADAR_MISSILE_ACTIVE_SEEKER_HALF_ANGLE_RAD,
  ProjectileGuidanceMode,
  type ProjectileState,
  type DetectableEntity,
  type WeaponProfile,
} from '../contracts/combat';
import { Vec3, Quat, clamp } from '../math';

const WORLD_FORWARD_BODY: Vec3Like = { x: 1, y: 0, z: 0 };
const _missileForwardW: Vec3Like = { x: 0, y: 0, z: 0 };
const _dirToTarget: Vec3Like = { x: 0, y: 0, z: 0 };

/**
 * Radar-missile-specific guidance-mode transition, called once per tick
 * from gunBallistics.ts's stepProjectile dispatcher for
 * `kind === 'radar_missile'`. Datalink (perfect target state) beyond
 * RADAR_MISSILE_ACTIVE_SEEKER_RANGE_M; autonomous active-seeker cone check
 * within it. Sticky once 'lost' (never recovers). Allocation-free.
 */
export function updateRadarMissileGuidance(
  projectile: ProjectileState,
  missileRot: Readonly<QuatLike>,
  missilePos: Readonly<Vec3Like>,
  target: DetectableEntity | undefined,
  profile?: WeaponProfile,
): void {
  if (projectile.guidance === ProjectileGuidanceMode.Lost) return;

  if (!target) {
    projectile.guidance = ProjectileGuidanceMode.Lost;
    return;
  }

  const dx = target.pos.x - missilePos.x;
  const dy = target.pos.y - missilePos.y;
  const dz = target.pos.z - missilePos.z;
  const rangeToTarget = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const seekerRange = profile?.radar?.activeSeekerRangeM ?? RADAR_MISSILE_ACTIVE_SEEKER_RANGE_M;
  const seekerHalfAngle = profile?.radar?.activeSeekerHalfAngleRad ?? RADAR_MISSILE_ACTIVE_SEEKER_HALF_ANGLE_RAD;
  if (rangeToTarget > seekerRange) {
    projectile.guidance = ProjectileGuidanceMode.RadarDatalink;
  } else if (rangeToTarget < 1e-6) {
    projectile.guidance = ProjectileGuidanceMode.RadarActive;
  } else {
    Quat.rotate(missileRot, WORLD_FORWARD_BODY, _missileForwardW);
    _dirToTarget.x = dx / rangeToTarget;
    _dirToTarget.y = dy / rangeToTarget;
    _dirToTarget.z = dz / rangeToTarget;
    const angle = Math.acos(clamp(Vec3.dot(_dirToTarget, _missileForwardW), -1, 1));
    projectile.guidance = angle <= seekerHalfAngle ? ProjectileGuidanceMode.RadarActive : ProjectileGuidanceMode.Lost;
  }

  // With a realism profile, mid-course knowledge comes from the datalink (stepProjectile).
  if (profile?.flight && projectile.guidance === ProjectileGuidanceMode.RadarDatalink) return;
  projectile.lastKnownTargetPos.x = target.pos.x;
  projectile.lastKnownTargetPos.y = target.pos.y;
  projectile.lastKnownTargetPos.z = target.pos.z;
  projectile.lastKnownTargetVel.x = target.vel.x;
  projectile.lastKnownTargetVel.y = target.vel.y;
  projectile.lastKnownTargetVel.z = target.vel.z;
}
