/**
 * tools/lib/dogfightRunner.ts — implements RunAiDogfight (contracts/verify.ts).
 * See docs/spec/12-verification.md section 4.7 for the full setup/loop/
 * assertions this drives. Used by tests/integration/aiDogfight.test.ts and
 * `sim-check.ts --mode dogfight`.
 */
import type { EntityId, Pilot, Team } from '../../src/contracts/core';
import type { AiDogfightResult, RunAiDogfight, SimWorldHandle } from '../../src/contracts/verify';
import {
  DOGFIGHT_INITIAL_SEPARATION_M,
  DOGFIGHT_MAX_TICKS,
  DOGFIGHT_MIN_ALT_AGL_TOLERANCE_M,
  DOGFIGHT_MIN_LOCK_TIME_SEC,
} from '../../src/contracts/verify';

const DOGFIGHT_SPAWN_ALTITUDE_M = 4000;
const DOGFIGHT_SPAWN_SPEED_MPS = 220;
const DOGFIGHT_HEADING_EAST_RAD = Math.PI / 2;
const DOGFIGHT_HEADING_WEST_RAD = -Math.PI / 2;

/**
 * A spawn with `difficulty` set is flown by a real AI pilot that
 * tools/lib/worldAdapter.ts's SimWorldHandle constructs internally via the
 * real `World` (contracts/sim.ts's `WorldDependencies.createAiPilot`) --
 * the `pilot` argument `SimWorldHandle.spawnAircraft` still requires is
 * therefore never actually invoked for a difficulty-driven spawn. This
 * placeholder satisfies that required parameter without needing to import
 * src/ai directly (see tools/lib/worldAdapter.ts's own header comment for
 * the full rationale).
 */
const UNUSED_AI_PILOT_PLACEHOLDER: Pilot = {
  update() {
    /* never invoked: World drives difficulty-based spawns internally. */
  },
};

function otherTeam(team: Team): Team {
  return team === 0 ? 1 : 0;
}

export const runAiDogfight: RunAiDogfight = (world: SimWorldHandle, config): AiDogfightResult => {
  const halfSepM = DOGFIGHT_INITIAL_SEPARATION_M / 2;

  const id0 = world.spawnAircraft(
    config.aircraftDefId,
    0,
    { x: -halfSepM, y: DOGFIGHT_SPAWN_ALTITUDE_M, z: 0 },
    DOGFIGHT_HEADING_EAST_RAD,
    DOGFIGHT_SPAWN_SPEED_MPS,
    UNUSED_AI_PILOT_PLACEHOLDER,
    config.difficultyTeam0
  );
  const id1 = world.spawnAircraft(
    config.aircraftDefId,
    1,
    { x: halfSepM, y: DOGFIGHT_SPAWN_ALTITUDE_M, z: 0 },
    DOGFIGHT_HEADING_WEST_RAD,
    DOGFIGHT_SPAWN_SPEED_MPS,
    UNUSED_AI_PILOT_PLACEHOLDER,
    config.difficultyTeam1
  );

  const idToTeam = new Map<EntityId, Team>([
    [id0, 0],
    [id1, 1],
  ]);
  const minAltAgl: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  let firstLockTimeSec: number | undefined;
  let terminatedByKill = false;
  let winnerTeam: Team | undefined;
  let groundCollision = false;

  outer: while (world.tick < DOGFIGHT_MAX_TICKS) {
    world.stepFixed();

    for (const id of world.listAliveEntityIds()) {
      const tel = world.getTelemetry(id);
      if (tel === undefined) continue;
      const team = idToTeam.get(id);
      if (team === undefined) continue;
      if (tel.altAglM < minAltAgl[team]) minAltAgl[team] = tel.altAglM;
    }

    for (const ev of world.drainEvents()) {
      if (ev.type === 'lockAcquired' && firstLockTimeSec === undefined) {
        firstLockTimeSec = world.simTimeSec;
      } else if (ev.type === 'kill') {
        terminatedByKill = true;
        const targetTeam = idToTeam.get(ev.targetId);
        winnerTeam = targetTeam === undefined ? undefined : otherTeam(targetTeam);
        break outer;
      } else if (ev.type === 'crash') {
        const team = idToTeam.get(ev.entityId);
        if (team !== undefined && minAltAgl[team] < DOGFIGHT_MIN_ALT_AGL_TOLERANCE_M) {
          groundCollision = true;
        }
      }
    }
  }

  const cheatSuspected = firstLockTimeSec !== undefined && firstLockTimeSec < DOGFIGHT_MIN_LOCK_TIME_SEC;

  return {
    terminatedByKill,
    winnerTeam,
    ticksRun: world.tick,
    simTimeSec: world.simTimeSec,
    minAltAglTeam0: Number.isFinite(minAltAgl[0]) ? minAltAgl[0] : 0,
    minAltAglTeam1: Number.isFinite(minAltAgl[1]) ? minAltAgl[1] : 0,
    firstLockTimeSec,
    groundCollision,
    cheatSuspected,
  };
};
