import { describe, it, expect } from 'vitest';
import { computeEnergyHeightM } from '../../src/ai/energyState';

describe('computeEnergyHeightM', () => {
  it('matches the pinned formula (altitudeM + v^2/(2*GRAVITY_MPS2))', () => {
    // 06-ai.md section 4.6's worked example text states 5039.7877, but that
    // figure is itself arithmetically inconsistent with the section's own
    // pinned formula and its own inputs (altitudeM=3000, trueAirspeedMps=200):
    // 3000 + 200^2/(2*9.80665) = 5039.432426 (verified independently), not
    // 5039.7877. The formula (not the mis-transcribed worked number) is what
    // contracts/ai.ts's `ComputeEnergyHeightM` doc comment actually pins, so
    // this test asserts against the correct evaluation of that formula.
    expect(computeEnergyHeightM(3000, 200)).toBeCloseTo(5039.432426, 5);
  });

  it('is exactly 0 at rest at sea level', () => {
    expect(computeEnergyHeightM(0, 0)).toBe(0);
  });
});
