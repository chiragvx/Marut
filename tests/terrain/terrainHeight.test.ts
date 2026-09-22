import { describe, it, expect } from 'vitest';
import { createRawTerrainHeight, deriveTerrainSubSeed } from '../../src/terrain';
import { DEFAULT_TERRAIN_PARAMS, TERRAIN_MIN_HEIGHT_M, TERRAIN_MAX_HEIGHT_M, TerrainNoiseSeedTag } from '../../src/contracts/terrain';

describe('deriveTerrainSubSeed', () => {
  it('matches the verified fixtures', () => {
    expect(deriveTerrainSubSeed(42, TerrainNoiseSeedTag.Fbm)).toBe(2061797543);
    expect(deriveTerrainSubSeed(42, TerrainNoiseSeedTag.Continental)).toBe(492554467);
    expect(deriveTerrainSubSeed(42, TerrainNoiseSeedTag.Ridge)).toBe(1427514241);
    expect(deriveTerrainSubSeed(42, TerrainNoiseSeedTag.WarpX)).toBe(4264043515);
    expect(deriveTerrainSubSeed(42, TerrainNoiseSeedTag.WarpZ)).toBe(4235616498);
    expect(deriveTerrainSubSeed(1, TerrainNoiseSeedTag.Fbm)).toBe(226214301);
    expect(deriveTerrainSubSeed(2, TerrainNoiseSeedTag.Fbm)).toBe(2868339321);
  });
});

describe('createRawTerrainHeight', () => {
  it('matches the verified fixture at (1234.5, -6789.2) and is deterministic', () => {
    const h = createRawTerrainHeight(DEFAULT_TERRAIN_PARAMS);
    const v = h(1234.5, -6789.2);
    expect(v).toBeCloseTo(423.7411290843514, 6);
    expect(h(1234.5, -6789.2)).toBe(v);
  });

  it('matches the verified fixture at the origin', () => {
    const h = createRawTerrainHeight(DEFAULT_TERRAIN_PARAMS);
    expect(h(0, 0)).toBeCloseTo(226.48833905029295, 6);
  });

  it('stays within [TERRAIN_MIN_HEIGHT_M, TERRAIN_MAX_HEIGHT_M] over the world square', () => {
    const h = createRawTerrainHeight(DEFAULT_TERRAIN_PARAMS);
    const half = 100000;
    for (let i = 0; i < 50; i++) {
      for (let j = 0; j < 50; j++) {
        const x = -half + (i / 49) * 2 * half;
        const z = -half + (j / 49) * 2 * half;
        const v = h(x, z);
        expect(v).toBeGreaterThanOrEqual(TERRAIN_MIN_HEIGHT_M);
        expect(v).toBeLessThanOrEqual(TERRAIN_MAX_HEIGHT_M);
      }
    }
  });
});
