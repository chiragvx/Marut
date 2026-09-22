import { describe, it, expect } from 'vitest';
import { createNoise2D } from '../../src/terrain';

describe('createNoise2D', () => {
  it('matches the verified fixture for seed 12345', () => {
    const n = createNoise2D(12345);
    const v = n(1.234, -5.678);
    expect(v).toBeCloseTo(0.38828435101300646, 9);
    expect(n(1.234, -5.678)).toBe(v); // determinism: repeat call identical
  });

  it('matches the verified fixture for seed 999 and differs from seed 12345', () => {
    const n = createNoise2D(999);
    const v = n(1.234, -5.678);
    expect(v).toBeCloseTo(-0.5711847670297295, 9);
    expect(v).not.toBe(createNoise2D(12345)(1.234, -5.678));
  });

  it('stays within [-1,1] and actually reaches near the extremes over a grid', () => {
    const n = createNoise2D(12345);
    let maxAbs = 0;
    for (let i = 0; i < 50; i++) {
      for (let j = 0; j < 50; j++) {
        const v = n(i * 0.13, j * 0.13);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
        maxAbs = Math.max(maxAbs, Math.abs(v));
      }
    }
    expect(maxAbs).toBeGreaterThan(0.9);
  });
});
