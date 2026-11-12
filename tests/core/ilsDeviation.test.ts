import { describe, expect, it } from 'vitest';
import { computeIlsDeviation } from '../../src/core/hudTelemetry';
import type { IlsInfo } from '../../src/contracts/core';

// Runway heading 0 (north, -z), threshold at the origin, 2,700 m long; localiser 300 m beyond the
// far end, glide slope 300 m in from the threshold.
const ils: IlsInfo = {
  frequencyMhz: 110.1,
  localiserHeadingRad: 0,
  glideslopeAngleRad: (3 * Math.PI) / 180,
  localiserOriginPos: { x: 0, y: 0, z: -3000 },
  glideslopeOriginPos: { x: 0, y: 0, z: -300 },
};
const at = (x: number, y: number, z: number) => computeIlsDeviation({ x, y, z }, ils, { loc: 0, gs: 0 });

describe('computeIlsDeviation', () => {
  it('on course and on the glide path: needles centred', () => {
    const r = at(0, Math.tan((3 * Math.PI) / 180) * 10300, 10000);
    expect(Math.abs(r.loc)).toBeLessThan(0.01);
    expect(Math.abs(r.gs)).toBeLessThan(0.01);
  });
  it('right of the course reads +, left reads -, in proportion (not pinned)', () => {
    const right = at(200, 540, 10000); // 200 m right (east) at 13 km from the localiser: ~0.88 deg
    const left = at(-200, 540, 10000);
    expect(right.loc).toBeGreaterThan(0.2);
    expect(right.loc).toBeLessThan(0.5);
    expect(left.loc).toBeCloseTo(-right.loc, 6);
  });
  it('above the glide path reads +', () => {
    expect(at(0, 900, 10000).gs).toBeGreaterThan(0.3);
    expect(at(0, 300, 10000).gs).toBeLessThan(-0.3);
  });
  it('off: past the localiser, or far off to the side', () => {
    expect(at(0, 500, -5000)).toEqual({ loc: 0, gs: 0 });
    expect(at(9000, 500, 3000)).toEqual({ loc: 0, gs: 0 });
  });
});
