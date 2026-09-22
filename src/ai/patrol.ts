/**
 * src/ai/patrol.ts — Patrol / RTB / Intercept cruise-leg FlightGoal
 * builders. See docs/spec/06-ai.md section 4.12.
 */
import type { Contact, PilotContext, Vec3Like } from '../contracts/core';
import type { FlightGoal } from '../contracts/ai';
import { ControlGains, PitchMode } from '../contracts/ai';
import { clamp } from '../math';
import { bearingToPointRad } from './formation';

const DEFAULT_PATROL_RADIUS_M = 8000;
const PATROL_SPEED_MPS = 180;
const RTB_ALTITUDE_ABOVE_FIELD_M = 3000;
const RTB_SPEED_MPS = 220;
const INTERCEPT_LEAD_SEC = 3;
const INTERCEPT_ALT_BAND_M = 2000;
const INTERCEPT_SPEED_MPS = 250;

function bankFromBearing(bearingRad: number): number {
  return clamp(ControlGains.HEADING_TO_BANK_KP * bearingRad, -ControlGains.MAX_MANOEUVRE_BANK_RAD, ControlGains.MAX_MANOEUVRE_BANK_RAD);
}

export function buildPatrolGoal(
  ctx: PilotContext,
  patrolCenterWorld: Readonly<Vec3Like> | undefined,
  patrolRadiusM: number | undefined,
  out: FlightGoal
): FlightGoal {
  const center = patrolCenterWorld ?? ctx.self.pos;
  const radius = patrolRadiusM !== undefined && patrolRadiusM > 0 ? patrolRadiusM : DEFAULT_PATROL_RADIUS_M;

  const dx = ctx.self.pos.x - center.x;
  const dz = ctx.self.pos.z - center.z;
  const bearingFromCenterRad = Math.atan2(dx, -dz);
  const tangentBearingRad = bearingFromCenterRad + Math.PI / 2;
  const tangentX = center.x + radius * Math.sin(tangentBearingRad);
  const tangentZ = center.z - radius * Math.cos(tangentBearingRad);

  const bearingToTangentPointRad = bearingToPointRad(ctx.self.pos, ctx.telemetry.headingRad, { x: tangentX, y: 0, z: tangentZ });

  out.pitchMode = PitchMode.AltitudeHold;
  out.desiredAltitudeM = center.y !== 0 ? center.y + 2000 : ctx.telemetry.altMslM;
  out.desiredBankRad = bankFromBearing(bearingToTangentPointRad);
  out.desiredGLoad = 1;
  out.desiredSpeedMps = PATROL_SPEED_MPS;
  out.throttleOverride = undefined;
  out.afterburnerOverride = false;
  out.gearDown = false;
  out.airbrake = false;
  return out;
}

export function buildRtbGoal(ctx: PilotContext, homeAirportId: string | undefined, out: FlightGoal): FlightGoal {
  const airport = homeAirportId !== undefined ? ctx.navDb.getAirport(homeAirportId) : ctx.navDb.nearestAirport(ctx.self.pos);

  if (airport === undefined) {
    // No reference position available: hold current heading and altitude.
    out.pitchMode = PitchMode.AltitudeHold;
    out.desiredAltitudeM = ctx.telemetry.altMslM;
    out.desiredBankRad = 0;
    out.desiredGLoad = 1;
    out.desiredSpeedMps = RTB_SPEED_MPS;
    out.throttleOverride = undefined;
    out.afterburnerOverride = false;
    out.gearDown = false;
    out.airbrake = false;
    return out;
  }

  const bearingRad = bearingToPointRad(ctx.self.pos, ctx.telemetry.headingRad, airport.referencePos);
  out.pitchMode = PitchMode.AltitudeHold;
  out.desiredAltitudeM = airport.elevationM + RTB_ALTITUDE_ABOVE_FIELD_M;
  out.desiredBankRad = bankFromBearing(bearingRad);
  out.desiredGLoad = 1;
  out.desiredSpeedMps = RTB_SPEED_MPS;
  out.throttleOverride = undefined;
  out.afterburnerOverride = false;
  out.gearDown = false;
  out.airbrake = false;
  return out;
}

export function buildInterceptGoal(ctx: PilotContext, target: Readonly<Contact>, out: FlightGoal): FlightGoal {
  const leadX = target.pos.x + target.vel.x * INTERCEPT_LEAD_SEC;
  const leadY = target.pos.y + target.vel.y * INTERCEPT_LEAD_SEC;
  const leadZ = target.pos.z + target.vel.z * INTERCEPT_LEAD_SEC;
  const bearingRad = bearingToPointRad(ctx.self.pos, ctx.telemetry.headingRad, { x: leadX, y: leadY, z: leadZ });

  out.pitchMode = PitchMode.AltitudeHold;
  out.desiredAltitudeM = clamp(target.pos.y, ctx.telemetry.altMslM - INTERCEPT_ALT_BAND_M, ctx.telemetry.altMslM + INTERCEPT_ALT_BAND_M);
  out.desiredBankRad = bankFromBearing(bearingRad);
  out.desiredGLoad = 1;
  out.desiredSpeedMps = INTERCEPT_SPEED_MPS;
  out.throttleOverride = undefined;
  out.afterburnerOverride = false;
  out.gearDown = false;
  out.airbrake = false;
  return out;
}
