import { describe, expect, it } from 'vitest';
import { extractHeadingPitchRoll } from '../../src/core/hudTelemetry';

describe('extractHeadingPitchRoll', () => {
  it('worked fixture A: heading=1.2, pitch=0.3, roll=0.7', () => {
    const rot = { x: 0.359114159, y: 0.22158143, z: 0.075473147, w: 0.903461396 };
    const out = extractHeadingPitchRoll(rot, { headingRad: 0, pitchRad: 0, rollRad: 0 });
    expect(out.headingRad).toBeCloseTo(1.2, 6);
    expect(out.pitchRad).toBeCloseTo(0.3, 6);
    expect(out.rollRad).toBeCloseTo(0.7, 6);
  });

  it('identity quaternion -> heading=PI/2 due east, pitch=0, roll=0', () => {
    const out = extractHeadingPitchRoll({ x: 0, y: 0, z: 0, w: 1 }, { headingRad: 0, pitchRad: 0, rollRad: 0 });
    expect(out.headingRad).toBeCloseTo(Math.PI / 2, 9);
    expect(out.pitchRad).toBeCloseTo(0, 9);
    expect(out.rollRad).toBeCloseTo(0, 9);
  });
});
