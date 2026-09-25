/**
 * tests/terrain/goaScenery.test.ts — the Goa (Konkan) towns, roads and per-chunk scenery: gabled
 * houses, churches, coconut palms and forest, kept out of the sea and the estuaries.
 */
import { describe, expect, test } from 'vitest';
import { THEATRE_TERRAIN_PARAMS, TreeKind } from '../../src/contracts/terrain';
import { createHeightSampler } from '../../src/terrain';
import { buildRoadNetwork } from '../../src/terrain/roadNetwork';
import { buildChunkGeometryAndSurface } from '../../src/terrain/chunkGeometryBuilder';
import { buildChunkFeatures } from '../../src/terrain/chunkFeatures';
import { ESTUARY_FLOATS, estuaryField, shoreAt } from '../../src/terrain/coastMath';

const params = { ...THEATRE_TERRAIN_PARAMS.konkan, seed: 3141592 };
const sampler = createHeightSampler(params, []);
const net = buildRoadNetwork(params, sampler)!;

describe('Goa network', () => {
  test('is Goa-styled, with the coast data, named towns and villages', () => {
    expect(net.style).toBe('goa');
    expect(net.coast).toBeDefined();
    expect(net.coast!.count).toBeGreaterThan(0);
    expect(net.settlements.filter((s) => s.kind !== 'village').length).toBeGreaterThanOrEqual(10);
    expect(net.settlements.filter((s) => s.kind === 'village').length).toBeGreaterThan(50);
  });
});

describe('Goa chunk scenery', () => {
  const size = 200000 / 32;
  const chunk = (x: number, z: number) => {
    const key = { depth: 5, cx: Math.floor((x + 100000) / size), cz: Math.floor((z + 100000) / size) };
    const g = buildChunkGeometryAndSurface(sampler, key, 24);
    return buildChunkFeatures(net, g.bounds, g.surface, { objects: true, treeDensity: 1 });
  };

  test('a town chunk (Panaji) has gabled houses and palms', () => {
    const f = chunk(51000, -18300);
    expect(f.houseMatrices.length / 16).toBeGreaterThan(300);
    expect(f.houseColors.length / 3).toBe(f.houseMatrices.length / 16);
    expect(f.treeMatrices[TreeKind.Palm]!.length / 16).toBeGreaterThan(300);
  });

  test('no tree or house stands in the sea or an estuary', () => {
    const shore = { x: 0, headland: 0 };
    let checked = 0;
    for (const [x, z] of [[46500, -29000], [51000, -18300], [47000, 12500]] as const) {
      const f = chunk(x, z);
      for (const m of [...f.treeMatrices, f.houseMatrices]) {
        for (let i = 0; i < m.length; i += 16) {
          const px = m[i + 12]!;
          const pz = m[i + 14]!;
          shoreAt(net.coast!.table, pz, shore);
          expect(px - shore.x).toBeGreaterThan(0);
          for (let e = 0; e < net.coast!.count; e++) expect(estuaryField(net.coast!.estuaries, e * ESTUARY_FLOATS, px, pz)).toBeLessThan(0);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
