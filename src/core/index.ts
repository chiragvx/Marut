/**
 * src/core/index.ts — barrel re-export for src/core (excludes sim.worker.ts,
 * which is loaded as a worker entry, not imported as a library — see
 * 10-core-worker.md section 2).
 */

export { createEntityPool, createEntityPoolInternal, packEntityId, unpackEntityId } from './entityPool';
export type { WorldEntityPool } from './entityPool';
export { createWorld } from './world';
export { flightModelAdapter } from './flightModelAdapter';
export { combatAdapter, createCombatAdapter } from './combatAdapter';
export { aiPilotAdapter } from './aiPilotAdapter';
export { isaAtmosphere, isaAtmosphereInto } from './atmosphere';
export type { IsaAtmosphereResult } from './atmosphere';
export { createWindState, stepWind } from './wind';
export type { WindState } from './wind';
export { writeSnapshot } from './snapshotWriter';
export { readSnapshotHeader, readSnapshotEntity, readSnapshotHud } from './snapshotReader';
export { createEventQueue } from './eventQueue';
export { advanceFixedStep, shouldEmitSnapshot } from './fixedStepLoop';
export { subSeed } from './seed';
export { extractHeadingPitchRoll, computeIlsDeviation, forwardWorldInto, rightWorldInto } from './hudTelemetry';
export { buildWorldDependencies, loadMissionDescriptor, resolveBuiltinMission } from './missions/index';
export type { WorldCombatTickContext } from './combatContext';

// -----------------------------------------------------------------------------
// createSimWorld — a convenience factory NOT part of contracts/sim.ts,
// provided because module 12's own drafting-time guess (see
// tests/integration/testHarness.ts and tools/sim-check.ts's own header
// comments — "best-effort GUESS at the shape src/core actually exposes")
// anticipates exactly this export name/shape. It builds a real World for a
// given (mission, seed) pair and exposes a small, structurally-compatible
// subset matching contracts/verify.ts's SimWorldHandle closely enough for
// headless testing. If this guess is wrong, only
// tests/integration/testHarness.ts and tools/sim-check.ts's own adapters
// need a post-integration edit (per their own header comments).
//
// `spawnAircraft`'s `pilot` parameter cannot be honoured exactly: World's
// public contract (contracts/sim.ts) only ever attaches a Pilot it built
// itself via WorldDependencies.createAiPilot (keyed by AiDifficulty), not an
// arbitrary externally-constructed Pilot instance. When `pilot` is given and
// `difficulty` is not, this spawns WITHOUT an attached Pilot (a manually-
// driven entity whose inputs the caller drives via `setPlayerInput`, exactly
// like a scripted-input test player) — the closest honest behaviour
// available through the pinned World.spawnEntity(SpawnSpec) surface.
// -----------------------------------------------------------------------------

import { NO_ENTITY_ID, SNAPSHOT_FLOATS } from '../contracts/core';
import type { AiDifficulty, DamageState, EntityId, EntityState, AircraftTelemetry, Mission, Pilot, Result, SimEvent, Team, Vec3Like } from '../contracts/core';
import { EVENT_QUEUE_CAPACITY } from '../contracts/sim';
import { createWorld as createWorldInternal } from './world';
import { buildWorldDependencies as buildDepsInternal } from './missions/index';
import { readSnapshotEntity, readSnapshotHeader } from './snapshotReader';
import type { SnapshotEntityView } from '../contracts/sim';

export interface SimWorldConvenienceHandle {
  readonly tick: number;
  readonly simTimeSec: number;
  stepFixed(): void;
  spawnAircraft(
    aircraftDefId: string,
    team: Team,
    pos: Vec3Like,
    headingRad: number,
    speedMps: number,
    pilot: Pilot | undefined,
    difficulty?: AiDifficulty
  ): EntityId;
  getEntityState(id: EntityId): EntityState | undefined;
  getDamage(id: EntityId): DamageState | undefined;
  getTelemetry(id: EntityId): AircraftTelemetry | undefined;
  listAliveEntityIds(): readonly EntityId[];
  drainEvents(): readonly SimEvent[];
}

export function createSimWorld(mission: Mission, seed: number): Result<SimWorldConvenienceHandle, string> {
  try {
    const missionWithSeed: Mission = { ...mission, world: { ...mission.world, seed } };
    const deps = buildDepsInternal(missionWithSeed);
    const world = createWorldInternal(deps);
    world.loadMission(missionWithSeed);

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

    return {
      ok: true,
      value: {
        get tick() {
          return world.tick;
        },
        get simTimeSec() {
          return world.simTimeSec;
        },
        stepFixed(): void {
          world.stepOnce();
        },
        spawnAircraft(aircraftDefId, team, pos, headingRad, speedMps, _pilot, difficulty) {
          return world.spawnEntity({ kind: 'aircraft', team, pos, headingRad, speedMps, aircraftDefId, difficulty });
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
        listAliveEntityIds(): readonly EntityId[] {
          world.writeSnapshot(snapshotScratch);
          const header = readSnapshotHeader(snapshotScratch);
          const ids: EntityId[] = [];
          for (let i = 0; i < header.entityCount; i++) {
            ids.push(readSnapshotEntity(snapshotScratch, i, entityViewScratch).id);
          }
          return ids;
        },
        drainEvents(): readonly SimEvent[] {
          const out: SimEvent[] = new Array(EVENT_QUEUE_CAPACITY);
          const n = world.drainEvents(out);
          return out.slice(0, n);
        },
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
