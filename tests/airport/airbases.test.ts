/**
 * tests/airport/airbases.test.ts — the two reference airbases (built from OpenStreetMap by
 * tools/airbases/osm_to_layout.py) load, validate and hang together.
 */
import { describe, expect, test } from 'vitest';
import { loadAirportLayout } from '../../src/airport';
import type { AirportLayout } from '../../src/contracts/airport';
import bhisiana from '../../src/airport/layouts/bhisiana-afs.json';
import shahbaz from '../../src/airport/layouts/pafb-shahbaz.json';

function load(raw: unknown): AirportLayout {
  const r = loadAirportLayout(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.error.slice(0, 5)));
  return r.value.layout;
}

const BASES: [string, unknown, 'friendly' | 'hostile', number][] = [
  ['Bhisiana (Bathinda)', bhisiana, 'friendly', 23],
  ['Shahbaz (Jacobabad)', shahbaz, 'hostile', 38],
];

describe.each(BASES)('%s', (_name, raw, side, shelterCount) => {
  const L = load(raw);

  test('loads and validates, with its side and attribution', () => {
    expect(L.side).toBe(side);
    expect(L.attribution).toMatch(/OpenStreetMap/);
  });

  test('has its hardened shelters, each with a parking spot inside and a pad at the door', () => {
    const shelters = (L.structures ?? []).filter((s) => s.kind === 'shelter');
    expect(shelters.length).toBe(shelterCount);
    for (const s of shelters) {
      const spot = L.parkingSpots.find((p) => Math.hypot(p.worldX - s.worldX, p.worldZ - s.worldZ) < 1);
      expect(spot).toBeDefined();
      expect(spot!.headingRad).toBeCloseTo(s.headingRad, 4);
    }
    expect(L.aprons.filter((a) => a.kind === 'shelter_pad').length).toBe(shelterCount);
  });

  test('has the generic facilities: fuel depot, magazines, control tower, radar', () => {
    const kinds = new Set((L.structures ?? []).map((s) => s.kind));
    for (const k of ['fuel_tank', 'fuel_bund', 'magazine', 'control_tower', 'radar'] as const) expect(kinds.has(k)).toBe(true);
  });

  test('every shelter door is within reach of the taxi network', () => {
    const pts = L.taxiways.flatMap((t) => t.points);
    for (const s of (L.structures ?? []).filter((x) => x.kind === 'shelter')) {
      const dx = s.worldX + Math.sin(s.headingRad) * (s.lengthM / 2 + 25);
      const dz = s.worldZ - Math.cos(s.headingRad) * (s.lengthM / 2 + 25);
      const d = Math.min(...pts.map((p) => Math.hypot(p.worldX - dx, p.worldZ - dz)));
      expect(d).toBeLessThan(60);
    }
  });

  test('everything sits inside the flattened ground', () => {
    const z = L.flattenZones[0]!;
    for (const s of L.structures ?? []) expect(Math.hypot(s.worldX - z.centerWorldX, s.worldZ - z.centerWorldZ)).toBeLessThan(z.flatRadiusM);
    for (const t of L.taxiways) for (const p of t.points) expect(Math.hypot(p.worldX - z.centerWorldX, p.worldZ - z.centerWorldZ)).toBeLessThan(z.flatRadiusM);
  });
});

test('the two bases are under 70 km apart', () => {
  const a = load(bhisiana).flattenZones[0]!;
  const b = load(shahbaz).flattenZones[0]!;
  const d = Math.hypot(a.centerWorldX - b.centerWorldX, a.centerWorldZ - b.centerWorldZ);
  expect(d).toBeLessThan(70000);
  expect(d).toBeGreaterThan(40000);
});
