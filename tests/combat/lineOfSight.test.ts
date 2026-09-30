/**
 * tests/combat/lineOfSight.test.ts — terrain masking and ray-to-ground against a synthetic terrain:
 * flat ground at 100 m with a 300 m-high, 200 m-wide ridge across x = 5000.
 */
import { describe, expect, it } from 'vitest';
import type { HeightSampler, Vec3Like } from '../../src/contracts/core';
import { rayToGround, terrainLineOfSight } from '../../src/combat/lineOfSight';

const ridge: HeightSampler = {
  seed: 0,
  heightAt: (x) => 100 + (Math.abs(x - 5000) < 100 ? 300 : 0),
  normalAt: (_x, _z, out) => ((out.x = 0), (out.y = 1), (out.z = 0), out),
};
const p = (x: number, y: number, z = 0): Vec3Like => ({ x, y, z });

describe('terrainLineOfSight', () => {
  it('a ridge hides a ground radar from a low jet behind it, not from a high one', () => {
    const radar = p(0, 110);
    expect(terrainLineOfSight(ridge, radar, p(10000, 200))).toBe(false);
    expect(terrainLineOfSight(ridge, radar, p(10000, 1500))).toBe(true);
  });
  it('ground-level endpoints see over the flat ground next to them', () => {
    expect(terrainLineOfSight(ridge, p(0, 102), p(3000, 102))).toBe(true);
    expect(terrainLineOfSight(ridge, p(0, 102), p(3000, 102), 5)).toBe(false);
  });
  it('very long lines stay within the sample cap and still see the ridge', () => {
    expect(terrainLineOfSight(ridge, p(-50000, 150), p(60000, 150))).toBe(false);
  });
});

describe('rayToGround', () => {
  it('finds where a 10-degree dive line meets flat ground, to within a metre', () => {
    const out = p(0, 0);
    const s = Math.sin(10 * Math.PI / 180), c = Math.cos(10 * Math.PI / 180);
    const r = rayToGround(ridge, p(-20000, 1100), p(c, -s), 20000, out);
    expect(r).toBeCloseTo(1000 / s, -0);
    expect(out.y).toBeCloseTo(100, 0);
    expect(out.x).toBeCloseTo(-20000 + (1000 / s) * c, -0);
  });
  it('stops at the ridge face', () => {
    const out = p(0, 0);
    expect(rayToGround(ridge, p(0, 300), p(1, 0), 20000, out)).toBeCloseTo(4900, 0);
  });
  it('returns -1 beyond range or from underground', () => {
    const out = p(0, 0);
    expect(rayToGround(ridge, p(0, 1000), p(1, 0), 3000, out)).toBe(-1);
    expect(rayToGround(ridge, p(0, 50), p(0, -1), 3000, out)).toBe(-1);
  });
});
