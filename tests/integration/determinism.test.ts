/**
 * tests/integration/determinism.test.ts — two fresh SimWorldHandles,
 * identical seed + scripted inputs, hashes match. See
 * docs/spec/12-verification.md section 4.5.
 */
import { describe, expect, test } from 'vitest';
import type { Pilot } from '../../src/contracts/core';
import {
  DETERMINISM_CHECKPOINT_INTERVAL_TICKS,
  DETERMINISM_TEST_TICKS,
} from '../../src/contracts/verify';
import type { DeterminismCheckpoint, ObservedEntity, SimWorldHandle } from '../../src/contracts/verify';
import { resolveBuiltinMission } from '../../src/core';
import { hashSimState } from '../../tools/lib/hash';
import { createTestWorld } from './testHarness';

/**
 * A scripted Pilot (module 12's own, used only in this test) -- SimWorldHandle
 * takes a full Pilot per spawned aircraft (12-verification.md section 4.6),
 * so "scripted inputs" means implementing Pilot.update() to write a fixed
 * function of tick into `out`, never a bespoke world-level input-injection
 * method.
 */
function makeScriptedPilot(): Pilot {
  let tick = 0;
  return {
    update(_ctx, _dtSec, out) {
      out.pitch = Math.sin(tick / 240) * 0.3;
      out.roll = Math.sin(tick / 180) * 0.4;
      out.yaw = 0;
      out.throttle = 0.8;
      out.afterburner = false;
      out.brakes = 0;
      out.gearDown = false;
      out.airbrake = false;
      out.trigger = tick % 300 === 0;
      out.launch = false;
      out.cycleWeapon = false;
      out.cycleTarget = false;
      tick += 1;
    },
  };
}

function mustOk(world: SimWorldHandle | undefined, error: string | undefined): SimWorldHandle {
  if (world === undefined) throw new Error(`createTestWorld failed: ${error ?? 'unknown error'}`);
  return world;
}

function checkpointHashes(world: SimWorldHandle, totalTicks: number, intervalTicks: number): DeterminismCheckpoint[] {
  const checkpoints: DeterminismCheckpoint[] = [];
  for (let t = 1; t <= totalTicks; t++) {
    world.stepFixed();
    if (t % intervalTicks === 0) {
      const ids = [...world.listAliveEntityIds()].sort((a, b) => a - b);
      const entities: ObservedEntity[] = [];
      for (const id of ids) {
        const state = world.getEntityState(id);
        if (state === undefined) continue;
        entities.push({ state, damage: world.getDamage(id), telemetry: world.getTelemetry(id) });
      }
      checkpoints.push({ tick: t, hash: hashSimState(entities) });
    }
  }
  return checkpoints;
}

describe('determinism', () => {
  test(
    'two independent worlds built from the same seed + scripted inputs produce identical checkpoint hashes',
    () => {
      const mission = resolveBuiltinMission('dogfight-1v1'); // one player-slot aircraft + one AI flight
      const seed = 424242;

      const resultA = createTestWorld(mission, seed);
      const resultB = createTestWorld(mission, seed);
      const worldA = mustOk(resultA.ok ? resultA.value : undefined, resultA.ok ? undefined : resultA.error);
      const worldB = mustOk(resultB.ok ? resultB.value : undefined, resultB.ok ? undefined : resultB.error);

      // A fresh scripted-pilot instance per world (so per-instance closure
      // state never crosses worldA/worldB) drives an additional aircraft in
      // both worlds identically; the mission's own AI flight is driven by
      // the real src/ai Pilot in both worlds, which is exactly what this
      // test is proving is deterministic.
      worldA.spawnAircraft('tejas-mk1', 0, { x: 0, y: 4000, z: 0 }, 0, 200, makeScriptedPilot());
      worldB.spawnAircraft('tejas-mk1', 0, { x: 0, y: 4000, z: 0 }, 0, 200, makeScriptedPilot());

      const hashesA = checkpointHashes(worldA, DETERMINISM_TEST_TICKS, DETERMINISM_CHECKPOINT_INTERVAL_TICKS);
      const hashesB = checkpointHashes(worldB, DETERMINISM_TEST_TICKS, DETERMINISM_CHECKPOINT_INTERVAL_TICKS);

      let firstDivergentTick: number | undefined;
      for (let i = 0; i < hashesA.length; i++) {
        const a = hashesA[i];
        const b = hashesB[i];
        if (a !== undefined && b !== undefined && a.hash !== b.hash) {
          firstDivergentTick = a.tick;
          break;
        }
      }

      expect(firstDivergentTick, `first divergent tick: ${String(firstDivergentTick)}`).toBeUndefined();
      expect(hashesA).toEqual(hashesB);
    },
    { timeout: 30000 }
  );
});
