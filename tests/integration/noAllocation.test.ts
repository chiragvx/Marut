/**
 * tests/integration/noAllocation.test.ts — steady-state stepping does not
 * grow the heap (proxy check). See docs/spec/12-verification.md section 6.2.
 * Run with `NODE_OPTIONS=--expose-gc npx vitest run
 * tests/integration/noAllocation.test.ts` for a strict check (section 8,
 * row 9); without --expose-gc this test warns and passes trivially.
 */
import { describe, expect, test } from 'vitest';
import type { SimWorldHandle } from '../../src/contracts/verify';
import { resolveBuiltinMission } from '../../src/core';
import { createTestWorld } from './testHarness';

const WARMUP_TICKS = 600;
const MEASURED_TICKS = 6000; // 50 simulated seconds at SIM_HZ=120
const MAX_HEAP_GROWTH_BYTES = 2 * 1024 * 1024;

function mustOk(world: SimWorldHandle | undefined, error: string | undefined): SimWorldHandle {
  if (world === undefined) throw new Error(`createTestWorld failed: ${error ?? 'unknown error'}`);
  return world;
}

describe('no-allocation-in-hot-path proxy check', () => {
  test(
    'steady-state stepping does not grow the heap',
    () => {
      if (typeof global.gc !== 'function') {
        console.warn('run with NODE_OPTIONS=--expose-gc for a strict check; skipping strict assertion');
        return;
      }

      const mission = resolveBuiltinMission('free-flight'); // no AI flights -- isolates World's own per-tick hot path
      const result = createTestWorld(mission, 1);
      const world = mustOk(result.ok ? result.value : undefined, result.ok ? undefined : result.error);

      for (let i = 0; i < WARMUP_TICKS; i++) world.stepFixed(); // warm up JIT + pools

      global.gc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < MEASURED_TICKS; i++) world.stepFixed();
      global.gc();
      const after = process.memoryUsage().heapUsed;

      expect(after - before).toBeLessThan(MAX_HEAP_GROWTH_BYTES);
    },
    60000
  );
});
