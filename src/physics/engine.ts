/**
 * src/physics/engine.ts — thrust/fuel-flow lookup, first-order throttle
 * spool lag, flameout logic. See docs/spec/02-flight-model.md section 4.7.
 *
 * Allocation-free: the only "output" is a Vec3Like the caller owns (written
 * in place) plus mutation of `out`'s throttle/afterburnerOn/fuelKg fields.
 */
import type { EntityState, PilotInputs, DamageState, Vec3Like } from '../contracts/core';
import type { AircraftDefinition, EngineTables } from '../contracts/aircraft';
import { interpolate2D, lerp } from '../math';

/** damage.fuelLeak extra burn rate, kg/s (~2 min to empty a 500 kg tank). */
const FUEL_LEAK_RATE_KG_S = 4.1667;

/** Raw max-thrust table value (no health/throttle scaling) at (mach, altitudeM). */
export function sampleThrustN(engine: EngineTables, mach: number, altitudeM: number, afterburnerOn: boolean): number {
  return afterburnerOn ? interpolate2D(engine.afterburnerThrustN, mach, altitudeM) : interpolate2D(engine.militaryThrustN, mach, altitudeM);
}

/**
 * Actual applied thrust, N, given the CURRENTLY-APPLIED throttle/afterburner
 * state (post spool-lag) and damage/fuel availability — the same formula
 * 4.7 uses inside `stepEngine`, exposed separately so `telemetry.ts` can
 * recompute `thrustFrac` without re-running the spool-lag/fuel-burn logic.
 */
export function computeAppliedThrustN(
  engine: EngineTables,
  mach: number,
  altitudeM: number,
  throttle: number,
  afterburnerOn: boolean,
  engineHealthPct: number,
  fuelAvailable: boolean
): number {
  const engineOk = engineHealthPct > 0 && fuelAvailable;
  if (!engineOk) return 0;
  if (afterburnerOn) return sampleThrustN(engine, mach, altitudeM, true) * engineHealthPct;
  return throttle * sampleThrustN(engine, mach, altitudeM, false) * engineHealthPct;
}

/**
 * One substep of the engine model (4.7): spool-lags `out.throttle` toward
 * `inputs.throttle`, resolves the afterburner detent, computes thrust and
 * fuel flow, burns fuel (clamped >= 0), and writes the body-frame thrust
 * force `(thrustN, 0, 0)` into `outThrustForceBody`.
 */
export function stepEngine(
  out: EntityState,
  inputs: PilotInputs,
  damage: DamageState,
  def: AircraftDefinition,
  mach: number,
  dtSub: number,
  outThrustForceBody: Vec3Like
): void {
  const throttleCmd = inputs.throttle;
  const abCmd = inputs.afterburner && throttleCmd >= 0.999;

  out.throttle = throttleCmd + (out.throttle - throttleCmd) * Math.exp(-dtSub / def.engine.spoolTimeConstantSec);
  out.afterburnerOn = abCmd && out.throttle >= 0.999;

  const fuelAvailable = out.fuelKg > 0;
  const engineOk = damage.engineHealthPct > 0 && fuelAvailable;

  let thrustN = 0;
  if (engineOk) {
    if (out.afterburnerOn) {
      thrustN = sampleThrustN(def.engine, mach, out.pos.y, true) * damage.engineHealthPct;
    } else {
      thrustN = out.throttle * sampleThrustN(def.engine, mach, out.pos.y, false) * damage.engineHealthPct;
    }
  }

  let fuelFlowKgS = 0;
  if (engineOk) {
    if (out.afterburnerOn) {
      fuelFlowKgS = interpolate2D(def.engine.afterburnerFuelFlowKgS, mach, out.pos.y);
    } else if (out.throttle > 0.02) {
      fuelFlowKgS = lerp(def.engine.idleFuelFlowKgS, interpolate2D(def.engine.militaryFuelFlowKgS, mach, out.pos.y), out.throttle);
    } else {
      fuelFlowKgS = def.engine.idleFuelFlowKgS;
    }
  }
  const leakKgS = damage.fuelLeak ? FUEL_LEAK_RATE_KG_S : 0;
  out.fuelKg = Math.max(0, out.fuelKg - (fuelFlowKgS + leakKgS) * dtSub);

  outThrustForceBody.x = thrustN;
  outThrustForceBody.y = 0;
  outThrustForceBody.z = 0;
}
