import { describe, expect, it } from 'vitest';
import {
  computeBearingAndRange,
  computeBearingAndRangeFR,
  forwardWorldFromHeading,
  forwardWorldFromHeadingInto,
  rightWorldFromHeading,
  rightWorldFromHeadingInto,
  selectNearestContacts,
  type RadarCandidate,
} from '../../src/hud/radarScope';

describe('radarScope', () => {
  it('player at origin, heading 0: contact straight ahead has bearing~0, range=1000', () => {
    const out = { rangeM: 0, bearingRad: 0 };
    computeBearingAndRange({ x: 0, y: 0, z: 0 }, 0, { x: 0, y: 0, z: -1000 }, out);
    expect(out.bearingRad).toBeCloseTo(0, 9);
    expect(out.rangeM).toBe(1000);
  });

  it('selects exactly the N nearest contacts, sorted ascending by range', () => {
    const candidates: RadarCandidate[] = [];
    for (let i = 0; i < 20; i++) {
      candidates.push({ id: i, team: 0, rangeM: (i * 37) % 20000, bearingRad: 0 });
    }
    const expectedNearest = [...candidates].sort((a, b) => a.rangeM - b.rangeM).slice(0, 16);

    const outCount = { value: 0 };
    selectNearestContacts(candidates, 16, outCount);

    expect(outCount.value).toBe(16);
    const actualNearest = candidates.slice(0, 16);
    for (let i = 1; i < actualNearest.length; i++) {
      expect(actualNearest[i]!.rangeM).toBeGreaterThanOrEqual(actualNearest[i - 1]!.rangeM);
    }
    const expectedIds = new Set(expectedNearest.map((c) => c.id));
    const actualIds = new Set(actualNearest.map((c) => c.id));
    expect(actualIds).toEqual(expectedIds);
  });

  it('forwardWorldFromHeadingInto/rightWorldFromHeadingInto write into `out` without allocating and match the allocating variants', () => {
    const headingRad = 0.7123;
    const expectedFwd = forwardWorldFromHeading(headingRad);
    const expectedRight = rightWorldFromHeading(headingRad);

    const out: { x: number; y: number; z: number } = { x: 99, y: 99, z: 99 };
    const returned = forwardWorldFromHeadingInto(headingRad, out);
    expect(returned).toBe(out); // same reference: non-allocating, writes into `out`
    expect(out.x).toBeCloseTo(expectedFwd.x, 12);
    expect(out.y).toBeCloseTo(expectedFwd.y, 12);
    expect(out.z).toBeCloseTo(expectedFwd.z, 12);

    const outR: { x: number; y: number; z: number } = { x: -1, y: -1, z: -1 };
    const returnedR = rightWorldFromHeadingInto(headingRad, outR);
    expect(returnedR).toBe(outR);
    expect(outR.x).toBeCloseTo(expectedRight.x, 12);
    expect(outR.y).toBeCloseTo(expectedRight.y, 12);
    expect(outR.z).toBeCloseTo(expectedRight.z, 12);
  });

  it('computeBearingAndRangeFR with pre-computed forward/right matches computeBearingAndRange for the same heading (regression: hot-path variant must not change the result)', () => {
    const playerPos = { x: 120, y: 3000, z: -450 };
    const headingRad = 2.1;
    const contacts = [
      { x: 5000, y: 3000, z: -450 },
      { x: 120, y: 3200, z: -8000 },
      { x: -3000, y: 2800, z: 1000 },
    ];

    const fwd = forwardWorldFromHeading(headingRad);
    const right = rightWorldFromHeading(headingRad);

    for (const contactPos of contacts) {
      const expected = { rangeM: 0, bearingRad: 0 };
      computeBearingAndRange(playerPos, headingRad, contactPos, expected);

      const actual = { rangeM: 0, bearingRad: 0 };
      const returned = computeBearingAndRangeFR(playerPos, fwd, right, contactPos, actual);

      expect(returned).toBe(actual); // non-allocating: writes into and returns `out`
      expect(actual.rangeM).toBeCloseTo(expected.rangeM, 9);
      expect(actual.bearingRad).toBeCloseTo(expected.bearingRad, 9);
    }
  });
});
