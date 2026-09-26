/**
 * tests/terrain/urbanLayer.test.ts — Goa's urban layer (urbanField.ts, urbanMath.ts,
 * urbanBuildings.ts): the baked field, the shared street/lot maths, and the 3D buildings the
 * terrain worker places, which must stand exactly where the ground shader draws buildings.
 */
import { describe, expect, test } from 'vitest';
import { THEATRE_TERRAIN_PARAMS } from '../../src/contracts/terrain';
import { createHeightSampler } from '../../src/terrain';
import { buildRoadNetwork } from '../../src/terrain/roadNetwork';
import { forEachUrbanBuilding, type UrbanBuilding } from '../../src/terrain/urbanBuildings';
import { newUrbanPixel, sampleUrban, uh, unwarp, urbanMean, urbanPixel, warpX, warpZ } from '../../src/terrain/urbanMath';
import { ESTUARY_FLOATS, estuaryField, shoreAt } from '../../src/terrain/coastMath';

const params = { ...THEATRE_TERRAIN_PARAMS.konkan, seed: 3141592 };
const sampler = createHeightSampler(params, []);
const net = buildRoadNetwork(params, sampler)!;
const L = net.urban!;
const smp = new Float64Array(5);
const U = (x: number, z: number): number => {
  sampleUrban(L, x, z, smp);
  return smp[0]!;
};

const collect = (x0: number, z0: number, size: number): UrbanBuilding[] => {
  const out: UrbanBuilding[] = [];
  forEachUrbanBuilding(L, x0, z0, x0 + size, z0 + size, () => false, (b) => out.push({ ...b }));
  return out;
};

describe('urban maths', () => {
  test('the integer hash is deterministic, in [0, 1) and well spread', () => {
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      const h = uh(1024 + (i % 97), 2048 + Math.floor(i / 97), 5, 12345);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      sum += h;
    }
    expect(sum / 20000).toBeCloseTo(0.5, 1);
    expect(uh(1100, 1200, 3, 7)).toBe(uh(1100, 1200, 3, 7));
    expect(uh(1100, 1200, 3, 7)).not.toBe(uh(1100, 1200, 3, 8));
  });

  test('unwarp inverts the street warp to within a centimetre', () => {
    const w = { x: 0, z: 0 };
    for (let i = 0; i < 200; i++) {
      const x = 30000 + i * 311.7;
      const z = -60000 + i * 577.3;
      unwarp(x + warpX(x, z), z + warpZ(x, z), w);
      expect(Math.hypot(w.x - x, w.z - z)).toBeLessThan(0.01);
    }
  });
});

describe('urban field (Goa)', () => {
  test('dense town centres, empty sea and airfield', () => {
    expect(U(45300, -4300)).toBeGreaterThan(0.8); // Vasco
    expect(U(64950, 10000)).toBeGreaterThan(0.8); // Margao
    expect(U(51000, -18300)).toBeGreaterThan(0.8); // Panaji
    expect(U(38000, 0)).toBe(0); // Arabian Sea
    expect(U(48350, -900)).toBe(0); // INS Hansa runway
  });

  test('the countryside has scattered hamlets, not one uniform spread', () => {
    let hi = 0;
    let lo = 0;
    for (let z = 20000; z < 34000; z += 250) {
      for (let x = 50000; x < 62000; x += 250) {
        const u = U(x, z);
        if (u > 0.2) hi++;
        else if (u < 0.1) lo++;
      }
    }
    expect(hi).toBeGreaterThan(100);
    expect(lo).toBeGreaterThan(hi);
  });
});

describe('urban buildings', () => {
  const vasco = collect(43750, -9375, 6250);

  test('a town chunk (Vasco) has thousands of buildings, flat-roofed and tiled', () => {
    expect(vasco.length).toBeGreaterThan(5000);
    const flat = vasco.filter((b) => b.flat).length;
    expect(flat).toBeGreaterThan(vasco.length * 0.2);
    expect(flat).toBeLessThan(vasco.length * 0.8);
  });

  test('every 3D building stands where the ground shader draws a building, never on a street', () => {
    const px = newUrbanPixel();
    for (const b of vasco) {
      urbanPixel(L, b.x, b.z, 0, px);
      expect(px.building).toBe(true);
      expect(px.street).toBe(false);
    }
  });

  test('no building in the sea, an estuary, or on the airfield', () => {
    const shore = { x: 0, headland: 0 };
    const all = [...vasco, ...collect(43750, -3125, 6250), ...collect(45000, 10000, 6250)];
    expect(all.length).toBeGreaterThan(5000);
    for (const b of all) {
      shoreAt(net.coast!.table, b.z, shore);
      expect(b.x - shore.x).toBeGreaterThan(50);
      for (let e = 0; e < net.coast!.count; e++) expect(estuaryField(net.coast!.estuaries, e * ESTUARY_FLOATS, b.x, b.z)).toBeLessThan(0);
      // INS Hansa: the runway strip (heading 080) and its aprons.
      const dx = b.x - 48371;
      const dz = b.z + 777;
      const along = Math.abs(dx * Math.cos(-0.1745) + dz * Math.sin(-0.1745));
      const across = Math.abs(-dx * Math.sin(-0.1745) + dz * Math.cos(-0.1745));
      expect(along < 2000 && across < 500).toBe(false);
    }
  });

  test('the same buildings come out whichever chunk asks (no seams)', () => {
    const whole = collect(44000, -6000, 2000).length;
    const parts = collect(44000, -6000, 1000).length + collect(45000, -6000, 1000).length + collect(44000, -5000, 1000).length + collect(45000, -5000, 1000).length;
    expect(parts).toBe(whole);
  });
});

describe('far view', () => {
  test("the expected cover (urbanMean) matches the drawn streets and roofs", () => {
    const px = newUrbanPixel();
    const m = new Float64Array(4);
    for (const [x, z] of [[45300, -4300], [48900, -4000], [55000, 12000]] as const) {
      let roof = 0;
      let st = 0;
      let us = 0;
      const n = 120;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          urbanPixel(L, x - 300 + i * 5 + 1.3, z - 300 + j * 5 + 2.1, 0, px);
          us += px.U;
          if (px.building) roof++;
          else if (px.street) st++;
        }
      }
      urbanMean(us / (n * n), m);
      expect(Math.abs(m[0]! - roof / (n * n))).toBeLessThan(0.15);
      expect(Math.abs(m[1]! - st / (n * n))).toBeLessThan(0.08);
    }
  });
});
