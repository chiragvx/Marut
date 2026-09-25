import { describe, expect, it } from 'vitest';
import { GearIndicator, MPS_PER_KNOT, fuelDisplayKg, gearIndicatorState, mpsToKnots, throttlePercent, wrapHeadingDeg } from '../../src/hud/tapes';

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

// Regression coverage for the "convert HUD airspeed tape to knots" feature (user report: the
// sim's speeds were verified accurate to real Tejas figures, but the tape displayed raw m/s
// rather than the knots a real cockpit uses).
describe('mpsToKnots', () => {
  it('converts exactly 1 knot (0.514444 m/s) to 1', () => {
    expect(mpsToKnots(MPS_PER_KNOT)).toBeCloseTo(1, 9);
  });

  it('converts 0 to 0', () => {
    expect(mpsToKnots(0)).toBe(0);
  });

  it('matches the sim-check-validated vmax_11000 figure (466.36 m/s) to Mach-1.6-class knots', () => {
    // 466.36 m/s / 0.514444 = ~906.53 kt — sanity-checks the conversion against a real number
    // already validated elsewhere in this project (tools/sim-check.ts / docs/spec/12-verification.md).
    expect(mpsToKnots(466.36)).toBeCloseTo(906.53, 1);
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

describe('gearIndicatorState', () => {
  it('locked down / up at the ends of travel, transit in between', () => {
    expect(gearIndicatorState(1)).toBe(GearIndicator.Down);
    expect(gearIndicatorState(0.995)).toBe(GearIndicator.Down);
    expect(gearIndicatorState(0)).toBe(GearIndicator.Up);
    expect(gearIndicatorState(0.005)).toBe(GearIndicator.Up);
    expect(gearIndicatorState(0.5)).toBe(GearIndicator.Transit);
    expect(gearIndicatorState(0.05)).toBe(GearIndicator.Transit);
  });
});

describe('fuelDisplayKg', () => {
  it('rounds to whole kg and never shows negative', () => {
    expect(fuelDisplayKg(2457.6)).toBe(2458);
    expect(fuelDisplayKg(-3)).toBe(0);
  });
});
