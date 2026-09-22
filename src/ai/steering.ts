/**
 * src/ai/steering.ts — the control layer: converts a FlightGoal into
 * PilotInputs every tick via independent PD/PI loops. See docs/spec/06-ai.md
 * sections 4.2-4.3.
 *
 * CONTRACT NOTE: `SteerToGoal` (contracts/ai.ts) is typed as a stateless
 * `(ctx, goal, dtSec, out) => void`, but section 4.3's speed-hold loop needs
 * a persistent integral term across ticks. This module resolves that by
 * exporting a FACTORY, `createSteerToGoal()`, which returns a closure of
 * type `SteerToGoal` holding its own private `speedIntegral` (allocated once
 * per AiPilot at construction, per `CreateAiPilot`'s "never allocates on
 * subsequent update() calls" rule) — never a module-level singleton, so
 * multiple concurrently-simulated AI aircraft never share one integral.
 */
import type { PilotContext, PilotInputs } from '../contracts/core';
import { EntityFlag } from '../contracts/core';
import type { FlightGoal, SteerToGoal } from '../contracts/ai';
import { PitchMode, ControlGains } from '../contracts/ai';
import { clamp, wrapAngleSigned, bodyRateP, bodyRateQ } from '../math';

export function createSteerToGoal(): SteerToGoal {
  let speedIntegral = 0;

  return (ctx: PilotContext, goal: Readonly<FlightGoal>, dtSec: number, out: PilotInputs): void => {
    const telemetry = ctx.telemetry;
    const omega = ctx.self.omega;
    const p = bodyRateP(omega);
    const q = bodyRateQ(omega);

    // Bank (roll).
    const bankErrorRad = wrapAngleSigned(goal.desiredBankRad - telemetry.rollRad);
    out.roll = clamp(ControlGains.BANK_KP * bankErrorRad - ControlGains.BANK_RATE_KD * p, -1, 1);

    // Pitch.
    if (goal.pitchMode === PitchMode.GLoad) {
      const effectiveG = telemetry.stalled ? Math.min(goal.desiredGLoad, 1.0) : goal.desiredGLoad;
      const gErrorG = effectiveG - telemetry.gLoad;
      out.pitch = clamp(ControlGains.G_KP * gErrorG - ControlGains.G_RATE_KD * q, -1, 1);
    } else {
      const altErrorM = goal.desiredAltitudeM - telemetry.altMslM;
      const targetFpaRad = clamp(
        ControlGains.ALT_TO_FPA_KP * altErrorM,
        -ControlGains.MAX_ALT_HOLD_FPA_RAD,
        ControlGains.MAX_ALT_HOLD_FPA_RAD
      );
      const currentFpaRad = telemetry.pitchRad - telemetry.alphaRad;
      const fpaErrorRad = targetFpaRad - currentFpaRad;
      out.pitch = clamp(ControlGains.FPA_KP * fpaErrorRad - ControlGains.FPA_RATE_KD * q, -1, 1);
    }

    // Yaw (sideslip coordination).
    out.yaw = clamp(ControlGains.YAW_BETA_KP * telemetry.betaRad, -1, 1);

    // Gear / airbrake / brakes.
    out.gearDown = goal.gearDown;
    out.airbrake = goal.airbrake;
    const onGround = (ctx.self.flags & EntityFlag.OnGround) !== 0;
    out.brakes = onGround ? (goal.desiredSpeedMps < 5 ? 1 : 0) : 0;

    // Speed hold / throttle.
    if (goal.throttleOverride !== undefined) {
      out.throttle = clamp(goal.throttleOverride, 0, 1);
      speedIntegral = 0;
    } else {
      const speedErrorMps = goal.desiredSpeedMps - telemetry.iasMps;
      speedIntegral += speedErrorMps * dtSec;
      const iTerm = clamp(
        ControlGains.SPEED_KI * speedIntegral,
        -ControlGains.SPEED_INTEGRAL_CLAMP,
        ControlGains.SPEED_INTEGRAL_CLAMP
      );
      out.throttle = clamp(
        ControlGains.SPEED_THROTTLE_BIAS + ControlGains.SPEED_KP * speedErrorMps + iTerm,
        0,
        1
      );
    }
    out.afterburner =
      goal.afterburnerOverride === true ||
      (out.throttle >= 0.999 &&
        goal.desiredSpeedMps - telemetry.iasMps > ControlGains.AB_ENGAGE_SPEED_DEFICIT_MPS);
  };
}
