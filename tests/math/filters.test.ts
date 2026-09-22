import { describe, it, expect } from 'vitest';
import { lowPassStep, rateLimitStep } from '../../src/math';

describe('lowPassStep', () => {
  it('worked example: tau=0.5, dt=0.1, two sequential steps toward target=1', () => {
    const step1 = lowPassStep(0, 1, 0.5, 0.1);
    expect(step1).toBeCloseTo(0.18126924692201818, 9);
    const step2 = lowPassStep(step1, 1, 0.5, 0.1);
    expect(step2).toBeCloseTo(0.3296799539643608, 9);
  });

  it('non-positive tauSec is instantaneous', () => {
    expect(lowPassStep(0, 1, 0, 0.1)).toBe(1);
    expect(lowPassStep(0, 1, -1, 0.1)).toBe(1);
  });
});

describe('rateLimitStep', () => {
  it('caps the delta at maxRatePerSec * dtSec', () => {
    expect(rateLimitStep(0, 10, 5, 0.1)).toBe(0.5);
  });

  it('reaches target exactly when within budget', () => {
    expect(rateLimitStep(5, 5.1, 5, 0.1)).toBe(5.1);
  });

  it('caps in the negative direction too', () => {
    expect(rateLimitStep(0, -10, 5, 0.1)).toBe(-0.5);
  });
});
