/**
 * tests/terrain/roadNetwork.test.ts — the procedural Punjab settlements and road network, and the
 * per-chunk scenery built from them.
 */
import { describe, expect, test } from 'vitest';
import { DecalClass, THEATRE_TERRAIN_PARAMS } from '../../src/contracts/terrain';
import { createHeightSampler } from '../../src/terrain';
import { buildRoadNetwork, packSettlementLayer, SETTLEMENT_EDGE_REACH } from '../../src/terrain/roadNetwork';
import { SETTLEMENT_SLOTS } from '../../src/contracts/terrain';
import { buildChunkGeometryAndSurface } from '../../src/terrain/chunkGeometryBuilder';
import { airportClearZones, buildChunkFeatures } from '../../src/terrain/chunkFeatures';
import adampur from '../../src/airport/layouts/adampur-afs.json';

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
    // National highways are drawn as narrow 2-lane roads (State class), as they look from the air.
    expect(net.roads.some((r) => r.cls === DecalClass.State)).toBe(true);
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

  test('towns are small house clusters, not cities (Jalandhar chunk)', () => {
    const { f } = chunk(-17390, 11830);
    const n = f.buildingMatrices.length / 16;
    expect(n).toBeGreaterThan(200);
    expect(n).toBeLessThan(8000);
  });

  test('no trees on or around the airport (Adampur)', () => {
    const zones = airportClearZones(adampur.flattenZones);
    const size2 = 200000 / 32;
    let checked = 0;
    for (const [dx, dz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
      const key = { depth: 5, cx: Math.floor((dx * size2 + 1 + 100000) / size2), cz: Math.floor((dz * size2 + 1 + 100000) / size2) };
      const g = buildChunkGeometryAndSurface(sampler, key, 24);
      const f = buildChunkFeatures(net, g.bounds, g.surface, { objects: true, treeDensity: 1, clearZones: zones });
      for (const m of f.treeMatrices) {
        for (let i = 0; i < m.length; i += 16) {
          checked++;
          for (const zc of zones) expect(Math.hypot(m[i + 12]! - zc.x, m[i + 14]! - zc.z)).toBeGreaterThanOrEqual(zc.radiusM);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
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

describe('settlement layer for the terrain shader', () => {
  const layer = packSettlementLayer(net, params.network!);
  const W = SETTLEMENT_SLOTS * layer.nCells;
  const slotsAt = (i: number, j: number): number[][] => {
    const out: number[][] = [];
    for (let k = 0; k < SETTLEMENT_SLOTS; k++) {
      const o = (j * W + k * layer.nCells + i) * 4;
      if (layer.grid[o + 2]! <= 0) break;
      out.push(Array.from(layer.grid.subarray(o, o + 4)));
    }
    return out;
  };
  const cellOf = (v: number): number => Math.floor((v - layer.originM) / layer.spacingM);

  test('every settlement is found from any point of its disc (bar a few village edges)', () => {
    let missed = 0;
    let checked = 0;
    for (const s of net.settlements) {
      for (let a = 0; a < 8; a++) {
        const r = s.radiusM * SETTLEMENT_EDGE_REACH * 0.999;
        const x = s.x + Math.cos((a * Math.PI) / 4) * r;
        const z = s.z + Math.sin((a * Math.PI) / 4) * r;
        const i = cellOf(x);
        const j = cellOf(z);
        if (i < 0 || j < 0 || i >= layer.nCells || j >= layer.nCells) continue;
        checked++;
        if (!slotsAt(i, j).some((t) => t[0] === Math.fround(s.x) && t[1] === Math.fround(s.z))) {
          missed++;
          // Towns are packed first, so they are never the ones dropped.
          expect(s.kind).toBe('village');
        }
      }
    }
    expect(missed / checked).toBeLessThan(0.001);
  });

  test('is small enough to upload once per mission', () => {
    expect(layer.grid.byteLength).toBeLessThan(2_000_000);
  });
});
