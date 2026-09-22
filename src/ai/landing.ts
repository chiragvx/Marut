/**
 * src/ai/landing.ts — ILS-following approach/landing FlightGoal builder, and
 * `resolveHomeRunway` (shared with `tacticalFsm.ts`'s rule 5). See
 * docs/spec/06-ai.md section 4.11.
 */
import type { PilotContext, RunwayInfo } from '../contracts/core';
import { EntityFlag, ILS_DEFAULT_GLIDESLOPE_RAD } from '../contracts/core';
import type { FlightGoal } from '../contracts/ai';
import { ControlGains, PitchMode } from '../contracts/ai';
import { clamp, lerp, wrapAngleSigned } from '../math';

/** Local to this file per 06-ai.md section 5.8 (not exported from the contract). */
export const LOCALISER_CAPTURE_RANGE_M = 18000;
export const GLIDESLOPE_CAPTURE_RANGE_M = 12000;
export const FINAL_APPROACH_SPEED_MPS = 70;
export const PERP_CORRECTION_KP = 0.0006;
const MAX_PERP_CORRECTION_RAD = 0.35;

export function resolveHomeRunway(
  ctx: PilotContext,
  homeAirportId: string | undefined,
  homeRunwayId: string | undefined
): RunwayInfo | undefined {
  const airportId = homeAirportId ?? ctx.navDb.nearestAirport(ctx.self.pos)?.id;
  if (airportId === undefined) return undefined;
  const airport = ctx.navDb.getAirport(airportId);
  if (airport === undefined) return undefined;
  const runwayId = homeRunwayId ?? airport.runways[0]?.id;
  if (runwayId === undefined) return undefined;
  return ctx.navDb.getRunway(airportId, runwayId);
}

export function rangeToThresholdM(ctx: PilotContext, runway: Readonly<RunwayInfo>): number {
  const dx = ctx.self.pos.x - runway.thresholdPos.x;
  const dz = ctx.self.pos.z - runway.thresholdPos.z;
  return Math.hypot(dx, dz);
}

/**
 * Builds `Land`'s goal for the current tick. `runway` is guaranteed defined
 * by the caller (the FSM only transitions into `Land` once
 * `resolveHomeRunway` returned defined, and `homeAirportId`/`homeRunwayId`
 * never change after spawn — 06-ai.md section 4.11).
 */
export function buildLandingGoal(ctx: PilotContext, runway: Readonly<RunwayInfo>, out: FlightGoal): FlightGoal {
  if ((ctx.self.flags & EntityFlag.OnGround) !== 0) {
    out.pitchMode = PitchMode.GLoad;
    out.desiredGLoad = 1;
    out.desiredBankRad = 0;
    out.desiredAltitudeM = runway.elevationM;
    out.desiredSpeedMps = 0;
    out.throttleOverride = 0;
    out.afterburnerOverride = false;
    out.gearDown = true;
    out.airbrake = false;
    return out;
  }

  const ils = runway.ils;
  const rangeToThreshold = rangeToThresholdM(ctx, runway);

  if (ils !== undefined && rangeToThreshold <= LOCALISER_CAPTURE_RANGE_M) {
    // Perpendicular distance from the localiser centreline, using the
    // threshold as the line's origin and the localiser heading as its
    // direction (small-P correction, per 06-ai.md section 4.11).
    const dx = ctx.self.pos.x - runway.thresholdPos.x;
    const dz = ctx.self.pos.z - runway.thresholdPos.z;
    const dirX = Math.sin(ils.localiserHeadingRad);
    const dirZ = -Math.cos(ils.localiserHeadingRad);
    const perpM = dx * -dirZ + dz * dirX; // cross(dir, delta).y, signed perpendicular offset
    const bearingCorrectionFromOffsetLine = clamp(-PERP_CORRECTION_KP * perpM, -MAX_PERP_CORRECTION_RAD, MAX_PERP_CORRECTION_RAD);
    out.desiredBankRad = ControlGains.HEADING_TO_BANK_KP * wrapAngleSigned(ils.localiserHeadingRad - ctx.telemetry.headingRad + bearingCorrectionFromOffsetLine);
    out.desiredAltitudeM =
      rangeToThreshold <= GLIDESLOPE_CAPTURE_RANGE_M
        ? runway.elevationM + rangeToThreshold * Math.tan(ils.glideslopeAngleRad)
        : ctx.telemetry.altMslM;
  } else {
    out.desiredBankRad = ControlGains.HEADING_TO_BANK_KP * wrapAngleSigned(runway.headingRad - ctx.telemetry.headingRad);
    out.desiredAltitudeM = runway.elevationM + rangeToThreshold * Math.tan(ILS_DEFAULT_GLIDESLOPE_RAD);
  }

  out.pitchMode = PitchMode.AltitudeHold;
  out.desiredSpeedMps = clamp(
    lerp(FINAL_APPROACH_SPEED_MPS, 180, clamp(rangeToThreshold / LOCALISER_CAPTURE_RANGE_M, 0, 1)),
    FINAL_APPROACH_SPEED_MPS,
    180
  );
  out.gearDown = rangeToThreshold < 5000;
  out.airbrake = rangeToThreshold < 8000 && ctx.telemetry.iasMps > FINAL_APPROACH_SPEED_MPS + 20;
  out.throttleOverride = undefined;
  out.afterburnerOverride = false;
  return out;
}
