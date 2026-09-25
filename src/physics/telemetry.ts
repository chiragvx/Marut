/**
 * src/physics/telemetry.ts — derives `AircraftTelemetry` from an aircraft's
 * CURRENT (pre-step) state. Implements `ComputeTelemetry`
 * (contracts/flight.ts). See docs/spec/02-flight-model.md section 4.11.
 *
 * Allocation-free. Does NOT re-run aero/engine/gear table lookups beyond
 * the handful this file itself needs (airspeed frame + thrust-fraction
 * lookups) — the gLoad value is read back from `fcs.ts`'s cache, never
 * recomputed.
 */
import type { EntityState, DamageState, AircraftTelemetry } from '../contracts/core';
import { EntityFlag } from '../contracts/core';
import type { AircraftDefinition } from '../contracts/aircraft';
import type { Environment, ComputeTelemetry } from '../contracts/flight';
import { Quat } from '../math';
import type { YawPitchRoll } from '../math';
import { computeAirspeedFrame, type AirspeedFrame } from './aeroForces';
import { computeAppliedThrustN, sampleThrustN } from './engine';
import { entityPoolIndex, getLastGLoad } from './fcs';

/** ISA sea-level density, kg/m^3 (IAS ~= TAS*sqrt(rho/rho0) approximation). */
const RHO0_KG_M3 = 1.225;

const scratchFrame: AirspeedFrame = { alpha: 0, beta: 0, Vt: 0, mach: 0, qBar: 0 };
const scratchYpr: YawPitchRoll = { headingRad: 0, pitchRad: 0, rollRad: 0 };

export const computeTelemetry: ComputeTelemetry = (
  state: EntityState,
  def: AircraftDefinition,
  env: Environment,
  damage: DamageState,
  out: AircraftTelemetry
): AircraftTelemetry => {
  computeAirspeedFrame(state.vel, state.rot, env.windWorldMps, env.airDensityKgM3, env.soundSpeedMps, scratchFrame);

  out.iasMps = scratchFrame.Vt * Math.sqrt(env.airDensityKgM3 / RHO0_KG_M3);
  out.tasMps = scratchFrame.Vt;
  out.mach = scratchFrame.mach;
  out.altMslM = state.pos.y;
  out.altAglM = state.pos.y - env.groundElevationM;
  out.alphaRad = scratchFrame.alpha;
  out.betaRad = scratchFrame.beta;
  out.gLoad = getLastGLoad(entityPoolIndex(state.id));

  Quat.toYawPitchRoll(state.rot, scratchYpr);
  out.headingRad = scratchYpr.headingRad;
  out.pitchRad = scratchYpr.pitchRad;
  out.rollRad = scratchYpr.rollRad;

  out.vspeedMps = state.vel.y;
  out.fuelKg = state.fuelKg;
  out.fuelFrac = state.fuelKg / def.maxFuelKg;

  const fuelAvailable = state.fuelKg > 0 || (state.dropTankFuelKg ?? 0) > 0;
  const appliedThrustN = computeAppliedThrustN(
    def.engine,
    scratchFrame.mach,
    state.pos.y,
    state.throttle,
    state.afterburnerOn,
    damage.engineHealthPct,
    fuelAvailable
  );
  const maxThrustN = sampleThrustN(def.engine, scratchFrame.mach, state.pos.y, state.afterburnerOn);
  out.thrustFrac = maxThrustN > 0 ? appliedThrustN / maxThrustN : 0;

  out.onGround = (state.flags & EntityFlag.OnGround) !== 0;
  out.stalled = scratchFrame.alpha > def.aero.stallAlphaRad;

  return out;
};
