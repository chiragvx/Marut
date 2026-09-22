import { describe, expect, it } from 'vitest';
import { computeBearingAndRange, selectNearestContacts, type RadarCandidate } from '../../src/hud/radarScope';

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
});
