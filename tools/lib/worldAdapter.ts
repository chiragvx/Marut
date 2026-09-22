/**
 * tools/lib/worldAdapter.ts — bridges `contracts/sim.ts`'s real `World`
 * (module 10) onto `contracts/verify.ts`'s `SimWorldHandle`. Shared by
 * tests/integration/testHarness.ts and tools/sim-check.ts so the same
 * adaptation logic (and the same documented seams/guesses) lives in exactly
 * one place. See docs/spec/12-verification.md section 4.6 and section 9's
 * open assumption #2.
 *
 * Two real structural gaps between `World` and `SimWorldHandle`, both
 * resolved here (this is NOT a guess -- `contracts/sim.ts` is read directly,
 * since it is already scaffolded to src/contracts/sim.ts):
 *
 * 1. `SimWorldHandle.spawnAircraft` takes an explicit `Pilot` per spawn;
 *    `World.spawnEntity` only supports an AI pilot IT creates internally
 *    (keyed by `difficulty`) or a single externally-driven "player" entity
 *    per call to `World.setPlayerInput`. Every spawn with `difficulty`
 *    omitted is therefore treated as "player-controlled" and this adapter
 *    drives it every `stepFixed()` by calling the supplied `Pilot.update(...)`
 *    itself and forwarding the result via `setPlayerInput` before
 *    `world.stepOnce()`. A spawn WITH `difficulty` lets `World` build its own
 *    AI pilot; the `pilot` argument passed to `spawnAircraft` is unused in
 *    that case (the real AI, not a caller-supplied stand-in, flies it -- this
 *    is what `tools/lib/dogfightRunner.ts` wants anyway).
 * 2. `World` exposes no direct "list every alive entity id" query, only
 *    `writeSnapshot(out: Float64Array)` (the same mechanism sim.worker.ts
 *    itself uses to build the wire snapshot). This adapter calls that plus
 *    `readSnapshotHeader`/`readSnapshotEntity` (src/core/snapshotReader.ts)
 *    into a small reused scratch buffer each `listAliveEntityIds()` call, so
 *    every live entity is seen -- including ones `loadMission` or combat
 *    spawned directly, not just entities spawned through this handle.
 *
 * `createRealWorld` below resolves `Mission` + seed into a fully-wired
 * `World` using `src/core`'s own confirmed `buildWorldDependencies(mission)`
 * + `createWorld(deps)` + `world.loadMission(mission)` recipe (read directly
 * from src/core/index.ts and src/core/wireDependencies.ts -- not a guess).
 * src/core's barrel separately also exports a higher-level `createSimWorld`
 * convenience wrapper, but that wrapper does not expose `setPlayerInput` and
 * so cannot drive an externally-supplied scripted `Pilot` (gap 1 above) --
 * this file deliberately uses the lower-level `World` directly instead. If
 * `buildWorldDependencies`/`createWorld`'s names or signatures ever change,
 * only `createRealWorld` needs an edit -- `adaptWorldToHandle` and everything
 * else in this
 * file already matches `contracts/sim.ts` exactly and needs no change.
 */
import type { EntityId, Mission, Pilot, PilotContext, PilotInputs, Result, SimEvent, Vec3Like, HeightSampler, AirportNavDb } from '../../src/contracts/core';
import { NO_ENTITY_ID, SIM_DT_SEC, SNAPSHOT_FLOATS } from '../../src/contracts/core';
import type { SnapshotEntityView, World } from '../../src/contracts/sim';
import { EVENT_QUEUE_CAPACITY } from '../../src/contracts/sim';
import type { SimWorldHandle } from '../../src/contracts/verify';
import { readSnapshotEntity, readSnapshotHeader } from '../../src/core/snapshotReader';
import { unpackEntityId } from '../../src/core/entityPool';
import { resetFcsTrimState, getTrimIntegralRad, getLastGLoad, setFcsTrimState } from '../../src/physics/fcs';

interface ManualPilotBinding {
  entityId: EntityId;
  pilot: Pilot;
}

const NULL_HEIGHT_SAMPLER: HeightSampler = {
  seed: 0,
  heightAt: () => 0,
  normalAt: (_x: number, _z: number, out: Vec3Like) => {
    out.x = 0;
    out.y = 1;
    out.z = 0;
    return out;
  },
};

const NULL_NAV_DB: AirportNavDb = {
  getAirport: () => undefined,
  listAirports: () => [],
  nearestAirport: () => undefined,
  getRunway: () => undefined,
};

function makeEmptyPilotInputs(): PilotInputs {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0,
    afterburner: false,
    brakes: 0,
    gearDown: false,
    airbrake: false,
    trigger: false,
    launch: false,
    cycleWeapon: false,
    cycleTarget: false,
  };
}

/** Adapts a real `World` (contracts/sim.ts) into a `SimWorldHandle` (contracts/verify.ts). See this file's header for the two structural gaps this bridges. */
export function adaptWorldToHandle(world: World): SimWorldHandle {
  const manualBindings: ManualPilotBinding[] = [];
  const drainScratch: SimEvent[] = new Array(EVENT_QUEUE_CAPACITY);
  const snapshotScratch = new Float64Array(SNAPSHOT_FLOATS);
  const entityViewScratch: SnapshotEntityView = {
    id: NO_ENTITY_ID,
    kind: 'aircraft',
    team: 0,
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    omega: { x: 0, y: 0, z: 0 },
    alive: false,
    hp: 0,
    fuelKg: 0,
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    gearPos: 0,
    throttle: 0,
    afterburnerOn: false,
    flags: 0,
  };

  // src/physics/fcs.ts keeps its trim-integral/last-gLoad state in a
  // MODULE-LEVEL (process-wide, not per-World) table indexed by pool slot
  // (see 02-flight-model.md section 4.9/9). In real gameplay only one
  // `World` ever exists per worker process, so this is invisible there; it
  // is a test/tooling-only hazard whenever multiple `World`s share a
  // process, which is exactly what two `createTestWorld`-built
  // `SimWorldHandle`s stepped for direct comparison do
  // (tests/integration/determinism.test.ts, tools/sim-check.ts's
  // `determinism` mode). `src/core`'s own spawn path resets an entity's slot
  // once, at spawn time, which is NOT enough on its own: those tests step
  // worldA and worldB in an INTERLEAVED tick-by-tick pattern
  // (`worldA.stepFixed(); worldB.stepFixed();` repeated), and since a
  // second `World`'s entities are, in the ordinary case, spawned into the
  // SAME low pool indices as the first `World`'s (both pools allocate
  // their first aircraft at index 0, the second at index 1, etc.), every
  // OTHER call after the very first tick overwrites the previous world's
  // freshly-computed trim-integral/gLoad values with its own — a real,
  // verified (not hypothetical) source of divergence: with only the
  // once-at-first-tick reset below, worldA's and worldB's `elevonL/R`
  // measurably differ by tick 5 of tools/sim-check.ts's `determinism` mode
  // run (default free-flight mission), compounding into full state
  // divergence by the first 5-second checkpoint.
  //
  // The fix: this handle keeps its OWN save of every aircraft entity IT
  // owns' (trimIntegralRad, lastGLoadRad), restores that save into
  // fcs.ts's module slots immediately before every `stepOnce()` (undoing
  // whatever any interleaved OTHER `World`'s steps wrote there since this
  // handle's own last step) and re-captures it immediately after (before
  // control returns to the caller and, potentially, another `World` steps
  // and clobbers the shared slots again). The very first tick has no prior
  // save to restore from, so it instead resets to a clean zero, exactly
  // matching what a freshly spawned aircraft's slot already ought to be.
  let hasSteppedOnce = false;
  const localFcsTrimState = new Map<number, { trimIntegralRad: number; lastGLoadRad: number }>();
  const forEachOwnAircraftIndex = (fn: (entityIndex: number) => void): void => {
    world.writeSnapshot(snapshotScratch);
    const header = readSnapshotHeader(snapshotScratch);
    for (let i = 0; i < header.entityCount; i++) {
      const view = readSnapshotEntity(snapshotScratch, i, entityViewScratch);
      if (view.kind !== 'aircraft') continue;
      fn(unpackEntityId(view.id).index);
    }
  };
  const resetAllFcsTrimState = (): void => {
    forEachOwnAircraftIndex((entityIndex) => resetFcsTrimState(entityIndex));
  };
  const restoreLocalFcsTrimState = (): void => {
    for (const [entityIndex, saved] of localFcsTrimState) {
      setFcsTrimState(entityIndex, saved.trimIntegralRad, saved.lastGLoadRad);
    }
  };
  const saveLocalFcsTrimState = (): void => {
    forEachOwnAircraftIndex((entityIndex) => {
      localFcsTrimState.set(entityIndex, { trimIntegralRad: getTrimIntegralRad(entityIndex), lastGLoadRad: getLastGLoad(entityIndex) });
    });
  };

  return {
    get tick() {
      return world.tick;
    },
    get simTimeSec() {
      return world.simTimeSec;
    },
    stepFixed(): void {
      if (!hasSteppedOnce) {
        hasSteppedOnce = true;
        resetAllFcsTrimState();
      } else {
        restoreLocalFcsTrimState();
      }
      for (const binding of manualBindings) {
        const self = world.getEntityState(binding.entityId);
        const selfDamage = world.getDamageState(binding.entityId);
        const telemetry = world.getTelemetry(binding.entityId);
        const combat = world.getCombatStatus(binding.entityId);
        if (self === undefined || selfDamage === undefined || telemetry === undefined || combat === undefined) continue;
        const ctx: PilotContext = {
          self,
          selfDamage,
          telemetry,
          // World's public read surface exposes no sensor-contact query.
          // Every Pilot bound through this manual path is a scripted test
          // pilot (12-verification.md section 4.5) that never reads
          // ctx.contacts, so an empty array is a safe, honest placeholder.
          contacts: [],
          combat,
          sampler: NULL_HEIGHT_SAMPLER,
          navDb: NULL_NAV_DB,
          windWorldMps: { x: 0, y: 0, z: 0 },
          simTimeSec: world.simTimeSec,
        };
        const out = makeEmptyPilotInputs();
        binding.pilot.update(ctx, SIM_DT_SEC, out);
        world.setPlayerInput(binding.entityId, out);
      }
      world.stepOnce();
      saveLocalFcsTrimState();
    },
    spawnAircraft(aircraftDefId, team, pos, headingRad, speedMps, pilot, difficulty) {
      const id = world.spawnEntity({
        kind: 'aircraft',
        team,
        pos,
        headingRad,
        speedMps,
        aircraftDefId,
        difficulty,
      });
      if (difficulty === undefined) {
        manualBindings.push({ entityId: id, pilot });
      }
      return id;
    },
    getEntityState(id) {
      return world.getEntityState(id);
    },
    getDamage(id) {
      return world.getDamageState(id);
    },
    getTelemetry(id) {
      return world.getTelemetry(id);
    },
    listAliveEntityIds() {
      // Enumerates via World.writeSnapshot rather than tracking only ids
      // this adapter itself spawned, so entities loadMission/combat spawn
      // directly (the mission's own player, AI flights, missiles, bullets)
      // are seen too -- not just entities spawned through this handle.
      world.writeSnapshot(snapshotScratch);
      const header = readSnapshotHeader(snapshotScratch);
      const ids: EntityId[] = [];
      for (let i = 0; i < header.entityCount; i++) {
        ids.push(readSnapshotEntity(snapshotScratch, i, entityViewScratch).id);
      }
      return ids;
    },
    drainEvents() {
      const count = world.drainEvents(drainScratch);
      return drainScratch.slice(0, count);
    },
  };
}

interface CoreModuleWithWorldFactory {
  buildWorldDependencies: (mission: Mission) => unknown;
  createWorld: (deps: unknown) => World;
}

function hasWorldFactory(m: unknown): m is CoreModuleWithWorldFactory {
  const r = m as Record<string, unknown> | null;
  return typeof r === 'object' && r !== null && typeof r.buildWorldDependencies === 'function' && typeof r.createWorld === 'function';
}

/**
 * Resolves `mission`/`seed` into a real, raw `World` via `src/core`'s own
 * `buildWorldDependencies(mission)` + `createWorld(deps)` + `world.loadMission(mission)`
 * recipe (confirmed directly against src/core/index.ts's real barrel and
 * src/core/wireDependencies.ts's real `buildWorldDependencies` signature --
 * NOT a guess). A raw `World` (rather than src/core's own higher-level
 * `createSimWorld` convenience wrapper, which does not expose
 * `setPlayerInput` and therefore cannot drive an externally-supplied
 * scripted `Pilot`) is used deliberately so `adaptWorldToHandle` above can
 * fully honour `SimWorldHandle.spawnAircraft`'s `pilot` parameter.
 */
export function createRealWorld(coreModule: unknown, mission: Mission, seed: number): Result<World, string> {
  if (!hasWorldFactory(coreModule)) {
    return {
      ok: false,
      error:
        "tools/lib/worldAdapter.ts's world-creation seam could not find src/core's `buildWorldDependencies`/`createWorld` exports. Update createRealWorld() in this file to match src/core's real barrel exports.",
    };
  }
  try {
    const missionWithSeed: Mission = { ...mission, world: { ...mission.world, seed } };
    const deps = coreModule.buildWorldDependencies(missionWithSeed);
    const world = coreModule.createWorld(deps);
    world.loadMission(missionWithSeed);
    return { ok: true, value: world };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
