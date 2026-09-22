/**
 * src/ai/bfmManoeuvres.ts — basic fighter manoeuvre library: selection
 * (with hysteresis) and per-manoeuvre FlightGoal construction. See
 * docs/spec/06-ai.md section 4.8.
 *
 * CONTRACT NOTE: `BuildBfmGoal` is typed as `(ctx, target, manoeuvre,
 * difficulty, out) => FlightGoal`, but `Jink` needs a PRNG stream, the
 * current `timeInManoeuvreSec` (to know when to redraw) and a place to
 * persist the last-drawn bank/g between redraws (06-ai.md section 4.8's
 * `Jink` bullet). None of those fit the fixed 5-parameter signature, and a
 * module-level singleton would corrupt state across multiple concurrently
 * Jinking AI aircraft. Three further parameters are therefore added, all
 * OPTIONAL (still structurally assignable to `BuildBfmGoal`):
 * `rng`, `timeInManoeuvreSec`, and a per-pilot-owned `JinkState` (see
 * `createJinkState`). `pilotAi.ts` always passes its own instances of all
 * three. When they are omitted (a bare `BuildBfmGoal`-typed caller), `Jink`
 * falls back to `desiredBankRad = 0, desiredGLoad = 1` (wings-level,
 * non-random) rather than throwing.
 */
import type { Contact, PilotContext } from '../contracts/core';
import type { AiDifficultyProfile, BuildBfmGoal, FlightGoal, SelectBfmManoeuvre, TacticalState } from '../contracts/ai';
import { BfmManoeuvre, BfmThresholds, ControlGains, PitchMode, TacticalState as TacticalStateValues } from '../contracts/ai';
import { clamp, degToRad, type PrngState } from '../math';
import { nextRange } from '../math';
import { computeAspectAngleRad, headingFromVelocity } from './formation';
import { computeEnergyHeightM } from './energyState';

export interface JinkState {
  periodIndex: number;
  bankRad: number;
  gLoad: number;
}
export function createJinkState(): JinkState {
  return { periodIndex: -1, bankRad: 0, gLoad: 1 };
}

function signOrPositive(x: number): number {
  return Math.sign(x || 1);
}

export const selectBfmManoeuvre: SelectBfmManoeuvre = (
  ctx: PilotContext,
  target: Readonly<Contact>,
  state: TacticalState,
  difficulty: Readonly<AiDifficultyProfile>,
  previous: BfmManoeuvre | undefined,
  timeInManoeuvreSec: number
): BfmManoeuvre => {
  const mult = difficulty.bfmSkillMultiplier;
  const angleOffRad = Math.abs(target.bearingRad);

  let natural: BfmManoeuvre;

  if (state === TacticalStateValues.Bfm) {
    const selfEnergyHeightM = computeEnergyHeightM(ctx.telemetry.altMslM, ctx.telemetry.tasMps);
    const targetSpeedMps = Math.hypot(target.vel.x, target.vel.y, target.vel.z);
    const targetEnergyHeightM = computeEnergyHeightM(target.pos.y, targetSpeedMps);
    const energyDeficitM = targetEnergyHeightM - selfEnergyHeightM;

    if (
      angleOffRad > degToRad(BfmThresholds.HIGH_YOYO_MIN_ANGLE_OFF_DEG * mult) &&
      target.rangeM < BfmThresholds.HIGH_YOYO_MAX_RANGE_M * mult &&
      target.closureMps > 0
    ) {
      natural = BfmManoeuvre.HighYoYo;
    } else if (
      angleOffRad <= degToRad(BfmThresholds.LOW_YOYO_MAX_ANGLE_OFF_DEG * mult) &&
      energyDeficitM >= BfmThresholds.LOW_YOYO_MIN_ENERGY_DEFICIT_M * mult &&
      target.rangeM <= BfmThresholds.LOW_YOYO_MAX_RANGE_M * mult
    ) {
      natural = BfmManoeuvre.LowYoYo;
    } else if (target.rangeM < BfmThresholds.LAG_PURSUIT_MAX_RANGE_M * mult) {
      natural = BfmManoeuvre.LagPursuit;
    } else if (angleOffRad > degToRad(BfmThresholds.LEAD_PURSUIT_MIN_ANGLE_OFF_DEG * mult)) {
      natural = BfmManoeuvre.LeadPursuit;
    } else {
      natural = BfmManoeuvre.PurePursuit;
    }
  } else {
    // Defensive.
    if (ctx.combat.missileInboundWarning) {
      // Missile-warning Notch is exempt from the dwell gate below and fires immediately.
      return BfmManoeuvre.Notch;
    }
    const selfEnergyHeightM = computeEnergyHeightM(ctx.telemetry.altMslM, ctx.telemetry.tasMps);
    const targetSpeedMps = Math.hypot(target.vel.x, target.vel.y, target.vel.z);
    const targetEnergyHeightM = computeEnergyHeightM(target.pos.y, targetSpeedMps);

    const attackerHeadingRad = headingFromVelocity(target.vel);
    const aspectAngleRad = computeAspectAngleRad(attackerHeadingRad, target.pos, ctx.self.pos);

    if (
      target.rangeM <= BfmThresholds.BREAK_TURN_TRIGGER_RANGE_M * mult &&
      Math.abs(aspectAngleRad) <= degToRad(BfmThresholds.BREAK_TURN_TRIGGER_ANGLE_OFF_DEG * mult)
    ) {
      natural = BfmManoeuvre.BreakTurn;
    } else if (
      selfEnergyHeightM - targetEnergyHeightM > BfmThresholds.EXTENSION_MIN_ENERGY_ADVANTAGE_M * mult &&
      target.rangeM > BfmThresholds.BREAK_TURN_TRIGGER_RANGE_M * mult
    ) {
      natural = BfmManoeuvre.Extension;
    } else if (target.rangeM <= BfmThresholds.JINK_TRIGGER_RANGE_M * mult) {
      natural = BfmManoeuvre.Jink;
    } else {
      natural = BfmManoeuvre.BreakTurn;
    }
  }

  if (previous === undefined) return natural;
  if (natural === previous) return previous;
  if (timeInManoeuvreSec >= BfmThresholds.BFM_MANOEUVRE_MIN_DWELL_SEC) return natural;
  return previous;
};

// NOTE: exported WITHOUT a `: BuildBfmGoal` annotation on the const — see
// threatEvaluation.ts's identical note on `scoreThreatContact`.
// `_buildBfmGoalSatisfiesContract` below is the checked proof of contract
// compliance.
function buildBfmGoalImpl(
  ctx: PilotContext,
  target: Readonly<Contact>,
  manoeuvre: BfmManoeuvre,
  difficulty: Readonly<AiDifficultyProfile>,
  out: FlightGoal,
  rng?: PrngState,
  timeInManoeuvreSec?: number,
  jinkState?: JinkState
): FlightGoal {
  out.pitchMode = PitchMode.GLoad;
  out.desiredAltitudeM = ctx.telemetry.altMslM;
  out.desiredSpeedMps = ctx.telemetry.iasMps;
  out.throttleOverride = undefined;
  out.afterburnerOverride = undefined;
  out.gearDown = false;
  out.airbrake = false;

  const minG = Math.max(1, difficulty.minCommandedGLoad);

  switch (manoeuvre) {
    case BfmManoeuvre.PurePursuit: {
      out.desiredBankRad = clamp(
        ControlGains.HEADING_TO_BANK_KP * target.bearingRad,
        -ControlGains.MAX_MANOEUVRE_BANK_RAD,
        ControlGains.MAX_MANOEUVRE_BANK_RAD
      );
      out.desiredGLoad = clamp(
        BfmThresholds.BASE_PURSUIT_G_LOAD + BfmThresholds.PURSUIT_ELEVATION_G_GAIN * clamp(target.elevationRad, -0.5, 0.5),
        minG,
        difficulty.maxCommandedGLoad
      );
      break;
    }
    case BfmManoeuvre.LeadPursuit: {
      const leadBearingRad = target.bearingRad + signOrPositive(target.bearingRad) * BfmThresholds.LEAD_PURSUIT_OFFSET_RAD;
      out.desiredBankRad = clamp(
        ControlGains.HEADING_TO_BANK_KP * leadBearingRad,
        -ControlGains.MAX_MANOEUVRE_BANK_RAD,
        ControlGains.MAX_MANOEUVRE_BANK_RAD
      );
      out.desiredGLoad = clamp(
        BfmThresholds.BASE_PURSUIT_G_LOAD + BfmThresholds.PURSUIT_ELEVATION_G_GAIN * clamp(target.elevationRad, -0.5, 0.5),
        minG,
        difficulty.maxCommandedGLoad
      );
      break;
    }
    case BfmManoeuvre.LagPursuit: {
      const lagBearingRad = target.bearingRad - signOrPositive(target.bearingRad) * BfmThresholds.LAG_PURSUIT_OFFSET_RAD;
      out.desiredBankRad = clamp(
        ControlGains.HEADING_TO_BANK_KP * lagBearingRad,
        -ControlGains.MAX_MANOEUVRE_BANK_RAD,
        ControlGains.MAX_MANOEUVRE_BANK_RAD
      );
      out.desiredGLoad = clamp(BfmThresholds.BASE_PURSUIT_G_LOAD, minG, difficulty.maxCommandedGLoad);
      break;
    }
    case BfmManoeuvre.HighYoYo: {
      out.desiredBankRad = BfmThresholds.HIGH_YOYO_BANK_SCALE * (ControlGains.HEADING_TO_BANK_KP * target.bearingRad);
      out.desiredGLoad = BfmThresholds.BASE_PURSUIT_G_LOAD * 0.6;
      break;
    }
    case BfmManoeuvre.LowYoYo: {
      out.desiredBankRad = clamp(
        ControlGains.HEADING_TO_BANK_KP * target.bearingRad,
        -ControlGains.MAX_MANOEUVRE_BANK_RAD,
        ControlGains.MAX_MANOEUVRE_BANK_RAD
      );
      out.desiredGLoad = difficulty.maxCommandedGLoad;
      break;
    }
    case BfmManoeuvre.BreakTurn: {
      out.desiredBankRad = signOrPositive(target.bearingRad) * ControlGains.MAX_MANOEUVRE_BANK_RAD;
      out.desiredGLoad = difficulty.maxCommandedGLoad;
      out.throttleOverride = BfmThresholds.BREAK_TURN_THROTTLE;
      break;
    }
    case BfmManoeuvre.Notch: {
      out.desiredBankRad = clamp(
        signOrPositive(target.bearingRad) *
          ControlGains.HEADING_TO_BANK_KP *
          (Math.abs(target.bearingRad) - BfmThresholds.NOTCH_BEAM_OFFSET_RAD),
        -ControlGains.MAX_MANOEUVRE_BANK_RAD,
        ControlGains.MAX_MANOEUVRE_BANK_RAD
      );
      out.desiredGLoad = BfmThresholds.NOTCH_G_LOAD;
      break;
    }
    case BfmManoeuvre.Extension: {
      out.desiredBankRad = 0;
      out.desiredGLoad = 1.0;
      out.throttleOverride = 1.0;
      out.afterburnerOverride = true;
      break;
    }
    case BfmManoeuvre.Jink: {
      if (rng !== undefined && timeInManoeuvreSec !== undefined && jinkState !== undefined) {
        const periodIndex = Math.floor(timeInManoeuvreSec / BfmThresholds.JINK_PERIOD_SEC);
        if (periodIndex !== jinkState.periodIndex) {
          jinkState.periodIndex = periodIndex;
          jinkState.bankRad = nextRange(rng, -BfmThresholds.JINK_MAX_BANK_RAD, BfmThresholds.JINK_MAX_BANK_RAD);
          jinkState.gLoad = nextRange(rng, difficulty.minCommandedGLoad, difficulty.maxCommandedGLoad);
        }
        out.desiredBankRad = jinkState.bankRad;
        out.desiredGLoad = jinkState.gLoad;
      } else {
        out.desiredBankRad = 0;
        out.desiredGLoad = 1;
      }
      out.throttleOverride = 1.0;
      break;
    }
    default: {
      out.desiredBankRad = 0;
      out.desiredGLoad = 1;
    }
  }

  return out;
}
export const buildBfmGoal = buildBfmGoalImpl;
const _buildBfmGoalSatisfiesContract: BuildBfmGoal = buildBfmGoalImpl;
