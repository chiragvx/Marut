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

/*
 * Afterburner sequencing (the F404-GE-IN20's reheat is fully modulated). With the lever in the
 * detent and the core at military power, the nozzle opens and the spray bars light after
 * AB_IGNITION_SEC (no extra thrust yet); the zones then fill to full reheat over AB_STAGE_SEC.
 * Out of the detent it goes out over AB_OUT_SEC. `EntityState.afterburnerLevel` runs 0..1 through
 * the whole sequence: below AB_LIT_LEVEL it is the ignition delay, above it the reheat stage.
 */
export const AB_IGNITION_SEC = 0.35;
export const AB_STAGE_SEC = 1.5;
export const AB_OUT_SEC = 0.35;
/** The core must be at military power for the afterburner to light (the flight-model performance targets are calibrated to this detent). */
export const AB_MIN_CORE_THROTTLE = 0.999;
/** The level at which the flame lights. */
export const AB_LIT_LEVEL = AB_IGNITION_SEC / (AB_IGNITION_SEC + AB_STAGE_SEC);
/** Minimum reheat burns this share of the full afterburner's extra fuel for little extra thrust (reheat is least efficient at its lowest zone). */
const AB_MIN_FUEL_SHARE = 0.2;

/** The reheat stage, 0 (just lit / out) .. 1 (full), from the sequence level. */
export function afterburnerStage(level: number): number {
  return Math.min(1, Math.max(0, (level - AB_LIT_LEVEL) / (1 - AB_LIT_LEVEL)));
}

/**
 * Whether the afterburner will light (and stay lit) here: high and slow the air is too thin for the
 * flame (it blows out). Generous: ~13 km static, ~21 km at Mach 0.9, so it only bites near the ceiling.
 */
export function afterburnerLightable(mach: number, altitudeM: number): boolean {
  return altitudeM < 13000 + 9000 * mach;
}

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
  fuelAvailable: boolean,
  /** The reheat stage while lit (afterburnerStage), 0..1; absent = full. */
  abStage = 1
): number {
  const engineOk = engineHealthPct > 0 && fuelAvailable;
  if (!engineOk) return 0;
  const dry = throttle * sampleThrustN(engine, mach, altitudeM, false);
  if (afterburnerOn) return (dry + (sampleThrustN(engine, mach, altitudeM, true) - dry) * abStage) * engineHealthPct;
  return dry * engineHealthPct;
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

  const tankFuelKg = out.dropTankFuelKg ?? 0;
  const fuelAvailable = out.fuelKg > 0 || tankFuelKg > 0;
  const engineOk = damage.engineHealthPct > 0 && fuelAvailable;

  // The afterburner sequence: ignition delay, then the zones fill; out quickly (blown out high and slow).
  const wantAb = abCmd && engineOk && out.throttle >= AB_MIN_CORE_THROTTLE && afterburnerLightable(mach, out.pos.y);
  const level0 = out.afterburnerLevel ?? (out.afterburnerOn ? 1 : 0);
  const level = wantAb ? Math.min(1, level0 + dtSub / (AB_IGNITION_SEC + AB_STAGE_SEC)) : Math.max(0, level0 - dtSub / AB_OUT_SEC);
  out.afterburnerLevel = level;
  out.afterburnerOn = engineOk && level >= AB_LIT_LEVEL && (wantAb || level0 >= AB_LIT_LEVEL);
  const stage = afterburnerStage(level);

  let thrustN = 0;
  if (engineOk) thrustN = computeAppliedThrustN(def.engine, mach, out.pos.y, out.throttle, out.afterburnerOn, damage.engineHealthPct, true, stage);

  let fuelFlowKgS = 0;
  if (engineOk) {
    if (out.afterburnerOn) {
      const dryFlow = lerp(def.engine.idleFuelFlowKgS, interpolate2D(def.engine.militaryFuelFlowKgS, mach, out.pos.y), out.throttle);
      const abFlow = interpolate2D(def.engine.afterburnerFuelFlowKgS, mach, out.pos.y);
      fuelFlowKgS = dryFlow + (abFlow - dryFlow) * (AB_MIN_FUEL_SHARE + (1 - AB_MIN_FUEL_SHARE) * stage);
    } else if (out.throttle > 0.02) {
      fuelFlowKgS = lerp(def.engine.idleFuelFlowKgS, interpolate2D(def.engine.militaryFuelFlowKgS, mach, out.pos.y), out.throttle);
    } else {
      fuelFlowKgS = def.engine.idleFuelFlowKgS;
    }
  }
  const leakKgS = damage.fuelLeak ? FUEL_LEAK_RATE_KG_S : 0;
  // Drop tanks feed first; once they run dry the engine draws on internal fuel. A leak is in the
  // internal tanks, so it always drains internal fuel.
  let burnKg = fuelFlowKgS * dtSub;
  if (tankFuelKg > 0) {
    const fromTanks = Math.min(tankFuelKg, burnKg);
    out.dropTankFuelKg = tankFuelKg - fromTanks;
    burnKg -= fromTanks;
  }
  out.fuelKg = Math.max(0, out.fuelKg - burnKg - leakKgS * dtSub);

  outThrustForceBody.x = thrustN;
  outThrustForceBody.y = 0;
  outThrustForceBody.z = 0;
}
