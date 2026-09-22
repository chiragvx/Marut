/**
 * =============================================================================
 * TEJAS SIM — FLIGHT MODEL CONTRACT (docs/spec/contracts/flight.ts)
 * =============================================================================
 * Owner: module 02 (docs/spec/02-flight-model.md). Implemented by src/physics/*.
 *
 * Imports only from './core' and './aircraft' (per 00-architecture.md section
 * 9.1, the one place the architecture mandates a leaf-to-leaf contract
 * import). Contains ONLY interfaces, type aliases, and constants — no
 * implementation, no class bodies. Must compile standalone with
 * `tsc --noEmit --strict` once contracts/aircraft.ts (module 03) exists.
 *
 * `AircraftDefinition` is imported OPAQUELY: this file never reaches into
 * `AircraftDefinition.aero` / `.engine` / `.gear` / `.fcsLimits`'s internal
 * fields at the type level (every signature below just carries `def` through
 * as a black box), so this file compiles regardless of how module 03 shapes
 * those sub-objects internally. The CONCRETE shape module 02's own
 * implementation assumes for those sub-objects is documented in
 * `02-flight-model.md` sections 3–5, NOT here — see that document's section 9
 * ("Open assumptions") for why, and for the assumed shape in full.
 * =============================================================================
 */

import type { Vec3Like, EntityState, PilotInputs, DamageState, AircraftTelemetry, WeatherConfig } from './core';
import type { AircraftDefinition } from './aircraft';

// -----------------------------------------------------------------------------
// 1. Environment — per-aircraft, per-tick atmospheric/wind context.
//    Mandated skeleton: 00-architecture.md section 9.1 fixes airDensityKgM3,
//    soundSpeedMps, windWorldMps, gravityMps2 exactly as shown there (do not
//    rename or retype these four fields). This contract ADDS two further
//    fields, groundElevationM and groundNormalWorld, because StepAircraft's
//    mandated 7-parameter signature (section 3 below) has no HeightSampler
//    parameter and the landing-gear model needs a ground reference; see
//    02-flight-model.md section 9 for the justification. src/core populates
//    ALL SIX fields once per aircraft per tick, BEFORE calling ComputeTelemetry
//    or StepAircraft, using: atmosphere via SampleAtmosphere (section 2), wind
//    via SampleWind (section 5), and ground via the injected HeightSampler's
//    heightAt/normalAt at (state.pos.x, state.pos.z).
// -----------------------------------------------------------------------------

export interface Environment {
  /** Ambient air density at the aircraft's current altitude, kg/m^3. From SampleAtmosphere. */
  airDensityKgM3: number;
  /** Local speed of sound at the aircraft's current altitude, m/s. From SampleAtmosphere. */
  soundSpeedMps: number;
  /** World-frame wind vector (base wind + gust already combined), m/s. From SampleWind. */
  windWorldMps: Vec3Like;
  /** Standard gravity, m/s^2. src/core passes core.ts's GRAVITY_MPS2 through explicitly so StepAircraft stays a pure function of its arguments (no implicit import of a hot-path constant). */
  gravityMps2: number;
  /**
   * Terrain surface elevation (world Y, m, MSL) at (state.pos.x, state.pos.z),
   * i.e. HeightSampler.heightAt(state.pos.x, state.pos.z). Used for AGL in
   * ComputeTelemetry and for landing-gear ground contact in StepAircraft. A
   * SINGLE sample at the aircraft's own horizontal position is used for ALL
   * three gear legs (deliberate simplification — see 02-flight-model.md
   * section 9): gear leg spacing (~1–3 m) is small relative to terrain
   * features, so per-leg sampling is not worth the extra HeightSampler calls.
   */
  groundElevationM: number;
  /**
   * Terrain unit surface normal (world frame) at the same point, i.e.
   * HeightSampler.normalAt(state.pos.x, state.pos.z, out). StepAircraft's gear
   * model uses world +Y instead of this value for the CONTACT force direction
   * (a further deliberate simplification, see 02-flight-model.md section 9);
   * this field is carried in Environment so a future revision can switch to
   * slope-aware gear contact without changing the function signature.
   */
  groundNormalWorld: Vec3Like;
}

// -----------------------------------------------------------------------------
// 2. Atmosphere (ISA model, 0–20 km). src/core calls SampleAtmosphere once per
//    aircraft per tick (using the aircraft's current altMslM, i.e. state.pos.y)
//    to fill Environment.airDensityKgM3/soundSpeedMps before calling
//    StepAircraft. Full formulas and reference-table check values are in
//    02-flight-model.md section 4.1.
// -----------------------------------------------------------------------------

export interface AtmosphereSample {
  densityKgM3: number;
  pressurePa: number;
  temperatureK: number;
  soundSpeedMps: number;
}

/** Pure, allocation-free: mutates and returns `out`. `altitudeMslM` may be negative (below MSL) or above 20000 m; see 02-flight-model.md section 4.1 for out-of-table behaviour. */
export type SampleAtmosphere = (altitudeMslM: number, out: AtmosphereSample) => AtmosphereSample;

// -----------------------------------------------------------------------------
// 3. StepAircraft — the module's single entry point called once per aircraft
//    entity, once per SIM_DT_SEC, by src/core's fixed-step loop. Mandated
//    signature: 00-architecture.md section 9.1 fixes this exact parameter
//    list and this exact Environment shape's four original fields; do not add
//    parameters. `state` is the entity's state at the START of this tick
//    (read-only in); `out` receives the state at the END of this tick and MAY
//    safely alias `state` for in-place integration (src/core is expected to
//    call `stepAircraft(s, damage, inputs, env, def, dt, s)`). `damage` is
//    READ-ONLY: core.ts documents DamageState as "written by src/combat,
//    read by src/physics" — StepAircraft scales control authority, thrust and
//    gear availability from it but never mutates it (see
//    02-flight-model.md section 9 for the consequence: hard-landing /
//    overstress structural damage is NOT applied by this function).
//    Pure and allocation-free: no `new`, no closures capturing per-call state,
//    all scratch Vec3/Quat/Mat3 objects reused across calls (module-level or
//    passed via a reusable scratch — implementation detail, not contract).
// -----------------------------------------------------------------------------

export type StepAircraft = (
  state: EntityState,
  damage: DamageState,
  inputs: PilotInputs,
  env: Environment,
  def: AircraftDefinition,
  dtSec: number,
  out: EntityState
) => void;

// -----------------------------------------------------------------------------
// 4. ComputeTelemetry — derives AircraftTelemetry (core.ts) from an
//    aircraft's CURRENT state (i.e. called with the state as it stands BEFORE
//    StepAircraft advances it this tick). src/core calls this once per
//    aircraft per tick to fill PilotContext.telemetry (consumed by
//    Pilot.update, both src/input and src/ai) and the Snapshot HUD block.
//    Recomputes alpha/beta/mach/gLoad etc. independently from StepAircraft's
//    internal per-substep values (a few trig/arithmetic ops, not worth
//    threading an extra output parameter through StepAircraft's mandated
//    signature for). Pure, allocation-free.
// -----------------------------------------------------------------------------

export type ComputeTelemetry = (
  state: EntityState,
  def: AircraftDefinition,
  env: Environment,
  damage: DamageState,
  out: AircraftTelemetry
) => AircraftTelemetry;

// -----------------------------------------------------------------------------
// 5. Wind & gust. One GustState per aircraft entity, created once at spawn
//    (src/core derives a per-entity sub-seed from WorldConfig.seed per
//    00-architecture.md section 13, e.g. `hash(seed, 'wind:' + entityId)`,
//    and constructs one PRNG stream from it) and reused every tick. Full
//    turbulence formula in 02-flight-model.md section 4.6.
// -----------------------------------------------------------------------------

/** Opaque per-entity gust-filter state. Fields are mutated in place by SampleWind; callers must not read them directly. */
export interface GustState {
  filteredGustWorld: Vec3Like;
}

/** Allocation-free: allocates the GustState object itself (called once at spawn, not in the hot path) but never allocates the Vec3Like it holds beyond that one call. */
export type CreateGustState = () => GustState;

/**
 * Combines WeatherConfig's steady wind with a PRNG-driven, low-pass-filtered
 * gust component and writes the result (steady + gust) into `out`. Pure given
 * (weather, state, rngNext, dtSec) — the only randomness is `rngNext`, which
 * MUST be a stream derived from WorldConfig.seed (never Math.random) so wind
 * is replay-deterministic. `state` is mutated in place (no allocation).
 */
export type SampleWind = (
  weather: WeatherConfig,
  state: GustState,
  rngNext: () => number,
  dtSec: number,
  out: Vec3Like
) => Vec3Like;

// -----------------------------------------------------------------------------
// 6. Constants. Fixed tuning values used by this module's algorithms
//    (02-flight-model.md section 4/5 gives the formula each one appears in
//    and the justification for its value). Aircraft-specific limits (alpha
//    limit, g limit, elevon travel, gains, …) are NOT here — those live in
//    AircraftDefinition.fcsLimits (module 03's data), because they differ per
//    airframe. These constants are airframe-independent engineering choices
//    this module makes once for all aircraft.
// -----------------------------------------------------------------------------

/** Number of internal semi-implicit-Euler substeps StepAircraft runs per call (each of length dtSec/FLIGHT_MODEL_SUBSTEPS). Fixed at 2 (effective 240 Hz internal integration) for gear-contact and high-rate-BFM stability; see 02-flight-model.md section 4.2. */
export const FLIGHT_MODEL_SUBSTEPS = 2;

/** Below this true airspeed (m/s), alpha/beta/aero forces are held at zero rather than evaluated (atan2/asin become ill-conditioned near V=0 and aero forces are negligible there anyway). */
export const MIN_AIRSPEED_FOR_AERO_MPS = 1.0;

/** gearPos must be at least this close to 1 (fully extended) before a leg's ground-contact physics is evaluated. */
export const GEAR_CONTACT_GEARPOS_THRESHOLD = 0.98;

/** Tyre rolling-resistance coefficient applied to a gear leg's rolling-direction friction when NOT braking (typical published aviation tyre value, 0.015–0.03 range). */
export const ROLLING_RESISTANCE_COEFFICIENT = 0.02;

/** Multiplier applied to GearDefinition's spring rate for compression beyond maxCompressionM (hard-stop stiffening), preventing ground penetration without a force discontinuity. */
export const GEAR_HARD_STOP_STIFFNESS_MULTIPLIER = 20;

/** Lateral (cornering) stiffness gain, N per (m/s) of lateral slip velocity, used by the gear friction model before saturating at the leg's kinetic-friction limit. */
export const GEAR_LATERAL_STIFFNESS_N_PER_MPS = 50000;

/** Fraction of AircraftDefinition.fcsLimits.maxElevonRad the on-ground direct pitch law (used instead of the airborne g-command law while EntityFlag.OnGround) maps full aft stick to. */
export const GROUND_LAW_PITCH_AUTHORITY_FRACTION = 0.5;
