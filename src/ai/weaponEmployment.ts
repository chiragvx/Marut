/**
 * src/ai/weaponEmployment.ts — weapon envelope estimation and
 * trigger/launch/cycleWeapon decision logic (decision only — src/ai never
 * fires a weapon itself). See docs/spec/06-ai.md section 4.9.
 */
import type { Contact, EntityId, PilotContext, PilotInputs, WeaponKind } from '../contracts/core';
import { WeaponKind as WeaponKindValues } from '../contracts/core';
import type { AiDifficultyProfile, EstimateWeaponEnvelope, WeaponEnvelopeEstimate } from '../contracts/ai';
import { AiWeaponEnvelope } from '../contracts/ai';
import { degToRad, wrapAngleSigned, type PrngState } from '../math';
import { nextFloat01 } from '../math';
import { headingOfDelta, nextGaussian, type GaussianCache } from './formation';

// Pooled, module-owned scratch estimates, one per weapon kind so estimates
// for different weapons can be held/compared simultaneously within one tick
// without one call's result clobbering another's.
const scratchEstimates: Record<WeaponKind, WeaponEnvelopeEstimate> = {
  gun: { weapon: WeaponKindValues.Gun, inEnvelope: false, quality: 0 },
  ir_missile: { weapon: WeaponKindValues.IrMissile, inEnvelope: false, quality: 0 },
  radar_missile: { weapon: WeaponKindValues.RadarMissile, inEnvelope: false, quality: 0 },
};

const scratchLeadPoint = { x: 0, y: 0, z: 0 };

export const estimateWeaponEnvelope: EstimateWeaponEnvelope = (
  ctx: PilotContext,
  weapon: WeaponKind,
  target: Readonly<Contact>
): WeaponEnvelopeEstimate => {
  const est = scratchEstimates[weapon];
  est.weapon = weapon;

  if (weapon === WeaponKindValues.Gun) {
    const timeOfFlightSec = target.rangeM / AiWeaponEnvelope.GUN_ASSUMED_MUZZLE_VEL_MPS;
    scratchLeadPoint.x = target.pos.x + target.vel.x * timeOfFlightSec;
    scratchLeadPoint.y = target.pos.y + target.vel.y * timeOfFlightSec;
    scratchLeadPoint.z = target.pos.z + target.vel.z * timeOfFlightSec;
    const dx = scratchLeadPoint.x - ctx.self.pos.x;
    const dz = scratchLeadPoint.z - ctx.self.pos.z;
    const leadBearingRad = wrapAngleSigned(headingOfDelta(dx, dz) - ctx.telemetry.headingRad);
    const maxAngleOffRad = degToRad(AiWeaponEnvelope.GUN_MAX_ANGLE_OFF_DEG);
    const inEnvelope =
      target.rangeM >= AiWeaponEnvelope.GUN_MIN_RANGE_M &&
      target.rangeM <= AiWeaponEnvelope.GUN_MAX_RANGE_M &&
      Math.abs(leadBearingRad) <= maxAngleOffRad;
    est.inEnvelope = inEnvelope;
    est.quality = inEnvelope ? 1 - Math.abs(leadBearingRad) / maxAngleOffRad : 0;
    return est;
  }

  if (weapon === WeaponKindValues.IrMissile) {
    const maxOffRad = degToRad(AiWeaponEnvelope.IR_MAX_OFF_BORESIGHT_DEG);
    const inEnvelope =
      target.rangeM >= AiWeaponEnvelope.IR_MIN_RANGE_M &&
      target.rangeM <= AiWeaponEnvelope.IR_MAX_RANGE_M &&
      Math.abs(target.bearingRad) <= maxOffRad;
    est.inEnvelope = inEnvelope;
    est.quality = inEnvelope ? 1 - Math.abs(target.bearingRad) / maxOffRad : 0;
    return est;
  }

  // radar_missile
  const inEnvelope =
    target.rangeM >= AiWeaponEnvelope.RADAR_MIN_RANGE_M &&
    target.rangeM <= AiWeaponEnvelope.RADAR_MAX_RANGE_M &&
    ctx.combat.lockState === AiWeaponEnvelope.RADAR_REQUIRED_LOCK;
  est.inEnvelope = inEnvelope;
  est.quality = inEnvelope ? 1 : 0;
  return est;
};

export interface WeaponEmploymentState {
  lastLaunchSimTimeSec: number;
  lastLaunchTargetId: EntityId | undefined;
  gunGaussianCache: GaussianCache;
  cycleWindowIndex: number;
}

export function createWeaponEmploymentState(): WeaponEmploymentState {
  return {
    lastLaunchSimTimeSec: -1e9,
    lastLaunchTargetId: undefined,
    gunGaussianCache: { value: undefined },
    cycleWindowIndex: -1,
  };
}

function ammoForWeapon(ctx: PilotContext, weapon: WeaponKind): number {
  if (weapon === WeaponKindValues.Gun) return ctx.combat.ammoGun;
  if (weapon === WeaponKindValues.IrMissile) return ctx.combat.missilesIr;
  return ctx.combat.missilesRadar;
}

const WEAPON_PREFERENCE_ORDER: readonly WeaponKind[] = [
  WeaponKindValues.RadarMissile,
  WeaponKindValues.IrMissile,
  WeaponKindValues.Gun,
];
const CYCLE_WINDOW_SEC = 1.5; // reuses BfmThresholds.MIN_STATE_DWELL_SEC's magnitude, per 06-ai.md 4.9

/**
 * Fills `out.trigger`/`out.launch`/`out.cycleWeapon` for one tick.
 * `out.cycleTarget` is NOT touched here — pilotAi.ts sets that directly by
 * comparing this tick's selected target id to last tick's (06-ai.md 4.9's
 * last paragraph), since that is orchestration state pilotAi.ts already
 * owns.
 */
export function decideWeaponEmployment(
  ctx: PilotContext,
  target: Readonly<Contact> | undefined,
  difficulty: Readonly<AiDifficultyProfile>,
  timeInStateSec: number,
  dtSec: number,
  state: WeaponEmploymentState,
  rng: PrngState,
  out: PilotInputs
): void {
  if (target === undefined) {
    out.trigger = false;
    out.launch = false;
    out.cycleWeapon = false;
    return;
  }

  const weapon = ctx.combat.selectedWeapon;

  // Weapon selection: at most once per CYCLE_WINDOW_SEC-sized window.
  const windowIndex = Math.floor(timeInStateSec / CYCLE_WINDOW_SEC);
  const windowCrossed = windowIndex !== state.cycleWindowIndex;
  let cycleWeapon = false;
  if (windowCrossed) {
    state.cycleWindowIndex = windowIndex;
    let bestWeapon: WeaponKind | undefined;
    for (let i = 0; i < WEAPON_PREFERENCE_ORDER.length; i++) {
      const w = WEAPON_PREFERENCE_ORDER[i];
      if (w === undefined) continue;
      if (estimateWeaponEnvelope(ctx, w, target).inEnvelope) {
        bestWeapon = w;
        break;
      }
    }
    cycleWeapon = bestWeapon !== undefined && bestWeapon !== weapon;
  }
  out.cycleWeapon = cycleWeapon;

  // Firing (gun only).
  if (weapon === WeaponKindValues.Gun) {
    const gunEnvelope = estimateWeaponEnvelope(ctx, WeaponKindValues.Gun, target);
    const aimErrorDeg = nextGaussian(rng, state.gunGaussianCache, nextFloat01) * difficulty.gunAccuracyErrorStdDeg;
    out.trigger =
      gunEnvelope.inEnvelope && ctx.combat.ammoGun > 0 && aimErrorDeg <= AiWeaponEnvelope.GUN_MAX_ANGLE_OFF_DEG;
  } else {
    out.trigger = false;
  }

  // Launching (missiles only).
  if (weapon === WeaponKindValues.Gun) {
    out.launch = false;
    return;
  }
  const envelope = estimateWeaponEnvelope(ctx, weapon, target);
  const missilesInFlightAtTarget =
    state.lastLaunchTargetId === target.id && ctx.simTimeSec - state.lastLaunchSimTimeSec < AiWeaponEnvelope.LAUNCH_COOLDOWN_SEC
      ? 1
      : 0;
  const cooldownElapsed = ctx.simTimeSec - state.lastLaunchSimTimeSec >= AiWeaponEnvelope.LAUNCH_COOLDOWN_SEC;
  const shouldLaunch =
    envelope.inEnvelope &&
    ammoForWeapon(ctx, weapon) > 0 &&
    missilesInFlightAtTarget < difficulty.maxSimultaneousMissilesPerTarget &&
    cooldownElapsed;
  out.launch = shouldLaunch;
  if (shouldLaunch) {
    state.lastLaunchSimTimeSec = ctx.simTimeSec;
    state.lastLaunchTargetId = target.id;
  }
}
