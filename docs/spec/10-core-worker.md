# 10 — Core loop, world, workers, app entry

Read `00-architecture.md` and `contracts/core.ts` in full before this document; they are law. This document and `contracts/sim.ts` are the complete, self-contained spec for module 10: the fixed-step sim worker, the `World` that owns all entity state, the snapshot/event wire format writers and readers, the mission loader, and the application shell (`main.ts`, `index.html`, build config). Every cross-module dependency this module has is expressed either through `core.ts`'s own vocabulary or through a small adapter interface this document defines and names explicitly in `contracts/sim.ts` — see section 9 for exactly which names are pinned versus assumed.

## 1. Purpose & scope

`src/core` is the integrator: it is the only module whose code imports every other module, and the only module whose worker (`sim.worker.ts`) is the single source of truth for simulation state. Its job is:

- Run physics/AI/combat at a fixed 120 Hz (`SIM_HZ`, `core.ts`) inside `sim.worker.ts`, using an accumulator so the tick rate is exact regardless of the host's timer jitter.
- Own a pre-sized pool of up to `MAX_ENTITIES` (400) entities and step them in the fixed per-tick order given in section 4.1.
- Serialise player-relevant state into the binary `Snapshot` format `core.ts` section 11 defines, at 60 Hz (`SNAPSHOT_HZ`), using a 3-buffer round-robin pool so the hot path never allocates an `ArrayBuffer`.
- Collect discrete `SimEvent`s (explosions, hits, kills, warnings, ...) per tick and ship them to the main thread alongside (not inside) the snapshot stream.
- Load `Mission` data (the two built-in missions plus whatever `SimCommand.loadMission` supplies at runtime) and wire the concrete `Pilot`/`HeightSampler`/`AirportNavDb`/flight-model/combat implementations behind the narrow "Port" interfaces `contracts/sim.ts` defines.
- On the main thread: create both workers, wire `src/input`/`src/render`/`src/hud`/`src/ui`, and drive the render loop's `requestAnimationFrame`, resize, and visibility-change handling.
- Own the project's build configuration (`package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`) so the other eleven modules' files compile and bundle without any of them needing to touch build config.

Out of scope (owned elsewhere, only consumed here through a Port or a `core.ts` type): the actual flight-dynamics math (module 02), the Tejas's data tables (module 03), terrain generation (module 04), airport parsing (module 05), AI decision-making (module 06), weapons/damage resolution (module 07), rendering/HUD (module 08), device input reading (module 09), menus/editor/PWA (module 11), and all test authoring (module 12, which does read `contracts/sim.ts` — see 00-architecture.md section 8's exception for verification).

## 2. Owned files

| path | purpose |
|---|---|
| `src/core/entityPool.ts` | Pre-sized entity store; implements `EntityPool`/`CreateEntityPool`, `packEntityId`/`unpackEntityId` (`core.ts` types `PackEntityId`/`UnpackEntityId`). |
| `src/core/world.ts` | Implements `World`/`CreateWorld`. Owns the per-tick step order, warning-bit evaluation, wind/atmosphere construction, touchdown/crash detection, mission loading, player/AI bookkeeping. |
| `src/core/flightModelAdapter.ts` | Adapts module 02/03's real exports (`stepAircraft`, `AircraftDefinition` registry) to `FlightModelPort`. |
| `src/core/combatAdapter.ts` | Adapts module 07's real exports to `CombatPort`. |
| `src/core/aiPilotAdapter.ts` | Adapts module 06's real `Pilot` factory to `CreateAiPilot`. |
| `src/core/atmosphere.ts` | Self-contained ISA atmosphere model (density, speed of sound vs. altitude); see section 4.5 for why this module owns its own copy instead of depending on module 02's. |
| `src/core/wind.ts` | Deterministic wind + gust + turbulence evaluation from `WeatherConfig` and a seeded PRNG stream (section 4.5). |
| `src/core/snapshotWriter.ts` | Implements `WriteSnapshot`. |
| `src/core/snapshotReader.ts` | Implements `ReadSnapshotHeader`/`ReadSnapshotEntity`/`ReadSnapshotHud`. Used by `src/render`/`src/hud` (main thread) and by `tools/sim-check.ts`. |
| `src/core/eventQueue.ts` | Implements `EventQueue`/`CreateEventQueue`. |
| `src/core/fixedStepLoop.ts` | Implements `AdvanceFixedStep`/`ShouldEmitSnapshot`. |
| `src/core/seed.ts` | `subSeed(masterSeed, tag)` deterministic sub-seed derivation (section 4.7). |
| `src/core/missions/freeFlight.json`, `src/core/missions/dogfight1v1.json` | Concrete `MissionDescriptor` data (section 5.3). |
| `src/core/missions/index.ts` | Implements `LoadMissionDescriptor`; resolves a `MissionDescriptor`'s `airportIds`/`terrain` into a real `Mission` using module 04/05's real factories (adapter code, see section 9). |
| `src/core/sim.worker.ts` | Worker bootstrap: owns `onmessage` for `MainToSimMessage`, drives the timer + accumulator, owns the snapshot buffer pool, posts `SimToMainMessage`. |
| `src/core/index.ts` | Barrel re-export of the above (excluding `sim.worker.ts`, which is loaded as a worker entry, not imported as a library). |
| `src/main.ts` | App entry: creates both workers, wires `src/input`/`src/render`/`src/hud`/`src/ui`, drives `requestAnimationFrame`, resize, visibility pause (section 4.10). |
| `index.html` | Single-page shell (section 5.4). |
| `vite.config.ts` | Build config (section 5.5). |
| `tsconfig.json` | Project-wide strict TS config; content fixed verbatim by `00-architecture.md` section 13 (section 5.6). |
| `package.json` | Dependencies/scripts (section 5.7). |

## 3. Public API

This section restates `contracts/sim.ts` grouped by concern; the contract file is authoritative if this prose and that file ever disagree (they must not — this document is the contract's own design rationale, written by the same drafting pass).

### 3.1 Constants

```ts
export const DEFAULT_ENTITY_POOL_CAPACITY: Readonly<Record<EntityKind, number>> = { aircraft: 32, missile: 64, bullet: 240, effect: 64 };
export const SNAPSHOT_EVERY_N_TICKS = 2;                 // SIM_HZ / SNAPSHOT_HZ
export const ACCUMULATOR_MAX_CATCHUP_SEC = 0.25;
export const SIM_WORKER_TIMER_INTERVAL_MS = 4;
export const EVENT_QUEUE_CAPACITY = 256;
export const WARNING_LOW_FUEL_FRAC = 0.1;
export const WARNING_OVER_G_POS = 9.0;
export const WARNING_OVER_G_NEG = -3.0;
export const WARNING_TERRAIN_PULLUP_AGL_M = 150;
export const WARNING_TERRAIN_PULLUP_SINK_MPS = 10;
export const WARNING_GEAR_UNSAFE_AGL_M = 300;
export const WARNING_GEAR_UNSAFE_SINK_MPS = 1;
```

### 3.2 Entity pool

```ts
export interface EntityPoolCapacity { aircraft: number; missile: number; bullet: number; effect: number; }
export interface EntityPool {
  readonly capacity: Readonly<EntityPoolCapacity>;
  readonly liveCount: number;
  allocate(kind: EntityKind, team: Team): EntityId;      // NO_ENTITY_ID if that kind's budget is exhausted
  release(id: EntityId): void;
  isAlive(id: EntityId): boolean;
  get(id: EntityId): EntityState | undefined;
  getDamage(id: EntityId): DamageState | undefined;
  liveAt(denseIndex: number): EntityState;                // 0 .. liveCount-1, order unstable across ticks
}
export type CreateEntityPool = (capacity: EntityPoolCapacity) => EntityPool;
```

### 3.3 Ports (World's cross-module dependencies)

```ts
export interface SimEnvironment { airDensityKgM3: number; soundSpeedMps: number; windWorldMps: Vec3Like; gravityMps2: number; groundElevationM: number; groundNormalWorld: Vec3Like; }

export interface FlightModelPort {
  hasDefinition(aircraftDefId: string): boolean;
  step(aircraftDefId: string, state: EntityState, damage: DamageState, inputs: PilotInputs, env: SimEnvironment, dtSec: number, out: EntityState): void;
  computeTelemetry(aircraftDefId: string, state: EntityState, damage: DamageState, env: SimEnvironment, out: AircraftTelemetry): void;
  maxFuelKg(aircraftDefId: string): number;
}

export interface AiFormationSlotLike { role: 'leader' | 'wingman'; leaderId: EntityId; slotRightM: number; slotBackM: number; slotUpM: number; }
export interface AiPilotSpawnParamsLike { aircraftDefId: string; team: Team; difficulty: AiDifficulty; seed: number; homeAirportId?: string; homeRunwayId?: string; patrolCenterWorld?: Vec3Like; patrolRadiusM?: number; formation?: AiFormationSlotLike; }
export type CreateAiPilot = (params: Readonly<AiPilotSpawnParamsLike>) => Pilot;

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
export interface CombatPort { step(dtSec: number, ctx: CombatTickContext, eventsOut: EventQueue): void; }
```

### 3.4 Event queue

```ts
export interface EventQueue {
  readonly capacity: number;
  readonly length: number;
  push(event: SimEvent): boolean;                         // false = dropped, queue was full
  drainInto(out: SimEvent[]): number;                      // copies + clears, out.length >= capacity
  clear(): void;
}
export type CreateEventQueue = (capacity: number) => EventQueue;
```

### 3.5 Fixed-step accumulator

```ts
export interface FixedStepAccumulatorState { accumulatorSec: number; tickCount: number; }
export type AdvanceFixedStep = (state: FixedStepAccumulatorState, realDtSec: number, stepFn: (dtSec: number) => void) => number;
export type ShouldEmitSnapshot = (tickCount: number) => boolean;
```

### 3.6 Snapshot writer / reader

```ts
export interface SnapshotEntityView { id: EntityId; kind: EntityKind; team: Team; pos: Vec3Like; rot: QuatLike; vel: Vec3Like; omega: Vec3Like; alive: boolean; hp: number; fuelKg: number; elevonL: number; elevonR: number; rudder: number; gearPos: number; throttle: number; afterburnerOn: boolean; flags: EntityFlags; }
export interface SnapshotHudView { iasMps: number; tasMps: number; mach: number; altMslM: number; altAglM: number; aoaRad: number; betaRad: number; gLoad: number; headingRad: number; pitchRad: number; rollRad: number; vspeedMps: number; fuelKg: number; thrustFrac: number; gearPos: number; weaponIdx: number; targetId: EntityId; targetRangeM: number; closureMps: number; lockState: number; warningBits: number; ilsLoc: number; ilsGs: number; pipperX: number; pipperY: number; pipperZ: number; pipperValid: number; }
export interface SnapshotHeaderView { tick: number; simTimeSec: number; entityCount: number; playerIndex: number; }

export type WriteSnapshot = (pool: EntityPool, playerEntityId: EntityId, tick: number, simTimeSec: number, hud: SnapshotHudView, out: Float64Array) => void;
export type ReadSnapshotHeader = (buf: Float64Array) => SnapshotHeaderView;
export type ReadSnapshotEntity = (buf: Float64Array, index: number, out: SnapshotEntityView) => SnapshotEntityView;
export type ReadSnapshotHud = (buf: Float64Array, out: SnapshotHudView) => SnapshotHudView;
```

### 3.7 Spawning and World

```ts
export interface SpawnSpec { kind: EntityKind; team: Team; pos: Vec3Like; headingRad: number; speedMps?: number; aircraftDefId?: string; difficulty?: AiDifficulty; weapon?: WeaponKind; shooterId?: EntityId; }

export interface WorldDependencies { flightModel: FlightModelPort; combat: CombatPort; createAiPilot: CreateAiPilot; sampler: HeightSampler; navDb: AirportNavDb; entityPoolCapacity?: EntityPoolCapacity; }

export interface World {
  readonly tick: number;
  readonly simTimeSec: number;
  readonly paused: boolean;
  readonly missionSeed: number;
  loadMission(mission: Mission): void;
  reset(): void;
  spawnEntity(spec: SpawnSpec): EntityId;
  despawnEntity(id: EntityId): void;
  setPlayerInput(entityId: EntityId, inputs: PilotInputs): void;
  setDifficulty(entityId: EntityId, difficulty: AiDifficulty): void;
  setPaused(paused: boolean): void;
  stepOnce(): void;
  getPlayerEntityId(): EntityId;
  getEntityState(id: EntityId): EntityState | undefined;
  getDamageState(id: EntityId): DamageState | undefined;
  getTelemetry(id: EntityId): AircraftTelemetry | undefined;
  getCombatStatus(id: EntityId): CombatStatus | undefined;
  writeSnapshot(out: Float64Array): void;
  drainEvents(out: SimEvent[]): number;
}
export type CreateWorld = (deps: WorldDependencies) => World;
```

### 3.8 Mission descriptor

```ts
export interface MissionDescriptor { id: string; name: string; seed: number; terrain: Readonly<Record<string, unknown>>; airportIds: readonly string[]; playerStart: Mission['playerStart']; aiFlights: Mission['aiFlights']; weather: Mission['weather']; objectives: Mission['objectives']; }
export type LoadMissionDescriptor = (descriptor: MissionDescriptor, resolveAirport: (id: string) => unknown | undefined, resolveTerrainParams: (raw: Readonly<Record<string, unknown>>) => unknown) => Mission;
export interface SimBootConfig { mission: Mission; qualityTier: QualityTier; }
```

## 4. Design & algorithms

### 4.1 Per-tick order (`World.stepOnce`)

Called once per fixed tick from `sim.worker.ts`'s accumulator loop (section 4.4). No-op if `paused`. Exact order:

1. **Inputs.** Nothing to do here beyond what `setPlayerInput` already wrote into the pool's stored `PilotInputs` buffer for player-controlled aircraft (main thread calls `setPlayerInput` in response to a `SimInputMessage`, asynchronously with respect to ticks — see 4.9). Each aircraft's *effective* input this tick is whatever was last set; a freshly spawned player aircraft defaults to a neutral input (`pitch=roll=yaw=0, throttle=0, afterburner=false, brakes=0, gearDown=true, airbrake=false, trigger=false, launch=false, cycleWeapon=false, cycleTarget=false`) until the first `setPlayerInput` call arrives.
2. **Pilots (AI only).** For every live aircraft entity that has an attached `Pilot` (i.e. was spawned with `difficulty` set — see 4.2), build a `PilotContext` (reusing one pooled object per AI entity, never allocated fresh) from: `self` = the entity's own `EntityState`; `selfDamage` = its `DamageState`; `telemetry` = the `AircraftTelemetry` computed during the *previous* tick's step 4 (one tick stale — 8.3 ms old — which is the standard, accepted staleness for AI decision inputs); `contacts` = `[]` for tick 0 or whatever `CombatPort` populated via `CombatTickContext`/`CombatStatus` on the previous tick's step 6 (this module does not compute contacts itself — see section 9); `combat` = the entity's `CombatStatus` (defaulted to `{selectedWeapon:'gun', ammoGun:0, missilesIr:0, missilesRadar:0, lockState:'none', lockedTargetId:undefined, rwrWarning:false, missileInboundWarning:false}` until `CombatPort` first populates it); `sampler`/`navDb` = `WorldDependencies`'; `windWorldMps` = this tick's wind (step 3's input, computed once per tick, not per aircraft, since wind is spatially uniform in this project's model — see 4.5); `simTimeSec` = `World.simTimeSec` *before* this tick's advance. Call `pilot.update(ctx, SIM_DT_SEC, out)` where `out` is the entity's own stored `PilotInputs` object (mutated in place — this is exactly what feeds step 3 for this same tick, so AI reaction latency is zero extra ticks beyond the one-tick-stale telemetry it decided from).
3. **Flight model.** For every live aircraft entity (player and AI alike): construct `env: SimEnvironment` = `{ airDensityKgM3, soundSpeedMps }` from `isaAtmosphere(entity.pos.y)` (section 4.5) + `{ windWorldMps: thisTickWind, gravityMps2: GRAVITY_MPS2 }` + `{ groundElevationM: sampler.heightAt(state.pos.x, state.pos.z), groundNormalWorld: sampler.normalAt(state.pos.x, state.pos.z, groundNormalScratch) }` (a per-entity reused `Vec3Like` scratch object — `HeightSampler.normalAt`'s own `out` parameter — never allocated per tick; this is the same pair of `HeightSampler` calls `AircraftTelemetry.altAglM` already needs, so it costs nothing extra beyond the one `normalAt` call `altAglM` alone would not have needed); call `deps.flightModel.step(aircraftDefId, state, damage, inputs, env, SIM_DT_SEC, state)` (in-place: `out === state`, matching `StepAircraft`'s pinned aliasing contract). Then call `deps.flightModel.computeTelemetry(aircraftDefId, state, damage, env, telemetryOut)` into that entity's stored `AircraftTelemetry`, overwriting last tick's value (this is what step 2 reads *next* tick).
4. **Warning-bit evaluation.** For every live aircraft, compare this tick's freshly computed telemetry/flags against the values stored from the previous tick (kept per-entity) and push `WarningEvent`s on edges only (never every tick while a condition holds) per the rules in section 4.6. Then store this tick's values as "previous" for next tick's comparison.
5. **Touchdown/crash detection.** For every live aircraft: if `!wasOnGround && (state.flags & EntityFlag.OnGround)`, push `{type:'touchdown', entityId, vspeedMps: Math.abs(previousTelemetry.vspeedMps), pos: {...state.pos}}`. If `damage.structurePct <= 0` and it was `> 0` at the start of this tick, push `{type:'crash', entityId, pos:{...state.pos}}`, set `state.alive = false`, `state.hp = 0` (the entity is NOT immediately released from the pool — `despawnEntity` is a separate, explicit call `CombatPort`/`sim.worker.ts` makes after the crash event has had a chance to be observed at least once, per section 9's note on the same pattern `core.ts` uses for `KillEvent`).
6. **Weapons, missiles, collisions/damage.** One call: `deps.combat.step(SIM_DT_SEC, combatCtx, eventQueue)`, where `combatCtx` is a `World`-owned object implementing `CombatTickContext` (a thin view over the same pool `World` already owns — no copying). This single call is where gun/missile firing, missile guidance, hit detection and `DamageState` mutation all happen; `contracts/combat.ts` (unseen by this module) owns how it subdivides that work internally.
7. **Event flush prep.** Nothing further — events pushed in steps 4–6 already live in `World`'s own `EventQueue`; `drainEvents` (called by `sim.worker.ts` after `stepOnce`, see 4.9) copies and clears it.
8. **Bookkeeping.** `tick += 1`; `simTimeSec = tick * SIM_DT_SEC` (computed from `tick`, not accumulated by repeated `+= SIM_DT_SEC`, so it cannot drift from floating-point summation error over a long mission).
9. **Mission objective evaluation.** Skipped once `missionEndedThisLoad` (a per-`loadMission` boolean, reset to `false` in `loadMission`/`reset`) is already `true`. Otherwise call `evaluateObjectives(...)` (4.1b); if it returns a defined outcome, push the resulting `MissionEndedEvent` and set `missionEndedThisLoad = true` (the mission keeps simulating afterward — e.g. wreckage/rollout continues to render — but never emits a second `missionEnded` for the same `loadMission`).

### 4.1b Mission objective evaluation

`evaluateObjectives(world: World-internal state, mission: Mission): { outcome: MissionOutcome; objectivesCompleted: string[] } | undefined`, called from step 9 above. Universal defeat check runs first, then per-objective win checks; the first matching rule wins (defeat beats any simultaneous win):

```
// Universal defeat conditions (apply regardless of objectives[].kind):
if (!getEntityState(playerEntityId)?.alive) return { outcome: MissionOutcome.Failure, objectivesCompleted: [] };

// Per-objective completion (a MissionObjective is "complete" once its own condition holds):
completed = []
for (const obj of mission.objectives) {
  switch (obj.kind) {
    case MissionObjectiveKind.DestroyAllHostiles:
      // every live aircraft entity with team !== playerTeam has alive === false
      if (every hostile aircraft entity ever spawned this mission is now !alive) completed.push(obj.id);
      break;
    case MissionObjectiveKind.Land:
      // obj.params.airportId (string), obj.params.runwayId (string) — both required keys for this kind
      if ((playerState.flags & EntityFlag.OnGround) && playerTelemetry.iasMps < 5
          && playerIsNearRunway(obj.params.airportId, obj.params.runwayId)) completed.push(obj.id);
      break;
    case MissionObjectiveKind.ReachWaypoint:
      // obj.params.waypointX/waypointY/waypointZ (number), obj.params.radiusM (number, default 200 if absent)
      if (distance(playerState.pos, {x:obj.params.waypointX, y:obj.params.waypointY, z:obj.params.waypointZ}) <= (obj.params.radiusM ?? 200)) completed.push(obj.id);
      break;
    case MissionObjectiveKind.SurviveTime:
      // obj.params.seconds (number)
      if (world.simTimeSec >= obj.params.seconds) completed.push(obj.id);
      break;
  }
}
if (completed.length === mission.objectives.length && mission.objectives.length > 0)
  return { outcome: MissionOutcome.Success, objectivesCompleted: completed };
return undefined;   // not yet resolved either way
```

`playerIsNearRunway(airportId, runwayId)` resolves the runway via `deps.navDb.getRunway` and checks the player's horizontal distance to `runway.thresholdPos` is `<= runway.lengthM` (i.e. somewhere along the physical strip, not just at the exact threshold point). A `Land` objective whose `airportId`/`runwayId` do not resolve to a real runway never completes (logged once in dev builds, per this project's error-handling convention for bad-but-non-fatal data — never thrown). `dogfight1v1.json`'s sole `destroy_all_hostiles` objective (section 5.3) and `freeFlight.json`'s sole `survive_time` objective are both satisfiable by this algorithm using only the `params` keys shown above, which is why those two missions' JSON already only ever populates those exact keys.

`getPlayerEntityId()`/`getEntityState`/`getTelemetry` above are `World`'s own already-existing methods; "every hostile aircraft entity ever spawned this mission" is tracked as a `Set<EntityId>` of aircraft `EntityId`s with `team !== 0` populated at `loadMission` time (from `mission.aiFlights`' spawn results) — `World` already has this information from section 4.2's spawn loop, it just needs to retain the id list rather than discarding it.

### 4.2 Spawning and the player entity

`loadMission(mission)`: calls `reset()` internals (release every live entity back to the pool, clear the event queue, zero `tick`/`simTimeSec`), stores `mission`, sets `missionSeed = mission.world.seed`, then:

- **Player.** If `mission.playerStart.airportId`/`runwayId` are set, resolve the runway via `deps.navDb.getRunway(...)`; the spawn `pos` is `runway.thresholdPos` offset 200 m down the runway heading (so the aircraft starts on the runway, not exactly at the threshold edge) at `runway.elevationM + 0.5` (half a metre above the paved surface — a conservative initial clearance so first-tick gear contact resolution, owned by the flight model, starts from "just above ground" rather than "exactly on it"), `headingRad = runway.headingRad`, `speedMps = mission.playerStart.speedMps ?? 0`. Otherwise (`mission.playerStart.pos` set) spawn airborne at that `pos`/`headingRad`/`speedMps`. `spawnEntity({kind:'aircraft', team:0, pos, headingRad, speedMps, aircraftDefId: 'tejas-mk1'})` (confirmed, not a guess — `03-tejas-data.md`'s `tejasDefinition.id === 'tejas-mk1'` exactly, section 3) — no `difficulty` field, so this aircraft is player-controlled. The returned id is stored as `playerEntityId` and that entity's `flags` gets `EntityFlag.IsPlayer` set (via a direct pool write, not through `SpawnSpec`, since `IsPlayer`-marking is `World`'s own bookkeeping, not a general spawn feature).
- **AI flights.** For each `mission.aiFlights[i]`, for `j` in `0 .. flight.count-1`, **in ascending `j` order** (so index-0, the flight's leader, is always spawned — and its `EntityId` known — before any wingman): resolve start `pos`/`headingRad`/`speedMps` the same way (airport+runway, or explicit `startPos`/`startHeadingRad`/`startSpeedMps`; formation offset for `count > 1` is a `40*j` metre lateral offset along the axis perpendicular to `startHeadingRad`, at the same altitude, so a "flight" of N aircraft spawns in a simple line-abreast without overlapping — this initial line-abreast placement is independent of, and only a starting point for, the `AiFormationSlot`-driven formation-keeping described next), `entityId = spawnEntity({kind:'aircraft', team:flight.team, pos, headingRad, speedMps, aircraftDefId: flight.aircraftId, difficulty: flight.difficulty})`. Because `difficulty` is set, `spawnEntity` additionally builds an `AiPilotSpawnParamsLike` (section 3.3) — `{ aircraftDefId: flight.aircraftId, team: flight.team, difficulty: flight.difficulty, seed: subSeed(missionSeed, 'ai:' + flight.id + ':' + j), homeAirportId: flight.homeAirportId, homeRunwayId: flight.homeRunwayId, patrolCenterWorld: flight.patrolCenterWorld, patrolRadiusM: flight.patrolRadiusM, formation: flight.count > 1 ? { role: j === 0 ? 'leader' : 'wingman', leaderId: j === 0 ? NO_ENTITY_ID : flightLeaderId, slotRightM: 150, slotBackM: 100 * j, slotUpM: -20 } : undefined }` (`flightLeaderId` is `entityId` captured from this same loop's `j===0` iteration; the `150`/`100*j`/`-20` figures are contracts/ai.ts section 5.7's own recommended 2-ship default, scaled by `j` for a flight larger than two — `World` does not invent its own formation geometry) — calls `deps.createAiPilot(params)` and attaches the returned `Pilot` to `entityId` (stored in a parallel `Map<EntityId, Pilot>` — not part of `EntityState`, since `Pilot` is not serialisable data).

Non-mission spawns (`World.spawnEntity` called directly, e.g. by `CombatPort` for a bullet/missile, or by a `SimCommand.spawn` from the main thread for manual testing) never set `IsPlayer` and never attach a `Pilot` unless `difficulty` is explicitly passed. There is no separate "respawn the player" operation in this contract: recovering from a crash means the caller (`src/ui`'s debrief screen, via a fresh `SimCommand.loadMission`) reloads a `Mission`.

**`Map<EntityId, Pilot>` lifecycle.** `World.despawnEntity(id)` (called by `CombatPort`/`sim.worker.ts` per section 4.1 step 5's crash-then-despawn pattern, or directly by a `reset`/`SimCommand.spawn`-adjacent test path) deletes `id` from this map immediately after releasing the pool slot, in the same call — a released slot's `EntityId` is never reused for a *new* Pilot without going back through `spawnEntity`'s own attach step above, so a stale map entry would otherwise silently leak (harmless to correctness, since a recycled slot gets a new `EntityId` via its incremented `generation`, §4.3 — but an unbounded per-session memory leak across many AI spawn/despawn cycles, e.g. a long free-flight session with repeated `SimCommand.spawn` test traffic). `reset()` (called at the top of every `loadMission`, this section) clears the whole map in one call rather than deleting entries one at a time, exactly like it clears the entity pool and event queue.

**Fuel initialisation.** `EntityPool.allocate` (section 4.3) zero-reinitialises a slot's `EntityState`, which would otherwise leave a freshly-spawned aircraft's `fuelKg` at 0 (fuel-starved from tick one). `World.spawnEntity`, immediately after `allocate` returns for `kind==='aircraft'`, sets `pool.get(id)!.fuelKg = deps.flightModel.maxFuelKg(spec.aircraftDefId!)` (full internal fuel at spawn — this project has no partial-fuel loadout option). Non-aircraft kinds leave `fuelKg` at its zero default (core.ts documents it as aircraft-only).

### 4.3 Entity pool internals

`packEntityId`/`unpackEntityId` (`core.ts` types `PackEntityId`/`UnpackEntityId`), implemented in `entityPool.ts`, using **only** multiplication/division/modulo (never `<<`/`>>>`, per `core.ts`'s own warning about 32-bit signed overflow once `generation >= 0x8000`):

```ts
export const packEntityId: PackEntityId = (index, generation) => generation * ENTITY_INDEX_RADIX + index;
export const unpackEntityId: UnpackEntityId = (id) => ({ index: id % ENTITY_INDEX_RADIX, generation: Math.floor(id / ENTITY_INDEX_RADIX) });
```

(`ENTITY_INDEX_RADIX = 65536` from `core.ts`.) Worked example: `packEntityId(5, 3) === 3*65536+5 === 196613`; `unpackEntityId(196613) === {index:5, generation:3}`.

Storage: four typed sub-arrays of `EntityState`-shaped plain objects (one array per `EntityKind`, pre-allocated to that kind's capacity at construction — `new Array(capacity).fill(null).map(() => ({...zeroed EntityState}))` run exactly once, never again), plus a parallel `generation: Uint32Array` per kind and a `liveDense: EntityId[]` + `liveDenseCount: number` per kind for the `liveAt` iteration (swap-remove on `release`: overwrite the released slot's dense-array entry with the last live entry's, decrement the count — O(1), no shifting). `allocate(kind, team)`: if that kind's live count equals its capacity, return `NO_ENTITY_ID`; otherwise pop the next free index (a simple free-list stack per kind, refilled by `release`), zero-reinitialise that slot's `EntityState` fields (`alive=true, hp=100`, all vectors zeroed, `id = packEntityId(index, generation[index])`, `kind`, `team`), push it onto `liveDense`, return the id. `getDamage`/aircraft-only: a `DamageState` sub-array sized to the aircraft capacity only (missiles/bullets/effects never get one; `getDamage` returns `undefined` for them), initialised to `{structurePct:1, engineHealthPct:1, controlSurfaces:{elevonL:1,elevonR:1,rudder:1}, hydraulicsOk:true, fuelLeak:false, radarHealthPct:1, gearHealthPct:1}` on allocate.

`liveAt` across ALL kinds (used by the snapshot writer, which needs one combined dense list): `World` — not `EntityPool` itself — concatenates the four per-kind dense lists into one combined view at snapshot-write time (a plain indexed copy loop, capped at `MAX_ENTITIES`, into a pre-sized scratch array reused every call — never allocated per tick). `EntityPool.liveCount` is the sum of the four per-kind live counts; `EntityPool.liveAt(denseIndex)` walks the four kinds in a fixed order (`aircraft, missile, bullet, effect`) treating `denseIndex` as an index into their concatenation, for callers (like `CombatTickContext`) that only need "iterate everything," not "iterate the combined array `World` already built for the snapshot."

### 4.4 Fixed-step accumulator and the worker's own clock

`fixedStepLoop.ts` implements exactly 00-architecture.md section 4's algorithm, made pure and Node-testable:

```ts
export const advanceFixedStep: AdvanceFixedStep = (state, realDtSec, stepFn) => {
  state.accumulatorSec += Math.min(realDtSec, ACCUMULATOR_MAX_CATCHUP_SEC);
  let steps = 0;
  while (state.accumulatorSec >= SIM_DT_SEC) {
    stepFn(SIM_DT_SEC);
    state.accumulatorSec -= SIM_DT_SEC;
    state.tickCount += 1;
    steps += 1;
  }
  return steps;
};
export const shouldEmitSnapshot: ShouldEmitSnapshot = (tickCount) => tickCount % SNAPSHOT_EVERY_N_TICKS === 0;
```

`sim.worker.ts` drives this with its own clock, since dedicated workers have no `requestAnimationFrame`:

```ts
let lastNowMs = performance.now();
const accState: FixedStepAccumulatorState = { accumulatorSec: 0, tickCount: 0 };
setInterval(() => {
  const nowMs = performance.now();
  const realDtSec = (nowMs - lastNowMs) / 1000;
  lastNowMs = nowMs;
  if (world.paused) return;   // world.stepOnce() is ALSO a no-op while paused (4.1), but skipping the whole callback here additionally stops the snapshot/event work below from running at ~60 Hz for nothing — see the note below
  const stepsThisCall = advanceFixedStep(accState, realDtSec, (dtSec) => {
    world.stepOnce();
    if (shouldEmitSnapshot(accState.tickCount)) emitSnapshotIfBufferAvailable();
  });
  if (stepsThisCall > 0) flushEvents();
}, SIM_WORKER_TIMER_INTERVAL_MS);
```

**Why the `lastNowMs` update happens BEFORE the `paused` check, every callback, even while paused.** If `lastNowMs` were only updated on an unpaused callback, `realDtSec` on the FIRST callback after `setPaused(false)` would include the entire paused duration (seconds to hours), which `advanceFixedStep`'s own `ACCUMULATOR_MAX_CATCHUP_SEC` clamp (0.25 s) would then correctly cap — but capping is a safety net for a *real* stall, not the intended behaviour for an *intentional* pause; returning early only AFTER `lastNowMs = nowMs` means `realDtSec` on resume is a normal, small value (one `SIM_WORKER_TIMER_INTERVAL_MS` tick), exactly as if the pause had never happened. This is also why `accState` itself is untouched by `setPaused` (no reset needed): both `accumulatorSec` and `tickCount` simply stop advancing while paused and resume exactly where they left off, and `world.paused` (not a separate flag here) is the single source of truth `sim.worker.ts` reads every callback — `SimCommand.pause` (4.9) only ever calls `world.setPaused(cmd.paused)`, nothing else.

`SIM_WORKER_TIMER_INTERVAL_MS = 4` (shorter than the nominal `SIM_DT_SEC*1000 ≈ 8.33` ms) so the `while` loop inside `advanceFixedStep`, not `setInterval`'s own granularity, is what determines the exact tick count — a slow/late timer callback just makes one call step multiple ticks in its `while` loop, which is precisely the catch-up behaviour `ACCUMULATOR_MAX_CATCHUP_SEC` bounds (worst case after a 0.3 s stall: `Math.floor(0.25 / SIM_DT_SEC) = 30` ticks run in a single `advanceFixedStep` call, never more).

### 4.5 Environment: atmosphere and wind

`src/core/atmosphere.ts` implements a standard two-layer ISA model directly (troposphere 0–11000 m, isothermal layer 11000–20000 m), rather than depending on module 02's `atmosphere.ts` under an unpinned export name (see section 9) — `World` needs this independently of whatever module 02 does internally for its own aero force calculations, and the formula is a fixed physical standard, not a design choice module 02 owns exclusively:

```ts
const T0 = 288.15, P0 = 101325, LAPSE = 0.0065, R_SPECIFIC = 287.05287, G0 = 9.80665, GAMMA = 1.4;
const EXPONENT = G0 / (LAPSE * R_SPECIFIC); // 5.255879812716677
const T11 = T0 - LAPSE * 11000;             // 216.65
const P11 = P0 * Math.pow(T11 / T0, EXPONENT); // 22632.040095007793

export function isaAtmosphere(altMslM: number): { airDensityKgM3: number; soundSpeedMps: number } {
  const h = Math.max(-1000, Math.min(20000, altMslM));
  let T: number, P: number;
  if (h <= 11000) {
    T = T0 - LAPSE * h;
    P = P0 * Math.pow(T / T0, EXPONENT);
  } else {
    T = T11;
    P = P11 * Math.exp((-G0 * (h - 11000)) / (R_SPECIFIC * T11));
  }
  const rho = P / (R_SPECIFIC * T);
  return { airDensityKgM3: rho, soundSpeedMps: Math.sqrt(GAMMA * R_SPECIFIC * T) };
}
```

Verified reference values (section 7 turns these into exact unit-test assertions): `isaAtmosphere(0) = {1.225000018, 340.293988}`, `isaAtmosphere(11000) = {0.363917648, 295.069494}`, `isaAtmosphere(5000) = {0.736115547, 320.529394}`.

`src/core/wind.ts` computes one world-frame wind vector per tick (spatially uniform — this module does not model altitude- or position-varying wind shear; that is an acceptable simplification for a placeholder-visual, physics-focused sim, noted in section 9): `mission.weather.windWorldMps` plus a slowly-evolving gust component plus a fast, unfiltered turbulence jitter, both driven by a PRNG stream seeded once per mission via `subSeed(missionSeed, 'wind')` (using `src/math`'s `mulberry32`, imported directly by source — this file is real `src/core` code, not a contract, so it is free to import `../math`):

- Every `Math.round(2.0 / SIM_DT_SEC) = 240` ticks (a new gust every ~2 s), draw a new target gust vector: azimuth `= prng() * 2*PI`, magnitude `= mission.weather.gustMps`, vertical component `= (prng() - 0.5) * mission.weather.gustMps * 0.3` (gusts are mostly horizontal). `gustTarget = { x: magnitude*sin(azimuth), y: vertical, z: -magnitude*cos(azimuth) }`.
- Every tick: `gustCurrent += (gustTarget - gustCurrent) * (SIM_DT_SEC / 1.5)` (a single-pole low-pass filter, time constant 1.5 s, applied component-wise — this is a 3-line formula written directly in `wind.ts`, not a dependency on `src/math/filters.ts`'s unpinned export name).
- Every tick, a fast jitter: `jitter = { x: (prng()-0.5), y: (prng()-0.5)*0.3, z: (prng()-0.5) } * mission.weather.turbulence * 2.0` (m/s), added on top, unfiltered.
- `windWorldMps(tick) = mission.weather.windWorldMps + gustCurrent + jitter`.

### 4.6 Warning bits `World` owns

Evaluated in step 4.1's step 4, per live aircraft, comparing this tick's value against last tick's stored value and pushing `{type:'warning', entityId, bit, active}` only on a `false→true` or `true→false` edge (never re-pushed while the condition merely persists):

| bit | condition | source |
|---|---|---|
| `WarningBit.Stall` | `telemetry.stalled` | module 02's own computation, passed through `AircraftTelemetry` |
| `WarningBit.LowFuel` | `telemetry.fuelFrac < WARNING_LOW_FUEL_FRAC (0.1)` | telemetry |
| `WarningBit.OverG` | `telemetry.gLoad > WARNING_OVER_G_POS (9.0)` OR `telemetry.gLoad < WARNING_OVER_G_NEG (-3.0)` | telemetry |
| `WarningBit.TerrainPullUp` | `telemetry.altAglM < WARNING_TERRAIN_PULLUP_AGL_M (150)` AND `telemetry.vspeedMps < -WARNING_TERRAIN_PULLUP_SINK_MPS (-10)` | telemetry + `sampler` |
| `WarningBit.GearUnsafe` | `telemetry.altAglM < WARNING_GEAR_UNSAFE_AGL_M (300)` AND `telemetry.vspeedMps < -WARNING_GEAR_UNSAFE_SINK_MPS (-1)` AND `state.gearPos < 0.99` AND `!(state.flags & EntityFlag.GearDownCommanded)` | telemetry + state |

`WarningBit.MissileLock`/`MissileLaunch`/`EngineFire`/`ConfigWarning` are pushed by `CombatPort` (it receives the same `EventQueue` — see section 9), not by `World`; these thresholds are deliberately generic/airframe-independent fallbacks, not the Tejas's actual FCS/structural limits (see section 9).

### 4.7 Deterministic sub-seeding

```ts
export function subSeed(masterSeed: number, tag: string): number {
  let h = (0x811c9dc5 ^ masterSeed) >>> 0;
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
```

An FNV-1a-style 32-bit hash of `masterSeed` folded with `tag`'s characters — deterministic, allocation-free, platform-independent (only `Math.imul`/`>>>`, no float rounding). Verified: `subSeed(42, "ai:a") === 1264669096`, `subSeed(42, "ai:b") === 1315001953`, `subSeed(43, "terrain") === 2108588079`, `subSeed(1234567, "wind") === 1578955088`. Used for: `subSeed(missionSeed, 'wind')` (section 4.5), `subSeed(missionSeed, 'ai:' + flightId + ':' + indexInFlight)` (section 4.2). This module never calls `Math.random()` anywhere (mechanically enforced the same way as every other DOM-free module — see `00-architecture.md` section 2).

### 4.8 HUD block assembly and heading/pitch/roll extraction

Before calling `WriteSnapshot`, `World` (inside `writeSnapshot`) builds one `SnapshotHudView` for `playerEntityId` (or an all-zero one if there is no player): copies `iasMps/tasMps/mach/altMslM/altAglM/gLoad/vspeedMps/fuelKg/thrustFrac` and `alphaRad→aoaRad`/`betaRad→betaRad` straight from the player's stored `AircraftTelemetry`; `gearPos`/`throttle` from `EntityState`; `weaponIdx = WeaponKindCode[combat.selectedWeapon]`, `targetId = combat.lockedTargetId ?? NO_ENTITY_ID`, `targetRangeM`/`closureMps` from the matching `Contact` in the last set `CombatPort` produced (0 if the locked target is not currently a contact), `lockState = LockStateCode[combat.lockState]`, `warningBits` accumulated from section 4.6's currently-active bits (a live bitmask, not just the edges), `ilsLoc`/`ilsGs` computed by `World` itself from `navDb` + the player's `pos` when a runway's `ils` is tuned (nearest runway with `ils` within 40 km of the player, per a simple `navDb.listAirports()` scan — cheap, done only once per emitted snapshot, i.e. at 60 Hz not 120 Hz) using the standard deviation formula: angular deviation from the localiser/glideslope centerline in degrees, divided by `ILS_LOC_FULL_SCALE_DEG`/`ILS_GS_FULL_SCALE_DEG` (`core.ts`) and clamped to `[-1,1]`; `0` for both fields if no runway's ILS is in range.

`headingRad`/`pitchRad`/`rollRad` for the HUD (and for `AircraftTelemetry.headingRad`/`pitchRad`/`rollRad`, which `flightModelAdapter.ts`/module 02 is expected to fill using the *same* convention) are extracted from `EntityState.rot` via `src/math`'s `Quat.toYawPitchRoll` (pinned by name in `00-architecture.md` section 3.3 — `src/core` imports `Quat` directly from `../math`, a real source import, not a contract dependency). This spec's own formula, given here so this module's tests do not depend on module 01 existing yet, and as a cross-check `Quat.toYawPitchRoll` must agree with:

```ts
const fwd = Quat.rotate(rot, {x:1,y:0,z:0}, scratchVec3);
const pitchRad = Math.asin(clamp(fwd.y, -1, 1));
const headingRad = Math.atan2(fwd.x, -fwd.z);
const right = Quat.rotate(rot, {x:0,y:0,z:1}, scratchVec3B);
const cosPitch = Math.cos(pitchRad);
const rollRad = Math.abs(cosPitch) > 1e-6
  ? Math.atan2(-right.y / cosPitch, Math.cos(headingRad) * right.x + Math.sin(headingRad) * right.z)
  : 0; // gimbal lock at pitch = +/-90 deg: convention is roll = 0
```

Verified fixture (derived from, and consistent with, `00-architecture.md`'s worked examples): `heading=1.2, pitch=0.3, roll=0.7` composes (via the exact `qYaw⊗qPitch⊗qRoll` formula) to `rot = (0.359114159, 0.221581430, 0.075473147, 0.903461396)`; decomposing that `rot` with the formula above yields back `(1.2, 0.3, 0.7)` to within `1e-9`. A second fixture at `heading=4.5, pitch=-0.4, roll=-1.1` decomposes to `heading=-1.7832...` (`= 4.5 - 2*PI`, the equivalent angle in `(-PI,PI]`) `, pitch=-0.4, roll=-1.1`, also to within `1e-9`.

### 4.9 Worker protocol handling (`sim.worker.ts`)

State: `world: World` (constructed once, `init` re-`loadMission`s it rather than reconstructing it), `accState`, a 3-entry `snapshotFreeBuffers: ArrayBuffer[]` pool (all `SNAPSHOT_BYTES` long, allocated once at `init`), and one reusable `eventScratch: SimEvent[]` array of length `EVENT_QUEUE_CAPACITY`.

`self.onmessage = (e: MessageEvent<MainToSimMessage>) => { ... }`, dispatching on `e.data.type`:

- **`init`**: build the real `WorldDependencies` (via the three adapter files, section 9), construct `world = createWorld(deps)`, allocate the 3 snapshot buffers, call `world.loadMission(msg.mission)`, reset `accState`, `postMessage({type:'ready'} satisfies SimReadyMessage)`.
- **`input`**: `world.setPlayerInput(msg.entityId, msg.inputs)`. No reply.
- **`command`**: switch on `msg.command.kind`: `spawn` → `world.spawnEntity({kind: cmd.entityKind, team: cmd.team, pos: cmd.pos, headingRad: cmd.headingRad, aircraftDefId: cmd.aircraftDefId})`; `reset` → `world.reset()`, reset `accState`; `loadMission` → `world.loadMission(cmd.mission)`, reset `accState`; `setDifficulty` → `world.setDifficulty(cmd.entityId, cmd.difficulty)`; `pause` → `world.setPaused(cmd.paused)`. No reply (state changes surface through the next snapshot).
- **`releaseBuffer`**: `snapshotFreeBuffers.push(msg.buffer)`.

The `setInterval` callback (section 4.4) is created once, immediately after `init` completes (not before — ticking before `loadMission` has populated the pool would just step an empty world harmlessly, but starting the timer only after `init` keeps the worker's behaviour easy to reason about and matches "the sim worker's single source of truth begins at `init`"). `emitSnapshotIfBufferAvailable`: if `snapshotFreeBuffers.length === 0`, do nothing this tick (per `00-architecture.md` section 5's mandated skip-rather-than-allocate rule); otherwise pop a buffer, `new Float64Array(buffer)`, `world.writeSnapshot(view)`, `postMessage({type:'snapshot', buffer} satisfies SimSnapshotMessage, [buffer])` (transferred). `flushEvents`: `const n = world.drainEvents(eventScratch); if (n > 0) postMessage({type:'events', events: eventScratch.slice(0, n), tick: accState.tickCount} satisfies SimEventsMessage)` — the one deliberate exception to "no allocation in the hot path" in this file: `slice(0,n)` allocates a small array only on ticks where at least one event actually fired (rare, bursty, not once-per-tick — same justification `contracts/sim.ts`'s `EventQueue` doc comment gives).

### 4.10 `main.ts` wiring

**This section is written against the REAL, pinned exports of `contracts/render.ts`/`contracts/input.ts`/`contracts/ui.ts`/`contracts/terrain.ts`** (this document was drafted blind to all four, per `00-architecture.md` section 1, but — unlike every other cross-module boundary in this project — `src/main.ts` has no contract of its own to violate, so getting these call sites right is the one place this document's own text, not a `contracts/*.ts` file, is the thing that must be correct; `00-architecture.md` section 12 step 4 flags this as the one expected integration-time reconciliation point). The call sites below use each module's real, pinned signature.

#### 4.10.1 App state machine (screen navigation)

`src/ui` (module 11) explicitly does not own screen navigation — it only exports independent per-screen factories (`CreateMainMenu`, `CreateMissionSelect`, `CreateSettingsScreen`, `CreatePauseMenu`, `CreateDebriefScreen`, `CreateLoadingScreen`, `CreateAirportEditor`, `MountOrientationPrompt`). `main.ts` owns a small explicit state machine that mounts exactly one "primary" screen at a time into `uiRoot` (destroying the previous one first) plus the always-mounted `OrientationPromptHandle`:

```
AppState = 'boot' | 'mainMenu' | 'missionSelect' | 'loading' | 'gameplay' | 'paused' | 'debrief' | 'airportEditor'

boot            -> (after quality detection + terrain/sim worker init, section 4.10.2) -> mainMenu
mainMenu        -> onPlay -> missionSelect | onAirportEditor -> airportEditor | onSettings -> (settings screen, not a primary state; stacks over mainMenu)
missionSelect   -> onLaunch(missionId, difficulty) -> loading -> (SimReadyMessage received, section 4.9) -> gameplay
                -> onBack -> mainMenu
loading         -> (SimReadyMessage) -> gameplay
gameplay        -> PauseToggle meta action (src/input) -> paused
                -> MissionEndedEvent (SimEvent, section 4.1b) -> debrief
paused          -> onResume -> gameplay | onRestart -> loading (re-`loadMission` the same Mission) | onQuitToMenu -> mainMenu | onOpenSettings -> (settings screen, stacks over paused)
debrief         -> onReplay -> loading (same Mission) | onMissionSelect -> missionSelect | onMainMenu -> mainMenu
airportEditor   -> onExit -> mainMenu | onLaunchMission(layout) -> loading (a synthesized single-runway free-flight Mission using the edited layout, per 11-ui.md's "Test Fly" description)
```

Each transition: call the outgoing screen's `destroy()` (idempotent — safe even if it was never shown), then the new screen's factory. `mountOrientationPrompt(uiRoot)` (module 11) is called once at boot and never destroyed — it is self-managing (watches `matchMedia` itself).

#### 4.10.2 Boot sequence, quality tier, settings persistence

Module 10 owns a small `tejas.settings.v1` `localStorage` record (mirroring `09-input.md`'s own `InputMapData` persistence pattern — no other module is positioned to own this), read before running `DetectQualityTier`'s ~2.5 s benchmark so a returning player never re-benchmarks:

```ts
interface PersistedSettings { qualityTierOverride: QualityTier | 'auto'; version: 1 }
function loadPersistedSettings(): PersistedSettings | undefined { /* JSON.parse(localStorage.getItem('tejas.settings.v1')), undefined on any parse/shape error — never throws */ }
function savePersistedSettings(s: PersistedSettings): void { localStorage.setItem('tejas.settings.v1', JSON.stringify(s)); }

async function boot() {
  const uiRoot = document.getElementById('ui-root') as HTMLElement;
  const loading = createLoadingScreen(uiRoot);        // src/ui — shown immediately, before anything else
  loading.setProgress(0, 'Detecting quality tier…');

  const persisted = loadPersistedSettings();
  let qualityTier: QualityTier;
  if (persisted && persisted.qualityTierOverride !== 'auto') {
    qualityTier = persisted.qualityTierOverride;       // skip the benchmark entirely
  } else {
    const benchCanvas = document.createElement('canvas'); // detached probe canvas, per contracts/ui.ts's DetectQualityTier signature
    const report = await detectQualityTier(benchCanvas);  // src/ui — Promise<QualityTierReport>; the ~2.5s benchmark runs here
    qualityTier = report.tier;
  }
  mountOrientationPrompt(uiRoot);                       // src/ui, self-managing, mounted once
  currentQualityTier = qualityTier;                     // module-level, read by bootMission()/frame() in 4.10.4
  loading.setProgress(0.3, 'Starting simulation…');
  await initWorkersAndRenderer(qualityTier);            // section 4.10.3
  loading.setProgress(1, 'Ready');
  loading.destroy();
  showMainMenu();
}
boot();
```

`SettingsScreenHandle`'s `onChange` callback (whenever the player picks an explicit tier, or 'auto') writes `savePersistedSettings({ qualityTierOverride: next.qualityOverride, version: 1 })` immediately and, for a live tier change (not 'auto'), also calls `renderer.setQualityTier(...)`/`hud.setQualityTier(...)` right away (no benchmark re-run needed to switch tiers mid-session).

#### 4.10.3 Worker + renderer + input construction

```ts
let playerEntityId = NO_ENTITY_ID;
let currentQualityTier: QualityTier;
let renderer: SceneRenderer;
let hud: HudRenderer;
let inputSystem: PlayerInputSystem;
let chunkManager: ChunkManager;
const simWorker = new Worker(new URL('./core/sim.worker.ts', import.meta.url), { type: 'module' });
const terrainWorker = new Worker(new URL('../terrain/terrain.worker.ts', import.meta.url), { type: 'module' });

async function initWorkersAndRenderer(qualityTier: QualityTier) {
  const renderCanvas = document.getElementById('render-canvas') as HTMLCanvasElement;
  const hudCanvas = document.getElementById('hud-canvas') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui-root') as HTMLElement;

  renderer = createSceneRenderer(renderCanvas, qualityTier);        // src/render — CreateSceneRenderer(canvas, initialTier)
  hud = createHudRenderer(hudCanvas, qualityTier);                  // src/hud — CreateHudRenderer(canvas, initialTier)
  inputSystem = createPlayerInputSystem({ window, touchOverlayContainer: uiRoot }); // src/input
  renderer.registerAircraftModel(tejasWireframeModel);              // imported from src/aircraft (module 10 is the integrator — the only leaf-crossing import this file needs beyond the four adapters)
  renderer.setSunDirection({ x: 0.4, y: 0.7, z: -0.3 });
  renderer.setNavDb(activeNavDb);                                   // set again on each loadMission once the mission's airports are known

  // Terrain worker: TerrainInitMessage MUST be sent first (00-architecture.md section 5) and requestChunk must wait for TerrainReadyMessage.
  let terrainReady = false;
  const pendingTerrainMsgs: (MainToTerrainMessage | MainToTerrainMessageExt)[] = [];
  const sendToTerrainWorker: SendToTerrainWorker = (msg) => {
    if (!terrainReady && msg.type !== 'terrainInit') { pendingTerrainMsgs.push(msg); return; }
    terrainWorker.postMessage(msg);
  };
  terrainWorker.onmessage = (e: MessageEvent<TerrainToMainMessage | TerrainToMainMessageExt>) => {
    if (e.data.type === 'terrainReady') {
      terrainReady = true;
      for (const m of pendingTerrainMsgs.splice(0)) terrainWorker.postMessage(m);
      return;
    }
    chunkManager.handleTerrainWorkerMessage(e.data);
  };
  chunkManager = createChunkManager({ qualityTier, terrainParams: activeTerrainParams, flattenZones: activeFlattenZones }, sendToTerrainWorker);
  chunkManager.onChunkReady((chunk) => renderer.ingestTerrainChunk({ type: 'chunkReady', requestId: -1, chunkX: chunk.key.cx, chunkZ: chunk.key.cz, lod: chunk.key.depth, positions: chunk.geometry.positions.buffer, normals: chunk.geometry.normals.buffer, indices: chunk.geometry.indices.buffer }));
  chunkManager.onChunkEvicted((key) => renderer.evictTerrainChunk(key.cx, key.cz, key.depth));
  sendToTerrainWorker({ type: 'terrainInit', params: activeTerrainParams, flattenZones: activeFlattenZones } satisfies TerrainInitMessage);

  simWorker.onmessage = (e: MessageEvent<SimToMainMessage>) => {
    const msg = e.data;
    if (msg.type === 'ready') return;
    if (msg.type === 'snapshot') {
      const view = new Float64Array(msg.buffer);
      if (playerEntityId === NO_ENTITY_ID) {
        const header = readSnapshotHeader(view);
        if (header.playerIndex >= 0) { const ev = readSnapshotEntity(view, header.playerIndex, entityViewScratch); playerEntityId = ev.id; }
      }
      renderer.ingestSnapshot(view);
      hud.ingestSnapshot(view);
      simWorker.postMessage({ type: 'releaseBuffer', buffer: msg.buffer } satisfies SimReleaseBufferMessage, [msg.buffer]);
      return;
    }
    if (msg.type === 'events') {
      renderer.ingestEvents(msg.events);
      hud.ingestEvents(msg.events);
      const missionEnded = msg.events.find((e): e is MissionEndedEvent => e.type === 'missionEnded');
      if (missionEnded) showDebrief(missionEnded);   // section 4.1b's event; builds DebriefStats from it + this session's own kill/shot counters and transitions to 'debrief' (4.10.1)
    }
  };
}
```

`ChunkManager.update(cameraWorldPos, qualityTier)` is called once per rendered frame from inside `frame()` below (section 4.10.4), using `renderer`'s current camera world position (a small additional `SceneRenderer`-side getter, or `CameraState.worldPos` from the previous `renderFrame` call).

#### 4.10.4 Per-frame loop, resize, pause, WebGL context loss

```ts
function bootMission(mission: Mission) {
  playerEntityId = NO_ENTITY_ID;
  simWorker.postMessage({ type: 'init', mission, qualityTier: currentQualityTier } satisfies SimInitMessage);
}

let lastFrameMs = performance.now();
function frame(nowMs: number) {
  const dtSec = Math.min((nowMs - lastFrameMs) / 1000, 0.25);
  lastFrameMs = nowMs;
  if (appState === 'gameplay') {
    inputSystem.update(dummyPilotContext, dtSec, pilotInputsScratch); // Pilot.update's `ctx` is accepted for interface conformance only and never read (contracts/input.ts file header) — `dummyPilotContext` is a single module-level placeholder object, never populated
    simWorker.postMessage({ type: 'input', entityId: playerEntityId, inputs: pilotInputsScratch } satisfies SimInputMessage);
  }
  const camera = renderer.renderFrame(nowMs);
  hud.renderFrame(nowMs, camera);
  chunkManager.update(camera.worldPos, currentQualityTier);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function onResize() {
  const dpr = window.devicePixelRatio || 1;
  renderer.resize(window.innerWidth, window.innerHeight, dpr);
  hud.resize(window.innerWidth, window.innerHeight, dpr);
}
window.addEventListener('resize', onResize);
onResize();

document.addEventListener('visibilitychange', () => {
  const paused = document.visibilityState === 'hidden';
  simWorker.postMessage({ type: 'command', command: { kind: 'pause', paused } } satisfies SimCommandMessage);
});
```

`SceneRenderer`'s WebGL context-loss handling (`webglcontextlost`/`webglcontextrestored`, 08-render.md section 4.13) is entirely internal to `createSceneRenderer` — `main.ts` does not wire any context-loss listener itself; it only needs to keep calling `renderFrame` every animation frame as usual, which the renderer resumes drawing from once it has silently rebuilt its GPU resources.

`playerEntityId` is learned from the first `snapshot` message's header (`readSnapshotHeader(view).playerIndex` → that dense entity's `id`, read via `readSnapshotEntity`, as shown in 4.10.3) and cached for subsequent `input` messages; until then, `input` messages carry `NO_ENTITY_ID` and `World.setPlayerInput` no-ops (harmless — see 3.7).

### 4.11 Mission descriptor resolution

`src/core/missions/index.ts`'s `loadMissionDescriptor` (implementing `LoadMissionDescriptor`) is called by `sim.worker.ts`'s adapter wiring immediately before the FIRST `init`/`loadMission` for a given `MissionDescriptor` (the two built-in ones are resolved once, eagerly, at worker startup, and cached; a `SimCommand.loadMission` from the main thread instead carries an already-resolved `Mission` — see `core.ts`'s `SimCommand` union, which takes `mission: Mission`, not a descriptor — so descriptor resolution only ever happens for the two built-in JSON files, inside this worker, never over `postMessage`). It calls `resolveAirport(id)` for each of `descriptor.airportIds` (backed, at integration time, by module 05's real parser reading `src/airport/layouts/<id>.json`) and `resolveTerrainParams(descriptor.terrain)` (backed by whatever module 04 exposes), and assembles `{ id, name, world: { seed: descriptor.seed, terrain: resolvedTerrain, airports: resolvedAirports }, playerStart, aiFlights, weather, objectives }`.

## 5. Data

### 5.1 Entity pool capacity

| kind | capacity | rationale |
|---|---|---|
| aircraft | 32 | player + up to 31 AI across all flights in the largest planned mission; generous headroom over the two built-in missions' 1–2 aircraft |
| missile | 64 | up to 2 missiles in flight per aircraft on average across 32 aircraft, capped well below worst case |
| bullet | 240 | gun bursts: ~1000 rds/min ≈ 16.7 rds/s per shooter, ~2 s typical flight time at ~1000 m/s over ~2000 m range ⇒ ~33 concurrent bullets per active shooter; 240 covers several simultaneous shooters with margin |
| effect | 64 | explosions/tracers/smoke trails, capped generously; `src/render`/`src/combat` are expected to reuse/expire these aggressively |
| **total** | **400** | equals `MAX_ENTITIES` (`core.ts`) exactly |

### 5.2 Snapshot buffer sizing

`SNAPSHOT_FLOATS = HEADER_FLOATS(4) + MAX_ENTITIES(400)*ENTITY_STRIDE(26) + HUD_BLOCK_FLOATS(27) = 4 + 10400 + 27 = 10431` floats ⇒ `SNAPSHOT_BYTES = 83448` bytes (≈ 81.5 KiB) per buffer; `SNAPSHOT_BUFFER_POOL_SIZE = 3` (`core.ts`) ⇒ ≈ 244.5 KiB pre-allocated once at `init`, never grown.

### 5.3 Built-in missions (`src/core/missions/*.json`, exact content)

`src/core/missions/freeFlight.json`:

```json
{
  "id": "free-flight",
  "name": "Free Flight — Konarak Coastal",
  "seed": 1234567,
  "terrain": { "seed": 1234567 },
  "airportIds": ["konarak-coastal"],
  "playerStart": { "airportId": "konarak-coastal", "runwayId": "09L", "speedMps": 0 },
  "aiFlights": [],
  "weather": { "windWorldMps": { "x": 3, "y": 0, "z": -1 }, "gustMps": 2, "turbulence": 0.1 },
  "objectives": [
    { "id": "obj-survive", "kind": "survive_time", "description": "Complete a circuit and land safely.", "params": { "seconds": 1800 } }
  ]
}
```

`src/core/missions/dogfight1v1.json`:

```json
{
  "id": "dogfight-1v1",
  "name": "1v1 Dogfight — Rangpur Highlands",
  "seed": 7654321,
  "terrain": { "seed": 7654321 },
  "airportIds": ["rangpur-afb"],
  "playerStart": { "airportId": "rangpur-afb", "runwayId": "06", "speedMps": 0 },
  "aiFlights": [
    { "id": "bandit-1", "aircraftId": "tejas-mk1", "team": 1, "difficulty": "veteran", "startPos": { "x": 8000, "y": 4500, "z": -6000 }, "startHeadingRad": 3.14159265, "startSpeedMps": 230, "count": 1 }
  ],
  "weather": { "windWorldMps": { "x": 0, "y": 0, "z": 0 }, "gustMps": 1, "turbulence": 0.05 },
  "objectives": [
    { "id": "obj-kill", "kind": "destroy_all_hostiles", "description": "Destroy the hostile Tejas.", "params": {} }
  ]
}
```

`airportIds` values (`"rangpur-afb"`, `"konarak-coastal"`) match `00-architecture.md` section 9.3's pinned file-stem ids exactly — not a guess. `aircraftId: "tejas-mk1"` is likewise confirmed, matching `03-tejas-data.md`'s `tejasDefinition.id` exactly. `runwayId` values `"09L"` (freeFlight.json, on `konarak-coastal`) and `"06"` (dogfight1v1.json, on `rangpur-afb`) are CONFIRMED against `05-airport.md`'s actual built-in layouts (section 5.3/5.4 there): `rangpur-afb`'s only two runway ids are `"06"`/`"24"` and `konarak-coastal`'s are `"09L"`/`"27L"`/`"09R"`/`"27R"` — a real-world-style guess of plain `"09"`/`"27"` does not resolve on either layout and was corrected here to match module 05's actual ids exactly (see section 9, item 4).

### 5.4 `index.html` (exact content)

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
    <title>Tejas Sim</title>
    <link rel="manifest" href="/manifest.webmanifest" />
    <meta name="theme-color" content="#0a0e14" />
    <style>
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #0a0e14; overflow: hidden; overscroll-behavior: none; }
      #app { position: fixed; inset: 0; }
      #render-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
      #hud-canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
      #ui-root { position: absolute; inset: 0; }
    </style>
  </head>
  <body>
    <div id="app">
      <canvas id="render-canvas"></canvas>
      <canvas id="hud-canvas"></canvas>
      <div id="ui-root"></div>
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

### 5.5 `vite.config.ts` (exact content)

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  base: './',
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    host: true,
    port: 5173,
  },
});
```

`worker: { format: 'es' }` is required so `new Worker(new URL('./core/sim.worker.ts', import.meta.url), { type: 'module' })` bundles correctly in both dev and production (Vite's default worker format is `iife`, which cannot `import` ES modules — every worker in this project, including `terrain.worker.ts`, relies on this setting).

### 5.6 `tsconfig.json` (exact content — copied verbatim from `00-architecture.md` section 13, which is normative for this file)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "WebWorker"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "outDir": "dist-ts-check"
  },
  "include": ["src", "tests", "tools"]
}
```

### 5.7 `package.json` (exact content)

```json
{
  "name": "tejas-sim",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "npm run typecheck && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.worker.json",
    "sim-check": "vite build --config scripts/vite.tools.config.ts && node dist-tools/sim-check.mjs",
    "acceptance": "node scripts/ci.mjs"
  },
  "dependencies": {
    "three": "^0.160.0"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "vite": "^5.2.0",
    "vitest": "^1.6.0",
    "@types/three": "^0.160.0",
    "jsdom": "^24.0.0"
  }
}
```

`npm run acceptance` is a convenience alias for `node scripts/ci.mjs` (`12-verification.md` section 8's exact command sequence, rows 1–10 always, rows 11–12 when `PLAYWRIGHT=1` is set) so a reviewer or CI step can run the full mechanical acceptance gate through `npm run <script>` the same way `dev`/`build`/`test`/`sim-check` already do, without needing to know `scripts/ci.mjs`'s path by heart; it adds no new logic of its own (module 12 still owns `scripts/ci.mjs`'s content). No dependency beyond `three` (runtime) and `typescript`/`vite`/`vitest`/`@types/three`/`jsdom` (dev), per `00-architecture.md` section 2. `typecheck` runs BOTH tsconfigs (`00-architecture.md` section 13's DOM/WebWorker split); `build` depends on `typecheck` rather than inlining a single `tsc --noEmit` call, so both configs gate a production build the same way they gate CI. `sim-check` deliberately DELEGATES to module 12's own build recipe (`scripts/vite.tools.config.ts`, `12-verification.md` section 4.1) rather than defining a second, independent one: module 10 cannot see that file at drafting time (parallel, blind drafting), so rather than inventing a second, plausible-but-unverified `vite build --ssr ...` command that would silently diverge from whatever module 12 actually ships (and that `scripts/ci.mjs` actually runs), this script is simply a convenience alias for interactive/manual use — `npm run sim-check` and `node scripts/ci.mjs`'s own invocation (`12-verification.md` section 8, rows 5–8) always build and run the exact same `dist-tools/sim-check.mjs`, so there is exactly one build path for `tools/sim-check.ts`, never two that could drift apart.

## 6. Performance budget

All of this module's own hot-path code (`World.stepOnce` minus the time spent *inside* `FlightModelPort`/`CombatPort`/`Pilot.update`, which are each other modules' budgets) targets **under 5% of the 8.33 ms tick budget at `SIM_HZ`, i.e. ≤ 0.4 ms**, measured with the full 400-entity pool live, on the reference desktop profile; **≤ 1.5 ms** on the low-end mobile profile (quality tier `Low`). Concretely:

- `EntityPool.allocate`/`release`/`get`/`getDamage`/`liveAt`: O(1), zero allocation after construction (free-list pop/push, swap-remove, direct array index).
- `World.stepOnce`'s per-entity work (steps 2–5 of 4.1): O(live aircraft count, ≤ 32), each iteration doing fixed-size struct copies and comparisons — no per-tick allocation (`PilotContext`/`SimEnvironment`/`SnapshotHudView` objects are each allocated exactly once per live aircraft at spawn time and reused every tick thereafter).
- `EventQueue.push`: O(1) (index write into a pre-sized backing array of `EVENT_QUEUE_CAPACITY` slots); the `SimEvent` object itself is a small, rare (bursty, not per-entity-per-tick) allocation by whichever code constructs it (`World` for warning/touchdown/crash events, `CombatPort` for combat events) — accepted per `00-architecture.md`'s "hot path" definition (section 2), which is about *per-tick-per-entity* cost, not "never allocates an object anywhere, ever."
- `WriteSnapshot`: O(entity count actually alive, ≤ 400), one `Float64Array` index write per field, no allocation (writes into the caller-supplied `out`). Target ≤ 0.3 ms for a full 400-entity snapshot on the reference desktop profile.
- `isaAtmosphere`/`wind` evaluation: O(1) per aircraft (atmosphere) + O(1) per tick (wind, shared across all aircraft — computed once per `stepOnce`, not once per aircraft).
- The snapshot buffer pool (3 × ~81.5 KiB) and the event scratch array (`EVENT_QUEUE_CAPACITY` slots) are the only heap allocations `sim.worker.ts` performs after `init` completes; steady-state operation (`vitest`/`tools/sim-check.ts` can assert this via repeated `stepOnce`/`writeSnapshot`/`drainEvents` calls and checking that `process.memoryUsage().heapUsed` does not grow unboundedly across, say, 10000 ticks) allocates nothing else.
- Catch-up bound: after any stall, at most `Math.floor(ACCUMULATOR_MAX_CATCHUP_SEC / SIM_DT_SEC) = 30` ticks run inside one `advanceFixedStep` call — this caps worst-case single-callback CPU burst even on a severely throttled background tab.

## 7. Unit tests to write

`tests/core/entityPool.test.ts`:
- `packEntityId(5, 3) === 196613`; `unpackEntityId(196613)` deep-equals `{index: 5, generation: 3}`; `packEntityId(0, 0) === 0`.
- `createEntityPool({aircraft:32, missile:64, bullet:240, effect:64})`: `allocate('aircraft', 0)` 32 times all return distinct, non-`-1` ids; the 33rd call returns `-1` (`NO_ENTITY_ID`); `liveCount === 32` after the 32 successful allocations.
- Release + reallocate: `release(id)` on a live aircraft, then `allocate('aircraft', 0)` again — the new id's `unpackEntityId(...).generation` is exactly `1` greater than the released id's; `isAlive(oldId) === false`; `get(oldId) === undefined`.

`tests/core/fixedStepLoop.test.ts`:
- `advanceFixedStep({accumulatorSec:0, tickCount:0}, 1/120, stepFn)`: `stepFn` called exactly once; return value `1`; resulting `accumulatorSec` within `1e-12` of `0`.
- `advanceFixedStep({accumulatorSec:0, tickCount:0}, 0.3, stepFn)` (exceeds the 0.25 s clamp): `stepFn` called exactly `30` times; return value `30`.
- `shouldEmitSnapshot(0) === true`, `shouldEmitSnapshot(1) === false`, `shouldEmitSnapshot(2) === true`, `shouldEmitSnapshot(3) === false`.

`tests/core/snapshotWriter.test.ts` + `tests/core/snapshotReader.test.ts`:
- Build a 2-aircraft pool with known field values, write via `writeSnapshot`, read back via `readSnapshotHeader`/`readSnapshotEntity`/`readSnapshotHud`: every field matches exactly (`toBe`, not `toBeCloseTo` — same `Float64Array`, no precision loss) the values written.
- `out.length !== SNAPSHOT_FLOATS (10431)` throws (a programmer-error assertion per `00-architecture.md`'s error-handling rule).
- `playerEntityId = NO_ENTITY_ID` ⇒ `header.playerIndex === -1` and every field of the read-back HUD view is `0`.

`tests/core/eventQueue.test.ts`:
- Push `256` events (`EVENT_QUEUE_CAPACITY`): all return `true`, `length === 256`. A 257th `push` returns `false`, `length` stays `256`.
- `drainInto(out)` with `out.length >= 256`: returns `256`, copies in push order, then `length === 0`; a second `drainInto` call returns `0`.

`tests/core/atmosphere.test.ts`:
- `isaAtmosphere(0)`: `airDensityKgM3` within `0.001` of `1.225`; `soundSpeedMps` within `0.01` of `340.29`.
- `isaAtmosphere(11000)`: `airDensityKgM3` within `0.0005` of `0.363917`; `soundSpeedMps` within `0.01` of `295.069`.
- `isaAtmosphere(5000)`: `airDensityKgM3` within `0.001` of `0.736116`.

`tests/core/seed.test.ts`:
- `subSeed(42, "ai:a") === 1264669096`; `subSeed(42, "ai:b") === 1315001953`; `subSeed(43, "terrain") === 2108588079`; `subSeed(1234567, "wind") === 1578955088`. Same-args calls are equal; different-tag calls differ.

`tests/core/hudTelemetry.test.ts`:
- Given `rot = {x: 0.359114159, y: 0.221581430, z: 0.075473147, w: 0.903461396}`, the heading/pitch/roll extraction formula (section 4.8) yields `headingRad`, `pitchRad`, `rollRad` each within `1e-6` of `1.2`, `0.3`, `0.7` respectively.
- Given `rot` built from `heading=4.5, pitch=-0.4, roll=-1.1` via `Quat.fromYawPitchRoll`, the extraction yields `pitchRad` within `1e-9` of `-0.4`, `rollRad` within `1e-9` of `-1.1`, and `headingRad` within `1e-9` of the wrapped equivalent `-1.783185...` (`= 4.5 - 2*PI`).

`tests/core/world.test.ts` (against fake `FlightModelPort`/`CombatPort`/`createAiPilot`/`HeightSampler`/`AirportNavDb` stubs, so this tests `World`'s own logic in isolation from real flight/AI/combat):
- After `loadMission` with a minimal one-player, zero-AI `Mission`, `getPlayerEntityId() !== NO_ENTITY_ID` and `getEntityState(playerId).alive === true`.
- Determinism: construct two `World`s from identical `WorldDependencies` (a deterministic fake `FlightModelPort` that just integrates `pos += vel*dt`), `loadMission` with the same `Mission`, drive both with the same 120-call sequence of `setPlayerInput`/`stepOnce`, assert `getEntityState(playerId)` is deep-equal (`toEqual`) between the two `World`s after all 120 ticks.
- Warning edge behaviour: a fake `FlightModelPort.computeTelemetry` that sets `out.stalled = tick >= 5`; step 10 ticks; `drainEvents` shows exactly one `{type:'warning', bit: WarningBit.Stall, active: true}` (on tick 5) and no repeats on ticks 6–10.
- `EntityPool` exhaustion surfaces through `World`: `spawnEntity` 33 times with `kind:'aircraft'` — the 33rd returns `NO_ENTITY_ID`, and no exception is thrown (per the error-handling rule: pool exhaustion is an ordinary runtime condition, not a programmer error).

`tools/sim-check.ts` (module 12 owns the file; this spec fixes what it must assert against this module's contract): load `freeFlight.json` and `dogfight1v1.json` (via the real `loadMissionDescriptor` + real adapters once modules 02–07 exist), run `600` ticks (`5.0` simulated seconds) with a fixed scripted `PilotInputs` stream for the player, twice, from two fresh process invocations with the same seed; assert the final `getEntityState(playerId)` is bit-identical between the two runs, `tick === 600` exactly, and `simTimeSec` is within `1e-9` of `5.0`.

## 8. Acceptance criteria

- `docs/spec/contracts/sim.ts` compiles standalone with `tsc --noEmit --strict` when placed alongside `core.ts` with no other imports (mechanically verified during drafting: it does, with zero errors).
- Every file listed in section 2 exists at its exact path once implemented.
- `DEFAULT_ENTITY_POOL_CAPACITY.aircraft + .missile + .bullet + .effect === MAX_ENTITIES (400)` — mechanically checkable arithmetic, and asserted directly in `tests/core/entityPool.test.ts`.
- `SNAPSHOT_FLOATS === 10431` and `SNAPSHOT_BYTES === 83448`, computed from `core.ts`'s own constants — asserted in `tests/core/snapshotWriter.test.ts`.
- `npm run typecheck` (`tsc --noEmit`) passes with zero errors once every module's `src/*` exists.
- `npm test` passes for every `tests/core/**` file listed in section 7.
- `npm run build` (`tsc --noEmit && vite build`) succeeds and produces `dist/index.html` plus bundled worker chunks for `sim.worker.ts` and `terrain.worker.ts`.
- `npm run sim-check` exits `0` against both built-in missions once modules 02–07 exist, per the determinism assertions in section 7's `tools/sim-check.ts` entry.
- A repo-wide search for `Math.random(` under `src/core/` (excluding `src/main.ts`, which is UI-adjacent glue code, not sim code, though it also happens not to need randomness) returns zero matches.
- A repo-wide search for `document.`/`window.`/`localStorage` under every file in section 2 except `src/main.ts` and `index.html` returns zero matches (mechanically enforces the DOM-free rule for this module's sim-facing files).
- No file in section 2 imports from `../physics`, `../aircraft`, `../terrain`, `../airport`, `../ai`, `../combat`, `../render`, `../hud`, `../input`, or `../ui` EXCEPT `flightModelAdapter.ts`/`combatAdapter.ts`/`aiPilotAdapter.ts`/`missions/index.ts` (the four explicitly-named adapter files) and `main.ts` — mechanically greppable, enforces that the adapters are the only points of contact with sibling modules' real code, matching `00-architecture.md` section 10's "src/core imports everything, everyone else imports only through contracts" rule at the file-granularity `World`/`EntityPool`/etc. actually need.

## 9. Open assumptions

Public flight-test data for the Tejas Mk1 does not bear on this module (it owns no aerodynamic data — that is module 03's concern), but this module has several genuine cross-module naming gaps inherent to a blind, single-pass parallel build, listed here in full rather than silently guessed at:

1. **Adapter target names are unconfirmed.** `flightModelAdapter.ts`/`combatAdapter.ts`/`aiPilotAdapter.ts` must, at integration time, wrap whatever module 02/07/06 actually export from `src/physics/index.ts`/`src/combat/index.ts`/`src/ai/index.ts` — this document cannot name those exports (it is drafted without reading `02-flight-model.md`/`06-ai.md`/`07-combat.md`/their contracts, per `00-architecture.md` section 1). The `FlightModelPort`/`CombatPort`/`CreateAiPilot` shapes these adapters produce ARE fully pinned (section 3.3) and are what the rest of `src/core` codes against; only the *inside* of these four files needs a short integration-time pass to match module 02/06/07's real signatures to that shape.
2. **`FlightModelPort.computeTelemetry`'s real source.** `contracts/flight.ts`'s pinned skeleton (`00-architecture.md` section 9.1) only pins `StepAircraft`, which cannot itself produce `AircraftTelemetry` (wrong output shape — it writes an `EntityState`, not a telemetry struct). This spec assumes module 02 additionally exports a telemetry-computation function; if the integration pass finds none, `flightModelAdapter.ts`'s fallback is to compute a **degraded** telemetry itself from `EntityState`/`SimEnvironment` alone: `tasMps = |vel - wind|`, `mach = tasMps/soundSpeedMps`, `iasMps = tasMps * sqrt(airDensityKgM3/1.225)`, `altMslM = pos.y`, `altAglM = pos.y - sampler.heightAt(pos.x,pos.z)`, `headingRad/pitchRad/rollRad` via section 4.8's formula, `vspeedMps = vel.y`, `fuelKg = state.fuelKg` (`EntityState.fuelKg`, core.ts, is always the authoritative value — `FlightModelPort.step`/the real `stepAircraft` write it every tick regardless of whether a separate telemetry function exists, so this fallback never needs its own fuel-tracking estimate), `fuelFrac = state.fuelKg / deps.flightModel.maxFuelKg(aircraftDefId)`, `thrustFrac = state.throttle`, `onGround = !!(state.flags & EntityFlag.OnGround)`, and `alphaRad = betaRad = gLoad = 0`, `stalled = false` (the fields this fallback genuinely cannot derive without aero data). This fallback existing at all is a signal the integration pass should treat as a defect to fix, not a permanent design — module 12's acceptance checklist should flag if it is ever exercised in the final build.
3. **`main.ts`'s sibling factory names — RESOLVED against the real contracts.** An earlier drafting pass of this document guessed at `createRenderer`/`createHud`/`createUi`/`createInputSource` (wrong names, wrong arities, an aggregate `createUi` that does not exist) before those four contracts were available. Section 4.10 has since been rewritten against `contracts/render.ts`/`contracts/input.ts`/`contracts/ui.ts`/`contracts/terrain.ts`'s real, pinned exports (`createSceneRenderer`, `createHudRenderer`, `createPlayerInputSystem`, `detectQualityTier`, `createChunkManager`, and `src/ui`'s ~9 independent per-screen factories driven by this module's own app-state machine, section 4.10.1) and should need no further reconciliation beyond the ordinary "does the implementer's code match its own contract" checking every other module already gets.
4. **`aircraftId: "tejas-mk1"` — CONFIRMED, no longer a guess.** `03-tejas-data.md`'s `tejasDefinition.id === 'tejas-mk1'` exactly (that document's section 3 says so explicitly: "this is the exact string `10-core-worker.md`... already assumes — it is not a guess, it is this value"). The two **airport ids** (`"rangpur-afb"`, `"konarak-coastal"`) are likewise NOT a guess — they are pinned verbatim by `00-architecture.md` section 9.3. The **runway ids** are now likewise CONFIRMED, not a guess: cross-checking `05-airport.md`'s actual built-in layout JSON (section 5.3/5.4 there) shows `rangpur-afb`'s two runway ids are `"06"`/`"24"` and `konarak-coastal`'s four are `"09L"`/`"27L"`/`"09R"`/`"27R"` — an earlier drafting pass of this document guessed the plain real-world-style `"09"`/`"27"`, which do not exist on either layout and would have made both `MissionPlayerStart.runwayId` lookups fail (`AirportNavDb.getRunway` returns `undefined`, silently stranding the player per this project's error-handling convention rather than throwing). Section 5.3's mission JSON now uses `"06"` (rangpur-afb) and `"09L"` (konarak-coastal), both verified present in module 05's actual data.
5. **ISA atmosphere is deliberately duplicated**, not imported from module 02, specifically to avoid depending on an unpinned export name from `src/physics/atmosphere.ts` — this is a considered design choice (the formula is a fixed physical standard, not module 02's design surface to own exclusively), not a gap, and it costs a small amount of duplicated logic between the two modules.
6. **Contact list for `PilotContext.contacts` and target range/closure for the HUD block** are populated from whatever `CombatPort` leaves in `CombatStatus`/a per-entity contacts cache after its `step` call (section 4.1 step 6) — this module does not itself compute sensor contacts (that is module 07's radar/visual model). The exact mechanism by which `CombatPort` communicates "these are entity X's current contacts this tick" back to `World` beyond what `CombatTickContext.getCombatStatus` already exposes is left to the `combatAdapter.ts` integration pass (a plausible mechanism: the adapter also exposes a `getContacts(id): readonly Contact[]` method beyond the pinned `CombatPort` interface, called by `World` when building each AI's `PilotContext` — this is an internal implementation detail of `combatAdapter.ts`/`world.ts`'s interaction, not something `contracts/sim.ts` needs to pin, since nothing outside `src/core` observes it).
7. **`WarningBit.EngineFire`/`ConfigWarning`** are not evaluated by `World` (section 4.6 only covers 5 of the 10 bits) and are not explicitly assigned to any other module either — an acceptable v1 gap, left for `CombatPort`/`subsystemDamage.ts` to optionally cover via the same `EventQueue` it already receives, or for a future revision.
8. **`npm run sim-check` — RESOLVED by delegation, not by guessing an output path.** An earlier drafting pass of this document guessed `tools/sim-check.ts`'s bundled output filename (`vite build --ssr ... → dist-tools/sim-check.js`) independently of module 12, which owns that build step and could easily have shipped a different config/filename (as it in fact does: `scripts/vite.tools.config.ts` → `dist-tools/sim-check.mjs`, per `12-verification.md` section 4.1). Section 5.7's `sim-check` script now simply invokes module 12's own `scripts/vite.tools.config.ts` and `dist-tools/sim-check.mjs` directly, so there is nothing left to reconcile at integration time on this point.
9. **No differential wind/weather by position or altitude band** beyond the ISA-driven density/sound-speed change already captured — `mission.weather` is a single global vector + scalars, applied uniformly (section 4.5). Acceptable simplification for a placeholder-visual, physics-focused sim; a future revision could make `WeatherConfig` position-dependent without changing this module's `World` interface (only `wind.ts`'s internals).
10. **No mid-mission player respawn.** Crash/kill of the player aircraft is recoverable only via a fresh `loadMission`/`reset`, driven by `src/ui`'s debrief flow issuing a new `SimCommand.loadMission` — there is no `World.respawnPlayer()` or similar in this contract (section 4.2). This is a deliberate v1 scope simplification, not an oversight.
11. **How `combatAdapter.ts` obtains a `WeaponsState` per aircraft entity — RESOLVED here so the integration pass has a concrete mechanism, not an open question.** `CombatPort.step(dtSec, ctx, eventsOut)` (section 3.3) is the only entry point `World` calls; `contracts/combat.ts`'s real, fine-grained exports (`createWeaponsState(loadout, rngSubSeed)`, `updateSensors`, `fireWeapons`, `stepProjectile`, `resolveProjectileHit`, `writeCombatStatus`, per `07-combat.md` section 3.1's own per-tick call order, which this document's drafting agent never read) are therefore called BY `combatAdapter.ts`'s `step()` implementation, not by `World` directly. Two things `combatAdapter.ts` needs that neither `CombatTickContext` nor `CombatPort` exposes are pinned here: (a) **which entities are aircraft it has not seen before** — on every `step()` call, before dispatching any per-entity combat function, the adapter scans `ctx.liveAt(0..ctx.liveCount-1)` for `kind === EntityKind.Aircraft` entities whose `id` is not yet a key in the adapter's own `Map<EntityId, WeaponsState>` (a private field of `combatAdapter.ts`, exactly analogous to `world.ts`'s own `Map<EntityId, Pilot>`, section 4.2 — neither map is part of any pinned contract, since nothing outside the file that owns it needs to observe it); (b) **the `WeaponsLoadout` to build each one's `WeaponsState` from** — this project has exactly one `AircraftDefinition` (`tejasDefinition`, `id === 'tejas-mk1'`, confirmed everywhere in this document `spawnEntity` is called, section 4.2), so `combatAdapter.ts` imports `tejasDefinition` directly from `src/aircraft` (a normal import for this file: `src/core` is the one module allowed to import every leaf module, section 10) and builds ONE static `WeaponsLoadout` once, at adapter-construction time (not per entity, not per tick — `AircraftDefinition.hardpoints` never changes at runtime), by mapping every `Hardpoint` whose `type !== 'fuel_tank'` to a `WeaponStationSpec { hardpointId: hardpoint.id, posBodyM: hardpoint.posBodyM, weapon: hardpoint.type as WeaponKind, maxCount }` (a `'fuel_tank'` hardpoint carries no weapon and is simply omitted from `WeaponsLoadout.stations` — `contracts/combat.ts`'s `WeaponStationSpec.weapon` is typed `WeaponKind`, which has no `'fuel_tank'` member, so this filter is required for the mapping to type-check, not just a design choice). **`maxCount` per station — resolved here, since `contracts/combat.ts`'s `GUN_MAX_AMMO_ROUNDS`/`IR_MAX_AMMO_MISSILES`/`RADAR_MISSILE_MAX_AMMO` (module 07) are each a single, PER-AIRCRAFT total (confirmed by `WriteCombatStatus`'s own doc comment, "Aggregates `WeaponsState`", and by `CombatStatus.ammoGun`/`missilesIr`/`missilesRadar` each being one number, not one per station) while `03-tejas-data.md`'s seven hardpoints (section 5.1 there) include TWO `ir_missile` stations (`wingtip-l`/`wingtip-r`) and TWO `radar_missile` stations (`pylon-outer-l`/`pylon-outer-r`), so a station-by-station `maxCount` cannot just copy the aggregate constant without double-counting.** `combatAdapter.ts` sets `maxCount = weaponMaxAmmoConstant / (count of hardpoints of that same `type` in `tejasDefinition.hardpoints`)` — `GUN_MAX_AMMO_ROUNDS(220) / 1 = 220` for `gun-1`; `IR_MAX_AMMO_MISSILES(4) / 2 = 2` for each of `wingtip-l`/`wingtip-r`; `RADAR_MISSILE_MAX_AMMO(4) / 2 = 2` for each of `pylon-outer-l`/`pylon-outer-r` — all three divide evenly for this aircraft's actual hardpoint counts, so the adapter needs no remainder/rounding rule; a future `AircraftDefinition` whose per-type hardpoint count does not evenly divide its module-07 ammo constant is out of this project's fixed two-mission, one-aircraft scope. For a new entity `id` found by (a), the adapter calls `createWeaponsState(thatStaticLoadout, subSeed(missionSeed, 'combat:' + id))` (`missionSeed` is threaded into `combatAdapter.ts` the same way `world.ts` already threads it into `createAiPilot`'s `seed` param, section 4.2) and stores the result in its map; a future revision supporting more than one `AircraftDefinition` would key this cache/lookup by `aircraftDefId` instead of always resolving to `tejasDefinition`, but that need does not exist in this project's fixed two-mission scope. The adapter deletes an entity's map entry when it observes (via the same per-tick scan) that the id is no longer present in `ctx.liveAt(...)`'s live list (i.e. `World` released the pool slot via `despawnEntity`), mirroring `world.ts`'s own `Pilot`-map cleanup obligation on the same event.
