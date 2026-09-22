import { describe, it, expect } from 'vitest';
import { interpolate1D } from '../../src/math';

describe('interpolate1D', () => {
  const table = { xs: [-10, 0, 10, 20], ys: [-0.5, 0.05, 0.9, 0.95] };

  it('interpolates within a segment', () => {
    expect(interpolate1D(table, 5)).toBeCloseTo(0.475, 9);
  });

  it('clamps below domain', () => {
    expect(interpolate1D(table, -20)).toBe(-0.5);
  });

  it('clamps above domain', () => {
    expect(interpolate1D(table, 100)).toBe(0.95);
  });

  it('single-point table always returns the one value', () => {
    const single = { xs: [3], ys: [42] };
    expect(interpolate1D(single, -100)).toBe(42);
    expect(interpolate1D(single, 100)).toBe(42);
  });

  it('exact node values are returned (within floating-point rounding)', () => {
    expect(interpolate1D(table, 0)).toBeCloseTo(0.05, 9);
    expect(interpolate1D(table, 10)).toBeCloseTo(0.9, 9);
  });
});
