import { describe, it, expect } from 'vitest';
import { createHeightSampler } from '../../src/terrain';
import { DEFAULT_TERRAIN_PARAMS } from '../../src/contracts/terrain';
import type { AirportFlattenZone } from '../../src/contracts/terrain';

describe('createHeightSampler.heightAt — airport flattening', () => {
  const zone: AirportFlattenZone = { centerWorldX: 1000, centerWorldZ: 2000, elevationM: 50, flatRadiusM: 500, blendRadiusM: 200 };
  const sampler = createHeightSampler(DEFAULT_TERRAIN_PARAMS, [zone]);

  it('matches the 5-point verified fixture (center, flat-radius edge, mid-blend, blend edge, outside)', () => {
    expect(sampler.heightAt(1000, 2000)).toBeCloseTo(50, 6); // d=0
    expect(sampler.heightAt(1500, 2000)).toBeCloseTo(50, 6); // d=500, edge of flat radius, still exactly 50
    expect(sampler.heightAt(1600, 2000)).toBeCloseTo(15.013877462403457, 6); // d=600, mid-blend
    expect(sampler.heightAt(1700, 2000)).toBeCloseTo(-42.26489813275134, 6); // d=700, weight=0 boundary
    expect(sampler.heightAt(2000, 2000)).toBeCloseTo(-13.863848509359755, 6); // d=1000, fully outside
  });

  it('at the blend-radius boundary and beyond, equals the raw (unflattened) height exactly', () => {
    const raw = createHeightSampler(DEFAULT_TERRAIN_PARAMS, []);
    expect(sampler.heightAt(1700, 2000)).toBeCloseTo(raw.heightAt(1700, 2000), 6);
    expect(sampler.heightAt(2000, 2000)).toBeCloseTo(raw.heightAt(2000, 2000), 6);
  });
});

describe('createHeightSampler.normalAt', () => {
  const sampler = createHeightSampler(DEFAULT_TERRAIN_PARAMS, []);

  it('matches the verified fixture at (1234.5, -6789.2)', () => {
    const out = { x: 0, y: 0, z: 0 };
    sampler.normalAt(1234.5, -6789.2, out);
    expect(out.x).toBeCloseTo(-0.2956766822239997, 6);
    expect(out.y).toBeCloseTo(0.951572670718101, 6);
    expect(out.z).toBeCloseTo(0.08417096845960884, 6);
    const len = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
    expect(len).toBeCloseTo(1, 9);
  });

  it('at the origin: generic invariants only (upward-facing, unit length) — not a hardcoded slope', () => {
    const out = { x: 0, y: 0, z: 0 };
    sampler.normalAt(0, 0, out);
    expect(out.y).toBeGreaterThan(0);
    const len = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
    expect(len).toBeCloseTo(1, 9);
  });
});

describe('createHeightSampler.seed', () => {
  it('exposes params.seed read-only', () => {
    const sampler = createHeightSampler(DEFAULT_TERRAIN_PARAMS, []);
    expect(sampler.seed).toBe(DEFAULT_TERRAIN_PARAMS.seed);
  });
});
