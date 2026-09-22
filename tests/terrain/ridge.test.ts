import { describe, it, expect } from 'vitest';
import { createNoise2D, createRidgeNoise2D } from '../../src/terrain';
import { DEFAULT_TERRAIN_PARAMS } from '../../src/contracts/terrain';

function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('createRidgeNoise2D', () => {
  it('is always >= 0 and never exceeds the conservative max amplitude', () => {
    const p = DEFAULT_TERRAIN_PARAMS.ridge;
    const maxAmp = p.baseAmplitudeM * (1 + 0.5 + 0.25 + 0.125 + 0.0625 + 0.03125); // 500 * 1.96875 = 984.375
    expect(maxAmp).toBeCloseTo(984.375, 6);

    const ridge = createRidgeNoise2D(createNoise2D(11), p);
    const rand = makeLcg(2);
    for (let i = 0; i < 1000; i++) {
      const x = (rand() - 0.5) * 20000;
      const z = (rand() - 0.5) * 20000;
      const v = ridge(x, z);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(maxAmp + 1e-6);
    }
  });
});
