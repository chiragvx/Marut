import { describe, it, expect } from 'vitest';
import { createHeightSampler, buildChunkGeometry } from '../../src/terrain';
import { DEFAULT_TERRAIN_PARAMS, TERRAIN_QUALITY_PROFILES } from '../../src/contracts/terrain';

const sampler = createHeightSampler(DEFAULT_TERRAIN_PARAMS, []);

describe('buildChunkGeometry — vertex/index counts', () => {
  const table: Record<number, { vertexCount: number; indexCount: number }> = {
    12: { vertexCount: 221, indexCount: 1152 },
    16: { vertexCount: 357, indexCount: 1920 },
    24: { vertexCount: 725, indexCount: 4032 },
    32: { vertexCount: 1221, indexCount: 6912 },
  };

  for (const tierName of ['low', 'medium', 'high', 'ultra'] as const) {
    const profile = TERRAIN_QUALITY_PROFILES[tierName];
    it(`${tierName} (gridQuads=${profile.chunkGridQuads}) matches section 4.7's table`, () => {
      const geo = buildChunkGeometry(sampler, { depth: profile.maxLodDepth, cx: 0, cz: 0 }, profile.chunkGridQuads);
      const expected = table[profile.chunkGridQuads]!;
      expect(geo.vertexCount).toBe(expected.vertexCount);
      expect(geo.indexCount).toBe(expected.indexCount);
      expect(geo.positions.length).toBe(geo.vertexCount * 3);
      expect(geo.normals.length).toBe(geo.vertexCount * 3);
      expect(geo.indices.length).toBe(geo.indexCount);
    });
  }
});

describe('buildChunkGeometry — interior grid winding', () => {
  it('every interior-grid triangle is up-facing (cross(B-A, C-A).y > 0)', () => {
    const res = 12;
    const geo = buildChunkGeometry(sampler, { depth: 3, cx: 0, cz: 0 }, res);
    const interiorIdxCount = res * res * 6;
    const posAt = (i: number): [number, number, number] => [geo.positions[i * 3]!, geo.positions[i * 3 + 1]!, geo.positions[i * 3 + 2]!];
    for (let t = 0; t < interiorIdxCount; t += 3) {
      const a = posAt(geo.indices[t]!);
      const b = posAt(geo.indices[t + 1]!);
      const c = posAt(geo.indices[t + 2]!);
      const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
      const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
      const crossY = abz * acx - abx * acz;
      expect(crossY).toBeGreaterThan(0);
    }
  });
});

describe('buildChunkGeometry — absolute world coordinates', () => {
  it('main (non-skirt) vertex x/z lie within the chunk bounds for {depth:6,cx:31,cz:31}', () => {
    const res = 32; // ultra tier chunkGridQuads, depth 6 is ultra's maxLodDepth
    const geo = buildChunkGeometry(sampler, { depth: 6, cx: 31, cz: 31 }, res);
    const mainVertCount = (res + 1) * (res + 1);
    for (let i = 0; i < mainVertCount; i++) {
      const x = geo.positions[i * 3]!;
      const z = geo.positions[i * 3 + 2]!;
      expect(x).toBeGreaterThanOrEqual(-3125 - 1e-6);
      expect(x).toBeLessThanOrEqual(0 + 1e-6);
      expect(z).toBeGreaterThanOrEqual(-3125 - 1e-6);
      expect(z).toBeLessThanOrEqual(0 + 1e-6);
    }
  });
});

describe('buildChunkGeometry — never throws (acceptance criterion 4)', () => {
  it('for every depth 0..MAX_QUADTREE_DEPTH and gridQuads in {12,16,24,32}', () => {
    for (let depth = 0; depth <= 8; depth++) {
      for (const gridQuads of [12, 16, 24, 32]) {
        expect(() => buildChunkGeometry(sampler, { depth, cx: 0, cz: 0 }, gridQuads)).not.toThrow();
      }
    }
  });
});
