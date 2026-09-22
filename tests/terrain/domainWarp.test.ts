import { describe, it, expect } from 'vitest';
import { createNoise2D, createFbmNoise2D, createDomainWarp2D } from '../../src/terrain';
import { DEFAULT_TERRAIN_PARAMS } from '../../src/contracts/terrain';
import type { Vec2Like, FbmParams } from '../../src/contracts/terrain';

function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('createDomainWarp2D', () => {
  it('with enabled:false, leaves (x,z) unchanged', () => {
    const p = { ...DEFAULT_TERRAIN_PARAMS.domainWarp, enabled: false };
    const warp = createDomainWarp2D(createNoise2D(1), createNoise2D(2), p);
    const out: Vec2Like = { x: 0, z: 0 };
    for (const [x, z] of [[0, 0], [1234.5, -6789.2], [-500, 900]] as const) {
      warp(x, z, out);
      expect(out.x).toBe(x);
      expect(out.z).toBe(z);
    }
  });

  it('with enabled:true, displacement magnitude stays within warpAmplitudeM * Sum(0.5^i)', () => {
    const p = DEFAULT_TERRAIN_PARAMS.domainWarp;
    const warpFbmParams: FbmParams = { octaves: p.octaves, baseFrequency: p.warpFrequency, baseAmplitudeM: 1, lacunarity: 2, persistence: 0.5 };
    const warpXFbm = createFbmNoise2D(createNoise2D(4), warpFbmParams);
    const warpZFbm = createFbmNoise2D(createNoise2D(5), warpFbmParams);
    const warp = createDomainWarp2D(warpXFbm, warpZFbm, p);

    const maxDisp = p.warpAmplitudeM * (1 + 0.5 + 0.25); // 600 * 1.75 = 1050
    expect(maxDisp).toBeCloseTo(1050, 6);

    const out: Vec2Like = { x: 0, z: 0 };
    const rand = makeLcg(3);
    for (let i = 0; i < 1000; i++) {
      const x = (rand() - 0.5) * 20000;
      const z = (rand() - 0.5) * 20000;
      warp(x, z, out);
      const dx = out.x - x;
      const dz = out.z - z;
      expect(Math.sqrt(dx * dx + dz * dz)).toBeLessThanOrEqual(maxDisp + 1e-6);
    }
  });
});
