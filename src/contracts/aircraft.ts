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

import type { Vec3Like, WeaponKind } from './core';
import type { Table1D, Table2D } from './math';

// -----------------------------------------------------------------------------
// 1. Weapon stations and the placeholder wireframe visual model.
// -----------------------------------------------------------------------------

export interface Hardpoint {
  id: string;
  /** Body-frame mounting position, m. */
  posBodyM: Vec3Like;
  /** The store's kind: a WeaponKind (core.ts), a drop tank, or a sensor pod. */
  type: WeaponKind | 'fuel_tank' | 'pod';
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
  /** Drag coefficient increment with the landing gear fully extended (scaled by gearPos). Optional: absent means 0. */
  CD_gear?: number;
  /** Drag coefficient increment with the airbrake extended (scaled by airbrake position). Optional: absent means 0. */
  CD_airbrake?: number;
  /** Drag and pitching-moment increments with the cargo ramp/door fully open (scaled by EntityState.rampPos). Optional: absent means 0. */
  CD_ramp?: number;
  Cm_ramp?: number;
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
  /**
   * False for an engine with no reheat (the afterburner tables are then ignored and the
   * afterburner input does nothing). Absent = true (the fighters). Only read by the
   * multi-engine model (AircraftDefinition.engines).
   */
  hasAfterburner?: boolean;
  /**
   * Thrust at idle, fraction of `militaryThrustN` (flight idle). Absent = 0 (thrust is
   * throttle x military, today's single-engine model). Multi-engine model only.
   */
  idleThrustFrac?: number;
  /**
   * Two-rate N1 spool model (multi-engine model only): spool-up time constant below / above
   * `breakN1Frac` of N1, spool-down time constant. Absent = `spoolTimeConstantSec` throughout.
   */
  spool?: { upLowTauSec: number; upHighTauSec: number; breakN1Frac: number; downTauSec: number };
  /** Thrust reversers (multi-engine model only). Absent = none. */
  reverser?: ReverserDefinition;
  /**
   * Hot-day derating: thrust x (1 - thrustLossPerK x (ISA deviation - flatRateIsaDevK)) above the
   * flat-rate temperature. Absent = no temperature effect. Multi-engine model only.
   */
  hotDay?: { flatRateIsaDevK: number; thrustLossPerK: number };
}

/** Cascade thrust reversers. */
export interface ReverserDefinition {
  /** Reverse thrust as a fraction of the forward thrust at the same N1 (ground, full reverse). */
  thrustFrac: number;
  /** In-flight/ram drag of a deployed reverser: D = ramDragCoeff x rho x V^2 x fanAreaM2, per engine, N. */
  ramDragCoeff: number;
  fanAreaM2: number;
  /** Deploy or stow time, s. */
  transitSec: number;
  /** In flight the engine logic holds reverse at idle (true for the C-17). */
  idleOnlyInFlight: boolean;
  /** Placard: highest airspeed (IAS, m/s) for ground reverse; exceeding it only raises a telemetry warning. */
  maxGroundIasMps?: number;
}

/**
 * One engine of a multi-engine aircraft (AircraftDefinition.engines). The thrust acts along body
 * +x through `posBodyM`, so an engine off the centreline makes a yawing moment when its thrust
 * differs from its opposite number's (engine-out yaw comes from position, nothing else).
 */
export interface EngineInstanceDefinition {
  id: string;
  /** Thrust line position, body frame relative to the reference CG, m. */
  posBodyM: Vec3Like;
}

/** One flap-lever detent (AircraftDefinition.highLift). Increments are added to the clean tables. */
export interface FlapDetentDefinition {
  /** HUD/telemetry name, e.g. 'UP', 'SLATS', '1/2', '3/4', 'FULL'. */
  name: string;
  /** Slats extended in this detent. */
  slats: boolean;
  /** Aft flap segment angle, deg (for the renderer and the jet-turning angle). */
  flapDeg: number;
  /** Lift increment at a given alpha (in the linear range), unpowered. */
  dCL0: number;
  /** Stall-alpha shift of the lift curve, rad: CLmax rises by dCL0 + CLalpha x dAlphaStallRad. */
  dAlphaStallRad: number;
  dCD0: number;
  /** Pitching-moment increment about the reference CG, before trim. */
  dCm0: number;
  /** Externally blown flap efficiency: dCL_EBF = ebfEta x F(Cmu). 0 = no powered lift. */
  ebfEta: number;
  /** Placard: highest IAS, m/s, and Mach with the lever in this detent (exceeding it only warns). */
  maxIasMps: number;
  maxMach: number;
}

/** Slats/flaps and powered lift. Absent = a clean wing (the fighters). */
export interface HighLiftDefinition {
  detents: readonly FlapDetentDefinition[];
  /** Seconds for the flaps to travel one detent; slats take `slatTransitSec` in or out. */
  flapSecPerDetent: number;
  slatTransitSec: number;
  /** Lift-dependent drag factor K (CD_i = K CL^2), used to correct the clean table's induced drag for the extra lift. */
  inducedDragK: number;
  /** Static margin (fraction of the mean chord) the clean Cm table was built with. */
  staticMargin: number;
  /** Clean-wing stall alpha (ys, rad) vs Mach (xs): the lift curve's peak in the clean table. */
  cleanStallAlpha: Table1D;
  /** Externally blown flap powered lift. Absent = none. */
  ebf?: {
    /** F(Cmu): lift increment per unit flap efficiency (ys) vs thrust coefficient Cmu = T/(q S/2) per wing half (xs). */
    lift: Table1D;
    /**
     * The stall alpha rises by stallAlphaRadPerDCL x dCL_EBF, so CLmax rises by
     * (1 + CLalpha x stallAlphaRadPerDCL) x dCL_EBF.
     */
    stallAlphaRadPerDCL: number;
    /** dCm = cmPerDCL x dCL_EBF (nose-down flap loads). */
    cmPerDCL: number;
    /** Spanwise arm of each wing half's blown lift, m: an engine out rolls the jet. */
    rollArmM: number;
    /** Jet-turning angle = turnFrac x aft flap angle: the blown engines lose cos(angle) of axial thrust. */
    turnFrac: number;
    /** Ground effect fades to zero at this Cmu (jet impingement). */
    groundEffectZeroCmu: number;
  };
}

/** Spoiler panels: in-flight speedbrake and ground lift dump. Absent = the plain `CD_airbrake` airbrake. */
export interface SpoilerDefinition {
  /** Panel position (0..1 of full travel) the in-flight speedbrake uses; lift dump uses 1. */
  speedbrakeFrac: number;
  /** Full in-flight speedbrake increments. */
  speedbrake: { dCL: number; dCD: number; dCm: number };
  /** Full ground lift dump increments: dCL with the wing clean and with landing flaps (flap detent >= `liftDumpFlapsFromDetent`). */
  liftDump: { dCLClean: number; dCLFlaps: number; dCD: number; dCm: number; liftDumpFlapsFromDetent: number };
  extendSec: number;
  retractSec: number;
}

/**
 * Mass distribution for aircraft whose mass changes a lot (fuel, cargo). Absent = the fighters'
 * rule (inertia scaled with mass by a fixed sensitivity, CG fixed).
 */
export interface MassModelDefinition {
  /** Inertia added per kg of fuel / of cargo (the k^2 of each about the CG), m^2 per axis. */
  fuelInertiaM2: { xx: number; yy: number; zz: number };
  cargoInertiaM2: { xx: number; yy: number; zz: number };
  /** Body x of the empty aircraft's CG, the fuel's CG and the default cargo CG, m (reference CG = 0). */
  emptyCgBodyX: number;
  fuelCgBodyX: number;
  cargoCgBodyX: number;
  /** Largest cargo load, kg (the loader clamps to it). */
  maxCargoKg: number;
}

/** Speed placards that only raise telemetry warnings when exceeded. */
export interface PlacardDefinition {
  /** Highest IAS, m/s, with the gear down or moving. */
  gearMaxIasMps?: number;
  /** Vmo (IAS, m/s) and Mmo. */
  vmoIasMps?: number;
  mmo?: number;
  /** Highest IAS, m/s, with the cargo ramp/door open or moving. */
  rampMaxIasMps?: number;
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
  /**
   * Steerable legs: the wheelbase the steering turns about (to the main gear), m. With it the
   * steering angle is capped so a turn at speed stays within NWS_MAX_LATERAL_ACCEL_MPS2.
   */
  steeringWheelbaseM?: number;
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
  // --- Optional transport-FCS extensions. Absent = the fighters' behaviour, unchanged. ---
  /** g limits with the flaps or slats out (replace maxGLoadPos/maxGLoadNeg there). */
  flapsDownMaxGLoadPos?: number;
  flapsDownMaxGLoadNeg?: number;
  /** Bank protection: the roll-rate command tapers to `highBankRollRateRadS` past `bankRateReduceAboveRad` and to 0 at `maxBankRad`. */
  maxBankRad?: number;
  bankRateReduceAboveRad?: number;
  highBankRollRateRadS?: number;
  /** Ground-law rotation rate at full aft stick, rad/s (default GROUND_LAW_MAX_ROTATION_RATE_RAD_S). */
  groundRotationRateRadS?: number;
  /** Trim-integral authority, rad of elevator (default ~12 deg); a transport's trimmable stabiliser adds to it. */
  trimIntegralMaxRad?: number;
  /** Ceiling on the commanded pitch rate, rad/s (default 60 deg/s). */
  maxPitchRateCmdRadS?: number;
  /**
   * The alpha limit as a fraction of the configured stall alpha (flaps, slats, powered lift):
   * used instead of maxAlphaRad when the aircraft has AircraftDefinition.highLift.
   */
  alphaLimitStallFrac?: number;
  /** Sideslip-command yaw law: rudder integral gain, rad of rudder per (rad of sideslip x s). Absent = the direct rudder law. */
  sideslipIntegralGain?: number;
  /**
   * Pitch-attitude protection, rad: the commanded pitch rate tapers to hold the nose between these
   * (a transport's +25/-15 deg envelope). Absent = no attitude limit.
   */
  maxPitchAttitudeRad?: number;
  minPitchAttitudeRad?: number;
  /**
   * Pitch-rate ceiling for the alpha limiter's own path, rad/s. The g path's ceiling is sized so the
   * elevator never saturates in steady state, which at low dynamic pressure leaves the limiter too
   * little nose-down rate to follow a falling flight path; a transport lets the limiter use this
   * instead. Absent = the g path's ceiling (the fighters).
   */
  alphaPathMaxPitchRateRadS?: number;
  /**
   * Roll-rate command / attitude hold: an integral on the roll-rate error, rad of differential
   * elevon per rad of bank error, 1/s, so the bank stays where the pilot left it against a steady
   * rolling moment (an engine failure's blown-flap lift asymmetry). Absent = pure rate command.
   */
  rollIntegralGain?: number;
  /**
   * Ground-law rotation integral, 1/s: while the stick is pulled on the ground the rotation-rate
   * error is integrated into the elevator (a heavy transport's nose-gear load needs most of the
   * elevator to rotate, which a proportional rate loop alone never reaches). The integral carries
   * into the air law at lift-off as its pitch trim and bleeds off when the stick is released.
   * Absent = the fighters' proportional ground law.
   */
  groundRotationIntegralGain?: number;
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

export interface DropTankSpec {
  /** Usable fuel per tank when full, kg. */
  capacityKg: number;
  /** Mass of one empty tank, kg. */
  emptyMassKg: number;
  /** Drag area of one tank (CD*S), m^2. */
  dragAreaM2: number;
}

/** A weapon station (hardpoint): where it is and which catalogue stores it can carry. */
export interface StationDef {
  id: string;
  /** Body-frame mounting position, m. */
  posBodyM: Vec3Like;
  /** Catalogue store ids (src/catalog) this station can carry. */
  accepts: readonly string[];
  /** Most of one store carried at once (twin/triple racks; rounds for the gun). */
  maxCount: number;
}

/** A named store fit: station id -> store id and count. Stations left out are empty. */
export interface LoadoutPreset {
  id: string;
  name: string;
  fit: Readonly<Record<string, { store: string; count: number }>>;
}

/** Sensors and self-protection systems carried (catalogue ids where the system has data). */
export interface AircraftSensors {
  /** Fire-control radar (src/catalog/sensors.ts RADARS). */
  radar?: string;
  /** IFF interrogator fitted. */
  iff?: boolean;
  /** Radar-warning receiver / EW suite id. */
  rwr?: string;
  /** Missile-approach warner fitted. */
  maws?: boolean;
  /** Self-protection jammer id. */
  jammer?: string;
  /** Countermeasure dispensers: chaff and flare cartridges. */
  countermeasures?: { chaff: number; flares: number };
}

/** How the aircraft looks to sensors and weapons. */
export interface AircraftSignature {
  /** Radar cross-section nose-on and beam-on, m^2. */
  rcsNoseOnM2: number;
  rcsBroadsideM2: number;
  /** Hit-test ellipsoid semi-axes, body frame, m. */
  hitEllipsoidBodyM: Vec3Like;
}

export interface AircraftDefinition {
  id: string;
  /** e.g. "HAL Tejas Mk1A". */
  displayName?: string;
  /** Weapon stations (the hardpoints, with what each can carry). When present, `hardpoints` is the default loadout's view of them. */
  stations?: readonly StationDef[];
  loadouts?: readonly LoadoutPreset[];
  defaultLoadoutId?: string;
  sensors?: AircraftSensors;
  signature?: AircraftSignature;
  massKg: number;
  emptyMassKg: number;
  maxFuelKg: number;
  /** Maximum take-off weight, kg (the loadout screen shows the fit against it; nothing enforces it). */
  maxTakeoffMassKg?: number;
  /** Its 3D model (contracts/core.ts AircraftModel code); absent = the Tejas's. */
  renderModel?: number;
  /** Landing gear's full up<->down travel time, s (physics/landingGear.ts); absent = 2 s (the fighters'). */
  gearTransitSec?: number;
  /**
   * External drop tank carried on each `type: 'fuel_tank'` hardpoint (all identical). Optional:
   * absent means the aircraft carries none. Fuel is burned from the tanks before internal fuel.
   */
  dropTank?: DropTankSpec;
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
  /**
   * Hard points on the airframe's skin, body frame, m: belly, nose, nozzle, wing tips and trailing
   * edge, fin tip, canopy. Any of them touching the ground is a crash (src/core/world.ts); only the
   * wheels may touch it. Optional: without them, only the terrain-impact fallback applies.
   */
  airframeContactPointsBodyM?: readonly Vec3Like[];
  /**
   * Multi-engine aircraft: one entry per engine (each with its own spool, failure flag and
   * reverser, `EntityState.engines`). `engine` is then the per-engine table. Absent = one engine
   * on the centreline through the CG (the fighters' original model, unchanged).
   */
  engines?: readonly EngineInstanceDefinition[];
  /** Slats, flap detents and powered lift. Absent = clean wing only. */
  highLift?: HighLiftDefinition;
  /** Spoilers (speedbrake + ground lift dump) in place of the plain airbrake. */
  spoilers?: SpoilerDefinition;
  /** Fuel/cargo mass distribution (inertia and CG move with them). */
  massModel?: MassModelDefinition;
  /** Speed placards (telemetry warnings). */
  placards?: PlacardDefinition;
}
