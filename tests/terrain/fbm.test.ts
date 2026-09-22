import { describe, it, expect } from 'vitest';
import { createNoise2D, createFbmNoise2D } from '../../src/terrain';
import { DEFAULT_TERRAIN_PARAMS } from '../../src/contracts/terrain';

// Simple deterministic LCG for reproducible "random" sample points (Math.random
// is fine in tests/, but a fixed generator keeps this test byte-for-byte stable).
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('createFbmNoise2D', () => {
  it('never exceeds the theoretical max amplitude Sum(baseAmplitudeM * persistence^i)', () => {
    const p = DEFAULT_TERRAIN_PARAMS.fbm;
    const maxAmp = p.baseAmplitudeM * (1 + 0.5 + 0.25 + 0.125 + 0.0625 + 0.03125); // 220 * 1.96875 = 433.125
    expect(maxAmp).toBeCloseTo(433.125, 6);

    const fbm = createFbmNoise2D(createNoise2D(7), p);
    const rand = makeLcg(1);
    for (let i = 0; i < 1000; i++) {
      const x = (rand() - 0.5) * 20000;
      const z = (rand() - 0.5) * 20000;
      expect(Math.abs(fbm(x, z))).toBeLessThanOrEqual(maxAmp + 1e-6);
    }
  });
});
