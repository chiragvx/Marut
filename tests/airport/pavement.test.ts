/**
 * tests/airport/pavement.test.ts — the airfield pavement mesh and ground mask.
 */
import { describe, expect, test } from 'vitest';
import { loadAirportLayout } from '../../src/airport';
import type { AirportLayout } from '../../src/contracts/airport';
import { PavementKind, buildPavementGeometry, designatorCode, smoothTaxiway, triangulate } from '../../src/airport/pavementGeometry';
import { AIRFIELD_MASK_SIZE, buildAirfieldMask } from '../../src/airport/airfieldMask';
import bhisiana from '../../src/airport/layouts/bhisiana-afs.json';
import shahbaz from '../../src/airport/layouts/pafb-shahbaz.json';

const load = (raw: unknown): AirportLayout => {
  const r = loadAirportLayout(raw);
  if (!r.ok) throw new Error('layout failed');
  return r.value.layout;
};

describe('pavement geometry', () => {
  test('designator codes', () => {
    expect(designatorCode('13')).toBe(130);
    expect(designatorCode('15R')).toBe(152);
    expect(designatorCode('33L')).toBe(331);
    expect(designatorCode('09C')).toBe(93);
  });

  test('triangulates a concave polygon with the right area, either winding', () => {
    const L: [number, number][] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
    for (const pts of [L, [...L].reverse()]) {
      const t = triangulate(pts);
      expect(t.length).toBe((pts.length - 2) * 3);
      let area = 0;
      for (let i = 0; i < t.length; i += 3) {
        const [a, b, c] = [pts[t[i]!]!, pts[t[i + 1]!]!, pts[t[i + 2]!]!];
        area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      }
      expect(area).toBeCloseTo(64, 6);
    }
  });

  test('both bases: runways drawn once each, last; every surface kind present', () => {
    const g = buildPavementGeometry([load(bhisiana), load(shahbaz)]);
    const kinds = new Set<number>();
    for (let i = 0; i < g.surf.length; i += 4) kinds.add(g.surf[i]!);
    for (const k of Object.values(PavementKind)) expect(kinds.has(k)).toBe(true);
    // 3 physical runways x 4 corners, each base's runways drawn after its other surfaces.
    const n = g.positions.length / 3;
    const rwy: number[] = [];
    for (let v = 0; v < n; v++) if (g.surf[v * 4] === PavementKind.Runway) rwy.push(v);
    const S = load(shahbaz);
    const pieces = (len: number): number => 2 * (Math.ceil(len / 80) + 1);
    expect(rwy.length).toBe(pieces(2739.39) + S.runways.filter((r) => r.id.startsWith('15')).reduce((n, r) => n + pieces(r.lengthM), 0));
    const single = buildPavementGeometry([S]);
    const ns = single.positions.length / 3;
    const nr = S.runways.filter((r) => r.id.startsWith('15')).reduce((n, r) => n + pieces(r.lengthM), 0);
    for (let v = ns - nr; v < ns; v++) expect(single.surf[v * 4]).toBe(PavementKind.Runway);
    expect(g.indices.length % 3).toBe(0);
    expect(g.indices.reduce((m, v) => Math.max(m, v), 0)).toBeLessThan(n);
    const codes = new Set<number>();
    for (const v of rwy) codes.add(g.extra[v * 4 + 2]!).add(g.extra[v * 4 + 3]!);
    expect([...codes].sort()).toEqual([130, 151, 152, 310, 331, 332]);
  });
});

test('runways and taxiways are cut into short pieces so they follow the curved ground', () => {
  const g = buildPavementGeometry([load(bhisiana)]);
  for (let t = 0; t < g.indices.length; t += 3) {
    const k = g.surf[g.indices[t]! * 4]!;
    if (k !== PavementKind.Runway && k !== PavementKind.Taxiway) continue;
    for (let e = 0; e < 3; e++) {
      const a = g.indices[t + e]!;
      const b = g.indices[t + ((e + 1) % 3)]!;
      const d = Math.hypot(g.positions[a * 3]! - g.positions[b * 3]!, g.positions[a * 3 + 2]! - g.positions[b * 3 + 2]!);
      expect(d).toBeLessThan(100);
    }
  }
});

test('taxiway bends are rounded into arcs; ends and junctions stay where they are', () => {
  const pts = [{ worldX: 0, worldZ: 0 }, { worldX: 200, worldZ: 0 }, { worldX: 200, worldZ: 200 }, { worldX: 400, worldZ: 200 }];
  const junction = (x: number, z: number, end: boolean): boolean => end || (x === 200 && z === 200);
  const out = smoothTaxiway(pts, junction);
  expect(out[0]).toEqual([0, 0]);
  expect(out[out.length - 1]).toEqual([400, 200]);
  expect(out.some(([x, z]) => x === 200 && z === 200)).toBe(true); // the junction is kept
  expect(out.some(([x, z]) => x === 200 && z === 0)).toBe(false); // the free corner is rounded
  // No step turns more than ~7 degrees, and none of the arc strays far from the corner's legs.
  for (let i = 1; i + 1 < out.length; i++) {
    const [ax, az] = out[i - 1]!;
    const [bx, bz] = out[i]!;
    const [cx, cz] = out[i + 1]!;
    if (bx === 200 && bz === 200) continue;
    const t = Math.acos(Math.min(1, ((bx - ax) * (cx - bx) + (bz - az) * (cz - bz)) / (Math.hypot(bx - ax, bz - az) * Math.hypot(cx - bx, cz - bz))));
    expect(t).toBeLessThan((7.5 * Math.PI) / 180);
  }
});

describe('airfield ground mask', () => {
  test('is airfield on and around the pavement and not far outside it', () => {
    const L = load(bhisiana);
    const m = buildAirfieldMask(L);
    const N = AIRFIELD_MASK_SIZE;
    const at = (x: number, z: number): [number, number] => {
      const i = Math.floor(((x - m.minX) / m.sizeM) * N);
      const j = Math.floor(((z - m.minZ) / m.sizeM) * N);
      return [m.data[(j * N + i) * 2]!, m.data[(j * N + i) * 2 + 1]!];
    };
    const r = L.runways[0]!;
    expect(at(r.thresholdWorldX + Math.sin(r.headingRad) * 500, r.thresholdWorldZ - Math.cos(r.headingRad) * 500)).toEqual([255, 0]);
    const z = L.flattenZones[0]!;
    expect(at(m.minX + 5, m.minZ + 5)[0]).toBe(0);
    expect(at(z.centerWorldX, z.centerWorldZ)[0]).toBeGreaterThan(200);
  });
});
