/**
 * src/physics/integrator.ts — top-level `stepAircraft`, implementing
 * `StepAircraft` (contracts/flight.ts). Owns the substep loop and calls
 * every other file in this module in order. See
 * docs/spec/02-flight-model.md sections 4.2, 4.9 (gLoad plumbing), 4.10
 * (structural-failure short-circuit).
 *
 * Allocation-free in steady state: the per-`AircraftDefinition.id` inertia
 * tensor cache allocates once per distinct aircraft TYPE the first time it
 * is seen (not per entity, not per tick) — see `getInertia` below and
 * section 6 of the spec, which explicitly sanctions this.
 */
import type { EntityState, DamageState, PilotInputs, Vec3Like } from '../contracts/core';
import { EntityFlag, LIGHT_FLAGS_MASK } from '../contracts/core';
import type { AircraftDefinition, FcsLimits } from '../contracts/aircraft';
import type { Environment, StepAircraft } from '../contracts/flight';
import { FLIGHT_MODEL_SUBSTEPS } from '../contracts/flight';
import type { Mat3 as Mat3Type } from '../contracts/math';
import { Vec3, Quat, Mat3, createMat3, rateLimitStep } from '../math';
import { computeAirspeedFrame, computeAeroForceMoment, type AirspeedFrame, type AeroOutput } from './aeroForces';
import { stepEngine } from './engine';
import { computeGearLeg, stepGearPos, type GearLegOutput } from './landingGear';
import { stepFcs, entityPoolIndex, type FcsSurfaces } from './fcs';
import { integrateRigidBody } from './rigidBody';
import { stepEngines, type EngineStepEnv, type EngineStepOut } from './engines';
import { blendDetent, configuredStallAlphaRad, stepFlapsAndSlats, type AeroConfig, type DetentBlend } from './highLift';

// ---------------------------------------------------------------------------
// Inertia tensor cache — built once per distinct AircraftDefinition.id.
// ---------------------------------------------------------------------------

interface InertiaEntry {
  I: Mat3Type;
  Iinv: Mat3Type;
}
const inertiaCache = new Map<string, InertiaEntry>();

function getInertia(def: AircraftDefinition): InertiaEntry {
  let entry = inertiaCache.get(def.id);
  if (entry === undefined) {
    const I = createMat3();
    Mat3.fromInertia(def.inertiaBodyKgM2, I);
    const Iinv = createMat3();
    Mat3.invert(I, Iinv);
    entry = { I, Iinv };
    inertiaCache.set(def.id, entry);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Scratch state — module-level, reused across every call/substep.
// ---------------------------------------------------------------------------

const scratchFrame: AirspeedFrame = { alpha: 0, beta: 0, Vt: 0, mach: 0, qBar: 0 };
const scratchAero: AeroOutput = { forceBody: { x: 0, y: 0, z: 0 }, momentBody: { x: 0, y: 0, z: 0 } };
const scratchThrustForceBody: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchGearForceWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchGearMomentBody: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchLegResult: GearLegOutput = { legForceWorld: { x: 0, y: 0, z: 0 }, legMomentBody: { x: 0, y: 0, z: 0 }, onGround: false };
const scratchBodyForceSum: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchWorldForceFromBody: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchTotalForce: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchTotalMoment: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchSurfaces: FcsSurfaces = { elevonL: 0, elevonR: 0, rudder: 0 };

/**
 * How strongly the rotational inertia follows the mass: `I = I_ref * (1 + k*(m/m_ref - 1))`,
 * where `I_ref` is `def.inertiaBodyKgM2` at the reference mass `def.massKg`. Well under 1 because
 * the mass that changes in flight -- internal fuel and fuselage/wing-root stores -- sits close to
 * the CG, so it moves the inertia far less than it moves the mass.
 */
const INERTIA_MASS_SENSITIVITY = 0.5;

/** Current all-up mass: empty airframe + internal fuel + carried stores + drop tanks (shells + fuel) + cargo. */
export function aircraftMassKg(
  state: Pick<EntityState, 'fuelKg' | 'storesMassKg' | 'dropTankCount' | 'dropTankFuelKg' | 'dropTankShellKg' | 'cargoMassKg'>,
  def: Pick<AircraftDefinition, 'emptyMassKg' | 'dropTank'>
): number {
  const n = state.dropTankCount ?? 0;
  const tankShellsKg = n > 0 ? (state.dropTankShellKg ?? n * (def.dropTank?.emptyMassKg ?? 0)) : 0;
  const m = def.emptyMassKg + state.fuelKg + (state.storesMassKg ?? 0) + tankShellsKg + (state.dropTankFuelKg ?? 0);
  return state.cargoMassKg ? m + state.cargoMassKg : m;
}

/**
 * Body-x position of the actual CG relative to the reference CG (the body origin), m, for an
 * aircraft with a mass model: the mass-weighted mean of the empty airframe's, the fuel's and the
 * cargo's CGs. 0 without one.
 */
export function cgOffsetBodyX(state: Pick<EntityState, 'fuelKg' | 'cargoMassKg' | 'cargoCgBodyX'>, def: Pick<AircraftDefinition, 'emptyMassKg' | 'massModel'>, massKg: number): number {
  const mm = def.massModel;
  if (!mm || massKg <= 0) return 0;
  const cargo = state.cargoMassKg ?? 0;
  return (def.emptyMassKg * mm.emptyCgBodyX + state.fuelKg * mm.fuelCgBodyX + cargo * (state.cargoCgBodyX ?? mm.cargoCgBodyX)) / massKg;
}

/** Diagonal inertia with fuel and cargo for a mass-model aircraft (writes `out`). */
export function massModelInertia(
  state: Pick<EntityState, 'fuelKg' | 'cargoMassKg'>,
  def: AircraftDefinition,
  out: { xx: number; yy: number; zz: number; xy: number; xz: number; yz: number }
): typeof out {
  const mm = def.massModel!;
  const I0 = def.inertiaBodyKgM2;
  const fuel = state.fuelKg;
  const cargo = state.cargoMassKg ?? 0;
  out.xx = I0.xx + fuel * mm.fuelInertiaM2.xx + cargo * mm.cargoInertiaM2.xx;
  out.yy = I0.yy + fuel * mm.fuelInertiaM2.yy + cargo * mm.cargoInertiaM2.yy;
  out.zz = I0.zz + fuel * mm.fuelInertiaM2.zz + cargo * mm.cargoInertiaM2.zz;
  out.xy = I0.xy;
  out.xz = I0.xz;
  out.yz = I0.yz;
  return out;
}

/** Drag area (CD*S, m^2) of carried stores plus attached drop tanks. */
function externalDragAreaM2(state: EntityState, def: AircraftDefinition): number {
  const n = state.dropTankCount ?? 0;
  return (state.storesDragAreaM2 ?? 0) + (n > 0 ? (state.dropTankDragAreaM2 ?? n * (def.dropTank?.dragAreaM2 ?? 0)) : 0);
}

function copyEntityState(src: EntityState, dst: EntityState): void {
  dst.id = src.id;
  dst.kind = src.kind;
  dst.team = src.team;
  Vec3.copy(dst.pos, src.pos);
  Quat.copy(dst.rot, src.rot);
  Vec3.copy(dst.vel, src.vel);
  Vec3.copy(dst.omega, src.omega);
  dst.alive = src.alive;
  dst.hp = src.hp;
  dst.fuelKg = src.fuelKg;
  dst.elevonL = src.elevonL;
  dst.elevonR = src.elevonR;
  dst.rudder = src.rudder;
  dst.gearPos = src.gearPos;
  dst.throttle = src.throttle;
  dst.afterburnerOn = src.afterburnerOn;
  dst.afterburnerLevel = src.afterburnerLevel;
  dst.storesMassKg = src.storesMassKg;
  dst.airbrakePos = src.airbrakePos;
  dst.storesDragAreaM2 = src.storesDragAreaM2;
  dst.dropTankCount = src.dropTankCount;
  dst.dropTankFuelKg = src.dropTankFuelKg;
  dst.dropTankShellKg = src.dropTankShellKg;
  dst.dropTankDragAreaM2 = src.dropTankDragAreaM2;
  dst.flags = src.flags;
  // Transport state (absent on the fighters: only touched when either side has it).
  if (src.flapPos !== undefined || dst.flapPos !== undefined) {
    dst.flapDetent = src.flapDetent;
    dst.flapPos = src.flapPos;
    dst.flapFrac = src.flapFrac;
    dst.slatPos = src.slatPos;
  }
  if (src.spoilerPos !== undefined || dst.spoilerPos !== undefined) dst.spoilerPos = src.spoilerPos;
  if (src.cargoMassKg !== undefined || dst.cargoMassKg !== undefined) {
    dst.cargoMassKg = src.cargoMassKg;
    dst.cargoCgBodyX = src.cargoCgBodyX;
  }
  if (src.rampPos !== undefined || dst.rampPos !== undefined) dst.rampPos = src.rampPos;
  if (src.engines !== undefined) {
    if (dst.engines === undefined || dst.engines.length !== src.engines.length) dst.engines = src.engines.map((e) => ({ ...e }));
    else {
      for (let i = 0; i < src.engines.length; i++) {
        const a = src.engines[i]!;
        const b = dst.engines[i]!;
        b.n1 = a.n1;
        b.reverserPos = a.reverserPos;
        b.failed = a.failed;
        b.thrustN = a.thrustN;
      }
    }
  } else if (dst.engines !== undefined) dst.engines = undefined;
}

// --- Transport (multi-engine / high-lift / mass-model) scratch. ---
const scratchEngineEnv: EngineStepEnv = { mach: 0, airDensityKgM3: 1.225, tasMps: 0, isaDeviationK: 0, onGround: false, flapDeg: 0 };
const scratchEngineOut: EngineStepOut = { forceBody: { x: 0, y: 0, z: 0 }, momentBody: { x: 0, y: 0, z: 0 }, thrustLeftN: 0, thrustRightN: 0 };
const scratchAeroConfig: AeroConfig = { flapPos: 0, spoilerPos: 0, cmuLeft: 0, cmuRight: 0, rampPos: 0 };
const scratchDetent: DetentBlend = { dCL0: 0, dAlphaStallRad: 0, dCD0: 0, dCm0: 0, ebfEta: 0, flapDeg: 0 };
const scratchGearForceBody: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchInertiaComponents = { xx: 0, yy: 0, zz: 0, xy: 0, xz: 0, yz: 0 };
const scratchInertia: InertiaEntry = { I: createMat3(), Iinv: createMat3() };
/** Per-aircraft-type FcsLimits copy the configuration limits (g with flaps, alpha from the configured stall) are written into. */
const configLimitsCache = new Map<string, FcsLimits>();

/** Cargo ramp/door travel time, s (no published figure; pack 6.2 suggests ~20 s to airdrop position). */
export const RAMP_TRANSIT_SEC = 20;
/** Throttle lever at or below which the ground spoilers deploy on their own once on the wheels (thrust levers at idle). */
const LIFT_DUMP_IDLE_LEVER = 0.05;

/** Thrust coefficient Cmu of one wing half from its engines' thrust. */
export function halfCmu(thrustN: number, qBar: number, wingAreaM2: number): number {
  if (thrustN <= 0) return 0;
  return thrustN / (Math.max(qBar, 50) * 0.5 * wingAreaM2);
}

/** Left/right forward thrust of the engines (previous substep), N. */
export function sideThrustN(state: Pick<EntityState, 'engines'>, def: AircraftDefinition, right: boolean): number {
  const inst = def.engines;
  const eng = state.engines;
  if (!inst || !eng) return 0;
  let t = 0;
  for (let i = 0; i < inst.length; i++) {
    const e = eng[i];
    if (!e) continue;
    if (inst[i]!.posBodyM.z > 0 === right) t += Math.max(0, e.thrustN);
  }
  return t;
}

function configLimits(def: AircraftDefinition, mach: number, cfg: Readonly<AeroConfig>, slatPos: number): FcsLimits {
  let lim = configLimitsCache.get(def.id);
  if (lim === undefined) {
    lim = { ...def.fcsLimits };
    configLimitsCache.set(def.id, lim);
  }
  const base = def.fcsLimits;
  const highLiftOut = cfg.flapPos > 0.02 || slatPos > 0.02;
  lim.maxGLoadPos = highLiftOut ? (base.flapsDownMaxGLoadPos ?? base.maxGLoadPos) : base.maxGLoadPos;
  lim.maxGLoadNeg = highLiftOut ? (base.flapsDownMaxGLoadNeg ?? base.maxGLoadNeg) : base.maxGLoadNeg;
  if (base.alphaLimitStallFrac !== undefined) lim.maxAlphaRad = base.alphaLimitStallFrac * configuredStallAlphaRad(def, mach, cfg.flapPos, cfg.cmuLeft, cfg.cmuRight);
  return lim;
}

/**
 * One substep (length `dtSub`) of the flight model, fully mutating `out` in
 * place. `structuralFailure` (damage.structurePct <= 0, checked once at
 * `stepAircraft` entry) skips aero force/moment (4.4/4.5) and the FCS (4.9)
 * entirely — see section 4.10 ("ballistic + gear only"); this implementation
 * additionally treats the engine as offline in that case (no thrust, no
 * further fuel burn), since a structurally-failed airframe producing engine
 * thrust would contradict "ballistic" — see this module's contractConcerns
 * note for the ambiguity this resolves.
 */
function runSubstep(
  out: EntityState,
  damage: DamageState,
  inputs: PilotInputs,
  env: Environment,
  def: AircraftDefinition,
  dtSub: number,
  wasOnGroundAtEntry: boolean,
  structuralFailure: boolean,
  entityIndex: number,
  inertia: InertiaEntry
): void {
  computeAirspeedFrame(out.vel, out.rot, env.windWorldMps, env.airDensityKgM3, env.soundSpeedMps, scratchFrame);
  const altAglM = out.pos.y - env.groundElevationM;
  // Mass varies with fuel burn and stores release (previously a fixed def.massKg).
  const massKg = aircraftMassKg(out, def);

  const highLift = def.highLift;
  const multiEngine = def.engines !== undefined;
  if (highLift !== undefined) {
    scratchAeroConfig.flapPos = out.flapPos ?? 0;
    scratchAeroConfig.spoilerPos = out.spoilerPos ?? 0;
    scratchAeroConfig.rampPos = out.rampPos ?? 0;
    scratchAeroConfig.cmuLeft = halfCmu(sideThrustN(out, def, false), scratchFrame.qBar, def.wingAreaM2);
    scratchAeroConfig.cmuRight = halfCmu(sideThrustN(out, def, true), scratchFrame.qBar, def.wingAreaM2);
  }

  if (!structuralFailure) {
    const configDragCoeff =
      out.gearPos * (def.aero.CD_gear ?? 0) +
      (out.airbrakePos ?? 0) * (def.aero.CD_airbrake ?? 0) +
      (def.wingAreaM2 > 0 ? externalDragAreaM2(out, def) / def.wingAreaM2 : 0);
    computeAeroForceMoment(scratchFrame, out.elevonL, out.elevonR, out.rudder, out.omega, altAglM, def, scratchAero, configDragCoeff, highLift !== undefined ? scratchAeroConfig : undefined);
  } else {
    Vec3.set(scratchAero.forceBody, 0, 0, 0);
    Vec3.set(scratchAero.momentBody, 0, 0, 0);
  }

  if (!structuralFailure && multiEngine) {
    scratchEngineEnv.mach = scratchFrame.mach;
    scratchEngineEnv.airDensityKgM3 = env.airDensityKgM3;
    scratchEngineEnv.tasMps = scratchFrame.Vt;
    scratchEngineEnv.isaDeviationK = env.isaDeviationK ?? 0;
    scratchEngineEnv.onGround = wasOnGroundAtEntry || (out.flags & EntityFlag.OnGround) !== 0;
    scratchEngineEnv.flapDeg = highLift !== undefined ? blendDetent(highLift, out.flapPos ?? 0, scratchDetent).flapDeg : 0;
    stepEngines(out, inputs, damage, def, scratchEngineEnv, dtSub, scratchEngineOut);
    Vec3.copy(scratchThrustForceBody, scratchEngineOut.forceBody);
  } else if (!structuralFailure) {
    stepEngine(out, inputs, damage, def, scratchFrame.mach, dtSub, scratchThrustForceBody);
  } else {
    Vec3.set(scratchThrustForceBody, 0, 0, 0);
  }

  Vec3.set(scratchGearForceWorld, 0, 0, 0);
  Vec3.set(scratchGearMomentBody, 0, 0, 0);
  let anyGroundContact = false;
  for (let k = 0; k < def.gear.length; k++) {
    const legDef = def.gear[k];
    if (legDef === undefined) continue;
    computeGearLeg(out, legDef, inputs, env, scratchLegResult);
    if (scratchLegResult.onGround) anyGroundContact = true;
    Vec3.add(scratchGearForceWorld, scratchLegResult.legForceWorld, scratchGearForceWorld);
    Vec3.add(scratchGearMomentBody, scratchLegResult.legMomentBody, scratchGearMomentBody);
  }
  if (anyGroundContact) out.flags |= EntityFlag.OnGround;

  // Total force: rotate (aero+thrust, body) to world, add gear force (world) and gravity.
  Vec3.add(scratchAero.forceBody, scratchThrustForceBody, scratchBodyForceSum);
  Quat.rotate(out.rot, scratchBodyForceSum, scratchWorldForceFromBody);
  Vec3.add(scratchWorldForceFromBody, scratchGearForceWorld, scratchTotalForce);
  scratchTotalForce.y += -massKg * env.gravityMps2;

  // Total moment: aero + gear (thrust assumed through the CG, section 9).
  Vec3.add(scratchAero.momentBody, scratchGearMomentBody, scratchTotalMoment);
  if (multiEngine && !structuralFailure) {
    // Engines off the centreline / thrust line (engines.ts): r x F about the reference CG.
    Vec3.add(scratchTotalMoment, scratchEngineOut.momentBody, scratchTotalMoment);
  }
  const cgDx = cgOffsetBodyX(out, def, massKg);
  if (cgDx !== 0) {
    // The CG sits cgDx ahead of the reference point every force/moment above was taken about:
    // moment about the CG = M_ref + (-cgDx x) x F_nongravity (gravity acts through the CG).
    Quat.rotateInverse(out.rot, scratchGearForceWorld, scratchGearForceBody);
    const fy = scratchAero.forceBody.y + scratchThrustForceBody.y + scratchGearForceBody.y;
    const fz = scratchAero.forceBody.z + scratchThrustForceBody.z + scratchGearForceBody.z;
    scratchTotalMoment.y += cgDx * fz;
    scratchTotalMoment.z -= cgDx * fy;
  }

  const currentOnGround = (out.flags & EntityFlag.OnGround) !== 0;
  if (!structuralFailure) {
    scratchSurfaces.elevonL = out.elevonL;
    scratchSurfaces.elevonR = out.elevonR;
    scratchSurfaces.rudder = out.rudder;
    stepFcs(
      entityIndex,
      scratchSurfaces,
      currentOnGround,
      wasOnGroundAtEntry,
      scratchFrame.alpha,
      out.omega,
      scratchTotalForce,
      out.rot,
      massKg,
      env.gravityMps2,
      inputs,
      damage,
      highLift !== undefined ? configLimits(def, scratchFrame.mach, scratchAeroConfig, out.slatPos ?? 0) : def.fcsLimits,
      dtSub,
      scratchFrame.qBar,
      scratchFrame.Vt,
      scratchFrame.beta
    );
    out.elevonL = scratchSurfaces.elevonL;
    out.elevonR = scratchSurfaces.elevonR;
    out.rudder = scratchSurfaces.rudder;
  }

  if (def.massModel !== undefined) {
    // Fuel (in the wings) and cargo (on the floor) each add their own inertia per axis.
    Mat3.fromInertia(massModelInertia(out, def, scratchInertiaComponents), scratchInertia.I);
    Mat3.invert(scratchInertia.I, scratchInertia.Iinv);
    integrateRigidBody(out, scratchTotalForce, scratchTotalMoment, massKg, scratchInertia.I, scratchInertia.Iinv, dtSub);
  } else {
    // Scaling the inertia tensor by s is equivalent to scaling the applied moment by 1/s in Euler's
    // equation (the gyroscopic term's s cancels), so the cached tensor is reused as-is.
    const inertiaScale = 1 + INERTIA_MASS_SENSITIVITY * (massKg / def.massKg - 1);
    Vec3.scale(scratchTotalMoment, 1 / inertiaScale, scratchTotalMoment);
    integrateRigidBody(out, scratchTotalForce, scratchTotalMoment, massKg, inertia.I, inertia.Iinv, dtSub);
  }

  stepGearPos(out, inputs, damage.gearHealthPct, dtSub, def.gearTransitSec);
  if (inputs.gearDown) out.flags |= EntityFlag.GearDownCommanded;
  else out.flags &= ~EntityFlag.GearDownCommanded;
  if (inputs.airbrake) out.flags |= EntityFlag.AirbrakeOut;
  else out.flags &= ~EntityFlag.AirbrakeOut;
  out.flags = (out.flags & ~LIGHT_FLAGS_MASK) | ((inputs.lights ?? 0) & LIGHT_FLAGS_MASK);
  // Airbrake panels move at a finite rate (hydraulic actuators: ~1.2 s out, ~1.0 s in) rather than
  // snapping; drag follows the panel position.
  const ab = out.airbrakePos ?? 0;
  const abTarget = inputs.airbrake && !structuralFailure ? 1 : 0;
  const abRate = abTarget > ab ? 1 / AIRBRAKE_EXTEND_SEC : 1 / AIRBRAKE_RETRACT_SEC;
  out.airbrakePos = abTarget > ab ? Math.min(abTarget, ab + abRate * dtSub) : Math.max(abTarget, ab - abRate * dtSub);

  // Transport systems: flaps/slats, spoilers (speedbrake in the air, lift dump on the wheels), ramp.
  if (highLift !== undefined) stepFlapsAndSlats(out, highLift, inputs.flapLever, damage.hydraulicsOk && !structuralFailure, dtSub);
  const sp = def.spoilers;
  if (sp !== undefined) {
    // Ground spoilers deploy by themselves on the wheels with the thrust levers at idle or reverse
    // selected (and with the speedbrake lever out); in the air the speedbrake lever sets them.
    const onWheels = (out.flags & EntityFlag.OnGround) !== 0;
    const liftDump = onWheels && (inputs.throttle <= LIFT_DUMP_IDLE_LEVER || inputs.reverseThrust === true || inputs.airbrake);
    const target = structuralFailure ? 0 : liftDump ? 1 : inputs.airbrake ? sp.speedbrakeFrac : 0;
    const cur = out.spoilerPos ?? 0;
    out.spoilerPos = rateLimitStep(cur, target, 1 / (target > cur ? sp.extendSec : sp.retractSec), dtSub);
  }
  if (def.massModel !== undefined || out.rampPos !== undefined) {
    out.rampPos = rateLimitStep(out.rampPos ?? 0, inputs.rampOpen ? 1 : 0, 1 / RAMP_TRANSIT_SEC, dtSub);
  }
}

/** Airbrake panel actuation times, full travel, seconds. */
export const AIRBRAKE_EXTEND_SEC = 1.2;
export const AIRBRAKE_RETRACT_SEC = 1.0;

export const stepAircraft: StepAircraft = (
  state: EntityState,
  damage: DamageState,
  inputs: PilotInputs,
  env: Environment,
  def: AircraftDefinition,
  dtSec: number,
  out: EntityState
): void => {
  if (out !== state) copyEntityState(state, out);

  const wasOnGroundAtEntry = (state.flags & EntityFlag.OnGround) !== 0;
  const structuralFailure = damage.structurePct <= 0;
  const entityIndex = entityPoolIndex(state.id);
  const inertia = getInertia(def);
  const dtSub = dtSec / FLIGHT_MODEL_SUBSTEPS;

  out.flags &= ~EntityFlag.OnGround;

  // Jettison drops the tanks and whatever fuel is left in them (idempotent while held).
  if (inputs.jettisonTanks && (out.dropTankCount ?? 0) > 0) {
    out.dropTankCount = 0;
    out.dropTankFuelKg = 0;
  }

  for (let s = 0; s < FLIGHT_MODEL_SUBSTEPS; s++) {
    runSubstep(out, damage, inputs, env, def, dtSub, wasOnGroundAtEntry, structuralFailure, entityIndex, inertia);
  }
};
