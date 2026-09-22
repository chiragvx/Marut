/**
 * =============================================================================
 * TEJAS SIM — MODULE 10 CONTRACT (docs/spec/contracts/sim.ts)
 * =============================================================================
 * Owner: module 10 (docs/spec/10-core-worker.md), implementing src/core/*,
 * src/main.ts, index.html, vite.config.ts, tsconfig.json, package.json.
 *
 * Imports ONLY from './core'. Deliberately does NOT import from './flight',
 * './aircraft', './terrain', './airport', './ai', './combat', './input',
 * './render', './ui' — this module is drafted and implemented blind to those
 * contracts (00-architecture.md section 1), so every cross-module dependency
 * below is expressed purely in terms of core.ts's own vocabulary (EntityState,
 * DamageState, PilotInputs, AircraftTelemetry, CombatStatus, Pilot,
 * HeightSampler, AirportNavDb, SimEvent, Mission, ...). Where src/core's real
 * implementation needs something a sibling module actually exports under a
 * name this file cannot know in advance (e.g. module 02's telemetry builder),
 * this file defines the NARROWEST possible adapter shape (a "Port") that
 * src/core's own adapter files bridge to the real export at integration time.
 * See 10-core-worker.md section 9 ("Open assumptions") for the exact list.
 *
 * Contains ONLY interfaces, type aliases, `as const` objects + derived
 * unions, and bare function-signature type aliases. NO implementation. Must
 * compile standalone with `tsc --noEmit --strict`.
 * =============================================================================
 */

import type {
  AiDifficulty,
  AircraftTelemetry,
  AirportNavDb,
  CombatStatus,
  DamageState,
  EntityFlags,
  EntityId,
  EntityKind,
  EntityState,
  HeightSampler,
  Mission,
  PilotInputs,
  QualityTier,
  SimEvent,
  Team,
  Vec3Like,
  QuatLike,
  WeaponKind,
  Pilot,
} from './core';

// -----------------------------------------------------------------------------
// 1. Constants. Every number here is a module-10 design decision, justified in
//    10-core-worker.md; nobody else reads or redefines these.
// -----------------------------------------------------------------------------

/** Per-`EntityKind` slot budgets for the pooled entity store. Sums to `core.ts`'s `MAX_ENTITIES` (400). */
export const DEFAULT_ENTITY_POOL_CAPACITY: Readonly<Record<EntityKind, number>> = {
  aircraft: 32,
  missile: 64,
  bullet: 240,
  effect: 64,
} as const;

/** Ticks between emitted snapshots = SIM_HZ / SNAPSHOT_HZ, from core.ts's constants (120/60). Recomputed here as a literal so this file need not do arithmetic on imported consts. */
export const SNAPSHOT_EVERY_N_TICKS = 2;

/** Clamp applied to a single real-time delta fed into the accumulator, seconds. Prevents a "spiral of death" after the tab/worker is backgrounded or debugger-paused; see 00-architecture.md section 4. */
export const ACCUMULATOR_MAX_CATCHUP_SEC = 0.25;

/** Interval, ms, at which `sim.worker.ts` schedules its own clock tick (workers have no `requestAnimationFrame`). Deliberately shorter than `SIM_DT_SEC*1000` (~8.33ms) so the accumulator's `while` loop, not the timer's own granularity, is what determines the exact tick rate. See 10-core-worker.md section 4. */
export const SIM_WORKER_TIMER_INTERVAL_MS = 4;

/** Max `SimEvent`s the queue holds per tick before it starts dropping (and logging once per drop-streak in dev builds). Generous for the busiest plausible tick (multiple simultaneous hits/kills). */
export const EVENT_QUEUE_CAPACITY = 256;

/** Warning-bit thresholds World itself evaluates every tick (see 10-core-worker.md section 4.6). These are generic, airframe-independent fallbacks — NOT the Tejas's actual FCS/structural limits, which live in `AircraftDefinition.fcsLimits` (module 03) and are invisible to this contract. */
export const WARNING_LOW_FUEL_FRAC = 0.1;
export const WARNING_OVER_G_POS = 9.0;
export const WARNING_OVER_G_NEG = -3.0;
export const WARNING_TERRAIN_PULLUP_AGL_M = 150;
export const WARNING_TERRAIN_PULLUP_SINK_MPS = 10;
export const WARNING_GEAR_UNSAFE_AGL_M = 300;
export const WARNING_GEAR_UNSAFE_SINK_MPS = 1;

// -----------------------------------------------------------------------------
// 2. Entity pool.
// -----------------------------------------------------------------------------

export interface EntityPoolCapacity {
  aircraft: number;
  missile: number;
  bullet: number;
  effect: number;
}

/**
 * Pre-sized, allocation-free entity store. `allocate`/`release` reuse slots;
 * `EntityId` encodes (slot index, generation) per core.ts section 3 so a
 * stale id (e.g. a missile seeker's remembered target) can detect its slot
 * was recycled. Implemented by `src/core/entityPool.ts`.
 */
export interface EntityPool {
  readonly capacity: Readonly<EntityPoolCapacity>;
  /** Number of currently-alive entities across all kinds. */
  readonly liveCount: number;
  /**
   * Reserves a slot for a new entity of `kind`, returns its fresh `EntityId`
   * with a freshly-initialized `EntityState` (zeroed, `alive=true`, `hp=100`,
   * `kind`/`team`/`id` set) reachable via `get(id)`. Returns `NO_ENTITY_ID`
   * (core.ts, = -1) if `kind`'s per-kind budget is exhausted — callers MUST
   * check for this and must not treat it as a crash condition.
   */
  allocate(kind: EntityKind, team: Team): EntityId;
  /** Marks `id`'s slot free (bumps its generation) and `alive=false`. A no-op if `id` is already stale/invalid. */
  release(id: EntityId): void;
  /** True iff `id` refers to a currently-live slot (index in range AND generation matches AND `alive===true`). */
  isAlive(id: EntityId): boolean;
  /** The live `EntityState` for `id`, or `undefined` if `id` is stale/invalid/released. The returned object is the pool's own mutable storage — callers may read it but must not retain it across a tick boundary (a later `allocate` may reuse the same underlying slot object for a different entity). */
  get(id: EntityId): EntityState | undefined;
  /** The live `DamageState` for an aircraft `id`, or `undefined` if `id` is not a live aircraft. Missiles/bullets/effects have no `DamageState`. */
  getDamage(id: EntityId): DamageState | undefined;
  /**
   * Dense, live-entities-only iteration for the tick loop and snapshot
   * writer: `denseIndex` ranges `0 .. liveCount-1`. Order is NOT stable
   * across ticks — `release` may swap-remove, moving the last live entity
   * into the freed dense slot — so callers must re-read `denseIndex` fresh
   * each tick rather than caching it.
   */
  liveAt(denseIndex: number): EntityState;
}

export type CreateEntityPool = (capacity: EntityPoolCapacity) => EntityPool;

// -----------------------------------------------------------------------------
// 3. Ports — the narrow, core.ts-only-vocabulary interfaces World depends on
//    for behaviour this module does not own. src/core's own adapter files
//    (section 2 of 10-core-worker.md) wrap the real src/physics, src/ai,
//    src/combat exports to these exact shapes at integration time.
// -----------------------------------------------------------------------------

/** Atmosphere + wind + ground reference for one (aircraft, tick) pair. World constructs this once per aircraft per tick (see 10-core-worker.md section 4.5) and passes it to `FlightModelPort.step`; field names/units match `contracts/flight.ts`'s real, six-field `Environment` shape (00-architecture.md section 9.1) exactly, so a straight object literal from World satisfies module 02's real `Environment` parameter with no adapter needed. `groundElevationM`/`groundNormalWorld` are `sampler.heightAt`/`normalAt(state.pos.x, state.pos.z)` — see 10-core-worker.md section 4.1 step 3. */
export interface SimEnvironment {
  airDensityKgM3: number;
  soundSpeedMps: number;
  windWorldMps: Vec3Like;
  gravityMps2: number;
  /** Terrain surface elevation (world Y, m MSL) directly below the aircraft. */
  groundElevationM: number;
  /** Terrain unit surface normal at the same point, world frame. */
  groundNormalWorld: Vec3Like;
}

/**
 * Minimal aircraft-physics surface World depends on. Adapts module 02/03's
 * pinned `StepAircraft`/`AircraftDefinition` (00-architecture.md section 9.1)
 * to a shape expressed only in core.ts + `SimEnvironment` types, keyed by a
 * string `aircraftDefId` so World never needs to know `AircraftDefinition`'s
 * full shape. Implemented (as an adapter) by `src/core/flightModelAdapter.ts`.
 */
export interface FlightModelPort {
  /** True iff `aircraftDefId` names a definition this port can step (e.g. `"tejas-mk1"`). */
  hasDefinition(aircraftDefId: string): boolean;
  /**
   * Pure, allocation-free: advances one aircraft's `EntityState` by `dtSec`.
   * `state`/`damage`/`inputs`/`env` are read-only in; the result is written
   * into `out` (`out` may safely alias `state` for in-place integration).
   * Must also update `out.elevonL/elevonR/rudder/gearPos/throttle/afterburnerOn`
   * and the `EntityFlag.OnGround` bit of `out.flags` (gear weight-on-wheels).
   */
  step(aircraftDefId: string, state: EntityState, damage: DamageState, inputs: PilotInputs, env: SimEnvironment, dtSec: number, out: EntityState): void;
  /**
   * Fills `out` with telemetry for `state` (already stepped this tick) given
   * `env`. Pure, allocation-free. If the real module 02 export this adapts
   * does not expose a standalone telemetry function (see 10-core-worker.md
   * section 9), the adapter falls back to the degraded computation specified
   * there rather than leaving this unimplemented.
   */
  computeTelemetry(aircraftDefId: string, state: EntityState, damage: DamageState, env: SimEnvironment, out: AircraftTelemetry): void;
  /** Fuel capacity, kg, for `aircraftDefId`; used by World to compute `AircraftTelemetry.fuelFrac` independently if the adapter's `computeTelemetry` does not, and to seed a freshly spawned aircraft's `fuelKg`-equivalent bookkeeping. */
  maxFuelKg(aircraftDefId: string): number;
}

/**
 * Structurally mirrors `contracts/ai.ts`'s `AiFormationSlot` (module 06)
 * field-for-field. Duplicated here (rather than imported) only because this
 * contract is drafted and compiled blind to `contracts/ai.ts` — see the file
 * header and 00-architecture.md section 1.
 */
export interface AiFormationSlotLike {
  role: 'leader' | 'wingman';
  leaderId: EntityId;
  slotRightM: number;
  slotBackM: number;
  slotUpM: number;
}

/**
 * Structurally mirrors `contracts/ai.ts`'s `AiPilotSpawnParams` field-for-
 * field, so module 06's real `createAiPilot` export is directly assignable
 * to `CreateAiPilot` below with no adapter object-shape conversion (only a
 * return-type widening from the real `AiPilot` to `Pilot`, a safe supertype
 * substitution). See 10-core-worker.md section 4.2 for how `World` builds
 * one of these per AI spawn, including resolving `formation.leaderId` to an
 * already-spawned flight leader's `EntityId`.
 */
export interface AiPilotSpawnParamsLike {
  aircraftDefId: string;
  team: Team;
  difficulty: AiDifficulty;
  /** Per-entity sub-seed World derives deterministically from `Mission.world.seed` (see 10-core-worker.md section 4.7) — the returned `Pilot` must not use any randomness source other than what it derives from this. */
  seed: number;
  homeAirportId?: string;
  homeRunwayId?: string;
  patrolCenterWorld?: Vec3Like;
  patrolRadiusM?: number;
  formation?: AiFormationSlotLike;
}

/** Creates a `Pilot` (core.ts) for an AI-controlled aircraft. Implemented (as an adapter) by `src/core/aiPilotAdapter.ts`, wrapping module 06's real `createAiPilot` factory. */
export type CreateAiPilot = (params: Readonly<AiPilotSpawnParamsLike>) => Pilot;

/** The slice of `EntityPool` + world services `CombatPort.step` may touch, scoped narrower than the full `World` interface (combat gets spawn/despawn + damage + sampler, not e.g. mission/UI state). */
export interface CombatTickContext {
  readonly liveCount: number;
  liveAt(denseIndex: number): EntityState;
  getDamage(id: EntityId): DamageState | undefined;
  getCombatStatus(id: EntityId): CombatStatus | undefined;
  spawn(spec: SpawnSpec): EntityId;
  despawn(id: EntityId): void;
  sampler: HeightSampler;
  simTimeSec: number;
}

/**
 * Minimal combat surface World depends on: one call per tick that resolves
 * weapon firing, missile guidance/ballistics, hit detection and subsystem
 * damage for every entity, appending any resulting `SimEvent`s. Adapts
 * module 07's real exports (unseen by this contract — see 00-architecture.md
 * section 8) to this single entry point. Implemented (as an adapter) by
 * `src/core/combatAdapter.ts`. Must not allocate beyond what `eventsOut`
 * itself allows (see `EventQueue`).
 */
export interface CombatPort {
  step(dtSec: number, ctx: CombatTickContext, eventsOut: EventQueue): void;
}

// -----------------------------------------------------------------------------
// 4. Event queue.
// -----------------------------------------------------------------------------

/** Capacity-bounded, allocation-free-after-construction event buffer. `push` beyond `capacity` is dropped (the event object itself, e.g. `{type:'hit',...}`, is still a small per-occurrence allocation by the pusher — rare/bursty, not once-per-tick-per-entity, so this is accepted per 00-architecture.md's "hot path" definition; the QUEUE's own backing array never grows). Implemented by `src/core/eventQueue.ts`. */
export interface EventQueue {
  readonly capacity: number;
  readonly length: number;
  /** Appends `event`. Returns `false` (and drops it) if `length === capacity`. */
  push(event: SimEvent): boolean;
  /** Copies all queued events, in push order, into `out` starting at index 0, then clears the queue (`length` becomes 0). `out.length` must be `>= capacity`. Returns the number of events written. */
  drainInto(out: SimEvent[]): number;
  /** Clears the queue without copying anything out. */
  clear(): void;
}

export type CreateEventQueue = (capacity: number) => EventQueue;

// -----------------------------------------------------------------------------
// 5. Fixed-step accumulator (00-architecture.md section 4's algorithm, made
//    testable in isolation under Node with no worker/timer involved).
// -----------------------------------------------------------------------------

export interface FixedStepAccumulatorState {
  accumulatorSec: number;
  tickCount: number;
}

/**
 * Advances `state` in place given `realDtSec` elapsed since the previous
 * call (first clamped to `ACCUMULATOR_MAX_CATCHUP_SEC`), invoking
 * `stepFn(SIM_DT_SEC)` once per whole fixed tick that has now accumulated —
 * exactly reproducing 00-architecture.md section 4's `while (accumulator >=
 * SIM_DT_SEC)` loop. Returns the number of ticks stepped this call (0 if
 * less than one tick's worth of time had accumulated). Pure with respect to
 * `state` (mutates only it and calls `stepFn`); does not itself decide
 * snapshot cadence — see `shouldEmitSnapshot`.
 */
export type AdvanceFixedStep = (state: FixedStepAccumulatorState, realDtSec: number, stepFn: (dtSec: number) => void) => number;

/** True iff `tickCount` is a tick on which a snapshot should be emitted, i.e. `tickCount % SNAPSHOT_EVERY_N_TICKS === 0`. */
export type ShouldEmitSnapshot = (tickCount: number) => boolean;

// -----------------------------------------------------------------------------
// 6. Snapshot writer / reader. Layout constants (`HEADER_FLOATS`,
//    `SnapshotEntity`, `SnapshotHud`, `entityFieldOffset`, ...) all live in
//    core.ts section 11; this section only adds the read/write function
//    shapes and the plain-object "view" types callers fill in.
// -----------------------------------------------------------------------------

/** One entity's fields as a plain mutable object, mirroring `SnapshotEntity`'s offsets 1:1 (field order/names match `EntityState` plus the wire-coded `kind`). Reused across calls by callers — `readSnapshotEntity` writes into a caller-owned instance, never allocates one. */
export interface SnapshotEntityView {
  id: EntityId;
  kind: EntityKind;
  team: Team;
  pos: Vec3Like;
  rot: QuatLike;
  vel: Vec3Like;
  omega: Vec3Like;
  alive: boolean;
  hp: number;
  fuelKg: number;
  elevonL: number;
  elevonR: number;
  rudder: number;
  gearPos: number;
  throttle: number;
  afterburnerOn: boolean;
  flags: EntityFlags;
}

/** Mirrors `SnapshotHud`'s 23 fields 1:1. */
export interface SnapshotHudView {
  iasMps: number;
  tasMps: number;
  mach: number;
  altMslM: number;
  altAglM: number;
  aoaRad: number;
  betaRad: number;
  gLoad: number;
  headingRad: number;
  pitchRad: number;
  rollRad: number;
  vspeedMps: number;
  fuelKg: number;
  thrustFrac: number;
  gearPos: number;
  weaponIdx: number;
  targetId: EntityId;
  targetRangeM: number;
  closureMps: number;
  lockState: number;
  warningBits: number;
  ilsLoc: number;
  ilsGs: number;
  pipperX: number;
  pipperY: number;
  pipperZ: number;
  pipperValid: number;
}

export interface SnapshotHeaderView {
  tick: number;
  simTimeSec: number;
  entityCount: number;
  playerIndex: number;
}

/**
 * Writes one full snapshot (header + dense entity list, capped at
 * `MAX_ENTITIES`, + the HUD block for `playerEntityId`) into `out`.
 * `out.length` must equal `SNAPSHOT_FLOATS` (core.ts). Allocation-free.
 * `playerEntityId` may be `NO_ENTITY_ID`, in which case
 * `SnapshotHeader.PLAYER_INDEX_OFFSET` is written as -1 and the HUD block is
 * written as all zeros. `hud` is the caller's already-computed HUD data for
 * this tick (World assembles it from telemetry + combat status + ILS
 * deviation before calling this — see 10-core-worker.md section 4.8).
 */
export type WriteSnapshot = (pool: EntityPool, playerEntityId: EntityId, tick: number, simTimeSec: number, hud: SnapshotHudView, out: Float64Array) => void;

export type ReadSnapshotHeader = (buf: Float64Array) => SnapshotHeaderView;
/** Reads entity block `index` (`0 .. header.entityCount-1`) from `buf` into `out`. Allocation-free. */
export type ReadSnapshotEntity = (buf: Float64Array, index: number, out: SnapshotEntityView) => SnapshotEntityView;
export type ReadSnapshotHud = (buf: Float64Array, out: SnapshotHudView) => SnapshotHudView;

// -----------------------------------------------------------------------------
// 7. Spawning.
// -----------------------------------------------------------------------------

export interface SpawnSpec {
  kind: EntityKind;
  team: Team;
  pos: Vec3Like;
  /** World heading, rad, per core.ts's convention. Initial `rot` is built via the yaw/pitch/roll composition in 00-architecture.md section 3.3 with `pitch=roll=0` unless `kind==='aircraft'` and the spawn is airborne (see 10-core-worker.md section 4.2 for the exact rule). */
  headingRad: number;
  /** Initial speed along `headingRad`, m/s. Default 0 (parked/static spawn) if omitted. */
  speedMps?: number;
  /** Required when `kind==='aircraft'`. Must satisfy `FlightModelPort.hasDefinition`. */
  aircraftDefId?: string;
  /** AI-controlled aircraft only. Omitted (for `kind==='aircraft'`) means this aircraft is player-controlled and driven by `World.setPlayerInput` instead of an internal `Pilot`. Ignored for non-aircraft kinds. */
  difficulty?: AiDifficulty;
  /** `kind==='missile'|'bullet'` only: which weapon spawned this projectile, for damage/event attribution. */
  weapon?: WeaponKind;
  /** `kind==='missile'|'bullet'` only: the firing entity's id. */
  shooterId?: EntityId;
}

// -----------------------------------------------------------------------------
// 8. World.
// -----------------------------------------------------------------------------

export interface WorldDependencies {
  flightModel: FlightModelPort;
  combat: CombatPort;
  createAiPilot: CreateAiPilot;
  sampler: HeightSampler;
  navDb: AirportNavDb;
  /** Per-kind pool sizing; defaults to `DEFAULT_ENTITY_POOL_CAPACITY` if omitted. */
  entityPoolCapacity?: EntityPoolCapacity;
}

/**
 * Owns all entity state for one simulation instance. `stepOnce` advances
 * exactly `SIM_DT_SEC` (core.ts) of simulated time in the fixed order given
 * in 10-core-worker.md section 4.1. Deterministic: given an identical prior
 * `World` state and an identical sequence of `setPlayerInput`/`spawnEntity`/
 * `despawnEntity`/`setDifficulty` calls interleaved with `stepOnce` calls,
 * two `World` instances constructed from the same `WorldDependencies` (whose
 * own randomness, if any, must itself be seeded from `Mission.world.seed`)
 * produce bit-identical `EntityState`s. Implemented by `src/core/world.ts`.
 */
export interface World {
  readonly tick: number;
  readonly simTimeSec: number;
  readonly paused: boolean;
  readonly missionSeed: number;

  /** Resets all pools and loads `mission`: spawns the player (per `mission.playerStart`) and every `mission.aiFlights` entry (per its `count`), each AI aircraft getting a `Pilot` from `createAiPilot` seeded per section 4.7. Sets `tick=0`, `simTimeSec=0`. */
  loadMission(mission: Mission): void;
  /** Equivalent to re-calling `loadMission` with the most recently loaded `Mission`. */
  reset(): void;

  /** Direct spawn (used by `CombatPort` for bullets/missiles, and by `SimCommand.spawn` handling in `sim.worker.ts`). Returns `NO_ENTITY_ID` if the relevant per-kind pool is full. */
  spawnEntity(spec: SpawnSpec): EntityId;
  despawnEntity(id: EntityId): void;

  /** Sets the `PilotInputs` applied to `entityId` on its next `stepOnce` (and every subsequent one, until called again). `entityId` need not be the player — used for scripted/AI-less test entities too (see `tools/sim-check.ts`). No-op if `entityId` is not a live aircraft. */
  setPlayerInput(entityId: EntityId, inputs: PilotInputs): void;
  /** Replaces the `Pilot` driving `entityId` (via `createAiPilot`) with one built for `difficulty`, keeping the same seed. No-op if `entityId` is not a live, AI-controlled aircraft. */
  setDifficulty(entityId: EntityId, difficulty: AiDifficulty): void;
  setPaused(paused: boolean): void;

  /** Advances the simulation by exactly one fixed tick. No-op (does not advance `tick`/`simTimeSec`) while `paused`. See 10-core-worker.md section 4.1 for the exact per-tick order. */
  stepOnce(): void;

  /** The entity id most recently spawned as the player (via `loadMission`'s `playerStart` or an explicit `spawnEntity` marked as player by the caller — see 10-core-worker.md section 4.2), or `NO_ENTITY_ID`. */
  getPlayerEntityId(): EntityId;
  getEntityState(id: EntityId): EntityState | undefined;
  getDamageState(id: EntityId): DamageState | undefined;
  /** `undefined` if `id` is not a live aircraft. Reflects the telemetry computed during the most recent `stepOnce` (i.e. one tick behind the `EntityState` when read mid-tick — never, since callers only read between `stepOnce` calls). */
  getTelemetry(id: EntityId): AircraftTelemetry | undefined;
  getCombatStatus(id: EntityId): CombatStatus | undefined;

  /** Writes this tick's snapshot for the current player (see `WriteSnapshot`). `out.length` must equal `SNAPSHOT_FLOATS`. */
  writeSnapshot(out: Float64Array): void;
  /** Copies and clears this tick's queued `SimEvent`s into `out` (caller-owned, `out.length >= EVENT_QUEUE_CAPACITY`). Returns the count written. */
  drainEvents(out: SimEvent[]): number;
}

export type CreateWorld = (deps: WorldDependencies) => World;

// -----------------------------------------------------------------------------
// 9. Mission loading from disk (`src/core/missions/*.json`). The on-disk
//    format is intentionally NOT `Mission<TTerrain,TAirport>` itself (this
//    file cannot name module 04/05's real `TerrainParams`/`AirportLayout`
//    shapes — see 00-architecture.md section 8) — it is a flatter descriptor
//    that `LoadMissionDescriptor`'s real implementation (in
//    `src/core/missions/index.ts`, which DOES import `src/contracts/terrain`
//    and `src/contracts/airport` directly, same as `world.ts` does for its
//    other dependencies) resolves into a real `Mission` before handing it to
//    `World.loadMission`.
// -----------------------------------------------------------------------------

export interface MissionDescriptor {
  id: string;
  name: string;
  /** `WorldConfig.seed` (core.ts) — the one master seed. */
  seed: number;
  /** Passed through opaquely to `resolveTerrainParams`; this module does not interpret it. */
  terrain: Readonly<Record<string, unknown>>;
  /** `AirportLayout.id`s (module 05) to resolve via `resolveAirport`, matching the file-stem ids `"rangpur-afb"` / `"konarak-coastal"` (00-architecture.md section 9.3). */
  airportIds: readonly string[];
  playerStart: Mission['playerStart'];
  aiFlights: Mission['aiFlights'];
  weather: Mission['weather'];
  objectives: Mission['objectives'];
}

/**
 * Resolves a `MissionDescriptor` into a real `Mission` by looking up each of
 * `descriptor.airportIds` via `resolveAirport` (dropping — and, in a dev
 * build, warning about — any id it returns `undefined` for) and adapting
 * `descriptor.terrain` via `resolveTerrainParams`. `resolveAirport`/
 * `resolveTerrainParams` are typed `unknown`-returning here because this
 * contract cannot name `contracts/airport.ts`/`contracts/terrain.ts`'s real
 * types; `src/core/missions/index.ts`'s actual implementation types them
 * precisely against `src/contracts/airport.ts`/`src/contracts/terrain.ts`.
 */
export type LoadMissionDescriptor = (descriptor: MissionDescriptor, resolveAirport: (id: string) => unknown | undefined, resolveTerrainParams: (raw: Readonly<Record<string, unknown>>) => unknown) => Mission;

// -----------------------------------------------------------------------------
// 10. Quality-tier-driven main-thread wiring config (main.ts / src/ui glue).
//     Only the pieces module 10's OWN code (main.ts) reads directly; the full
//     per-tier control table is 00-architecture.md section 14 and is owned by
//     src/render/src/ui, not re-specified here.
// -----------------------------------------------------------------------------

/** What `src/main.ts` passes into the sim worker's `init` message alongside the `Mission`. */
export interface SimBootConfig {
  mission: Mission;
  qualityTier: QualityTier;
}
