/**
 * src/core/fixedStepLoop.ts — implements `AdvanceFixedStep`/`ShouldEmitSnapshot`
 * (contracts/sim.ts section 5), exactly 00-architecture.md section 4's
 * accumulator algorithm, made pure and Node-testable (no worker/timer
 * involved).
 */

import { SIM_DT_SEC } from '../contracts/core';
import { ACCUMULATOR_MAX_CATCHUP_SEC, SNAPSHOT_EVERY_N_TICKS } from '../contracts/sim';
import type { AdvanceFixedStep, FixedStepAccumulatorState, ShouldEmitSnapshot } from '../contracts/sim';

export const advanceFixedStep: AdvanceFixedStep = (state: FixedStepAccumulatorState, realDtSec: number, stepFn: (dtSec: number) => void): number => {
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

export const shouldEmitSnapshot: ShouldEmitSnapshot = (tickCount: number): boolean => tickCount % SNAPSHOT_EVERY_N_TICKS === 0;
