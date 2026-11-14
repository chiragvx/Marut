/**
 * tests/integration/jf17AiDogfight.test.ts — the AI pilots fly the JF-17's own flight data
 * (src/aircraft/jf17Data.ts: smaller wing, 26 deg alpha limit, RD-93) sanely: an ace-vs-ace
 * headless dogfight, as aiDogfight.test.ts does for the Tejas.
 */
import { describe, expect, test } from 'vitest';
import { DOGFIGHT_TEST_TIMEOUT_MS } from '../../src/contracts/verify';
import { resolveBuiltinMission } from '../../src/core';
import { runAiDogfight } from '../../tools/lib/dogfightRunner';
import { createTestWorld } from './testHarness';

describe('AI-vs-AI headless dogfight, JF-17', () => {
  test(
    'ace vs ace: terminates, no ground collision, stays above the AGL tolerance',
    () => {
      const result = createTestWorld(resolveBuiltinMission('dogfight-1v1'), 1);
      if (!result.ok) throw new Error(result.error);
      const outcome = runAiDogfight(result.value, { seed: 1, difficultyTeam0: 'ace', difficultyTeam1: 'ace', aircraftDefId: 'jf-17' });
      expect(outcome.cheatSuspected).toBe(false);
      expect(outcome.groundCollision).toBe(false);
      expect(Number.isFinite(outcome.ticksRun)).toBe(true);
      expect(outcome.minAltAglTeam0).toBeGreaterThanOrEqual(-2);
      expect(outcome.minAltAglTeam1).toBeGreaterThanOrEqual(-2);
    },
    DOGFIGHT_TEST_TIMEOUT_MS
  );
});
