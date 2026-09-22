/**
 * tests/integration/aiDogfight.test.ts — AI-vs-AI headless dogfight, both
 * Veteran and Ace. See docs/spec/12-verification.md section 4.7.
 */
import { describe, expect, test } from 'vitest';
import { DOGFIGHT_TEST_TIMEOUT_MS } from '../../src/contracts/verify';
import type { SimWorldHandle } from '../../src/contracts/verify';
import { resolveBuiltinMission } from '../../src/core';
import { runAiDogfight } from '../../tools/lib/dogfightRunner';
import { createTestWorld } from './testHarness';

function mustOk(world: SimWorldHandle | undefined, error: string | undefined): SimWorldHandle {
  if (world === undefined) throw new Error(`createTestWorld failed: ${error ?? 'unknown error'}`);
  return world;
}

describe('AI-vs-AI headless dogfight', () => {
  test(
    'veteran vs veteran: terminates, no ground collision, no omniscient-targeting cheat',
    () => {
      const mission = resolveBuiltinMission('dogfight-1v1');
      const result = createTestWorld(mission, 1);
      const world = mustOk(result.ok ? result.value : undefined, result.ok ? undefined : result.error);
      const outcome = runAiDogfight(world, {
        seed: 1,
        difficultyTeam0: 'veteran',
        difficultyTeam1: 'veteran',
        aircraftDefId: 'tejas-mk1',
      });
      expect(outcome.cheatSuspected).toBe(false);
      expect(outcome.groundCollision).toBe(false);
      expect(Number.isFinite(outcome.ticksRun)).toBe(true);
    },
    DOGFIGHT_TEST_TIMEOUT_MS
  );

  test(
    'ace vs ace: terminates, no ground collision, no omniscient-targeting cheat, stays above the AGL tolerance',
    () => {
      const mission = resolveBuiltinMission('dogfight-1v1');
      const result = createTestWorld(mission, 1);
      const world = mustOk(result.ok ? result.value : undefined, result.ok ? undefined : result.error);
      const outcome = runAiDogfight(world, {
        seed: 1,
        difficultyTeam0: 'ace',
        difficultyTeam1: 'ace',
        aircraftDefId: 'tejas-mk1',
      });
      expect(outcome.cheatSuspected).toBe(false);
      expect(outcome.groundCollision).toBe(false);
      expect(Number.isFinite(outcome.ticksRun)).toBe(true);
      expect(outcome.minAltAglTeam0).toBeGreaterThanOrEqual(-2);
      expect(outcome.minAltAglTeam1).toBeGreaterThanOrEqual(-2);
    },
    DOGFIGHT_TEST_TIMEOUT_MS
  );
});
