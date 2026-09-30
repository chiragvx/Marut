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
  slot.rngState = 0;
  slot.datalinkOk = false;
  slot.datalinkAgeSec = 0;
  slot.noiseAgeSec = 0;
};

export const initProjectile: InitProjectile = (slot, spec, _simTimeSec) => {
  slot.active = true;
  slot.kind = spec.kind;
  slot.ownerId = spec.ownerId;
  slot.targetId = spec.targetId ?? NO_ENTITY_ID;
  slot.ageSec = 0;
  slot.guidance = spec.kind === ProjectileKind.IrMissile ? ProjectileGuidanceMode.IrHoming
    : spec.kind === ProjectileKind.RadarMissile ? ProjectileGuidanceMode.RadarDatalink
    : ProjectileGuidanceMode.Ballistic;
  slot.distanceTravelledM = 0;
  slot.fuelFracRemaining = spec.kind === ProjectileKind.Bullet || spec.kind === ProjectileKind.Bomb ? 0 : 1;
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
  // Realism state: own random stream, autopilot, seeker noise, datalink (updates at once).
  slot.rngState = (spec.rngSeed ?? (spec.ownerId * 2654435761 + 12345)) >>> 0;
  if (!slot.accelLat) slot.accelLat = { x: 0, y: 0, z: 0 };
  slot.accelLat.x = 0; slot.accelLat.y = 0; slot.accelLat.z = 0;
  if (!slot.noiseOffset) slot.noiseOffset = { x: 0, y: 0, z: 0 };
  slot.noiseOffset.x = 0; slot.noiseOffset.y = 0; slot.noiseOffset.z = 0;
  slot.noiseAgeSec = 1e9;
  slot.datalinkOk = true;
  slot.datalinkAgeSec = 1e9;
  // Guided bombs: GPS coordinates given at release (with the solution's error); laser bombs get
  // their point from a laser spot each tick (the caller sets it).
  if (!slot.targetPoint) slot.targetPoint = { x: 0, y: 0, z: 0 };
  slot.targetPointValid = false;
  const tp = spec.targetPoint;
  if (tp) {
    const err = spec.profile?.guided?.gpsErrorM ?? 0;
    slot.targetPoint.x = tp.x + gauss(slot) * err;
    slot.targetPoint.y = tp.y;
    slot.targetPoint.z = tp.z + gauss(slot) * err;
    slot.targetPointValid = true;
  }
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

const _noisyTarget: Vec3Like = { x: 0, y: 0, z: 0 };
const ZERO_VEL: Vec3Like = { x: 0, y: 0, z: 0 };
const _loftTarget: Vec3Like = { x: 0, y: 0, z: 0 };

/** The projectile's own random stream (mulberry32), [0, 1). */
function rand01(p: ProjectileState): number {
  let t = ((p.rngState ?? 0) + 0x6d2b79f5) >>> 0;
  p.rngState = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** A standard normal draw from the projectile's stream (Box-Muller). */
function gauss(p: ProjectileState): number {
  const u = Math.max(1e-9, rand01(p));
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand01(p));
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
  if (kind === ProjectileKind.GuidedBomb) {
    projectile.guidance = projectile.targetPointValid ? ProjectileGuidanceMode.PointGuided : ProjectileGuidanceMode.Ballistic;
  } else if (kind === ProjectileKind.IrMissile) {
    updateIrGuidance(projectile, state.rot, state.pos, targetEntity, dtSec, prof);
  } else if (kind === ProjectileKind.RadarMissile) {
    updateRadarMissileGuidance(projectile, state.rot, state.pos, targetEntity, prof);
  }

  // 3. Drag + gravity. Air density at this altitude when the environment provides it; with a
  //    realism profile, the missile gets lighter as it burns, drag rises through the sound
  //    barrier, and manoeuvring costs induced drag (added in step 5).
  const fl = kind !== ProjectileKind.Bullet ? prof.flight : undefined;
  const rho = env.densityAtAltitude ? env.densityAtAltitude(posY) : env.airDensityKgM3;
  const speed = Math.sqrt(velX * velX + velY * velY + velZ * velZ);
  let mass = phys.massKg;
  const boostT = prof.motorBurnSec;
  const sustT = fl ? fl.sustainBurnSec : 0;
  if (fl && fl.propellantMassKg > 0) {
    const totalI = prof.motorThrustN * boostT + fl.sustainThrustN * sustT;
    const usedI = prof.motorThrustN * Math.min(projectile.ageSec, boostT) + fl.sustainThrustN * Math.max(0, Math.min(projectile.ageSec - boostT, sustT));
    mass = phys.massKg - fl.propellantMassKg * (totalI > 0 ? usedI / totalI : 0);
  }
  let cd = phys.dragCoeff;
  if (fl && fl.waveDragRise > 0) {
    const mach = speed / Math.max(295, 340.3 - 0.0041 * posY);
    cd *= mach < 0.85 ? 1 : mach < 1.1 ? 1 + (fl.waveDragRise * (mach - 0.85)) / 0.25 : 1 + fl.waveDragRise * Math.max(0.4, 1 - (mach - 1.1) * 0.3);
  }
  const q = 0.5 * rho * speed * speed;
  let accelX = 0, accelY = -env.gravityMps2, accelZ = 0;
  if (speed > 1e-9) {
    // A retarded bomb's tail opens shortly after release (much more drag).
    const retard = prof.bomb && projectile.ageSec >= prof.bomb.retardAfterSec ? prof.bomb.retardCdA : 0;
    const dragAccelMag = q * (cd * phys.crossSectionM2 + retard) / mass;
    accelX -= (velX / speed) * dragAccelMag;
    accelY -= (velY / speed) * dragAccelMag;
    accelZ -= (velZ / speed) * dragAccelMag;
  }

  // Out of energy: after burnout, too slow to manoeuvre -> self-destruct.
  if (fl?.minSpeedMps && projectile.ageSec > boostT + sustT && speed < fl.minSpeedMps) {
    out.alive = false;
    return { outcome: ProjectileOutcome.Expired, missDistanceM: NaN };
  }

  // 4. Motor thrust (missiles only): boost, then sustain.
  if (kind !== ProjectileKind.Bullet) {
    const thrustN = projectile.ageSec < boostT ? prof.motorThrustN : projectile.ageSec < boostT + sustT && fl ? fl.sustainThrustN : 0;
    if (thrustN > 0) {
      projectile.fuelFracRemaining = 1;
      if (speed > 1e-6) {
        const thrustAccel = thrustN / mass;
        accelX += (velX / speed) * thrustAccel;
        accelY += (velY / speed) * thrustAccel;
        accelZ += (velZ / speed) * thrustAccel;
      }
    } else {
      projectile.fuelFracRemaining = 0;
    }
  }

  // 5. Proportional-navigation lateral accel (guided kinds actively homing/datalinked only).
  const pointGuided = projectile.guidance === ProjectileGuidanceMode.PointGuided && projectile.targetPoint !== undefined;
  const guidanceActive = projectile.guidance === ProjectileGuidanceMode.IrHoming
    || projectile.guidance === ProjectileGuidanceMode.RadarDatalink
    || projectile.guidance === ProjectileGuidanceMode.RadarActive
    || pointGuided;

  if (guidanceActive) {
    let tPos: Vec3Like = pointGuided ? projectile.targetPoint! : targetEntity ? targetEntity.pos : projectile.lastKnownTargetPos;
    let tVel: Vec3Like = pointGuided ? ZERO_VEL : targetEntity ? targetEntity.vel : projectile.lastKnownTargetVel;
    if (fl && !pointGuided) {
      // What the missile actually knows. Mid-course (radar datalink): the launcher's radar track,
      // sent every datalinkIntervalSec with an angular error that grows with range, and
      // extrapolated in between (inertial flight if the launcher drops the track). Terminal
      // (IR seeker / active radar seeker): the target seen through seeker noise.
      if (projectile.guidance === ProjectileGuidanceMode.RadarDatalink) {
        projectile.datalinkAgeSec = (projectile.datalinkAgeSec ?? 0) + dtSec;
        if (targetEntity && projectile.datalinkOk && projectile.datalinkAgeSec >= (fl.datalinkIntervalSec ?? 1)) {
          projectile.datalinkAgeSec = 0;
          const rng = Math.hypot(targetEntity.pos.x - posX, targetEntity.pos.y - posY, targetEntity.pos.z - posZ);
          const sigma = ((fl.datalinkErrMrad ?? 3) / 1000) * (rng + projectile.distanceTravelledM) + 20;
          projectile.lastKnownTargetPos.x = targetEntity.pos.x + gauss(projectile) * sigma;
          projectile.lastKnownTargetPos.y = targetEntity.pos.y + gauss(projectile) * sigma * 0.5;
          projectile.lastKnownTargetPos.z = targetEntity.pos.z + gauss(projectile) * sigma;
          projectile.lastKnownTargetVel.x = targetEntity.vel.x;
          projectile.lastKnownTargetVel.y = targetEntity.vel.y;
          projectile.lastKnownTargetVel.z = targetEntity.vel.z;
        } else {
          projectile.lastKnownTargetPos.x += projectile.lastKnownTargetVel.x * dtSec;
          projectile.lastKnownTargetPos.y += projectile.lastKnownTargetVel.y * dtSec;
          projectile.lastKnownTargetPos.z += projectile.lastKnownTargetVel.z * dtSec;
        }
        tPos = projectile.lastKnownTargetPos;
        tVel = projectile.lastKnownTargetVel;
      } else if (targetEntity) {
        const n = projectile.noiseOffset!;
        projectile.noiseAgeSec = (projectile.noiseAgeSec ?? 0) + dtSec;
        if (projectile.noiseAgeSec >= fl.seekerUpdateSec) {
          projectile.noiseAgeSec = 0;
          const rng = Math.hypot(targetEntity.pos.x - posX, targetEntity.pos.y - posY, targetEntity.pos.z - posZ);
          const sigma = (fl.seekerNoiseMrad / 1000) * rng;
          n.x = gauss(projectile) * sigma;
          n.y = gauss(projectile) * sigma;
          n.z = gauss(projectile) * sigma;
        }
        _noisyTarget.x = targetEntity.pos.x + n.x;
        _noisyTarget.y = targetEntity.pos.y + n.y;
        _noisyTarget.z = targetEntity.pos.z + n.z;
        tPos = _noisyTarget;
      }
      // Loft: climb towards a point above the target while far out (thin air carries further).
      if (fl.loftRad && projectile.guidance === ProjectileGuidanceMode.RadarDatalink) {
        const togo = Math.hypot(tPos.x - posX, tPos.z - posZ);
        const fade = Math.max(0, Math.min(1, (togo - 18000) / 20000));
        if (fade > 0) {
          _loftTarget.x = tPos.x;
          _loftTarget.y = tPos.y + Math.min(togo * Math.tan(fl.loftRad), 22000) * fade;
          _loftTarget.z = tPos.z;
          tPos = _loftTarget;
        }
      }
    }
    const gain = prof.pnGain;
    // Available g: the airframe's limit, or what the wings can make at this dynamic pressure.
    let maxAccel = prof.maxG * env.gravityMps2;
    if (fl) maxAccel = Math.min(maxAccel, (fl.clMax * q * fl.liftAreaM2) / mass);

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
      if (pointGuided) {
        // Guided bombs fly against gravity: the wings hold 1 g of lift on top of the steering
        // command (within what they can make), so the bomb glides instead of sinking under it.
        _pnAccel.y += env.gravityMps2;
        const m = Math.hypot(_pnAccel.x, _pnAccel.y, _pnAccel.z);
        if (m > maxAccel) {
          const k = maxAccel / m;
          _pnAccel.x *= k;
          _pnAccel.y *= k;
          _pnAccel.z *= k;
        }
      }
      if (fl && projectile.accelLat) {
        // Autopilot/airframe lag, then induced drag for the lift being pulled.
        const a = projectile.accelLat;
        const k = Math.min(1, dtSec / Math.max(1e-3, fl.autopilotTauSec));
        a.x += (_pnAccel.x - a.x) * k;
        a.y += (_pnAccel.y - a.y) * k;
        a.z += (_pnAccel.z - a.z) * k;
        accelX += a.x; accelY += a.y; accelZ += a.z;
        const aLat2 = a.x * a.x + a.y * a.y + a.z * a.z;
        if (speed > 1e-6 && q > 1) {
          const induced = (fl.inducedDragK * mass * aLat2) / (q * fl.liftAreaM2);
          accelX -= (velX / speed) * induced;
          accelY -= (velY / speed) * induced;
          accelZ -= (velZ / speed) * induced;
        }
      } else {
        accelX += _pnAccel.x; accelY += _pnAccel.y; accelZ += _pnAccel.z;
      }
    }
  } else {
    projectile.gSaturatedSec = 0;
    if (projectile.accelLat) { projectile.accelLat.x = 0; projectile.accelLat.y = 0; projectile.accelLat.z = 0; }
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

    // Fuze reliability (realism profiles): a dud passes through harmlessly.
    const lethality = kind !== ProjectileKind.Bullet ? prof.lethality : undefined;
    if (bestHit && lethality && rand01(projectile) > lethality.fuzeReliability) {
      out.pos.x = newPosX; out.pos.y = newPosY; out.pos.z = newPosZ;
      out.alive = false;
      return { outcome: ProjectileOutcome.Expired, missDistanceM: NaN };
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

    // Proximity fuzes: air-to-air missiles only (bombs and rockets fuze on impact).
    if (kind === ProjectileKind.IrMissile || kind === ProjectileKind.RadarMissile) {
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
      if (bestProx && lethality && rand01(projectile) > lethality.fuzeReliability) {
        out.pos.x = newPosX; out.pos.y = newPosY; out.pos.z = newPosZ;
        out.alive = false;
        return { outcome: ProjectileOutcome.Expired, missDistanceM: NaN };
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
