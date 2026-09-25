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
import { EntityFlag } from '../contracts/core';
import type { AircraftDefinition } from '../contracts/aircraft';
import type { Environment, StepAircraft } from '../contracts/flight';
import { FLIGHT_MODEL_SUBSTEPS } from '../contracts/flight';
import type { Mat3 as Mat3Type } from '../contracts/math';
import { Vec3, Quat, Mat3, createMat3 } from '../math';
import { computeAirspeedFrame, computeAeroForceMoment, type AirspeedFrame, type AeroOutput } from './aeroForces';
import { stepEngine } from './engine';
import { computeGearLeg, stepGearPos, type GearLegOutput } from './landingGear';
import { stepFcs, entityPoolIndex, type FcsSurfaces } from './fcs';
import { integrateRigidBody } from './rigidBody';

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

/** Current all-up mass: empty airframe + internal fuel + carried stores + drop tanks (shells + fuel). */
export function aircraftMassKg(
  state: Pick<EntityState, 'fuelKg' | 'storesMassKg' | 'dropTankCount' | 'dropTankFuelKg'>,
  def: Pick<AircraftDefinition, 'emptyMassKg' | 'dropTank'>
): number {
  const tankShellsKg = (state.dropTankCount ?? 0) * (def.dropTank?.emptyMassKg ?? 0);
  return def.emptyMassKg + state.fuelKg + (state.storesMassKg ?? 0) + tankShellsKg + (state.dropTankFuelKg ?? 0);
}

/** Drag area (CD*S, m^2) of carried stores plus attached drop tanks. */
function externalDragAreaM2(state: EntityState, def: AircraftDefinition): number {
  return (state.storesDragAreaM2 ?? 0) + (state.dropTankCount ?? 0) * (def.dropTank?.dragAreaM2 ?? 0);
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
  dst.storesMassKg = src.storesMassKg;
  dst.storesDragAreaM2 = src.storesDragAreaM2;
  dst.dropTankCount = src.dropTankCount;
  dst.dropTankFuelKg = src.dropTankFuelKg;
  dst.flags = src.flags;
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

  if (!structuralFailure) {
    const configDragCoeff =
      out.gearPos * (def.aero.CD_gear ?? 0) +
      (inputs.airbrake ? (def.aero.CD_airbrake ?? 0) : 0) +
      (def.wingAreaM2 > 0 ? externalDragAreaM2(out, def) / def.wingAreaM2 : 0);
    computeAeroForceMoment(scratchFrame, out.elevonL, out.elevonR, out.rudder, out.omega, altAglM, def, scratchAero, configDragCoeff);
  } else {
    Vec3.set(scratchAero.forceBody, 0, 0, 0);
    Vec3.set(scratchAero.momentBody, 0, 0, 0);
  }

  if (!structuralFailure) {
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
      def.fcsLimits,
      dtSub,
      scratchFrame.qBar,
      scratchFrame.Vt
    );
    out.elevonL = scratchSurfaces.elevonL;
    out.elevonR = scratchSurfaces.elevonR;
    out.rudder = scratchSurfaces.rudder;
  }

  // Scaling the inertia tensor by s is equivalent to scaling the applied moment by 1/s in Euler's
  // equation (the gyroscopic term's s cancels), so the cached tensor is reused as-is.
  const inertiaScale = 1 + INERTIA_MASS_SENSITIVITY * (massKg / def.massKg - 1);
  Vec3.scale(scratchTotalMoment, 1 / inertiaScale, scratchTotalMoment);
  integrateRigidBody(out, scratchTotalForce, scratchTotalMoment, massKg, inertia.I, inertia.Iinv, dtSub);

  stepGearPos(out, inputs, damage.gearHealthPct, dtSub);
  if (inputs.gearDown) out.flags |= EntityFlag.GearDownCommanded;
  else out.flags &= ~EntityFlag.GearDownCommanded;
  if (inputs.airbrake) out.flags |= EntityFlag.AirbrakeOut;
  else out.flags &= ~EntityFlag.AirbrakeOut;
}

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
