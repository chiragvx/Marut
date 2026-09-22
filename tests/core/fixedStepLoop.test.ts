/**
 * tests/core/fixedStepLoop.test.ts — accumulator ticks exactly
 * floor(realDt/SIM_DT_SEC) times, catch-up cap at 0.25s. See
 * docs/spec/12-verification.md section 7.
 */
import { describe, expect, test } from 'vitest';
import { SIM_DT_SEC } from '../../src/contracts/core';
import type { FixedStepAccumulatorState } from '../../src/contracts/sim';
import { ACCUMULATOR_MAX_CATCHUP_SEC } from '../../src/contracts/sim';
import { advanceFixedStep, shouldEmitSnapshot } from '../../src/core/fixedStepLoop';

function freshState(): FixedStepAccumulatorState {
  return { accumulatorSec: 0, tickCount: 0 };
}

describe('advanceFixedStep', () => {
  test('a 0.033s real frame at 120Hz ticks exactly floor(0.033/SIM_DT_SEC) times', () => {
    const state = freshState();
    let ticks = 0;
    const stepped = advanceFixedStep(state, 0.033, () => {
      ticks += 1;
    });
    expect(stepped).toBe(Math.floor(0.033 / SIM_DT_SEC));
    expect(ticks).toBe(stepped);
    expect(state.tickCount).toBe(stepped);
  });

  test('a stalled 2s frame is clamped to the 0.25s catch-up cap, not 240 ticks', () => {
    const state = freshState();
    let ticks = 0;
    const stepped = advanceFixedStep(state, 2.0, () => {
      ticks += 1;
    });
    expect(stepped).toBe(Math.floor(ACCUMULATOR_MAX_CATCHUP_SEC / SIM_DT_SEC));
    expect(ticks).toBe(stepped);
  });

  test('accumulator carries a sub-tick remainder across calls', () => {
    const state = freshState();
    let ticks = 0;
    const dtPerCall = SIM_DT_SEC * 1.5; // 1.5 ticks worth each call
    advanceFixedStep(state, dtPerCall, () => ticks++);
    expect(ticks).toBe(1);
    advanceFixedStep(state, dtPerCall, () => ticks++);
    // Two calls of 1.5 ticks' worth of time = 3 ticks total across both calls.
    expect(ticks).toBe(3);
  });

  test('less than one tick worth of real time steps zero times', () => {
    const state = freshState();
    let ticks = 0;
    const stepped = advanceFixedStep(state, SIM_DT_SEC * 0.5, () => ticks++);
    expect(stepped).toBe(0);
    expect(ticks).toBe(0);
    expect(state.accumulatorSec).toBeCloseTo(SIM_DT_SEC * 0.5, 9);
  });

  test('stepFn is always called with exactly SIM_DT_SEC', () => {
    const state = freshState();
    const dts: number[] = [];
    advanceFixedStep(state, 0.05, (dtSec) => dts.push(dtSec));
    expect(dts.length).toBeGreaterThan(0);
    for (const dt of dts) expect(dt).toBe(SIM_DT_SEC);
  });
});

describe('shouldEmitSnapshot', () => {
  test('is true every SNAPSHOT_EVERY_N_TICKS (= SIM_HZ/SNAPSHOT_HZ = 2) ticks', () => {
    expect(shouldEmitSnapshot(0)).toBe(true);
    expect(shouldEmitSnapshot(1)).toBe(false);
    expect(shouldEmitSnapshot(2)).toBe(true);
    expect(shouldEmitSnapshot(3)).toBe(false);
    expect(shouldEmitSnapshot(120)).toBe(true);
  });
});
