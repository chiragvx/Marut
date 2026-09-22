/**
 * tests/airport/layouts.test.ts — mechanically re-checks that both built-in
 * layouts (05-airport.md sections 5.3/5.4) satisfy every validator rule as
 * authored, and that loadAirportLayout + createAirportNavDb work over both
 * combined without throwing (05-airport.md section 8 acceptance criteria
 * 3/4).
 */

import { describe, expect, it } from 'vitest';
import { loadAirportLayout } from '../../src/airport/validator';
import { createAirportNavDb } from '../../src/airport/navDb';
import { generateAirportRenderGeometry } from '../../src/airport/renderGeometry';
import { createAirportSurfaceIndex } from '../../src/airport/surfaceIndex';
import { BUILTIN_AIRPORT_LAYOUT_PATHS } from '../../src/contracts/airport';
import rangpurJson from '../../src/airport/layouts/rangpur-afb.json';
import konarakJson from '../../src/airport/layouts/konarak-coastal.json';

describe('built-in airport layouts', () => {
  it('BUILTIN_AIRPORT_LAYOUT_PATHS matches the two files this module owns', () => {
    expect(BUILTIN_AIRPORT_LAYOUT_PATHS).toEqual([
      'src/airport/layouts/rangpur-afb.json',
      'src/airport/layouts/konarak-coastal.json',
    ]);
  });

  it('rangpur-afb.json loads with zero errors and zero warnings', () => {
    const result = loadAirportLayout(rangpurJson);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.warnings.length).toBe(0);
    expect(result.value.layout.id).toBe('rangpur-afb');
  });

  it('konarak-coastal.json loads with zero errors and zero warnings', () => {
    const result = loadAirportLayout(konarakJson);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.warnings.length).toBe(0);
    expect(result.value.layout.id).toBe('konarak-coastal');
  });

  it('createAirportNavDb, generateAirportRenderGeometry and createAirportSurfaceIndex run over both layouts without throwing', () => {
    const a = loadAirportLayout(rangpurJson);
    const b = loadAirportLayout(konarakJson);
    if (!a.ok || !b.ok) throw new Error('fixtures failed to load');

    const db = createAirportNavDb([a.value.layout, b.value.layout]);
    expect(db.listAirports().length).toBe(2);

    for (const layout of [a.value.layout, b.value.layout]) {
      const geo = generateAirportRenderGeometry(layout);
      expect(geo.runways.length).toBe(layout.runways.length);
      expect(geo.taxiways.length).toBe(layout.taxiways.length);
      expect(geo.aprons.length).toBe(layout.aprons.length);

      const surfaceIndex = createAirportSurfaceIndex(layout);
      for (const runway of layout.runways) {
        const midX = runway.thresholdWorldX + Math.sin(runway.headingRad) * (runway.lengthM / 2);
        const midZ = runway.thresholdWorldZ - Math.cos(runway.headingRad) * (runway.lengthM / 2);
        expect(surfaceIndex.frictionAt(midX, midZ)?.kind).toBe('paved_runway');
      }
    }
  });
});
