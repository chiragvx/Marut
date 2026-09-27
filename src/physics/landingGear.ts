/**
 * src/physics/landingGear.ts — per-leg spring-damper ground contact, tyre
 * rolling/lateral friction, braking, nose-wheel steering, weight-on-wheels.
 * See docs/spec/02-flight-model.md section 4.8.
 *
 * Allocation-free: all scratch Vec3s are module-level, reused every call.
 */
import type { EntityState, PilotInputs, Vec3Like, QuatLike } from '../contracts/core';
import type { GearDefinition } from '../contracts/aircraft';
import type { Environment } from '../contracts/flight';
import {
  GEAR_CONTACT_GEARPOS_THRESHOLD,
  ROLLING_RESISTANCE_COEFFICIENT,
  GEAR_HARD_STOP_STIFFNESS_MULTIPLIER,
  GEAR_LATERAL_STIFFNESS_N_PER_MPS,
  TYRE_LATERAL_FRICTION_COEFFICIENT,
  NWS_FULL_AUTHORITY_BELOW_MPS,
  NWS_MIN_AUTHORITY_ABOVE_MPS,
  NWS_MIN_AUTHORITY_FRAC,
} from '../contracts/flight';
import { Vec3, Quat, clamp, lerp, sign, rateLimitStep, clamp01 } from '../math';

/** Gear fully transitions (0<->1) in 2 s. */
const GEAR_TRAVEL_RATE_PER_SEC = 0.5;

export interface GearLegOutput {
  legForceWorld: Vec3Like;
  legMomentBody: Vec3Like;
  onGround: boolean;
}

const scratchWheelWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchOmegaCrossPos: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchPointVelExtra: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchPointVelWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchFwdWorld: Vec3Like = { x: 1, y: 0, z: 0 };
const scratchRollDirWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchLateralDirWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchSlideVelWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchFrictionForceWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchNormalForceWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchMomentArmWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchMomentWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const BODY_FORWARD: Readonly<Vec3Like> = { x: 1, y: 0, z: 0 };

/** Rotates `v` (a ground-plane, y=0 vector) about world +Y by `angleRad`, per 00-architecture.md's heading convention. Safe when `out` aliases `v`. */
function rotateAroundWorldY(v: Readonly<Vec3Like>, angleRad: number, out: Vec3Like): Vec3Like {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const x = v.x;
  const z = v.z;
  out.x = x * c - z * s;
  out.y = v.y;
  out.z = x * s + z * c;
  return out;
}

/** Nosewheel steering authority (0..1 of the full angle) at a ground speed, m/s. */
export function nwsAuthority(groundSpeedMps: number): number {
  const t = clamp((groundSpeedMps - NWS_FULL_AUTHORITY_BELOW_MPS) / (NWS_MIN_AUTHORITY_ABOVE_MPS - NWS_FULL_AUTHORITY_BELOW_MPS), 0, 1);
  return 1 - t * (1 - NWS_MIN_AUTHORITY_FRAC);
}

/**
 * Computes one gear leg's contact force/moment this substep (4.8). Writes
 * `result.legForceWorld`/`legMomentBody` (zeroed when the leg has no
 * contact) and `result.onGround`. Allocation-free.
 */
export function computeGearLeg(
  state: Pick<EntityState, 'pos' | 'rot' | 'vel' | 'omega' | 'gearPos'>,
  legDef: GearDefinition,
  inputs: PilotInputs,
  env: Environment,
  result: GearLegOutput
): void {
  if (state.gearPos < GEAR_CONTACT_GEARPOS_THRESHOLD) {
    Vec3.set(result.legForceWorld, 0, 0, 0);
    Vec3.set(result.legMomentBody, 0, 0, 0);
    result.onGround = false;
    return;
  }

  const rot: Readonly<QuatLike> = state.rot;
  Quat.rotate(rot, legDef.posBodyM, scratchWheelWorld);
  Vec3.add(state.pos, scratchWheelWorld, scratchWheelWorld);
  const penetrationM = env.groundElevationM - scratchWheelWorld.y;
  if (penetrationM <= 0) {
    Vec3.set(result.legForceWorld, 0, 0, 0);
    Vec3.set(result.legMomentBody, 0, 0, 0);
    result.onGround = false;
    return;
  }

  const compressionM = Math.min(penetrationM, legDef.maxCompressionM);
  const overtravelM = Math.max(0, penetrationM - legDef.maxCompressionM);

  Vec3.cross(state.omega, legDef.posBodyM, scratchOmegaCrossPos);
  Quat.rotate(rot, scratchOmegaCrossPos, scratchPointVelExtra);
  Vec3.add(state.vel, scratchPointVelExtra, scratchPointVelWorld);
  const compressionRateMps = -scratchPointVelWorld.y;

  const springForce = legDef.springNPerM * compressionM + legDef.springNPerM * GEAR_HARD_STOP_STIFFNESS_MULTIPLIER * overtravelM;
  const damperForce = legDef.damperNPerMPerS * compressionRateMps;
  const normalForceMag = Math.max(0, springForce + damperForce);
  scratchNormalForceWorld.x = 0;
  scratchNormalForceWorld.y = normalForceMag;
  scratchNormalForceWorld.z = 0;

  Quat.rotate(rot, BODY_FORWARD, scratchFwdWorld);
  Vec3.set(scratchRollDirWorld, scratchFwdWorld.x, 0, scratchFwdWorld.z);
  Vec3.normalize(scratchRollDirWorld, scratchRollDirWorld);
  if (legDef.steerable && inputs.nwsEnabled) {
    const steerRad = inputs.yaw * legDef.maxSteerAngleRad * nwsAuthority(Math.hypot(scratchPointVelWorld.x, scratchPointVelWorld.z));
    rotateAroundWorldY(scratchRollDirWorld, steerRad, scratchRollDirWorld);
  }
  scratchLateralDirWorld.x = scratchRollDirWorld.z;
  scratchLateralDirWorld.y = 0;
  scratchLateralDirWorld.z = -scratchRollDirWorld.x;

  Vec3.set(scratchSlideVelWorld, scratchPointVelWorld.x, 0, scratchPointVelWorld.z);
  const vRoll = Vec3.dot(scratchSlideVelWorld, scratchRollDirWorld);
  const vLat = Vec3.dot(scratchSlideVelWorld, scratchLateralDirWorld);

  const longCoef = legDef.brakeCapable ? lerp(ROLLING_RESISTANCE_COEFFICIENT, legDef.kineticFrictionCoefficient, inputs.brakes) : ROLLING_RESISTANCE_COEFFICIENT;
  const Flong = Math.abs(vRoll) < 1e-4 ? 0 : -sign(vRoll) * longCoef * normalForceMag;
  const latLimit = TYRE_LATERAL_FRICTION_COEFFICIENT * normalForceMag;
  const Flat = -clamp(vLat * GEAR_LATERAL_STIFFNESS_N_PER_MPS, -latLimit, latLimit);

  Vec3.scale(scratchRollDirWorld, Flong, scratchFrictionForceWorld);
  Vec3.addScaled(scratchFrictionForceWorld, scratchLateralDirWorld, Flat, scratchFrictionForceWorld);

  Vec3.add(scratchNormalForceWorld, scratchFrictionForceWorld, result.legForceWorld);

  Vec3.sub(scratchWheelWorld, state.pos, scratchMomentArmWorld);
  Vec3.cross(scratchMomentArmWorld, result.legForceWorld, scratchMomentWorld);
  Quat.rotateInverse(rot, scratchMomentWorld, result.legMomentBody);

  result.onGround = normalForceMag > 0;
}

/**
 * Moves `out.gearPos` toward `inputs.gearDown ? 1 : 0` at a fixed rate,
 * EXCEPT `damage.gearHealthPct <= 0` forces it toward 0 regardless of
 * `inputs.gearDown` (4.8).
 */
export function stepGearPos(out: EntityState, inputs: PilotInputs, gearHealthPct: number, dtSub: number): void {
  const target = gearHealthPct <= 0 ? 0 : inputs.gearDown ? 1 : 0;
  out.gearPos = clamp01(rateLimitStep(out.gearPos, target, GEAR_TRAVEL_RATE_PER_SEC, dtSub));
}
