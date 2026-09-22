import { describe, expect, it } from 'vitest';
import { ilsDeviation } from '../../src/airport/ils';
import type { IlsDeviation } from '../../src/contracts/airport';
import { ILS_DEFAULT_GLIDESLOPE_RAD } from '../../src/contracts/core';
import type { IlsInfo } from '../../src/contracts/core';

// Worked example from 05-airport.md section 4.7: runway threshold (0,100,-1000),
// headingRad=0, lengthM=3000, default ILS offsets/angle.
const ils: IlsInfo = {
  frequencyMhz: 109.9,
  localiserHeadingRad: 0,
  glideslopeAngleRad: ILS_DEFAULT_GLIDESLOPE_RAD,
  localiserOriginPos: { x: 0, y: 100, z: -4300 },
  glideslopeOriginPos: { x: 0, y: 100, z: -1300 },
};

function freshOut(): IlsDeviation {
  return { locNormalized: -999, gsNormalized: -999, valid: false };
}

describe('ilsDeviation', () => {
  it('is on-path and on-centerline: near-zero loc/gs deviation', () => {
    const out = ilsDeviation({ x: 0, y: 362.039, z: 3700 }, ils, freshOut());
    expect(out.valid).toBe(true);
    expect(Math.abs(out.locNormalized)).toBeLessThan(1e-6);
    expect(Math.abs(out.gsNormalized)).toBeLessThan(0.01);
  });

  it('50 m right of centerline deflects the localiser needle', () => {
    const out = ilsDeviation({ x: 50, y: 362.039, z: 3700 }, ils, freshOut());
    expect(Math.abs(out.locNormalized - 0.1432)).toBeLessThan(0.001);
  });

  it('50 m above the glidepath deflects the glideslope needle', () => {
    const out = ilsDeviation({ x: 0, y: 412.039, z: 3700 }, ils, freshOut());
    expect(Math.abs(out.gsNormalized - 0.816)).toBeLessThan(0.01);
  });

  it('is invalid beyond ILS_LOC_VALID_RANGE_M and zeroes both needles', () => {
    const out = ilsDeviation({ x: 0, y: 362.039, z: 60000 }, ils, freshOut());
    expect(out.valid).toBe(false);
    expect(out.locNormalized).toBe(0);
    expect(out.gsNormalized).toBe(0);
  });

  it('is allocation-free: returns the same out reference across many varying calls', () => {
    const out = freshOut();
    for (let i = 0; i < 10000; i++) {
      const returned = ilsDeviation({ x: (i % 200) - 100, y: 300 + i, z: 3000 + i }, ils, out);
      expect(returned).toBe(out);
    }
  });
});
