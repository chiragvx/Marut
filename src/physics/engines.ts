/**
 * src/physics/engines.ts — the multi-engine model, for aircraft with `AircraftDefinition.engines`
 * (the C-17's four F117s). The single-engine fighters keep engine.ts's original model untouched;
 * this is its generalisation to N engines, each with
 *   - its own position (thrust along body +x through it, so asymmetric thrust yaws the aircraft:
 *     engine-out yaw comes from geometry, nothing is scripted),
 *   - its own N1 spool (two-rate model, docs/spec/c17-data.md 2.3), failure flag and reverser,
 *   - idle thrust (EngineTables.idleThrustFrac) and a part-throttle fuel-flow penalty,
 *   - hot-day derating (EngineTables.hotDay) from Environment.isaDeviationK.
 * All engines follow the one throttle lever (PilotInputs.throttle). A single engine at the CG with
 * the same tables would reproduce engine.ts's thrust exactly at idleThrustFrac 0.
 *
 * Thrust vs N1: thrust fraction = N1^2 (high-bypass fan, a reasonable fit between the 7% ICAO idle
 * point at ~26% N1 and 100%; estimate). The lever sets the N1 target sqrt(idle + (1-idle) lever).
 *
 * Reversers (EngineTables.reverser): deploy/stow over transitSec, engines held at idle while
 * moving. Deployed on the ground with reverse held, the engines go to full reverse power; in flight
 * the engine logic holds reverse idle (C-17, pack 2.4). Reverse force = thrustFrac x forward thrust
 * at that N1 plus the ram drag of the spilled inlet flow, ramDragCoeff rho V^2 A_fan.
 *
 * Externally blown flaps: the jet turned by the flaps loses cos(turn angle) of its axial thrust
 * (the lift it makes is in highLift.ts, from these engines' thrust).
 *
 * Allocation-free once `EntityState.engines` exists (created on first use, once per entity).
 */
import type { DamageState, EngineRunState, EntityState, PilotInputs, Vec3Like } from '../contracts/core';
import type { AircraftDefinition } from '../contracts/aircraft';
import { clamp, interpolate2D, rateLimitStep } from '../math';

const DEG = Math.PI / 180;
/** damage.fuelLeak extra burn rate, kg/s (as engine.ts). */
const FUEL_LEAK_RATE_KG_S = 4.1667;
/** N1 a failed engine winds down to (windmilling), fraction. */
const WINDMILL_N1 = 0.08;
/** Part-throttle TSFC penalty: TSFC(part) = TSFC(max) (1 + k (1 - T/Tmax)^2) (pack 2.2, estimate). */
const PART_THROTTLE_TSFC_K = 0.3;

/** Creates EntityState.engines for a multi-engine aircraft (all at idle N1, reversers stowed). */
export function createEngineStates(def: AircraftDefinition, startN1?: number): EngineRunState[] {
  const idleN1 = Math.sqrt(def.engine.idleThrustFrac ?? 0);
  return (def.engines ?? []).map(() => ({ n1: startN1 ?? idleN1, reverserPos: 0, failed: false, thrustN: 0 }));
}

/** N1 the lever asks for (0..1 lever). */
export function n1ForLever(def: AircraftDefinition, lever: number): number {
  const idle = def.engine.idleThrustFrac ?? 0;
  return Math.sqrt(idle + (1 - idle) * clamp(lever, 0, 1));
}

/** Hot-day thrust factor (1 at or below the flat-rate temperature). */
export function hotDayThrustFactor(def: AircraftDefinition, isaDeviationK: number): number {
  const h = def.engine.hotDay;
  if (!h) return 1;
  return clamp(1 - h.thrustLossPerK * Math.max(0, isaDeviationK - h.flatRateIsaDevK), 0.3, 1);
}

export interface EngineStepEnv {
  mach: number;
  airDensityKgM3: number;
  tasMps: number;
  isaDeviationK: number;
  onGround: boolean;
  /** Aft flap angle, deg (jet turning by the blown flaps); 0 without flaps. */
  flapDeg: number;
}

export interface EngineStepOut {
  forceBody: Vec3Like;
  momentBody: Vec3Like;
  /** Gross forward thrust of the engines on each wing half (blowing the flaps), N. */
  thrustLeftN: number;
  thrustRightN: number;
}

/**
 * One substep of every engine: spool, reversers, thrust, fuel burn. Writes the summed thrust force
 * and its moment about the reference CG (body frame) into `result`.
 */
export function stepEngines(out: EntityState, inputs: PilotInputs, damage: DamageState, def: AircraftDefinition, env: Readonly<EngineStepEnv>, dtSub: number, result: EngineStepOut): void {
  const instances = def.engines!;
  const tables = def.engine;
  if (out.engines === undefined || out.engines.length !== instances.length) out.engines = createEngineStates(def, n1ForLever(def, out.throttle));
  const engines = out.engines;
  const idle = tables.idleThrustFrac ?? 0;
  const rev = tables.reverser;
  const spool = tables.spool;
  const fuelAvailable = out.fuelKg > 0 || (out.dropTankFuelKg ?? 0) > 0;
  const allOut = damage.engineHealthPct <= 0 || !fuelAvailable;
  const altM = out.pos.y;
  const milN = interpolate2D(tables.militaryThrustN, env.mach, altM) * hotDayThrustFactor(def, env.isaDeviationK) * Math.max(0, Math.min(1, damage.engineHealthPct));
  const milFlowKgS = interpolate2D(tables.militaryFuelFlowKgS, env.mach, altM);
  const turnCos = env.flapDeg > 0 && def.highLift?.ebf ? Math.cos(def.highLift.ebf.turnFrac * env.flapDeg * DEG) : 1;
  const ramDragN = rev ? rev.ramDragCoeff * env.airDensityKgM3 * env.tasMps * env.tasMps * rev.fanAreaM2 : 0;
  const lever = clamp(inputs.throttle, 0, 1);

  result.forceBody.x = 0;
  result.forceBody.y = 0;
  result.forceBody.z = 0;
  result.momentBody.x = 0;
  result.momentBody.y = 0;
  result.momentBody.z = 0;
  result.thrustLeftN = 0;
  result.thrustRightN = 0;
  let fuelFlowKgS = 0;
  let powerSum = 0;
  let running = 0;

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i]!;
    const e = engines[i]!;
    const dead = e.failed || allOut;

    // Reverser: deploy while reverse is held (a failed engine's reverser still moves: hydraulics).
    let reverseWanted = false;
    if (rev) {
      reverseWanted = inputs.reverseThrust === true;
      e.reverserPos = rateLimitStep(e.reverserPos, reverseWanted ? 1 : 0, 1 / rev.transitSec, dtSub);
    }
    // Lever this engine follows: forward lever; idle while a reverser is in transit; full reverse
    // once deployed on the ground; reverse idle in flight.
    let engineLever = lever;
    if (rev && (reverseWanted || e.reverserPos > 0)) {
      engineLever = reverseWanted && e.reverserPos >= 1 && (env.onGround || !rev.idleOnlyInFlight) ? 1 : 0;
    }
    const n1Target = dead ? WINDMILL_N1 : Math.sqrt(idle + (1 - idle) * engineLever);
    let tau = tables.spoolTimeConstantSec;
    if (spool) tau = n1Target > e.n1 ? (e.n1 < spool.breakN1Frac ? spool.upLowTauSec : spool.upHighTauSec) : spool.downTauSec;
    e.n1 = n1Target + (e.n1 - n1Target) * Math.exp(-dtSub / tau);

    let axialN = 0;
    if (!dead) {
      const thrustFrac = Math.max(idle, e.n1 * e.n1);
      const grossN = milN * thrustFrac;
      const r = e.reverserPos;
      const fwdN = grossN * (1 - r);
      axialN = fwdN * turnCos - r * ((rev?.thrustFrac ?? 0) * grossN + ramDragN);
      if (inst.posBodyM.z < 0) result.thrustLeftN += fwdN;
      else result.thrustRightN += fwdN;
      fuelFlowKgS += Math.max(tables.idleFuelFlowKgS, milFlowKgS * thrustFrac * (1 + PART_THROTTLE_TSFC_K * (1 - thrustFrac) * (1 - thrustFrac)));
      powerSum += idle < 1 ? clamp((thrustFrac - idle) / (1 - idle), 0, 1) : 1;
      running++;
    } else if (rev && e.reverserPos > 0) {
      axialN = -e.reverserPos * ramDragN;
    }
    e.thrustN = axialN;
    // Force along body +x at posBodyM: moment = r x F = (0, z F, -y F).
    result.forceBody.x += axialN;
    result.momentBody.y += inst.posBodyM.z * axialN;
    result.momentBody.z -= inst.posBodyM.y * axialN;
  }

  out.throttle = running > 0 ? powerSum / running : 0;
  out.afterburnerOn = false;
  out.afterburnerLevel = 0;

  const leakKgS = damage.fuelLeak ? FUEL_LEAK_RATE_KG_S : 0;
  let burnKg = fuelFlowKgS * dtSub;
  const tankFuelKg = out.dropTankFuelKg ?? 0;
  if (tankFuelKg > 0) {
    const fromTanks = Math.min(tankFuelKg, burnKg);
    out.dropTankFuelKg = tankFuelKg - fromTanks;
    burnKg -= fromTanks;
  }
  out.fuelKg = Math.max(0, out.fuelKg - burnKg - leakKgS * dtSub);
}

/** Total thrust all engines make at full lever (forward), N, at a Mach/pressure altitude. */
export function totalThrustAvailableN(def: AircraftDefinition, mach: number, altitudeM: number, isaDeviationK = 0): number {
  return interpolate2D(def.engine.militaryThrustN, mach, altitudeM) * hotDayThrustFactor(def, isaDeviationK) * (def.engines?.length ?? 1);
}
