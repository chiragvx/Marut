import { describe, expect, it } from 'vitest';
import { CRATER_DENIAL_FACTOR, MOS_LENGTH_M, RunwayDamage, craterRadiusM, longestUsableM } from '../../src/ground';
import type { SimEvent } from '../../src/contracts/core';

/** One 3000 x 50 m runway "09/27" from (0, 0) heading east (+x). */
function oneRunway(): RunwayDamage {
  const d = new RunwayDamage();
  d.addAirport({
    id: 'ab',
    runways: [
      { id: '09', thresholdWorldX: 0, thresholdWorldZ: 0, elevationM: 0, headingRad: Math.PI / 2, lengthM: 3000, widthM: 50, surface: 'asphalt', reciprocalId: '27' },
      { id: '27', thresholdWorldX: 3000, thresholdWorldZ: 0, elevationM: 0, headingRad: -Math.PI / 2, lengthM: 3000, widthM: 50, surface: 'asphalt', reciprocalId: '09' },
    ],
  } as never);
  return d;
}

const SAAW_WARHEAD = { explosiveKg: 30, penetrator: true };

describe('runway damage', () => {
  it('treats both ends of a strip as one runway', () => {
    expect(oneRunway().strips.length).toBe(1);
  });

  it('a crater off the pavement does nothing; one on it is recorded', () => {
    const d = oneRunway();
    const ev: SimEvent[] = [];
    d.impact({ x: 1500, y: 0, z: 200 }, SAAW_WARHEAD, ev);
    expect(ev.length).toBe(0);
    d.impact({ x: 1500, y: 0, z: 0 }, SAAW_WARHEAD, ev);
    expect(ev.map((e) => e.type)).toEqual(['runwayCrater']);
    expect(d.strips[0]!.craters.length).toBe(1);
    expect(d.isClosed('ab')).toBe(false);
  });

  it('one cut leaves a strip longer than the minimum; two cuts on the centreline close it', () => {
    const d = oneRunway();
    const ev: SimEvent[] = [];
    d.impact({ x: 1000, y: 0, z: 0 }, SAAW_WARHEAD, ev);
    expect(longestUsableM(d.strips[0]!)).toBeGreaterThan(MOS_LENGTH_M);
    expect(d.isClosed('ab')).toBe(false);
    d.impact({ x: 2000, y: 0, z: 0 }, SAAW_WARHEAD, ev);
    expect(longestUsableM(d.strips[0]!)).toBeLessThan(MOS_LENGTH_M);
    expect(d.isClosed('ab')).toBe(true);
    expect(d.isClosed('ab', '27')).toBe(true);
    expect(ev.filter((e) => e.type === 'runwayClosed').length).toBe(1);
  });

  it('a cut near the edge leaves a lane past it', () => {
    const d = oneRunway();
    const ev: SimEvent[] = [];
    d.impact({ x: 1000, y: 0, z: 20 }, SAAW_WARHEAD, ev);
    d.impact({ x: 2000, y: 0, z: 20 }, SAAW_WARHEAD, ev);
    expect(d.isClosed('ab')).toBe(false);
  });

  it('crater sizes grow with the charge, more for a penetrator', () => {
    expect(craterRadiusM({ explosiveKg: 200 })).toBeGreaterThan(craterRadiusM({ explosiveKg: 30 }));
    expect(craterRadiusM(SAAW_WARHEAD)).toBeGreaterThan(craterRadiusM({ explosiveKg: 30 }));
    // A SAAW cut on the centreline blocks every 15 m lane of a 50 m runway (lane centres within 17.5 m of the centreline).
    expect(craterRadiusM(SAAW_WARHEAD) * CRATER_DENIAL_FACTOR + 7.5).toBeGreaterThan(17.5);
  });

  it('a jet rolling into a crater is in it', () => {
    const d = oneRunway();
    d.impact({ x: 1000, y: 0, z: 0 }, SAAW_WARHEAD, []);
    expect(d.inCrater(1002, 1)).toBe(true);
    expect(d.inCrater(1100, 0)).toBe(false);
  });
});
