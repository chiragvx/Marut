/**
 * src/math/filters.ts — first-order low-pass filter step + slew-rate limiter step.
 * See docs/spec/01-math.md section 4.12.
 */
import type { LowPassStep, RateLimitStep } from '../contracts/math';

export const lowPassStep: LowPassStep = (prevOutput, target, tauSec, dtSec) => {
  if (tauSec <= 0) return target;
  const alpha = 1 - Math.exp(-dtSec / tauSec);
  return prevOutput + (target - prevOutput) * alpha;
};

export const rateLimitStep: RateLimitStep = (prevValue, target, maxRatePerSec, dtSec) => {
  const maxDelta = maxRatePerSec * dtSec;
  const delta = target - prevValue;
  if (delta > maxDelta) return prevValue + maxDelta;
  if (delta < -maxDelta) return prevValue - maxDelta;
  return target;
};
