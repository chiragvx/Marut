/**
 * tests/airport/taxiGraph.test.ts — taxi networks and routes on the reference bases.
 */
import { describe, expect, test } from 'vitest';
import { loadAirportLayout } from '../../src/airport';
import type { AirportLayout } from '../../src/contracts/airport';
import { activeRunway, buildTaxiGraph, routeToRunway, routeToStand } from '../../src/airport/taxiGraph';
import bhisiana from '../../src/airport/layouts/bhisiana-afs.json';
import shahbaz from '../../src/airport/layouts/pafb-shahbaz.json';

const load = (raw: unknown): AirportLayout => {
  const r = loadAirportLayout(raw);
  if (!r.ok) throw new Error('layout failed');
  return r.value.layout;
};

describe.each([
  ['Bhisiana', bhisiana],
  ['Shahbaz', shahbaz],
])('%s taxi network', (_n, raw) => {
  const L = load(raw);
  const g = buildTaxiGraph(L);

  test('every stand is in the graph and the runways have entries', () => {
    expect(g.stands.length).toBe(L.parkingSpots.length);
    for (const r of L.runways) expect(g.entries.some((e) => e.runwayId === r.id)).toBe(true);
  });

  test('from every stand there is a route to each runway direction, with a holding point', () => {
    for (const s of g.stands) {
      const [x, z] = g.nodes[s.node]!;
      for (const r of L.runways) {
        const route = routeToRunway(g, L, x, z, r.id);
        expect(route, `stand ${s.spotId} -> ${r.id}`).toBeDefined();
        expect(route!.holdIndex).toBeGreaterThanOrEqual(0); // 0: a stand already inside the holding distance
        // The route is continuous: no jump longer than a runway (the longest straight edge).
        for (let i = 1; i < route!.points.length; i++) {
          const [ax, az] = route!.points[i - 1]!;
          const [bx, bz] = route!.points[i]!;
          expect(Math.hypot(bx - ax, bz - az)).toBeLessThan(3100);
        }
      }
    }
  });

  test('from a runway entry the nearest stand is reachable', () => {
    const e = g.entries[0]!;
    const [x, z] = g.nodes[e.node]!;
    const route = routeToStand(g, x, z);
    expect(route).toBeDefined();
    expect(route!.standNumber).toBeGreaterThan(0);
  });
});

test('the active runway is the one into the wind', () => {
  const L = load(bhisiana);
  // Runway 31 heads 311 deg (north-west): a wind FROM the north-west (blowing to the south-east) favours it.
  const h = (311 * Math.PI) / 180;
  expect(activeRunway(L, { x: -Math.sin(h) * 5, z: Math.cos(h) * 5 })).toBe('31');
  expect(activeRunway(L, { x: Math.sin(h) * 5, z: -Math.cos(h) * 5 })).toBe('13');
});
