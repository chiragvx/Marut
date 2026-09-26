/**
 * src/combat/gunBallistics.ts — bullet drag/gravity integration, and the
 * top-level `stepProjectile` dispatcher shared by bullets + both missile
 * kinds (drag/gravity/thrust integration, velocity-alignment orientation,
 * guidance dispatch, hit/fuse resolution). Also hosts the projectile pool
 * factories. See docs/spec/07-combat.md sections 4.2, 4.6, 4.7, 4.9.
 */
import type { EntityState, QuatLike, Vec3Like } from '../contracts/core';
import { EntityKind, NO_ENTITY_ID } from '../contracts/core';
import {
  DEFAULT_AIRCRAFT_HIT_ELLIPSOID_M,
  ProjectileKind,
  ProjectileGuidanceMode,
  ProjectileOutcome,
  type CreateProjectilePool,
  type ResetProjectile,
  type InitProjectile,
  type StepProjectile,
  type ProjectileState,
  type ProjectileStepResult,
  type DetectableEntity,
} from '../contracts/combat';
import { Vec3 } from '../math';
import { computePnAccel } from './proportionalNavigation';
import { updateIrGuidance } from './irMissileSeeker';
import { updateRadarMissileGuidance } from './radarMissile';
import { segmentHitsEllipsoid, closestApproachOnSegment } from './hitDetection';
import { projectileProfile } from './weaponProfiles';

// -----------------------------------------------------------------------------
// Pool factories (init-time only; allocation is expected/allowed here).
// -----------------------------------------------------------------------------

function freshProjectileState(): ProjectileState {
  return {
    active: false,
    kind: ProjectileKind.Bullet,
    ownerId: NO_ENTITY_ID,
    targetId: NO_ENTITY_ID,
    ageSec: 0,
    guidance: ProjectileGuidanceMode.Ballistic,
    distanceTravelledM: 0,
    fuelFracRemaining: 0,
    seekerLosDirBody: { x: 1, y: 0, z: 0 },
    lastKnownTargetPos: { x: 0, y: 0, z: 0 },
    lastKnownTargetVel: { x: 0, y: 0, z: 0 },
    gSaturatedSec: 0,
    profile: undefined,
  };
}

export const createProjectilePool: CreateProjectilePool = (size) => {
  const pool: ProjectileState[] = new Array(size);
  for (let i = 0; i < size; i++) pool[i] = freshProjectileState();
  return pool;
};

export const resetProjectile: ResetProjectile = (slot) => {
  slot.active = false;
  slot.kind = ProjectileKind.Bullet;
  slot.ownerId = NO_ENTITY_ID;
  slot.targetId = NO_ENTITY_ID;
  slot.ageSec = 0;
  slot.guidance = ProjectileGuidanceMode.Ballistic;
  slot.distanceTravelledM = 0;
  slot.fuelFracRemaining = 0;
  slot.seekerLosDirBody.x = 1;
  slot.seekerLosDirBody.y = 0;
  slot.seekerLosDirBody.z = 0;
  slot.lastKnownTargetPos.x = 0;
  slot.lastKnownTargetPos.y = 0;
  slot.lastKnownTargetPos.z = 0;
  slot.lastKnownTargetVel.x = 0;
  slot.lastKnownTargetVel.y = 0;
  slot.lastKnownTargetVel.z = 0;
  slot.gSaturatedSec = 0;
  slot.profile = undefined;
};

export const initProjectile: InitProjectile = (slot, spec, _simTimeSec) => {
  slot.active = true;
  slot.kind = spec.kind;
  slot.ownerId = spec.ownerId;
  slot.targetId = spec.targetId ?? NO_ENTITY_ID;
  slot.ageSec = 0;
  slot.guidance = spec.kind === ProjectileKind.Bullet ? ProjectileGuidanceMode.Ballistic
    : spec.kind === ProjectileKind.IrMissile ? ProjectileGuidanceMode.IrHoming
    : ProjectileGuidanceMode.RadarDatalink;
  slot.distanceTravelledM = 0;
  slot.fuelFracRemaining = spec.kind === ProjectileKind.Bullet ? 0 : 1;
  slot.seekerLosDirBody.x = 1;
  slot.seekerLosDirBody.y = 0;
  slot.seekerLosDirBody.z = 0;
  slot.lastKnownTargetPos.x = 0;
  slot.lastKnownTargetPos.y = 0;
  slot.lastKnownTargetPos.z = 0;
  slot.lastKnownTargetVel.x = 0;
  slot.lastKnownTargetVel.y = 0;
  slot.lastKnownTargetVel.z = 0;
  slot.gSaturatedSec = 0;
  slot.profile = spec.profile;
};

// -----------------------------------------------------------------------------
// stepProjectile — per-tick physics + guidance + hit/fuse resolution.
// -----------------------------------------------------------------------------


function copyEntityState(src: EntityState, dst: EntityState): void {
  dst.id = src.id;
  dst.kind = src.kind;
  dst.team = src.team;
  dst.pos.x = src.pos.x; dst.pos.y = src.pos.y; dst.pos.z = src.pos.z;
  dst.rot.x = src.rot.x; dst.rot.y = src.rot.y; dst.rot.z = src.rot.z; dst.rot.w = src.rot.w;
  dst.vel.x = src.vel.x; dst.vel.y = src.vel.y; dst.vel.z = src.vel.z;
  dst.omega.x = src.omega.x; dst.omega.y = src.omega.y; dst.omega.z = src.omega.z;
  dst.alive = src.alive;
  dst.hp = src.hp;
  dst.fuelKg = src.fuelKg;
  dst.elevonL = src.elevonL;
  dst.elevonR = src.elevonR;
  dst.rudder = src.rudder;
  dst.gearPos = src.gearPos;
  dst.throttle = src.throttle;
  dst.afterburnerOn = src.afterburnerOn;
  dst.flags = src.flags;
}

/**
 * Builds the body->world quaternion whose body +X/+Y/+Z map to world
 * `forward`/`up`/`right` respectively (standard rotation-matrix -> quaternion
 * conversion, trace method). All three inputs assumed unit length and
 * mutually orthogonal.
 */
function quatFromBasis(forward: Vec3Like, up: Vec3Like, right: Vec3Like, out: QuatLike): QuatLike {
  const m00 = forward.x, m10 = forward.y, m20 = forward.z;
  const m01 = up.x, m11 = up.y, m21 = up.z;
  const m02 = right.x, m12 = right.y, m22 = right.z;
  const trace = m00 + m11 + m22;
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const S = Math.sqrt(trace + 1) * 2;
    qw = 0.25 * S;
    qx = (m21 - m12) / S;
    qy = (m02 - m20) / S;
    qz = (m10 - m01) / S;
  } else if (m00 > m11 && m00 > m22) {
    const S = Math.sqrt(1 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / S;
    qx = 0.25 * S;
    qy = (m01 + m10) / S;
    qz = (m02 + m20) / S;
  } else if (m11 > m22) {
    const S = Math.sqrt(1 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / S;
    qx = (m01 + m10) / S;
    qy = 0.25 * S;
    qz = (m12 + m21) / S;
  } else {
    const S = Math.sqrt(1 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / S;
    qx = (m02 + m20) / S;
    qy = (m12 + m21) / S;
    qz = 0.25 * S;
  }
  out.x = qx; out.y = qy; out.z = qz; out.w = qw;
  return out;
}

// Scratch (allocation-free hot path).
const _forward: Vec3Like = { x: 0, y: 0, z: 0 };
const _right: Vec3Like = { x: 0, y: 0, z: 0 };
const _up: Vec3Like = { x: 0, y: 0, z: 0 };
const _pnAccel: Vec3Like = { x: 0, y: 0, z: 0 };
const _pnAccelUnclamped: Vec3Like = { x: 0, y: 0, z: 0 };
const _missilePosScratch: Vec3Like = { x: 0, y: 0, z: 0 };
const _missileVelScratch: Vec3Like = { x: 0, y: 0, z: 0 };
const _segStart: Vec3Like = { x: 0, y: 0, z: 0 };
const _segEnd: Vec3Like = { x: 0, y: 0, z: 0 };
const _ellipsoidResult = { hit: false, tEntry: NaN };
const _impactPos: Vec3Like = { x: 0, y: 0, z: 0 };

function velocityAlignQuat(velX: number, velY: number, velZ: number, out: QuatLike): void {
  const speed = Math.sqrt(velX * velX + velY * velY + velZ * velZ);
  if (speed < 1e-6) {
    out.x = 0; out.y = 0; out.z = 0; out.w = 1;
    return;
  }
  _forward.x = velX / speed; _forward.y = velY / speed; _forward.z = velZ / speed;

  // right = normalize(cross(forward, worldUp=(0,1,0))) = normalize((-fz, 0, fx))
  const rawRightX = -_forward.z;
  const rawRightZ = _forward.x;
  const rawRightLen = Math.sqrt(rawRightX * rawRightX + rawRightZ * rawRightZ);
  if (rawRightLen < 1e-4) {
    // forward within ~1e-4 rad of world up/down: fall back to world +X.
    _right.x = 1; _right.y = 0; _right.z = 0;
  } else {
    _right.x = rawRightX / rawRightLen; _right.y = 0; _right.z = rawRightZ / rawRightLen;
  }
  Vec3.cross(_right, _forward, _up);
  quatFromBasis(_forward, _up, _right, out);
}

export const stepProjectile: StepProjectile = (state, projectile, candidates, sampler, env, dtSec, out) => {
  const kind = projectile.kind;
  const prof = projectileProfile(projectile);
  const phys = { dragCoeff: prof.dragCoeff, crossSectionM2: prof.crossSectionM2, massKg: prof.projectileMassKg, maxLifetimeSec: prof.maxLifetimeSec, armDistanceM: prof.armDistanceM };

  const posX = state.pos.x, posY = state.pos.y, posZ = state.pos.z;
  const velX = state.vel.x, velY = state.vel.y, velZ = state.vel.z;

  copyEntityState(state, out);

  projectile.ageSec += dtSec;
  if (projectile.ageSec > phys.maxLifetimeSec) {
    out.alive = false;
    return { outcome: ProjectileOutcome.Expired, missDistanceM: NaN };
  }

  // 1. Resolve current target (guided kinds only).
  let targetEntity: DetectableEntity | undefined;
  if (kind !== ProjectileKind.Bullet && projectile.targetId !== NO_ENTITY_ID) {
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      if (c.id === projectile.targetId && c.alive) { targetEntity = c; break; }
    }
  }

  // 2. Guidance-mode transition (sense).
  if (kind === ProjectileKind.IrMissile) {
    updateIrGuidance(projectile, state.rot, state.pos, targetEntity, dtSec, prof);
  } else if (kind === ProjectileKind.RadarMissile) {
    updateRadarMissileGuidance(projectile, state.rot, state.pos, targetEntity, prof);
  }

  // 3. Drag + gravity.
  const speed = Math.sqrt(velX * velX + velY * velY + velZ * velZ);
  let accelX = 0, accelY = -env.gravityMps2, accelZ = 0;
  if (speed > 1e-9) {
    const dragAccelMag = 0.5 * env.airDensityKgM3 * speed * speed * phys.dragCoeff * phys.crossSectionM2 / phys.massKg;
    accelX -= (velX / speed) * dragAccelMag;
    accelY -= (velY / speed) * dragAccelMag;
    accelZ -= (velZ / speed) * dragAccelMag;
  }

  // 4. Motor thrust (missiles only, while within burn time).
  if (kind !== ProjectileKind.Bullet) {
    const burnTime = prof.motorBurnSec;
    const thrustN = prof.motorThrustN;
    if (projectile.ageSec < burnTime) {
      projectile.fuelFracRemaining = 1;
      if (speed > 1e-6) {
        const thrustAccel = thrustN / phys.massKg;
        accelX += (velX / speed) * thrustAccel;
        accelY += (velY / speed) * thrustAccel;
        accelZ += (velZ / speed) * thrustAccel;
      }
    } else {
      projectile.fuelFracRemaining = 0;
    }
  }

  // 5. Proportional-navigation lateral accel (guided kinds actively homing/datalinked only).
  const guidanceActive = projectile.guidance === ProjectileGuidanceMode.IrHoming
    || projectile.guidance === ProjectileGuidanceMode.RadarDatalink
    || projectile.guidance === ProjectileGuidanceMode.RadarActive;

  if (guidanceActive) {
    const tPos = targetEntity ? targetEntity.pos : projectile.lastKnownTargetPos;
    const tVel = targetEntity ? targetEntity.vel : projectile.lastKnownTargetVel;
    const gain = prof.pnGain;
    const maxG = prof.maxG;
    const maxAccel = maxG * env.gravityMps2;

    _missilePosScratch.x = posX; _missilePosScratch.y = posY; _missilePosScratch.z = posZ;
    _missileVelScratch.x = velX; _missileVelScratch.y = velY; _missileVelScratch.z = velZ;

    // Unclamped magnitude, for the radar-missile g-saturation "lost" check.
    computePnAccel(_missilePosScratch, _missileVelScratch, tPos, tVel, gain, Number.POSITIVE_INFINITY, _pnAccelUnclamped);
    const unclampedMag = Math.sqrt(_pnAccelUnclamped.x * _pnAccelUnclamped.x + _pnAccelUnclamped.y * _pnAccelUnclamped.y + _pnAccelUnclamped.z * _pnAccelUnclamped.z);
    if (unclampedMag >= maxAccel) {
      projectile.gSaturatedSec += dtSec;
    } else {
      projectile.gSaturatedSec = 0;
    }
    if (kind === ProjectileKind.RadarMissile && projectile.gSaturatedSec >= (prof.radar?.gSaturationLostSec ?? Infinity)) {
      projectile.guidance = ProjectileGuidanceMode.Lost;
    } else {
      computePnAccel(_missilePosScratch, _missileVelScratch, tPos, tVel, gain, maxAccel, _pnAccel);
      accelX += _pnAccel.x; accelY += _pnAccel.y; accelZ += _pnAccel.z;
    }
  } else {
    projectile.gSaturatedSec = 0;
  }

  // 6. Semi-implicit Euler integration.
  const newVelX = velX + accelX * dtSec;
  const newVelY = velY + accelY * dtSec;
  const newVelZ = velZ + accelZ * dtSec;
  const newPosX = posX + newVelX * dtSec;
  const newPosY = posY + newVelY * dtSec;
  const newPosZ = posZ + newVelZ * dtSec;

  const stepDx = newPosX - posX, stepDy = newPosY - posY, stepDz = newPosZ - posZ;
  projectile.distanceTravelledM += Math.sqrt(stepDx * stepDx + stepDy * stepDy + stepDz * stepDz);

  out.vel.x = newVelX; out.vel.y = newVelY; out.vel.z = newVelZ;
  velocityAlignQuat(newVelX, newVelY, newVelZ, out.rot);

  // 7. Hit / fuse resolution (armed projectiles only). Only aircraft other than the owner can be
  //    hit: `candidates` is the world's full live-entity list, which includes this projectile
  //    itself (and every other bullet/missile) -- without excluding it, an armed projectile's own
  //    position sits inside its own segment start and it "hits" itself on the first armed step.
  const armed = projectile.distanceTravelledM >= phys.armDistanceM;
  _segStart.x = posX; _segStart.y = posY; _segStart.z = posZ;
  _segEnd.x = newPosX; _segEnd.y = newPosY; _segEnd.z = newPosZ;

  if (armed) {
    let bestHit: DetectableEntity | undefined;
    let bestHitT = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      if (c.id === projectile.ownerId || c.id === state.id || !c.alive || c.kind !== EntityKind.Aircraft) continue;
      const semiAxes = c.hitEllipsoidBodyM ?? DEFAULT_AIRCRAFT_HIT_ELLIPSOID_M;
      segmentHitsEllipsoid(_segStart, _segEnd, c.pos, c.rot, semiAxes, _ellipsoidResult);
      if (_ellipsoidResult.hit && _ellipsoidResult.tEntry < bestHitT) {
        bestHitT = _ellipsoidResult.tEntry;
        bestHit = c;
      }
    }

    if (bestHit) {
      _impactPos.x = _segStart.x + stepDx * bestHitT;
      _impactPos.y = _segStart.y + stepDy * bestHitT;
      _impactPos.z = _segStart.z + stepDz * bestHitT;
      out.pos.x = _impactPos.x; out.pos.y = _impactPos.y; out.pos.z = _impactPos.z;
      out.alive = false;
      return {
        outcome: ProjectileOutcome.DirectHit,
        hitTargetId: bestHit.id,
        missDistanceM: 0,
        impactPos: { x: _impactPos.x, y: _impactPos.y, z: _impactPos.z },
      };
    }

    if (kind !== ProjectileKind.Bullet) {
      const fuseRadius = prof.proximityFuseRadiusM;
      let bestProx: DetectableEntity | undefined;
      let bestProxDist = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        if (c.id === projectile.ownerId || c.id === state.id || !c.alive || c.kind !== EntityKind.Aircraft) continue;
        const dist = closestApproachOnSegment(_segStart, _segEnd, c.pos);
        if (dist <= fuseRadius && dist < bestProxDist) {
          bestProxDist = dist;
          bestProx = c;
        }
      }
      if (bestProx) {
        // Closest point on the segment to bestProx.pos, matching closestApproachOnSegment's own computation.
        const segLenSq = stepDx * stepDx + stepDy * stepDy + stepDz * stepDz;
        let t = 0;
        if (segLenSq > 1e-12) {
          t = ((bestProx.pos.x - _segStart.x) * stepDx + (bestProx.pos.y - _segStart.y) * stepDy + (bestProx.pos.z - _segStart.z) * stepDz) / segLenSq;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
        }
        _impactPos.x = _segStart.x + stepDx * t;
        _impactPos.y = _segStart.y + stepDy * t;
        _impactPos.z = _segStart.z + stepDz * t;
        out.pos.x = _impactPos.x; out.pos.y = _impactPos.y; out.pos.z = _impactPos.z;
        out.alive = false;
        return {
          outcome: ProjectileOutcome.ProximityDetonation,
          hitTargetId: bestProx.id,
          missDistanceM: bestProxDist,
          impactPos: { x: _impactPos.x, y: _impactPos.y, z: _impactPos.z },
        };
      }
    }
  }

  // 8. Terrain impact.
  const terrainH = sampler.heightAt(newPosX, newPosZ);
  if (newPosY <= terrainH) {
    out.pos.x = newPosX; out.pos.y = terrainH; out.pos.z = newPosZ;
    out.alive = false;
    return { outcome: ProjectileOutcome.TerrainImpact, missDistanceM: NaN, impactPos: { x: newPosX, y: terrainH, z: newPosZ } };
  }

  // 9. Still flying.
  out.pos.x = newPosX; out.pos.y = newPosY; out.pos.z = newPosZ;
  out.alive = true;
  return { outcome: ProjectileOutcome.Flying, missDistanceM: NaN };
};
