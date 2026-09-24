import { describe, expect, it } from 'vitest';
import { gaugeFraction } from '../../src/hud/controlSurfaceDebug';

describe('gaugeFraction', () => {
  it('maps 0 to 0 (centered, no fill)', () => {
    expect(gaugeFraction(0, 30)).toBe(0);
  });

  it('maps +-rangeDeg to +-1 exactly', () => {
    expect(gaugeFraction(30, 30)).toBe(1);
    expect(gaugeFraction(-30, 30)).toBe(-1);
  });

  it('scales linearly within range', () => {
    expect(gaugeFraction(15, 30)).toBeCloseTo(0.5, 10);
    expect(gaugeFraction(-7.5, 30)).toBeCloseTo(-0.25, 10);
  });

  it('clamps past the range instead of overflowing the gauge track', () => {
    expect(gaugeFraction(45, 30)).toBe(1);
    expect(gaugeFraction(-45, 30)).toBe(-1);
  });
});
