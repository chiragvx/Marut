/**
 * tests/integration/testHarness.ts — the SimWorldHandle adapter.
 * See docs/spec/12-verification.md section 4.6 and section 9's open
 * assumption #2. NOT a test file (vitest.config.ts's `include` only matches
 * `*.test.ts`, so this file is never run directly as a suite).
 *
 * This file is deliberately the ONLY file under tests/ that imports src/core's
 * real exports directly for harness-construction purposes. The actual
 * World -> SimWorldHandle bridging logic (confirmed directly against
 * src/contracts/sim.ts) lives in tools/lib/worldAdapter.ts, shared with
 * tools/sim-check.ts, so both places stay in sync automatically -- this file
 * only wires that shared adapter to `src/core`'s real module object.
 */
import type { CreateTestWorld } from '../../src/contracts/verify';
import { adaptWorldToHandle, createRealWorld } from '../../tools/lib/worldAdapter';
import * as core from '../../src/core';

export const createTestWorld: CreateTestWorld = (mission, seed) => {
  const result = createRealWorld(core, mission, seed);
  if (!result.ok) return result;
  return { ok: true, value: adaptWorldToHandle(result.value) };
};
