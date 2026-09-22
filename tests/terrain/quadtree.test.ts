import { describe, it, expect } from 'vitest';
import { chunkSizeAtDepth, chunkChildren, chunkParent, computeDesiredChunks, chunkKeyToBounds } from '../../src/terrain';
import { TERRAIN_QUALITY_PROFILES } from '../../src/contracts/terrain';
import type { ChunkKey, ChunkBounds } from '../../src/contracts/terrain';

function neverSplit(): boolean {
  return false;
}

function depthHistogram(keys: readonly ChunkKey[]): Record<number, number> {
  const h: Record<number, number> = {};
  for (const k of keys) h[k.depth] = (h[k.depth] ?? 0) + 1;
  return h;
}

function findCoveringKey(keys: readonly ChunkKey[], x: number, z: number): ChunkKey | undefined {
  const bounds: ChunkBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, minY: 0, maxY: 0 };
  for (const k of keys) {
    chunkKeyToBounds(k, bounds);
    if (x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ) return k;
  }
  return undefined;
}

describe('chunk addressing', () => {
  it('chunkSizeAtDepth', () => {
    expect(chunkSizeAtDepth(0)).toBe(200000);
    expect(chunkSizeAtDepth(6)).toBe(3125);
    expect(chunkSizeAtDepth(8)).toBe(781.25);
  });

  it('chunkChildren yields the exact fixed child order', () => {
    const out: [ChunkKey, ChunkKey, ChunkKey, ChunkKey] = [
      { depth: 0, cx: 0, cz: 0 }, { depth: 0, cx: 0, cz: 0 }, { depth: 0, cx: 0, cz: 0 }, { depth: 0, cx: 0, cz: 0 },
    ];
    chunkChildren({ depth: 0, cx: 0, cz: 0 }, out);
    expect(out).toEqual([
      { depth: 1, cx: 0, cz: 0 },
      { depth: 1, cx: 1, cz: 0 },
      { depth: 1, cx: 0, cz: 1 },
      { depth: 1, cx: 1, cz: 1 },
    ]);
  });

  it('chunkParent', () => {
    expect(chunkParent({ depth: 1, cx: 1, cz: 0 })).toEqual({ depth: 0, cx: 0, cz: 0 });
    expect(chunkParent({ depth: 0, cx: 0, cz: 0 })).toBeUndefined();
  });
});

describe('computeDesiredChunks (cold start, wasSplitLastFrame always false)', () => {
  it('Ultra @ (0,5000,0): 124 chunks, depth histogram {4:16,5:44,6:64}, origin key {6,31,31}', () => {
    const out: ChunkKey[] = [];
    computeDesiredChunks({ x: 0, y: 5000, z: 0 }, TERRAIN_QUALITY_PROFILES.ultra, neverSplit, out);
    expect(out.length).toBe(124);
    expect(depthHistogram(out)).toEqual({ 4: 16, 5: 44, 6: 64 });
    expect(findCoveringKey(out, 0, 0)).toEqual({ depth: 6, cx: 31, cz: 31 });
  });

  it('Ultra @ (0,15000,0): 44 chunks, origin key {5,15,15}', () => {
    const out: ChunkKey[] = [];
    computeDesiredChunks({ x: 0, y: 15000, z: 0 }, TERRAIN_QUALITY_PROFILES.ultra, neverSplit, out);
    expect(out.length).toBe(44);
    expect(findCoveringKey(out, 0, 0)).toEqual({ depth: 5, cx: 15, cz: 15 });
  });

  it('Low @ (0,2000,0): 4 chunks, all depth 3', () => {
    const out: ChunkKey[] = [];
    computeDesiredChunks({ x: 0, y: 2000, z: 0 }, TERRAIN_QUALITY_PROFILES.low, neverSplit, out);
    expect(out.length).toBe(4);
    expect(depthHistogram(out)).toEqual({ 3: 4 });
  });

  it('Medium @ (0,5000,0): 12 chunks, depth histogram {4:12}, origin key {4,7,7}', () => {
    const out: ChunkKey[] = [];
    computeDesiredChunks({ x: 0, y: 5000, z: 0 }, TERRAIN_QUALITY_PROFILES.medium, neverSplit, out);
    expect(out.length).toBe(12);
    expect(depthHistogram(out)).toEqual({ 4: 12 });
    expect(findCoveringKey(out, 0, 0)).toEqual({ depth: 4, cx: 7, cz: 7 });
  });

  it('High @ (0,5000,0): 32 chunks, depth histogram {5:32}, origin key {5,15,15}', () => {
    const out: ChunkKey[] = [];
    computeDesiredChunks({ x: 0, y: 5000, z: 0 }, TERRAIN_QUALITY_PROFILES.high, neverSplit, out);
    expect(out.length).toBe(32);
    expect(depthHistogram(out)).toEqual({ 5: 32 });
    expect(findCoveringKey(out, 0, 0)).toEqual({ depth: 5, cx: 15, cz: 15 });
  });
});

describe('computeDesiredChunks — invariants (acceptance criterion 5)', () => {
  it('output contains no duplicate ChunkKey and no key whose ancestor is also present', () => {
    const out: ChunkKey[] = [];
    computeDesiredChunks({ x: 1234, y: 4000, z: -5678 }, TERRAIN_QUALITY_PROFILES.high, neverSplit, out);
    const seen = new Set<string>();
    for (const k of out) {
      const s = `${k.depth}/${k.cx}/${k.cz}`;
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
    for (const k of out) {
      let p = chunkParent(k);
      while (p) {
        expect(seen.has(`${p.depth}/${p.cx}/${p.cz}`)).toBe(false);
        p = chunkParent(p);
      }
    }
  });
});
