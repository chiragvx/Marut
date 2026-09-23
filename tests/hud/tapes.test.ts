import { describe, expect, it } from 'vitest';
import { throttlePercent, wrapHeadingDeg } from '../../src/hud/tapes';

// Regression coverage for the throttle/afterburner HUD indicator added after a user report that
// the throttle "doesn't seem to be creating enough power" — the real answer was that afterburner
// (a separate control from the 0..1 throttle axis) is required to hit any of the sim-check
// validated performance targets, and the HUD gave the player no way to see whether it was
// engaged or even what throttle percentage they were commanding. See drawPowerIndicator's doc
// comment in tapes.ts.
describe('throttlePercent', () => {
  it('maps 0..1 to 0..100, rounding to the nearest integer', () => {
    expect(throttlePercent(0)).toBe(0);
    expect(throttlePercent(1)).toBe(100);
    expect(throttlePercent(0.5)).toBe(50);
    expect(throttlePercent(0.784)).toBe(78);
    expect(throttlePercent(0.785)).toBe(79); // rounds up at .5
  });

  it('clamps out-of-range input instead of producing a nonsensical percent', () => {
    expect(throttlePercent(-0.2)).toBe(0);
    expect(throttlePercent(1.3)).toBe(100);
  });
});

describe('wrapHeadingDeg (pre-existing, was untested)', () => {
  it('wraps into [0,360)', () => {
    expect(wrapHeadingDeg(370)).toBe(10);
    expect(wrapHeadingDeg(-10)).toBe(350);
    expect(wrapHeadingDeg(0)).toBe(0);
    expect(wrapHeadingDeg(360)).toBe(0);
  });
});
