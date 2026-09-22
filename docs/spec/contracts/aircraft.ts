/**
 * =============================================================================
 * TEJAS SIM — AIRCRAFT DATA CONTRACT (docs/spec/contracts/aircraft.ts)
 * =============================================================================
 * Owner: module 03 (docs/spec/03-tejas-data.md). Implemented by src/aircraft/*.
 *
 * Imports from './core' and './math' only (00-architecture.md section 8 —
 * this is the one contract-to-contract import architecture section 9.1
 * mandates: `contracts/flight.ts`, module 02, imports `AircraftDefinition`
 * from here). `Table2D` is `contracts/math.ts`'s real, pinned interface —
 * this file does not redeclare a local structural copy, since
 * (unlike `contracts/ai.ts`/`contracts/combat.ts`/`contracts/terrain.ts`,
 * which were drafted before `contracts/math.ts` existed) this file is
 * drafted AFTER math.ts and flight.ts, with both available to read, so an
 * exact import is safe here.
 *
 * EVERY SHAPE IN THIS FILE IS PINNED, FIELD-FOR-FIELD, BY `00-architecture.md`
 * SECTION 9.1 — `Hardpoint`, `WireframeGroup`, `WireframeModel`,
 * `AircraftDefinition`, `AeroTables`, `EngineTables`, `GearDefinition`,
 * `FcsLimits` here MUST exactly match that document's own code block. This
 * is what makes `contracts/flight.ts` (module 02, drafted blind to this
 * file) and `contracts/render.ts` (module 08, same) structurally compatible
 * with the real data this module ships, without either of those two other
 * drafters having ever seen this file.
 *
 * Contains ONLY interfaces, type aliases, and the one concrete, exported
 * `AircraftDefinition` VALUE this module exists to provide is NOT declared
 * here — `tejasDefinition` is real DATA, implemented in `src/aircraft/*.ts`,
 * not part of this compile-time-only contract file (consistent with every
 * other contract in this project: contracts declare shapes, `src/*` supplies
 * values). This file contains no class bodies, no function bodies. It must
 * compile standalone with `tsc --noEmit --strict`.
 * =============================================================================
 */

import type { Vec3Like } from './core';
import type { Table2D } from './math';

// -----------------------------------------------------------------------------
// 1. Weapon stations and the placeholder wireframe visual model.
// -----------------------------------------------------------------------------

export interface Hardpoint {
  id: string;
  /** Body-frame mounting position, m. */
  posBodyM: Vec3Like;
  type: 'gun' | 'ir_missile' | 'radar_missile' | 'fuel_tank';
}

/**
 * One moving part of the wireframe. `name` MUST be one of the six exact
 * strings `contracts/render.ts`'s `WIREFRAME_CONTROL_GROUP_NAMES` animates
 * (`elevonL`, `elevonR`, `rudder`, `noseGear`, `mainGearL`, `mainGearR`) for
 * this group to move at all — any other name is rendered static (rest pose
 * only). `vertexIndices` must all be valid indices into the enclosing
 * `WireframeModel.vertices`.
 */
export interface WireframeGroup {
  name: string;
  vertexIndices: readonly number[];
  /** Body-frame pivot point, m. */
  pivotBodyM: Vec3Like;
  /** Body-frame unit rotation axis. */
  axisBody: Vec3Like;
}

/**
 * Body-frame, m, rest pose. Per `contracts/render.ts`'s own doc comment,
 * this rest pose is authored at gearPos=0 (fully retracted) for the three
 * gear groups, and at zero deflection for elevonL/elevonR/rudder.
 */
export interface WireframeModel {
  vertices: readonly (readonly [number, number, number])[];
  /** Index pairs into `vertices`. */
  edges: readonly (readonly [number, number])[];
  groups: readonly WireframeGroup[];
}

// -----------------------------------------------------------------------------
// 2. Aerodynamic, engine, gear and FCS-limit data shapes. Pinned verbatim by
//    00-architecture.md section 9.1 — see that document for the full
//    rationale (this shape is what makes 02-flight-model.md's own section 5
//    assumption CORRECT rather than merely plausible).
// -----------------------------------------------------------------------------

/**
 * Aerodynamic coefficient tables and derivatives. `CL`/`CD`/`Cm` are
 * `Table2D` indexed `(alphaRad, mach)` — i.e. every consumer calls
 * `interpolate2D(table, alphaRad, mach)` (`contracts/math.ts`), never the
 * reverse argument order. SIGN RULE (00-architecture.md section 6.2):
 * `Cm_elevon` MUST be negative — a positive (trailing-edge-down) symmetric
 * elevon deflection produces a NOSE-DOWN pitching moment about the CG, the
 * conventional elevator/elevon sign. `03-tejas-data.md` section 5 documents
 * this module's actual numeric table and the resulting Cm(alpha) slope at
 * the trimmed alpha (relaxed-static-stability requirement).
 */
export interface AeroTables {
  CL: Table2D;
  CD: Table2D;
  Cm: Table2D;
  /** Per rad sideslip. */
  CY_beta: number;
  Cl_beta: number;
  Cn_beta: number;
  /** Per rad symmetric elevon. */
  CL_elevon: number;
  /** Per rad |symmetric elevon| (induced drag from control deflection). */
  CD_elevon: number;
  /** Per rad symmetric elevon. MUST be negative — see the sign rule above. */
  Cm_elevon: number;
  /** Per rad (elevonL - elevonR). */
  Cl_elevon: number;
  /** Per rad (elevonL - elevonR) — adverse/proverse yaw from differential elevon. */
  Cn_elevon: number;
  /** Per rad rudder. */
  CY_rudder: number;
  Cl_rudder: number;
  Cn_rudder: number;
  /** Per non-dimensional roll/yaw rate. */
  Cl_p: number;
  Cl_r: number;
  /** Per non-dimensional pitch rate. */
  Cm_q: number;
  Cn_p: number;
  Cn_r: number;
  /** Fractional CL increase at h/b=0 (ground effect). */
  groundEffectMaxDeltaCL: number;
  /** Alpha above which AircraftTelemetry.stalled = true. */
  stallAlphaRad: number;
}

/** Thrust/fuel-flow tables, each `Table2D` indexed `(mach, altitudeM)` — every consumer calls `interpolate2D(table, mach, altitudeM)`. */
export interface EngineTables {
  /** Thrust vs (mach, altitudeM), throttle=1, no afterburner, N. */
  militaryThrustN: Table2D;
  /** Thrust vs (mach, altitudeM), full afterburner, N. */
  afterburnerThrustN: Table2D;
  /** vs (mach, altitudeM), at throttle=1 military, kg/s. */
  militaryFuelFlowKgS: Table2D;
  /** vs (mach, altitudeM), full afterburner, kg/s. */
  afterburnerFuelFlowKgS: Table2D;
  idleFuelFlowKgS: number;
  /** First-order lag time constant, throttle response, s. */
  spoolTimeConstantSec: number;
}

/** One landing-gear leg. `AircraftDefinition.gear` has exactly three entries: ids `'nose'`, `'mainLeft'`, `'mainRight'`. */
export interface GearDefinition {
  id: string;
  /** Wheel-ground contact point, body frame, at full extension (gearPos=1), m. */
  posBodyM: Vec3Like;
  maxCompressionM: number;
  springNPerM: number;
  damperNPerMPerS: number;
  kineticFrictionCoefficient: number;
  /** True only for `'nose'`. */
  steerable: boolean;
  /** 0 for main gear. */
  maxSteerAngleRad: number;
  /** True only for main gear. */
  brakeCapable: boolean;
}

export interface FcsLimits {
  maxAlphaRad: number;
  minAlphaRad: number;
  /** Structural g limit, positive. */
  maxGLoadPos: number;
  /** Structural g limit, negative. */
  maxGLoadNeg: number;
  maxRollRateRadS: number;
  maxElevonRad: number;
  maxRudderRad: number;
  maxElevonRateRadS: number;
  maxRudderRateRadS: number;
  /** Kq, pitch damper. */
  pitchRateGain: number;
  /** Kp, roll rate-command loop gain. */
  rollRateGain: number;
  /** Kr, yaw damper. */
  yawRateGain: number;
  /** Ka, alpha-limiter proportional gain. */
  alphaLimitGain: number;
  /** Kg, g-command loop proportional gain. */
  gLoadGain: number;
}

// -----------------------------------------------------------------------------
// 3. AircraftDefinition — the one shape module 02 (contracts/flight.ts)
//    imports OPAQUELY (never names a field inside aero/engine/gear/fcsLimits
//    at the type level) and module 06/07/08/10 consume through core.ts's
//    generic vocabulary (`aircraftDefId: string`, resolved through the
//    FlightModelPort/CombatPort adapters at integration time — no other
//    leaf module imports this file directly, per 00-architecture.md
//    section 10's dependency graph: only src/physics and src/core do).
// -----------------------------------------------------------------------------

export interface AircraftDefinition {
  id: string;
  massKg: number;
  emptyMassKg: number;
  maxFuelKg: number;
  /** Body-frame inertia tensor about the CG, kg*m^2. */
  inertiaBodyKgM2: { xx: number; yy: number; zz: number; xy: number; xz: number; yz: number };
  cgOffsetBodyM: Vec3Like;
  wingAreaM2: number;
  wingSpanM: number;
  meanChordM: number;
  hardpoints: readonly Hardpoint[];
  wireframe: WireframeModel;
  aero: AeroTables;
  engine: EngineTables;
  gear: readonly GearDefinition[];
  fcsLimits: FcsLimits;
}
