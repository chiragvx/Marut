import { describe, it, expect } from 'vitest';
import { interpolate2D } from '../../src/math';

describe('interpolate2D', () => {
  const table = { xs: [0, 10], ys: [0, 1], zs: [[0, 1], [2, 3]] };

  it('bilinear interpolation mid-cell', () => {
    expect(interpolate2D(table, 5, 0.5)).toBeCloseTo(1.5, 9);
  });

  it('clamps on both axes independently', () => {
    expect(interpolate2D(table, -100, 5)).toBe(1);
  });

  it('degenerates to 1D when one axis has a single point', () => {
    const singleX = { xs: [7], ys: [0, 1], zs: [[10, 20]] };
    expect(interpolate2D(singleX, -5, 0)).toBe(10);
    expect(interpolate2D(singleX, 100, 1)).toBe(20);
    expect(interpolate2D(singleX, 7, 0.5)).toBeCloseTo(15, 9);

    const singleY = { xs: [0, 1], ys: [7], zs: [[10], [20]] };
    expect(interpolate2D(singleY, 0, -5)).toBe(10);
    expect(interpolate2D(singleY, 1, 100)).toBe(20);
    expect(interpolate2D(singleY, 0.5, 7)).toBeCloseTo(15, 9);
  });

  it('exact corner values are returned exactly', () => {
    expect(interpolate2D(table, 0, 0)).toBe(0);
    expect(interpolate2D(table, 0, 1)).toBe(1);
    expect(interpolate2D(table, 10, 0)).toBe(2);
    expect(interpolate2D(table, 10, 1)).toBe(3);
  });
});
