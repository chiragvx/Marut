/**
 * tests/terrain/roadNetwork.test.ts — the procedural Punjab settlements and road network, and the
 * per-chunk scenery built from them.
 */
import { describe, expect, test } from 'vitest';
import { DecalClass, THEATRE_TERRAIN_PARAMS } from '../../src/contracts/terrain';
import { createHeightSampler } from '../../src/terrain';
import { buildRoadNetwork } from '../../src/terrain/roadNetwork';
import { buildChunkGeometryAndSurface } from '../../src/terrain/chunkGeometryBuilder';
import { buildChunkFeatures } from '../../src/terrain/chunkFeatures';

const params = { ...THEATRE_TERRAIN_PARAMS.punjab, seed: 3141592 };
const sampler = createHeightSampler(params, []);
const net = buildRoadNetwork(params, sampler)!;

describe('Punjab road network', () => {
  test('is deterministic', () => {
    const again = buildRoadNetwork(params, sampler)!;
    expect(again.roads.length).toBe(net.roads.length);
    expect(again.settlements.length).toBe(net.settlements.length);
    expect(Array.from(again.roads[123]!.pts)).toEqual(Array.from(net.roads[123]!.pts));
  });

  test('has the named towns, highways, canals and thousands of villages', () => {
    expect(net.settlements.filter((s) => s.kind === 'city').length).toBe(3);
    expect(net.settlements.filter((s) => s.kind === 'village').length).toBeGreaterThan(3000);
    expect(net.roads.some((r) => r.cls === DecalClass.Highway)).toBe(true);
    expect(net.roads.some((r) => r.cls === DecalClass.Canal)).toBe(true);
  });

  test('keeps villages off rivers and floodplains, and out of the airbase', () => {
    for (const s of net.settlements) {
      if (s.kind !== 'village') continue;
      expect(sampler.heightAt(s.x, s.z)).toBeGreaterThan(params.waterLevelM! + 4.5);
      expect(Math.hypot(s.x, s.z)).toBeGreaterThan(2600);
    }
  });

  test('village link roads never cross water', () => {
    for (const r of net.roads) {
      if (r.cls !== DecalClass.Link) continue;
      for (let k = 0; k + 3 < r.pts.length; k += 2) {
        const x = (r.pts[k]! + r.pts[k + 2]!) / 2;
        const z = (r.pts[k + 1]! + r.pts[k + 3]!) / 2;
        expect(sampler.isWaterAt!(x, z)).toBe(false);
      }
    }
  });
});

describe('Punjab chunk scenery', () => {
  const size = 200000 / 32;
  const chunk = (x: number, z: number) => {
    const key = { depth: 5, cx: Math.floor((x + 100000) / size), cz: Math.floor((z + 100000) / size) };
    const g = buildChunkGeometryAndSurface(sampler, key, 24);
    return { g, f: buildChunkFeatures(net, g.bounds, g.surface, { objects: true, treeDensity: 1 }) };
  };

  test('a rural chunk has roads, trees and village houses', () => {
    const { f } = chunk(30000, -30000);
    expect(f.decalIndices.length).toBeGreaterThan(1000);
    expect(f.treeMatrices.reduce((n, m) => n + m.length / 16, 0)).toBeGreaterThan(1000);
    expect(f.buildingMatrices.length / 16).toBeGreaterThan(100);
  });

  test('a city chunk (Jalandhar) is dense with buildings', () => {
    const { f } = chunk(-17390, 11830);
    expect(f.buildingMatrices.length / 16).toBeGreaterThan(10000);
  });

  test('scenery sits on the rendered terrain surface', () => {
    const { g, f } = chunk(30000, -30000);
    const m = f.treeMatrices[0]!;
    for (let i = 0; i < m.length; i += 16 * 50) {
      expect(m[i + 13]!).toBeCloseTo(g.surface(m[i + 12]!, m[i + 14]!), 3);
    }
    const p = f.decalPositions;
    for (let i = 0; i < p.length; i += 3 * 97) {
      expect(p[i + 1]! - g.surface(p[i]!, p[i + 2]!)).toBeGreaterThanOrEqual(0);
    }
  });
});
