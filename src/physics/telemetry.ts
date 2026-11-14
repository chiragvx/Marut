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
import { EntityFlag, TransportWarning } from '../contracts/core';
import type { AircraftDefinition } from '../contracts/aircraft';
import type { Environment, ComputeTelemetry } from '../contracts/flight';
import { Quat } from '../math';
import type { YawPitchRoll } from '../math';
import { computeAirspeedFrame, type AirspeedFrame } from './aeroForces';
import { afterburnerStage, computeAppliedThrustN, sampleThrustN } from './engine';
import { entityPoolIndex, getLastGLoad } from './fcs';
import { configuredCoefficients, configuredStallAlphaRad, cleanLiftSlope, type AeroConfig, type ConfiguredCoefficients } from './highLift';
import { hotDayThrustFactor } from './engines';
import { halfCmu, sideThrustN } from './integrator';
import { interpolate2D } from '../math';

/** ISA sea-level density, kg/m^3 (IAS ~= TAS*sqrt(rho/rho0) approximation). */
const RHO0_KG_M3 = 1.225;

const scratchFrame: AirspeedFrame = { alpha: 0, beta: 0, Vt: 0, mach: 0, qBar: 0 };
const scratchYpr: YawPitchRoll = { headingRad: 0, pitchRad: 0, rollRad: 0 };
const scratchCfg: AeroConfig = { flapPos: 0, spoilerPos: 0, cmuLeft: 0, cmuRight: 0, rampPos: 0 };
const scratchCoeffs: ConfiguredCoefficients = { CL: 0, CD: 0, Cm: 0, Cl: 0, groundEffectScale: 1 };
/** Over-g warning margin above the limit, g. */
const OVER_G_MARGIN = 0.05;
/** Stick shaker at the alpha of 1.1 Vs (docs/spec/c17-data.md 3.6): CL = CLmax / 1.21. */
const SHAKER_CL_FRACTION = 1 / 1.21;

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

  if (def.engines !== undefined) {
    computeTransportTelemetry(state, def, env, damage, out);
    return out;
  }

  const fuelAvailable = state.fuelKg > 0 || (state.dropTankFuelKg ?? 0) > 0;
  const appliedThrustN = computeAppliedThrustN(
    def.engine,
    scratchFrame.mach,
    state.pos.y,
    state.throttle,
    state.afterburnerOn,
    damage.engineHealthPct,
    fuelAvailable,
    afterburnerStage(state.afterburnerLevel ?? 1)
  );
  const maxThrustN = sampleThrustN(def.engine, scratchFrame.mach, state.pos.y, state.afterburnerOn);
  out.thrustFrac = maxThrustN > 0 ? appliedThrustN / maxThrustN : 0;

  out.onGround = (state.flags & EntityFlag.OnGround) !== 0;
  out.stalled = scratchFrame.alpha > def.aero.stallAlphaRad;

  return out;
};

/**
 * Thrust fraction, stall/stall warning and placard warnings for a multi-engine / high-lift aircraft
 * (the C-17). `out`'s air-data fields are already filled by computeTelemetry.
 */
function computeTransportTelemetry(state: EntityState, def: AircraftDefinition, env: Environment, damage: DamageState, out: AircraftTelemetry): void {
  const n = def.engines!.length;
  const maxN = interpolate2D(def.engine.militaryThrustN, scratchFrame.mach, state.pos.y) * hotDayThrustFactor(def, env.isaDeviationK ?? 0) * Math.max(0, Math.min(1, damage.engineHealthPct)) * n;
  let thrust = 0;
  for (const e of state.engines ?? []) thrust += Math.max(0, e.thrustN);
  out.thrustFrac = maxN > 0 ? Math.min(1, thrust / maxN) : 0;
  out.onGround = (state.flags & EntityFlag.OnGround) !== 0;

  const flapPos = state.flapPos ?? 0;
  scratchCfg.flapPos = flapPos;
  scratchCfg.spoilerPos = state.spoilerPos ?? 0;
  scratchCfg.rampPos = state.rampPos ?? 0;
  scratchCfg.cmuLeft = halfCmu(sideThrustN(state, def, false), scratchFrame.qBar, def.wingAreaM2);
  scratchCfg.cmuRight = halfCmu(sideThrustN(state, def, true), scratchFrame.qBar, def.wingAreaM2);
  const stallAlpha = configuredStallAlphaRad(def, scratchFrame.mach, flapPos, scratchCfg.cmuLeft, scratchCfg.cmuRight);
  out.stalled = scratchFrame.alpha > stallAlpha;
  if (def.highLift) {
    const clStall = configuredCoefficients(def, stallAlpha, scratchFrame.mach, scratchCfg, scratchCoeffs).CL;
    const slope = Math.max(1, cleanLiftSlope(def, scratchFrame.mach));
    const shakerAlpha = stallAlpha - ((1 - SHAKER_CL_FRACTION) * clStall) / slope;
    out.stallWarning = !out.onGround && scratchFrame.alpha > shakerAlpha;
  } else out.stallWarning = !out.onGround && out.stalled;

  let w = 0;
  const ias = out.iasMps;
  const mach = scratchFrame.mach;
  const hl = def.highLift;
  if (hl && (flapPos > 0.01 || (state.slatPos ?? 0) > 0.01)) {
    const d = hl.detents[Math.min(hl.detents.length - 1, Math.max(Math.ceil(flapPos - 0.01), (state.slatPos ?? 0) > 0.01 ? 1 : 0))]!;
    if (ias > d.maxIasMps || mach > d.maxMach) w |= TransportWarning.FlapOverspeed;
  }
  const pl = def.placards;
  if (pl) {
    if (pl.gearMaxIasMps !== undefined && state.gearPos > 0.01 && ias > pl.gearMaxIasMps) w |= TransportWarning.GearOverspeed;
    if ((pl.vmoIasMps !== undefined && ias > pl.vmoIasMps) || (pl.mmo !== undefined && mach > pl.mmo)) w |= TransportWarning.Overspeed;
    if (pl.rampMaxIasMps !== undefined && (state.rampPos ?? 0) > 0.01 && ias > pl.rampMaxIasMps) w |= TransportWarning.RampOverspeed;
  }
  const rev = def.engine.reverser;
  if (rev?.maxGroundIasMps !== undefined && out.onGround && ias > rev.maxGroundIasMps) {
    for (const e of state.engines ?? []) if (e.reverserPos > 0.01) w |= TransportWarning.ReverserOverspeed;
  }
  const lim = def.fcsLimits;
  const highLiftOut = flapPos > 0.02 || (state.slatPos ?? 0) > 0.02;
  const gMax = highLiftOut ? (lim.flapsDownMaxGLoadPos ?? lim.maxGLoadPos) : lim.maxGLoadPos;
  const gMin = highLiftOut ? (lim.flapsDownMaxGLoadNeg ?? lim.maxGLoadNeg) : lim.maxGLoadNeg;
  if (!out.onGround && (out.gLoad > gMax + OVER_G_MARGIN || out.gLoad < gMin - OVER_G_MARGIN)) w |= TransportWarning.OverG;
  out.limitWarnings = w;
}
