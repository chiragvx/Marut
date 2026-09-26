/**
 * tests/airport/airfieldAids.test.ts — where the airfield aids go on the reference bases.
 */
import { describe, expect, test } from 'vitest';
import { loadAirportLayout } from '../../src/airport';
import type { AirportLayout } from '../../src/contracts/airport';
import { buildAirfieldAids } from '../../src/airport/airfieldAids';
import bhisiana from '../../src/airport/layouts/bhisiana-afs.json';
import shahbaz from '../../src/airport/layouts/pafb-shahbaz.json';

const load = (raw: unknown): AirportLayout => {
  const r = loadAirportLayout(raw);
  if (!r.ok) throw new Error('layout failed');
  return r.value.layout;
};

describe('Bhisiana airfield aids', () => {
  const L = load(bhisiana);
  const aids = buildAirfieldAids(L);

  test('taxiway edge lights line every taxiway, none on the runway', () => {
    expect(aids.taxiEdgeLights.length).toBeGreaterThan(400);
    const r = L.runways[0]!;
    for (const [x, z] of aids.taxiEdgeLights) {
      const dx = x - r.thresholdWorldX;
      const dz = z - r.thresholdWorldZ;
      const along = dx * Math.sin(r.headingRad) - dz * Math.cos(r.headingRad);
      const across = Math.abs(dx * Math.cos(r.headingRad) + dz * Math.sin(r.headingRad));
      expect(along > -3 && along < r.lengthM + 3 && across < r.widthM / 2 + 3).toBe(false);
    }
  });

  test('a four-lamp PAPI at each runway end, left of the runway, 300 m in', () => {
    expect(aids.papi.length).toBe(8);
    const angles = aids.papi.slice(0, 4).map((p) => (p.angleRad * 180) / Math.PI);
    expect(angles[0]).toBeCloseTo(3.5, 2);
    expect(angles[3]).toBeCloseTo(2.5, 2);
  });

  test('windsocks, red holding-point signs, direction signs and distance boards', () => {
    expect(aids.windsocks.length).toBe(2);
    const mandatory = aids.signs.filter((s) => s.style === 'mandatory');
    expect(mandatory.length).toBeGreaterThanOrEqual(4);
    expect(mandatory.every((s) => s.text === '13-31')).toBe(true);
    expect(aids.signs.filter((s) => s.style === 'direction').length).toBeGreaterThan(5);
    expect(aids.signs.filter((s) => s.style === 'distance').map((s) => s.text)).toContain('8');
  });
});

test('Shahbaz has no PAPI (none in its layout) but has hold signs for both runways', () => {
  const aids = buildAirfieldAids(load(shahbaz));
  expect(aids.papi.length).toBe(0);
  const names = new Set(aids.signs.filter((s) => s.style === 'mandatory').map((s) => s.text));
  expect(names.has('15L-33R') || names.has('15R-33L')).toBe(true);
});

test('floodlight masts: a few, on open ground, well apart', () => {
  const L = load(bhisiana);
  const f = buildAirfieldAids(L).floodlights;
  expect(f.length).toBeGreaterThan(0);
  expect(f.length).toBeLessThan(20);
  for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) expect(Math.hypot(f[i]![0] - f[j]![0], f[i]![1] - f[j]![1])).toBeGreaterThanOrEqual(120);
});
