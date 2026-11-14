/**
 * Landing gear travel time per aircraft (AircraftDefinition.gearTransitSec): the fighters keep the
 * 2 s default, the C-17 takes its own.
 */
import { describe, expect, it } from 'vitest';
import type { EntityState, PilotInputs } from '../../src/contracts/core';
import { DEFAULT_GEAR_TRANSIT_SEC, stepGearPos } from '../../src/physics/landingGear';
import { c17Definition } from '../../src/aircraft/c17Definition';
import { tejasDefinition } from '../../src/aircraft/tejasDefinition';

function secondsToRetract(transitSec: number | undefined): number {
  const s = { gearPos: 1, flags: 0 } as unknown as EntityState;
  const inputs = { gearDown: false } as unknown as PilotInputs;
  const dt = 1 / 120;
  let t = 0;
  while (s.gearPos > 0 && t < 60) {
    stepGearPos(s, inputs, 100, dt, transitSec);
    t += dt;
  }
  return t;
}

describe('gear transit time', () => {
  it('is 2 s unless the aircraft gives its own', () => {
    expect(DEFAULT_GEAR_TRANSIT_SEC).toBe(2);
    expect(tejasDefinition.gearTransitSec).toBeUndefined();
    expect(secondsToRetract(undefined)).toBeCloseTo(2, 1);
  });

  it('runs the C-17 gear over its own (much longer) time, at a steady rate', () => {
    expect(c17Definition.gearTransitSec).toBeGreaterThanOrEqual(10);
    expect(secondsToRetract(c17Definition.gearTransitSec)).toBeCloseTo(c17Definition.gearTransitSec!, 1);
    // Half-way at half the time (the drawn gear follows gearPos, so it moves smoothly).
    const s = { gearPos: 1, flags: 0 } as unknown as EntityState;
    for (let k = 0; k < 600; k++) stepGearPos(s, { gearDown: false } as unknown as PilotInputs, 100, 0.01, c17Definition.gearTransitSec);
    expect(s.gearPos).toBeCloseTo(1 - 6 / c17Definition.gearTransitSec!, 5);
  });
});
