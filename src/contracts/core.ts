/**
 * =============================================================================
 * TEJAS SIM — CORE CONTRACT (docs/spec/contracts/core.ts)
 * =============================================================================
 * Owner: module 00 (docs/spec/00-architecture.md). This file is the ROOT of the
 * contract graph: it imports NOTHING (no other contract, no npm package, no
 * DOM lib). Every other contract file (math.ts, flight.ts, aircraft.ts,
 * terrain.ts, airport.ts, ai.ts, combat.ts, render.ts, input.ts, sim.ts,
 * ui.ts, verify.ts) may `import type { ... } from './core'`.
 *
 * This file contains ONLY interfaces, type aliases, `as const` objects and
 * derived union types, and bare function-signature type aliases
 * (`export type Foo = (...) => Bar`). NO classes with bodies, NO executable
 * logic. It must compile standalone with `tsc --noEmit --strict`.
 *
 * -----------------------------------------------------------------------------
 * COORDINATE FRAMES, UNITS AND SIGN CONVENTIONS — READ THIS BLOCK FIRST.
 * Full derivation and a worked numeric example live in
 * docs/spec/00-architecture.md section 3. This comment is the terse
 * reference; the two documents MUST NOT disagree, and 00-architecture.md is
 * the tie-breaker if they ever appear to.
 *
 * World frame: right-handed, +Y up, +X east, -Z north (+Z south).
 *   heading 0 rad = north (-Z), heading +pi/2 rad = east (+X), heading
 *   increases CLOCKWISE viewed from above (+Y looking down).
 *   forwardWorld(heading) = (sin(heading), 0, -cos(heading)).
 *
 * Body frame: +X forward (nose), +Y up (canopy), +Z right (starboard wing).
 *   Right-handed (X × Y = Z). Body→world rotation is the entity quaternion
 *   `rot` / `q`: v_world = q * v_body * conj(q).
 *
 * Angular velocity `omega = (wx, wy, wz)` is ALWAYS in body frame, rad/s,
 * about body X, Y, Z respectively. Aerodynamic body rates (textbook p, q, r)
 * are NOT the same components 1:1 because the body frame here is Y-up
 * (canopy), not the classical Z-down aero body frame:
 *   p (roll rate,  + = right roll)  =  wx
 *   q (pitch rate, + = nose up)     =  wz
 *   r (yaw rate,   + = nose right)  = -wy
 * Implement and use ONLY through src/math's named accessors so every module
 * agrees: `bodyRateP(omega)`, `bodyRateQ(omega)`, `bodyRateR(omega)`
 * (contracts/math.ts, module 01). Never read `.y` and call it yaw rate.
 *
 * Angle of attack / sideslip, computed from the BODY-FRAME AIRSPEED vector
 * v_air_body = worldToBody(q, v_world_entity - windWorld):
 *   alpha = atan2(-v_air_body.y, v_air_body.x)   (+ = air from below)
 *   beta  = asin(v_air_body.z / |v_air_body|)     (+ = air from the right)
 *
 * Euler yaw/pitch/roll → quaternion (for display and for constructing spawn
 * orientations), composed in this exact order and using these exact axes:
 *   qYaw   = axisAngle(worldY,  PI/2 - headingRad)
 *   qPitch = axisAngle(bodyZ,   pitchRad)      // + = nose up
 *   qRoll  = axisAngle(bodyX,   rollRad)       // + = right wing down
 *   q = qYaw ⊗ qPitch ⊗ qRoll   (Hamilton product, qYaw applied outermost)
 * Sanity check (verified in 00-architecture.md worked example): heading =
 * PI/2 (due east), pitch = 0, roll = 0  ⇒  q = (0,0,0,1) identity.
 *
 * PilotInputs axes: pitch +1 = stick full aft = nose-up command; roll +1 =
 * roll right; yaw +1 = nose right; throttle 0=idle..1=full military.
 *
 * Units: SI throughout runtime code (metres, kilograms, seconds, Newtons,
 * radians). Degrees appear ONLY in data tables / UI and are always suffixed
 * `Deg` in a field name when they do. Gravity = GRAVITY_MPS2 along -Y.
 *
 * Determinism: no `Math.random()` anywhere under src/math, src/physics,
 * src/aircraft, src/terrain, src/airport, src/ai, src/combat, src/core. Use
 * the seeded mulberry32 PRNG from src/math (contracts/math.ts).
 * =============================================================================
 */

// -----------------------------------------------------------------------------
// 0. Generic result type (shared error-handling shape; see 00-architecture.md
//    section "Coding rules — error handling"). Validation / parsing functions
//    return this instead of throwing.
// -----------------------------------------------------------------------------

/** A successful result carrying `value`, or a failure carrying `error`. */
export type Result<T, E = string> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

// -----------------------------------------------------------------------------
// 1. Minimal structural math types. The REAL, full-featured, mutable Vec3/Quat
//    classes are owned by contracts/math.ts (module 01), whose `Vec3`/`Quat`
//    types are structurally assignable to these. Anything in THIS file that
//    only needs to read/write x,y,z(,w) uses these, so core.ts never has to
//    import math.ts (core imports nothing).
// -----------------------------------------------------------------------------

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

// -----------------------------------------------------------------------------
// 2. Global numeric constants. Every module reads these from here; nobody
//    redefines them locally.
// -----------------------------------------------------------------------------

/** Fixed sim-worker physics/AI/combat step rate, Hz. Never varies with quality tier. */
export const SIM_HZ = 120;
/** Fixed sim timestep, seconds. = 1 / SIM_HZ. */
export const SIM_DT_SEC = 1 / SIM_HZ;
/** Rate at which the sim worker emits Snapshot buffers to the main thread, Hz. */
export const SNAPSHOT_HZ = 60;
/** Standard gravity, m/s^2, applied along world -Y. */
export const GRAVITY_MPS2 = 9.80665;
/** Distance (m) the render origin must be from the camera before floating-origin rebase. */
export const FLOATING_ORIGIN_REBASE_DISTANCE_M = 4000;
/** ILS localiser full-scale deflection, degrees, used to normalise HUD_OFF_ILS_LOC to [-1,1]. */
export const ILS_LOC_FULL_SCALE_DEG = 2.5;
/** ILS glideslope full-scale deflection, degrees, used to normalise HUD_OFF_ILS_GS to [-1,1]. */
export const ILS_GS_FULL_SCALE_DEG = 0.7;
/** Nominal ILS glideslope angle, radians (~3 degrees), used when a layout does not override it. */
export const ILS_DEFAULT_GLIDESLOPE_RAD = 0.05236;

// -----------------------------------------------------------------------------
// 3. Entity identity.
// -----------------------------------------------------------------------------

export const EntityKind = {
  Aircraft: 'aircraft',
  Missile: 'missile',
  Bullet: 'bullet',
  Effect: 'effect',
} as const;
export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

/** Numeric wire code for EntityKind, used in the Float64 snapshot buffer (see SnapshotEntity below). */
export const EntityKindCode: Record<EntityKind, number> = {
  aircraft: 0,
  missile: 1,
  bullet: 2,
  effect: 3,
} as const;
export const EntityKindByCode: readonly EntityKind[] = ['aircraft', 'missile', 'bullet', 'effect'];

/** 0 = friendly/player side, 1 = hostile side. Exactly two teams; no neutrals. */
export type Team = 0 | 1;

/**
 * Stable entity identifier = index (low bits) + generation counter (high bits)
 * of the pool slot, so a stale reference (e.g. an AI's remembered target, a
 * missile's seeker lock) can detect that its slot was recycled by a new
 * entity and drop the reference instead of tracking the wrong thing.
 *
 * IMPORTANT: pack/unpack with plain arithmetic, NEVER with `<<`/`>>>`. Bitwise
 * operators in JS coerce to signed 32-bit and `generation << 16` becomes
 * negative once `generation >= 0x8000`, corrupting the id. Always use
 * multiplication/division/modulo as shown in packEntityId/unpackEntityId.
 */
export type EntityId = number;

/** Pool slot index occupies this many low-order "digits" (base ENTITY_INDEX_RADIX) of an EntityId. */
export const ENTITY_INDEX_BITS = 16;
/** = 2^ENTITY_INDEX_BITS. Also the max representable pool size before generation would collide with index. */
export const ENTITY_INDEX_RADIX = 65536;
/** Sentinel EntityId meaning "no entity" (e.g. Contact.id never uses this; used for optional target fields as 0 with a separate boolean, or -1). Consumers should prefer `undefined` over this sentinel where the field is optional. */
export const NO_ENTITY_ID: EntityId = -1;

export type PackEntityId = (index: number, generation: number) => EntityId;
export type UnpackEntityId = (id: EntityId) => { index: number; generation: number };

// -----------------------------------------------------------------------------
// 4. Entity runtime state — the lean, per-tick-mutated state every entity
//    kind carries. This is what src/core pools, what src/physics integrates
//    (aircraft/missiles/bullets), and what gets serialised into a Snapshot.
//    Fields not meaningful for a given EntityKind are present for uniform
//    stride but are zero/ignored (documented per field below).
// -----------------------------------------------------------------------------

export const EntityFlag = {
  /** This entity is the local player's aircraft. */
  IsPlayer: 1 << 0,
  /** Weight-on-wheels: at least one gear leg is compressed against the ground. */
  OnGround: 1 << 1,
  /** Gear is commanded down (may still be transitioning; see gearPos). */
  GearDownCommanded: 1 << 2,
  /** Airbrake/speedbrake commanded extended. */
  AirbrakeOut: 1 << 3,
  /** Exterior lights on (nav/strobe), cosmetic only. */
  Lights: 1 << 4,
} as const;
export type EntityFlags = number; // bitmask of EntityFlag values

export interface EntityState {
  /** Stable id; see EntityId. */
  id: EntityId;
  kind: EntityKind;
  team: Team;

  /** World-frame position, metres. Absolute (not camera-relative); always a plain float64 JS number, never Math.fround'd. */
  pos: Vec3Like;
  /** Body→world rotation quaternion, unit length. */
  rot: QuatLike;
  /** World-frame linear velocity, m/s. */
  vel: Vec3Like;
  /** Body-frame angular velocity, rad/s, about body X/Y/Z. See the frame comment at the top of this file for the p/q/r mapping. */
  omega: Vec3Like;

  alive: boolean;
  /** Health, 0..100. 0 = destroyed. For bullets this is unused (bullets are removed via `alive=false` on impact/timeout, not hp depletion); always 100 while alive. */
  hp: number;

  // --- Aircraft-specific visual/control state. Zero for missile/bullet/effect. ---
  /** Fuel remaining, kg. Aircraft only; always 0 for missile/bullet/effect. The single authoritative fuel value: src/physics's `stepAircraft` (contracts/flight.ts, module 02) reads and writes this field directly (burns it every substep per that module's fuel-flow-table model) — no other module maintains an independent fuel estimate. src/core initialises it from `AircraftDefinition.maxFuelKg` at spawn. */
  fuelKg: number;
  /** Left elevon deflection, rad. + = trailing edge DOWN (produces a NOSE-DOWN pitching moment about the CG — the conventional elevator/elevon sign: pulling the stick back commands trailing-edge UP, nose-up). Combined asymmetrically (elevonL vs elevonR) it still produces roll exactly as documented on elevonR below; see 00-architecture.md section 3 and 02-flight-model.md section 5.1 for the required sign of `Cm_elevon` (negative) this convention implies. */
  elevonL: number;
  /** Right elevon deflection, rad. Same sign convention as elevonL. */
  elevonR: number;
  /** Rudder deflection, rad. + = trailing edge LEFT (produces nose-left / +wy yawing moment). */
  rudder: number;
  /** Landing gear position, 0 = fully retracted, 1 = fully extended. */
  gearPos: number;
  /** Current throttle lever position actually applied by the flight model, 0..1 (may lag PilotInputs.throttle per engine spool dynamics). */
  throttle: number;
  afterburnerOn: boolean;
  /**
   * Mass of carried stores (missiles + gun ammunition), kg. Aircraft only. Written each tick by
   * src/core's combat adapter from the live weapon-station counts, so it drops as weapons are
   * used; read by src/physics's `stepAircraft`, whose total mass is
   * `AircraftDefinition.emptyMassKg + fuelKg + storesMassKg`. Optional: absent means 0 (clean).
   */
  storesMassKg?: number;
  /**
   * Airbrake panel extension, 0 (stowed) .. 1 (fully out), moving towards PilotInputs.airbrake at
   * the panels' actuation rate (src/physics/integrator.ts). Drag scales with it. Optional: absent means 0.
   */
  airbrakePos?: number;
  /** Drag area (CD*S, m^2) of carried stores, added to the airframe's drag. Same ownership as storesMassKg. Optional: absent means 0. */
  storesDragAreaM2?: number;
  /**
   * Drop tanks still attached (0 after jettison), and the fuel remaining across all of them, kg.
   * Aircraft only. src/core sets them at spawn from AircraftDefinition.dropTank; src/physics burns
   * tank fuel before internal `fuelKg` and zeroes both on PilotInputs.jettisonTanks. Optional:
   * absent means no tanks.
   */
  dropTankCount?: number;
  dropTankFuelKg?: number;

  /** Bitmask of EntityFlag. */
  flags: EntityFlags;
}

// -----------------------------------------------------------------------------
// 5. Damage state — written by src/combat (hit resolution, subsystem damage
//    model), read by src/physics (flight model scales control authority /
//    engine output / gear availability accordingly) and by src/hud (warnings).
//    Kept in core.ts (rather than combat.ts) precisely because it is the one
//    shape both contracts/flight.ts (module 02) and contracts/combat.ts
//    (module 07) must agree on byte-for-byte without seeing each other's
//    contract file during drafting.
// -----------------------------------------------------------------------------

export interface ControlSurfaceHealth {
  /** 0..1 authority remaining. 1 = fully functional, 0 = surface destroyed/jammed at its last position. Scales max deflection AND max deflection rate. */
  elevonL: number;
  elevonR: number;
  rudder: number;
}

export interface DamageState {
  /** 0..1 overall airframe structural integrity. At 0 the airframe fails (module 02's integrator must treat this as an immediate crash/breakup event, not a divide-by-zero). */
  structurePct: number;
  /** 0..1. At 0, engine thrust output is forced to 0 (flameout/destroyed) regardless of throttle input. */
  engineHealthPct: number;
  controlSurfaces: ControlSurfaceHealth;
  /** false = hydraulic failure; flight model must freeze remaining-authority surfaces at their current position rather than driving them further, and FCS control laws degrade per 02's spec. */
  hydraulicsOk: boolean;
  /** true = active fuel leak; src/physics deducts extra fuel burn per 02's spec constant. */
  fuelLeak: boolean;
  /** 0..1. Scales radar detection range and lock-acquisition probability in src/combat and src/ai. */
  radarHealthPct: number;
  /** 0..1. At 0 the gear cannot be lowered (or collapses immediately on next touchdown if already down); flight model consults this before honouring PilotInputs.gearDown. */
  gearHealthPct: number;
}

// -----------------------------------------------------------------------------
// 6. Pilot input, and the Pilot interface both src/input (human) and src/ai
//    (AI) implement identically — the sim worker never knows which is which.
// -----------------------------------------------------------------------------

export interface PilotInputs {
  /** [-1,1]. +1 = stick full aft = nose-up command. */
  pitch: number;
  /** [-1,1]. +1 = roll right command. */
  roll: number;
  /** [-1,1]. +1 = nose-right (rudder) command. */
  yaw: number;
  /** [0,1]. 0 = idle, 1 = full military power. */
  throttle: number;
  /** Afterburner detent commanded. Only effective while throttle === 1 (see 02's engine model). */
  afterburner: boolean;
  /** [0,1] wheel brake application (both mains together; no differential braking modelled). */
  brakes: number;
  /** Landing gear commanded down (true) or up (false). */
  gearDown: boolean;
  /** Speedbrake/airbrake commanded extended. */
  airbrake: boolean;
  /** Jettison all external drop tanks (level; jettisoning is idempotent). Optional: absent = false. */
  jettisonTanks?: boolean;
  /** Gun trigger held. */
  trigger: boolean;
  /** Missile launch commanded. Edge-triggered by the consumer (src/combat fires once per false→true transition, not once per tick held). */
  launch: boolean;
  /** Cycle to next carried weapon. Edge-triggered by the consumer. */
  cycleWeapon: boolean;
  /** Cycle to next radar/visual target. Edge-triggered by the consumer. */
  cycleTarget: boolean;
  /** Nose-wheel steering enabled (ground ops only). Omitted/undefined is treated as false. */
  nwsEnabled?: boolean;
  /**
   * Bypasses fcs.ts's alpha limiter (the g-command reduction that keeps alpha within
   * FcsLimits.maxAlphaRad/minAlphaRad) when true. Omitted/undefined is treated as false (limiter
   * active), matching every real FBW jet's default and every non-player pilot (AI never sets
   * this — see src/ai/pilotAi.ts). A player-facing Settings option ("AoA limiter") for pilots who
   * want to fly past the FBW-protected envelope and risk a real departure/stall instead of the
   * limiter holding them at the boundary. NOTE: src/aircraft/tejasAeroTables.ts's CL/CD/Cm tables
   * only cover alpha up to FcsLimits.maxAlphaRad (22deg) and clamp flat beyond it (see
   * src/math/table2d.ts's edge-clamping) — there is no modelled post-stall lift/moment dropoff,
   * so disabling this does not currently produce a classic "nose drops as CL collapses" stall
   * break; it lets alpha climb unbounded while the aero model keeps using the 22deg coefficients.
   */
  alphaLimiterDisabled?: boolean;
}

/** Aerodynamic/engine/nav telemetry for the aircraft a Pilot is flying, recomputed by src/physics every SIM_DT_SEC and handed to Pilot.update via PilotContext. */
export interface AircraftTelemetry {
  /** Indicated airspeed, m/s. */
  iasMps: number;
  /** True airspeed, m/s. */
  tasMps: number;
  mach: number;
  /** Altitude above mean sea level (world Y of position, since world origin Y=0 is defined as MSL; see 00-architecture.md), m. */
  altMslM: number;
  /** Altitude above the terrain directly below, m. */
  altAglM: number;
  /** Angle of attack, rad. See frame comment at top of file for the exact formula. */
  alphaRad: number;
  /** Sideslip, rad. See frame comment at top of file for the exact formula. */
  betaRad: number;
  /** Load factor along body +Y, g (1g = steady level flight). = dot(nonGravityForceBody, (0,1,0)) / (massKg * GRAVITY_MPS2). */
  gLoad: number;
  /** Heading, rad, [0, 2*PI). Extracted from `rot` per the Euler convention at the top of this file. */
  headingRad: number;
  /** Pitch, rad, + = nose up. */
  pitchRad: number;
  /** Roll, rad, + = right wing down. */
  rollRad: number;
  /** Vertical speed, m/s, + = climbing. */
  vspeedMps: number;
  fuelKg: number;
  /** 0..1, fuelKg / AircraftDefinition.maxFuelKg. */
  fuelFrac: number;
  /** 0..1, current thrust / max available static thrust at current altitude/Mach/throttle setting (military or afterburner as commanded). */
  thrustFrac: number;
  onGround: boolean;
  /** True when alphaRad has exceeded the aircraft's stall AoA (see 02/03's spec for the exact threshold and hysteresis). */
  stalled: boolean;
}

export const LockState = {
  None: 'none',
  Searching: 'searching',
  Tracking: 'tracking',
  Locked: 'locked',
} as const;
export type LockState = (typeof LockState)[keyof typeof LockState];
export const LockStateCode: Record<LockState, number> = { none: 0, searching: 1, tracking: 2, locked: 3 } as const;
export const LockStateByCode: readonly LockState[] = ['none', 'searching', 'tracking', 'locked'];

export const WeaponKind = {
  Gun: 'gun',
  IrMissile: 'ir_missile',
  RadarMissile: 'radar_missile',
} as const;
export type WeaponKind = (typeof WeaponKind)[keyof typeof WeaponKind];
export const WeaponKindCode: Record<WeaponKind, number> = { gun: 0, ir_missile: 1, radar_missile: 2 } as const;
export const WeaponKindByCode: readonly WeaponKind[] = ['gun', 'ir_missile', 'radar_missile'];

/** Bitmask flags for HUD/RWR warnings. Combine with `|`; test with `&`. Stored as a plain number in SnapshotHud.WARNING_BITS (safe: all combinations fit well under 2^53). */
export const WarningBit = {
  Stall: 1 << 0,
  Overspeed: 1 << 1,
  OverG: 1 << 2,
  LowFuel: 1 << 3,
  GearUnsafe: 1 << 4,
  /** RWR: a hostile radar is tracking/illuminating this aircraft. */
  MissileLock: 1 << 5,
  /** RWR: a missile launch was detected against this aircraft. */
  MissileLaunch: 1 << 6,
  /** GPWS-style terrain closure warning. */
  TerrainPullUp: 1 << 7,
  EngineFire: 1 << 8,
  /** Gear/flap configuration inconsistent with current airspeed. */
  ConfigWarning: 1 << 9,
} as const;
export type WarningBits = number;

export const ContactSource = {
  Visual: 'visual',
  Radar: 'radar',
  Rwr: 'rwr',
} as const;
export type ContactSource = (typeof ContactSource)[keyof typeof ContactSource];

/** What a Pilot (human or AI) can know about another entity: sensor output, never ground truth beyond what the sensor model allows. Produced by src/combat's radar/visual detection logic, consumed by src/ai and src/hud. */
export interface Contact {
  id: EntityId;
  team: Team;
  kind: EntityKind;
  /** Best current position estimate, world frame, m. */
  pos: Vec3Like;
  /** Best current velocity estimate, world frame, m/s. */
  vel: Vec3Like;
  rangeM: number;
  /** Bearing relative to observer heading, rad, [-PI, PI], + = right of nose. */
  bearingRad: number;
  /** Elevation relative to observer, rad, + = above observer's horizon. */
  elevationRad: number;
  /** Closure rate, m/s, + = closing (range decreasing). */
  closureMps: number;
  detectedBy: ContactSource;
  /** IFF resolved: true once the observer's systems have positively identified team. Contacts may exist with identified === false (e.g. a distant radar return of unknown team) — never used to infer team beyond what the sensor model allows; src/ai must not read `.team` on an unidentified contact as ground truth for weapons-free decisions (see 06's ROE rules). */
  identified: boolean;
}

export interface CombatStatus {
  selectedWeapon: WeaponKind;
  ammoGun: number;
  missilesIr: number;
  missilesRadar: number;
  lockState: LockState;
  lockedTargetId: EntityId | undefined;
  /** RWR: being illuminated/tracked by a hostile radar right now. */
  rwrWarning: boolean;
  /** RWR: a missile launch was detected against self and is still considered inbound. */
  missileInboundWarning: boolean;
  /**
   * World-space gun lead-computing-sight aim point for the current
   * `lockedTargetId`/selected contact, computed by src/combat's real
   * `computeLeadSolution` (contracts/combat.ts, module 07) — the same
   * gravity-drop-compensated ballistic solve that governs where the actual
   * bullet lands. src/core copies this straight into the Snapshot HUD
   * block's `PIPPER_*` fields (section 11) each tick so `src/hud` never
   * needs its own independent ballistics approximation. Meaningless
   * (undefined aim point) when `aimPointValid` is false.
   */
  aimPointWorld: Vec3Like;
  /** False when no gun target is selected or `computeLeadSolution` did not converge (see contracts/combat.ts's `LeadSolutionResult.valid`); `aimPointWorld` is then a stale/zero value the HUD must not draw. */
  aimPointValid: boolean;
}

/**
 * Everything a Pilot needs to decide the next PilotInputs. Constructed fresh
 * (into a reused, pooled object — no per-tick allocation) by src/core each
 * SIM_DT_SEC for every aircraft entity that has a Pilot attached (the human
 * player via src/input, every AI aircraft via src/ai).
 */
export interface PilotContext {
  self: EntityState;
  selfDamage: DamageState;
  telemetry: AircraftTelemetry;
  /** Sensor contacts visible to `self` this tick, most-threatening first (src/combat's ordering; src/ai must not re-sort by a different key unless its own spec says so). */
  contacts: readonly Contact[];
  combat: CombatStatus;
  sampler: HeightSampler;
  navDb: AirportNavDb;
  /** World-frame wind vector at `self`'s altitude, m/s. Same value src/physics used this tick to compute telemetry. */
  windWorldMps: Vec3Like;
  simTimeSec: number;
}

/**
 * Implemented by src/input (PlayerPilot, reading keyboard/mouse/gamepad/
 * touch) and by src/ai (AiPilot, running the tactical FSM). src/core calls
 * `update` on every Pilot-bearing aircraft entity once per SIM_DT_SEC and
 * feeds the result straight into that tick's flight-model step. MUST NOT
 * allocate: write into `out`'s existing fields, do not replace `out` itself.
 */
export interface Pilot {
  update(ctx: PilotContext, dtSec: number, out: PilotInputs): void;
}

// -----------------------------------------------------------------------------
// 7. Terrain height sampling — the ONE function shape both src/terrain
//    (implementer) and every consumer (src/physics for gear/ground contact,
//    src/ai for terrain avoidance, src/render for camera collision) share.
//    Pure and deterministic: same (seed, x, z) always yields the same
//    height, in any thread (main, sim worker, terrain worker, Node/vitest).
// -----------------------------------------------------------------------------

export interface HeightSampler {
  readonly seed: number;
  /** World Y (m) of the terrain surface at world (x, z). Pure function of (seed, x, z); no allocation. */
  heightAt(x: number, z: number): number;
  /** Writes the unit surface normal at world (x, z) into `out` and returns `out` (no allocation). */
  normalAt(x: number, z: number, out: Vec3Like): Vec3Like;
  /** Present only for terrains with a water surface: true where `heightAt` is the water surface rather than ground. Touching water is a crash. */
  isWaterAt?(x: number, z: number): boolean;
  /** Present only for terrains with a water surface: that surface's elevation, m MSL. */
  readonly waterLevelM?: number;
  /** Present only for terrains with a water surface: the ground (seabed/riverbed) height, ignoring the water. */
  groundHeightAt?(x: number, z: number): number;
}

// -----------------------------------------------------------------------------
// 8. Airport nav database — read-only query surface used by src/hud (ILS
//    needles), src/ai (RTB/landing approach planning), src/ui (mission
//    select, airport editor preview) and src/core (spawning at a runway).
//    src/airport (module 05) owns the parser/validator that BUILDS the
//    concrete object implementing this interface from AirportLayout JSON;
//    everyone else only ever sees this narrow read interface.
// -----------------------------------------------------------------------------

export interface IlsInfo {
  frequencyMhz: number;
  /** Localiser course, rad, world heading convention (see top of file). */
  localiserHeadingRad: number;
  /** Glideslope angle above horizontal, rad (typically ILS_DEFAULT_GLIDESLOPE_RAD). */
  glideslopeAngleRad: number;
  localiserOriginPos: Vec3Like;
  glideslopeOriginPos: Vec3Like;
}

export interface RunwayInfo {
  id: string;
  /** World position of the landing threshold (touchdown zone start) for this runway direction. */
  thresholdPos: Vec3Like;
  /** Runway centerline heading FROM this threshold, rad, world heading convention. */
  headingRad: number;
  lengthM: number;
  widthM: number;
  /** MSL elevation at the threshold, m. */
  elevationM: number;
  ils?: IlsInfo;
}

export interface AirportInfo {
  id: string;
  name: string;
  referencePos: Vec3Like;
  elevationM: number;
  runways: readonly RunwayInfo[];
}

export interface AirportNavDb {
  getAirport(id: string): AirportInfo | undefined;
  listAirports(): readonly AirportInfo[];
  nearestAirport(pos: Vec3Like): AirportInfo | undefined;
  getRunway(airportId: string, runwayId: string): RunwayInfo | undefined;
}

// -----------------------------------------------------------------------------
// 9. Quality tiers and AI difficulty — shared enums referenced by UI, render,
//    hud, ai and core. See 00-architecture.md section "Quality tiers" for
//    the full table of what each tier controls; that table is normative,
//    this is just the type.
// -----------------------------------------------------------------------------

export const QualityTier = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  Ultra: 'ultra',
} as const;
export type QualityTier = (typeof QualityTier)[keyof typeof QualityTier];

/** Display unit for the HUD airspeed tape (src/hud/tapes.ts's drawSpeedTape) — a presentation-only choice, never the wire unit (SnapshotHud.IAS_MPS is always m/s). */
export const SpeedUnit = {
  Mps: 'ms',
  Knots: 'kt',
} as const;
export type SpeedUnit = (typeof SpeedUnit)[keyof typeof SpeedUnit];

export const AiDifficulty = {
  Rookie: 'rookie',
  Veteran: 'veteran',
  Ace: 'ace',
} as const;
export type AiDifficulty = (typeof AiDifficulty)[keyof typeof AiDifficulty];

// -----------------------------------------------------------------------------
// 10. World / mission configuration. `terrain` and `airports` are generic
//     because core.ts (the root) cannot import contracts/terrain.ts or
//     contracts/airport.ts (leaf contracts may only import core+math, never
//     the reverse — see 00-architecture.md "Contract-file rules"). src/core
//     (module 10, which imports everything) instantiates these generics as
//     `WorldConfig<TerrainParams, AirportLayout>` / `Mission<TerrainParams,
//     AirportLayout>` using the real types from contracts/terrain.ts and
//     contracts/airport.ts. Modules 04/05 must NOT depend on this generic
//     shape to learn their own field names; it exists only so src/core can
//     hold a `WorldConfig`/`Mission` value without a contract cycle.
// -----------------------------------------------------------------------------

export interface WorldConfig<TTerrain = unknown, TAirport = unknown> {
  /** Master seed. Terrain noise, AI PRNG streams, and any other seeded randomness all derive sub-seeds from this via src/math's PRNG utilities — never reseed independently from wall-clock time. */
  seed: number;
  terrain: TTerrain;
  airports: readonly TAirport[];
}

export interface WeatherConfig {
  /** World-frame wind vector at a nominal reference altitude, m/s. */
  windWorldMps: Vec3Like;
  /** Gust magnitude added as PRNG-driven noise on top of windWorldMps, m/s. */
  gustMps: number;
  /** 0..1 turbulence intensity scalar (see 02's spec for how it perturbs the flight model). */
  turbulence: number;
}

export const MissionObjectiveKind = {
  DestroyAllHostiles: 'destroy_all_hostiles',
  Land: 'land',
  ReachWaypoint: 'reach_waypoint',
  SurviveTime: 'survive_time',
} as const;
export type MissionObjectiveKind = (typeof MissionObjectiveKind)[keyof typeof MissionObjectiveKind];

export interface MissionObjective {
  id: string;
  kind: MissionObjectiveKind;
  description: string;
  /** Kind-specific parameters, e.g. { waypointX, waypointY, waypointZ } or { seconds: 300 }. Each kind's exact keys are fixed by 12-verification.md's acceptance tests. */
  params: Readonly<Record<string, number | string>>;
}

export interface MissionAiFlight {
  id: string;
  /** References an AircraftDefinition.id (contracts/aircraft.ts). Kept as a plain string here for the same reason WorldConfig is generic. */
  aircraftId: string;
  team: Team;
  difficulty: AiDifficulty;
  startAirportId?: string;
  startRunwayId?: string;
  startPos?: Vec3Like;
  startHeadingRad?: number;
  startSpeedMps?: number;
  /** Number of aircraft in this flight (formation), >= 1. */
  count: number;
  /** Airport this flight considers "home" for Rtb/Land (contracts/ai.ts's `AiPilotSpawnParams.homeAirportId`/`homeRunwayId`, module 06). Omitted means the AI falls back to `navDb.nearestAirport`. */
  homeAirportId?: string;
  homeRunwayId?: string;
  /** Patrol anchor/radius for this flight while in TacticalState.Patrol (contracts/ai.ts). Required, per module 06's own contract, unless every non-leader member of this flight is given a formation slot (formation index > 0 always follows the flight's own index-0 leader — see 10-core-worker.md section 4.2). */
  patrolCenterWorld?: Vec3Like;
  patrolRadiusM?: number;
}

export interface MissionPlayerStart {
  airportId?: string;
  runwayId?: string;
  pos?: Vec3Like;
  headingRad?: number;
  speedMps?: number;
}

export interface Mission<TTerrain = unknown, TAirport = unknown> {
  id: string;
  name: string;
  world: WorldConfig<TTerrain, TAirport>;
  playerStart: MissionPlayerStart;
  aiFlights: readonly MissionAiFlight[];
  weather: WeatherConfig;
  objectives: readonly MissionObjective[];
}

// -----------------------------------------------------------------------------
// 11. Snapshot binary layout. The sim worker writes ONE Float64Array of
//     length SNAPSHOT_FLOATS per emitted frame (SNAPSHOT_HZ times/sec) and
//     transfers its underlying ArrayBuffer to the main thread. A single
//     homogeneous Float64Array is used for ALL positions (deliberately
//     simplifying the brief's literal "float64 player / float32 others"
//     idea — see 00-architecture.md "Floating origin" for the justification:
//     the sim keeps everything in absolute float64; converting to
//     camera-relative float32 for Three.js is entirely src/render's job at
//     consume time, so the wire format stays simple and uniform).
//
//     Layout (all offsets are FLOAT indices into the Float64Array, i.e.
//     `buffer[OFFSET]`, not byte offsets):
//
//       [0 .. HEADER_FLOATS)                                    header
//       [HEADER_FLOATS .. HEADER_FLOATS + MAX_ENTITIES*ENTITY_STRIDE)   entity blocks (fixed-size region; only the first header.entityCount blocks are valid/meaningful)
//       [HEADER_FLOATS + MAX_ENTITIES*ENTITY_STRIDE .. SNAPSHOT_FLOATS) HUD block (one, for the player)
//
//     The region size is fixed at MAX_ENTITIES regardless of how many
//     entities are actually alive, so the sim worker can pre-allocate a
//     small POOL of SNAPSHOT_BUFFER_POOL_SIZE same-size ArrayBuffers once
//     at init and round-robin them (no per-frame allocation). The main
//     thread MUST transfer a buffer back via a `releaseBuffer` message
//     (see WorkerMessage section) once it has copied what it needs out of
//     it, or the pool will starve.
// -----------------------------------------------------------------------------

/** Hard cap on simultaneously alive entities (aircraft + missiles + bullets + effects combined). Sized generously; see 00-architecture.md performance section for the suggested per-kind budget. */
export const MAX_ENTITIES = 400;

export const SnapshotHeader = {
  /** Monotonically increasing sim tick counter (integer, increments by 1 every SIM_DT_SEC). */
  TICK_OFFSET: 0,
  /** Seconds since sim start (float). */
  SIM_TIME_SEC_OFFSET: 1,
  /** Number of valid entity blocks that follow, 0..MAX_ENTITIES. */
  ENTITY_COUNT_OFFSET: 2,
  /** Index (0..entityCount-1) of the local player's entity block, or -1 if none. */
  PLAYER_INDEX_OFFSET: 3,
} as const;
/** Number of floats in the header region. */
export const HEADER_FLOATS = 4;

export const SnapshotEntity = {
  ID: 0,
  KIND: 1, // EntityKindCode
  TEAM: 2,
  POS_X: 3,
  POS_Y: 4,
  POS_Z: 5,
  ROT_X: 6,
  ROT_Y: 7,
  ROT_Z: 8,
  ROT_W: 9,
  VEL_X: 10,
  VEL_Y: 11,
  VEL_Z: 12,
  OMEGA_X: 13,
  OMEGA_Y: 14,
  OMEGA_Z: 15,
  ALIVE: 16, // 0 or 1
  HP: 17,
  FUEL_KG: 18,
  ELEVON_L: 19,
  ELEVON_R: 20,
  RUDDER: 21,
  GEAR_POS: 22,
  THROTTLE: 23,
  AFTERBURNER_ON: 24, // 0 or 1
  FLAGS: 25, // EntityFlags bitmask
} as const;
/** Floats per entity block. Keep in sync with the field count above (26). */
export const ENTITY_STRIDE = 26;

/** Float index (from the start of the WHOLE buffer) of entity block `i`'s field `field`. `field` is one of the SnapshotEntity.* offsets above. */
export const entityFieldOffset = (entityIndex: number, field: number): number =>
  HEADER_FLOATS + entityIndex * ENTITY_STRIDE + field;

/** Float index (from the start of the whole buffer) where the fixed-size entity region ends and the HUD block begins. */
export const HUD_BLOCK_START = HEADER_FLOATS + MAX_ENTITIES * ENTITY_STRIDE;

export const SnapshotHud = {
  IAS_MPS: 0,
  TAS_MPS: 1,
  MACH: 2,
  ALT_MSL_M: 3,
  ALT_AGL_M: 4,
  AOA_RAD: 5,
  BETA_RAD: 6,
  G_LOAD: 7,
  HEADING_RAD: 8,
  PITCH_RAD: 9,
  ROLL_RAD: 10,
  VSPEED_MPS: 11,
  FUEL_KG: 12,
  THRUST_FRAC: 13,
  GEAR_POS: 14,
  /** WeaponKindCode of the currently selected weapon. */
  WEAPON_IDX: 15,
  /** EntityId of the current target, or NO_ENTITY_ID. */
  TARGET_ID: 16,
  TARGET_RANGE_M: 17,
  /** + = closing. */
  CLOSURE_MPS: 18,
  /** LockStateCode. */
  LOCK_STATE: 19,
  /** WarningBits bitmask. */
  WARNING_BITS: 20,
  /** Normalised localiser deviation, [-1,1], see ILS_LOC_FULL_SCALE_DEG. 0 if no ILS tuned. */
  ILS_LOC: 21,
  /** Normalised glideslope deviation, [-1,1], see ILS_GS_FULL_SCALE_DEG. 0 if no ILS tuned. */
  ILS_GS: 22,
  /** World-space gun lead-computing-sight aim point, x/y/z. Copied by src/core from that tick's player `CombatStatus.aimPointWorld` (see section 4). 0 when `PIPPER_VALID` is 0. */
  PIPPER_X: 23,
  PIPPER_Y: 24,
  PIPPER_Z: 25,
  /** 0 or 1; mirrors `CombatStatus.aimPointValid`. */
  PIPPER_VALID: 26,
  /** Fuel remaining in attached drop tanks, kg, or -1 when none are attached. */
  TANK_FUEL_KG: 27,
} as const;
/** Floats in the HUD block. Keep in sync with the field count above (27). */
export const HUD_BLOCK_FLOATS = 28;

/** Total length, in floats, of one snapshot ArrayBuffer's Float64Array view. */
export const SNAPSHOT_FLOATS = HEADER_FLOATS + MAX_ENTITIES * ENTITY_STRIDE + HUD_BLOCK_FLOATS;
/** Total length, in bytes, of one snapshot ArrayBuffer (Float64Array is 8 bytes/element). */
export const SNAPSHOT_BYTES = SNAPSHOT_FLOATS * 8;
/** Number of pre-allocated snapshot buffers the sim worker round-robins to avoid per-frame allocation. */
export const SNAPSHOT_BUFFER_POOL_SIZE = 3;

// -----------------------------------------------------------------------------
// 12. Simulation events — discrete, non-per-tick occurrences the sim worker
//     reports alongside (not inside) the snapshot stream, for src/hud (toast/
//     warnings), src/render (spawn a fx), and src/ui (debrief log).
// -----------------------------------------------------------------------------

export interface ExplosionEvent {
  type: 'explosion';
  pos: Vec3Like;
  radiusM: number;
  causedBy?: EntityId;
}
export interface MissileLaunchEvent {
  type: 'missileLaunch';
  shooterId: EntityId;
  missileId: EntityId;
  weapon: WeaponKind;
}
export interface GunFireEvent {
  type: 'gunFire';
  shooterId: EntityId;
  pos: Vec3Like;
  dir: Vec3Like;
}
export interface HitEvent {
  type: 'hit';
  targetId: EntityId;
  sourceId: EntityId;
  /** Damage applied to targetId's DamageState.structurePct this hit, 0..1. */
  damage: number;
  weapon: WeaponKind;
  pos: Vec3Like;
}
export interface KillEvent {
  type: 'kill';
  targetId: EntityId;
  sourceId: EntityId | undefined;
}
export interface TouchdownEvent {
  type: 'touchdown';
  entityId: EntityId;
  /** Vertical speed at touchdown, m/s, positive magnitude (i.e. descent rate, not signed vspeed). */
  vspeedMps: number;
  pos: Vec3Like;
}
export interface CrashEvent {
  type: 'crash';
  entityId: EntityId;
  pos: Vec3Like;
}
export interface LockAcquiredEvent {
  type: 'lockAcquired';
  observerId: EntityId;
  targetId: EntityId;
  weapon: WeaponKind;
}
export interface LockLostEvent {
  type: 'lockLost';
  observerId: EntityId;
  targetId: EntityId;
}
export interface WarningEvent {
  type: 'warning';
  entityId: EntityId;
  /** One WarningBit value (not a combined mask). */
  bit: number;
  /** true = warning became active this tick, false = it cleared. */
  active: boolean;
}

/**
 * `success`/`failure` = the mission's objectives were mechanically evaluated
 * to a win/loss (see `MissionEndedEvent`); `aborted` = the player quit/
 * reloaded before either outcome was reached (src/ui's own bookkeeping,
 * never emitted by src/core itself as a `MissionEndedEvent.outcome`).
 * Canonical home for this union: `contracts/ui.ts`'s own `MissionOutcome`
 * (module 11) MUST use these exact same three string values — it is
 * duplicated there only because `core.ts` (the root contract) cannot import
 * a leaf contract; see `00-architecture.md` section 9 for this project's
 * general pattern for a shape spanning two non-core modules.
 */
export const MissionOutcome = {
  Success: 'success',
  Failure: 'failure',
  Aborted: 'aborted',
} as const;
export type MissionOutcome = (typeof MissionOutcome)[keyof typeof MissionOutcome];

export interface MissionEndedEvent {
  type: 'missionEnded';
  outcome: MissionOutcome;
  /** `MissionObjective.id` values `World` evaluated as complete this mission. */
  objectivesCompleted: readonly string[];
  objectivesTotal: number;
}

export type SimEvent =
  | ExplosionEvent
  | MissileLaunchEvent
  | GunFireEvent
  | HitEvent
  | KillEvent
  | TouchdownEvent
  | CrashEvent
  | LockAcquiredEvent
  | LockLostEvent
  | WarningEvent
  | MissionEndedEvent;

// -----------------------------------------------------------------------------
// 13. Worker message protocol. Four one-directional message flows:
//       MainToSimMessage      main thread  -> sim worker
//       SimToMainMessage      sim worker   -> main thread
//       MainToTerrainMessage  main thread  -> terrain worker
//       TerrainToMainMessage  terrain worker -> main thread
//     Every message is a discriminated union on `type`, posted as the sole
//     argument to `postMessage` (with the listed fields as the transfer
//     list where noted). src/core owns both `sim.worker.ts` and the main-
//     thread-side dispatch in `src/main.ts`; src/terrain owns
//     `terrain.worker.ts`.
// -----------------------------------------------------------------------------

// ---- main -> sim worker ----

export interface SimInitMessage {
  type: 'init';
  mission: Mission;
  qualityTier: QualityTier;
}
export interface SimInputMessage {
  type: 'input';
  /** Entity the input applies to — normally the player's aircraft id. */
  entityId: EntityId;
  inputs: PilotInputs;
}
export type SimCommand =
  | { kind: 'spawn'; entityKind: EntityKind; team: Team; pos: Vec3Like; headingRad: number; aircraftDefId?: string }
  | { kind: 'reset' }
  | { kind: 'loadMission'; mission: Mission }
  | { kind: 'setDifficulty'; entityId: EntityId; difficulty: AiDifficulty }
  | { kind: 'pause'; paused: boolean };
export interface SimCommandMessage {
  type: 'command';
  command: SimCommand;
}
/** Returns a previously-transferred snapshot buffer to the sim worker's pool. See section 11. */
export interface SimReleaseBufferMessage {
  type: 'releaseBuffer';
  buffer: ArrayBuffer;
}
export type MainToSimMessage = SimInitMessage | SimInputMessage | SimCommandMessage | SimReleaseBufferMessage;

// ---- sim worker -> main ----

export interface SimReadyMessage {
  type: 'ready';
}
export interface SimSnapshotMessage {
  type: 'snapshot';
  /** Transferable. Float64Array-backed; layout per section 11. */
  buffer: ArrayBuffer;
}
export interface SimEventsMessage {
  type: 'events';
  events: readonly SimEvent[];
  tick: number;
}
export type SimToMainMessage = SimReadyMessage | SimSnapshotMessage | SimEventsMessage;

// ---- main -> terrain worker ----

export interface TerrainRequestChunkMessage {
  type: 'requestChunk';
  chunkX: number;
  chunkZ: number;
  lod: number;
  requestId: number;
}
export interface TerrainCancelMessage {
  type: 'cancel';
  requestId: number;
}
export type MainToTerrainMessage = TerrainRequestChunkMessage | TerrainCancelMessage;

// ---- terrain worker -> main ----

export interface TerrainChunkReadyMessage {
  type: 'chunkReady';
  requestId: number;
  chunkX: number;
  chunkZ: number;
  lod: number;
  /** Transferable. Float32Array of interleaved x,y,z. */
  positions: ArrayBuffer;
  /** Transferable. Float32Array of interleaved nx,ny,nz. */
  normals: ArrayBuffer;
  /** Transferable. Uint32Array triangle indices. */
  indices: ArrayBuffer;
  /**
   * Optional scenery for this chunk (roads, settlement ground, trees, buildings), all transferable
   * Float32/Uint32 buffers. Layout: contracts/terrain.ts ChunkFeatures (same field names, as ArrayBuffers).
   */
  features?: {
    decalPositions: ArrayBuffer;
    decalAttribs: ArrayBuffer;
    decalIndices: ArrayBuffer;
    treeMatrices: ArrayBuffer[];
    treeColors: ArrayBuffer[];
    buildingMatrices: ArrayBuffer;
    buildingColors: ArrayBuffer;
    domeMatrices: ArrayBuffer;
    houseMatrices: ArrayBuffer;
    houseColors: ArrayBuffer;
  };
}
export type TerrainToMainMessage = TerrainChunkReadyMessage;
