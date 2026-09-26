/**
 * src/ai/tacticalFsm.ts — tactical FSM transition rules (section 4.7) and
 * the EngageBvr/Merge/Disengage goal builders (sections 4.12a-c).
 *
 * CONTRACT NOTE: `EvaluateTacticalTransition` (contracts/ai.ts) does not
 * carry `homeAirportId`/`homeRunwayId`, which rule 5 (Rtb -> Land) needs to
 * call `resolveHomeRunway`. As with this module's other contract-signature
 * gaps (see threatEvaluation.ts/terrainAvoidance.ts notes), two further
 * OPTIONAL trailing parameters are added; `pilotAi.ts` always supplies them
 * from its own `AiPilotSpawnParams`. Reaction delay (`missileWarningNoticed`
 * aside) is applied by `pilotAi.ts` handing this function a `ctx` whose
 * `.contacts` is already the perception-delay-filtered list (see
 * `pilotAi.ts`'s `filterPerceived`), not necessarily the raw
 * `PilotContext.contacts` a caller elsewhere might pass.
 */
import type { Contact, PilotContext } from '../contracts/core';
import type { AiDifficultyProfile, EvaluateTacticalTransition, FlightGoal } from '../contracts/ai';
import { aiRadarMaxRangeM } from './weaponEmployment';
import { AiWeaponEnvelope, BfmThresholds, ControlGains, PitchMode, TacticalState } from '../contracts/ai';
import { clamp } from '../math';
import { computeAspectAngleRad, headingFromVelocity } from './formation';
import { nearestCandidateRangeM, pickBestCandidate } from './threatEvaluation';
import { resolveHomeRunway, LOCALISER_CAPTURE_RANGE_M, rangeToThresholdM } from './landing';

const NON_RTB_LAND_DISENGAGE_STATES: ReadonlySet<string> = new Set<string>([
  TacticalState.Patrol,
  TacticalState.Intercept,
  TacticalState.Bfm,
  TacticalState.Defensive,
  TacticalState.Merge,
  TacticalState.EngageBvr,
]);

// NOTE: exported WITHOUT a `: EvaluateTacticalTransition` annotation on the
// const — see threatEvaluation.ts's identical note on `scoreThreatContact`.
// `_evaluateTacticalTransitionSatisfiesContract` below is the checked proof
// of contract compliance.
function evaluateTacticalTransitionImpl(
  ctx: PilotContext,
  current: TacticalState,
  timeInStateSec: number,
  difficulty: Readonly<AiDifficultyProfile>,
  _formationLeaderAlive: boolean,
  missileWarningNoticed: boolean,
  homeAirportId?: string,
  homeRunwayId?: string
): TacticalState {
  // Rule 1 (no dwell).
  if (missileWarningNoticed === true) return TacticalState.Defensive;

  // Rule 2 (no dwell).
  if (NON_RTB_LAND_DISENGAGE_STATES.has(current)) {
    const noAmmo = ctx.combat.ammoGun === 0 && ctx.combat.missilesIr === 0 && ctx.combat.missilesRadar === 0;
    if (ctx.telemetry.fuelFrac < BfmThresholds.DISENGAGE_FUEL_FRAC || noAmmo) return TacticalState.Disengage;
  }

  // Rule 3 (no dwell) / Rule 6.
  if (current === TacticalState.Land) {
    const nearest = nearestCandidateRangeM(ctx.contacts, ctx, difficulty);
    if (nearest < BfmThresholds.LAND_ABORT_THREAT_RANGE_M) return TacticalState.Defensive;
    return TacticalState.Land;
  }

  if (timeInStateSec < BfmThresholds.MIN_STATE_DWELL_SEC) return current;

  // Rule 4.
  if (current === TacticalState.Disengage) {
    const nearest = nearestCandidateRangeM(ctx.contacts, ctx, difficulty);
    if (!(nearest < BfmThresholds.DISENGAGE_SAFE_RANGE_M)) return TacticalState.Rtb;
    return current;
  }

  // Rule 5.
  if (current === TacticalState.Rtb) {
    const runway = resolveHomeRunway(ctx, homeAirportId, homeRunwayId);
    if (runway !== undefined && rangeToThresholdM(ctx, runway) < LOCALISER_CAPTURE_RANGE_M) return TacticalState.Land;
    return current;
  }

  const best = pickBestCandidate(ctx.contacts, ctx, difficulty);

  // Rule 7.
  if (best === undefined) return TacticalState.Patrol;

  // Rule 8.
  if (
    best.rangeM <= aiRadarMaxRangeM(ctx.combat) &&
    ctx.combat.lockState === AiWeaponEnvelope.RADAR_REQUIRED_LOCK &&
    ctx.combat.missilesRadar > 0
  ) {
    return TacticalState.EngageBvr;
  }

  // Rule 9.
  if (best.rangeM > BfmThresholds.ENGAGE_BVR_MIN_RANGE_M) return TacticalState.Intercept;

  // Rule 10.
  if (best.rangeM > BfmThresholds.VISUAL_MANOEUVRE_RANGE_M) return TacticalState.Merge;

  // Rule 11.
  const bestHeadingRad = headingFromVelocity(best.vel);
  const aspectAngleRad = computeAspectAngleRad(bestHeadingRad, best.pos, ctx.self.pos);
  const threatFromAspect = 1 - Math.abs(aspectAngleRad) / Math.PI;
  if (threatFromAspect >= 0.5) return TacticalState.Defensive;

  // Rule 12.
  return TacticalState.Bfm;
}
export const evaluateTacticalTransition = evaluateTacticalTransitionImpl;
const _evaluateTacticalTransitionSatisfiesContract: EvaluateTacticalTransition = evaluateTacticalTransitionImpl;

function bankFromBearing(bearingRad: number): number {
  return clamp(ControlGains.HEADING_TO_BANK_KP * bearingRad, -ControlGains.MAX_MANOEUVRE_BANK_RAD, ControlGains.MAX_MANOEUVRE_BANK_RAD);
}

/** 06-ai.md section 4.12a. */
export function buildGoalForEngageBvr(ctx: PilotContext, target: Readonly<Contact>, out: FlightGoal): FlightGoal {
  out.pitchMode = PitchMode.AltitudeHold;
  out.desiredAltitudeM = clamp(target.pos.y, ctx.telemetry.altMslM - 1000, ctx.telemetry.altMslM + 1000);
  out.desiredBankRad = bankFromBearing(target.bearingRad);
  out.desiredGLoad = 1;
  out.desiredSpeedMps = 220;
  out.throttleOverride = undefined;
  out.afterburnerOverride = false;
  out.gearDown = false;
  out.airbrake = false;
  return out;
}

/** 06-ai.md section 4.12b. */
export function buildGoalForMerge(ctx: PilotContext, target: Readonly<Contact>, out: FlightGoal): FlightGoal {
  out.pitchMode = PitchMode.AltitudeHold;
  out.desiredAltitudeM = clamp(target.pos.y, ctx.telemetry.altMslM - 500, ctx.telemetry.altMslM + 500);
  out.desiredBankRad = bankFromBearing(target.bearingRad);
  out.desiredGLoad = 1;
  out.desiredSpeedMps = 280;
  out.throttleOverride = undefined;
  out.afterburnerOverride = false;
  out.gearDown = false;
  out.airbrake = false;
  return out;
}

/** 06-ai.md section 4.12c. `target` is the nearest identified-hostile candidate (section 4.5), or undefined if none. */
export function buildGoalForDisengage(ctx: PilotContext, target: Readonly<Contact> | undefined, out: FlightGoal): FlightGoal {
  out.pitchMode = PitchMode.GLoad;
  out.desiredGLoad = 1.0;
  out.desiredBankRad = target !== undefined ? Math.sign(target.bearingRad || 1) * BfmThresholds.DISENGAGE_BANK_RAD : 0;
  out.desiredAltitudeM = ctx.telemetry.altMslM;
  out.desiredSpeedMps = ctx.telemetry.iasMps;
  out.throttleOverride = 1.0;
  out.afterburnerOverride = true;
  out.gearDown = false;
  out.airbrake = false;
  return out;
}

export type { AiDifficultyProfile };
