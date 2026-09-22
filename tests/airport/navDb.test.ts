import { describe, expect, it } from 'vitest';
import { createAirportNavDb } from '../../src/airport/navDb';
import { parseAirportLayout } from '../../src/airport/parser';
import rangpurJson from '../../src/airport/layouts/rangpur-afb.json';
import konarakJson from '../../src/airport/layouts/konarak-coastal.json';

function mustParse(json: unknown) {
  const r = parseAirportLayout(json);
  if (!r.ok) throw new Error(`failed to parse fixture: ${JSON.stringify(r.error)}`);
  return r.value;
}

describe('createAirportNavDb', () => {
  const rangpur = mustParse(rangpurJson);
  const konarak = mustParse(konarakJson);

  it('serves listAirports/getRunway/nearestAirport/nearestRunway over both built-in layouts', () => {
    const db = createAirportNavDb([rangpur, konarak]);
    expect(db.listAirports().length).toBe(2);
    expect(Math.abs(db.getRunway('rangpur-afb', '06')!.headingRad - 1.0471976)).toBeLessThan(1e-6);
    expect(db.nearestAirport({ x: 0, y: 0, z: 0 })!.id).toBe('rangpur-afb');
    expect(db.nearestRunway({ x: 10, y: 0, z: -10 })!.runway.id).toBe('06');
  });

  it('throws on a duplicate airport id', () => {
    expect(() => createAirportNavDb([rangpur, rangpur])).toThrow();
  });

  it('approachFixes("rangpur-afb","06") returns FAF then IAF at the expected positions/altitudes', () => {
    const db = createAirportNavDb([rangpur, konarak]);
    const fixes = db.approachFixes('rangpur-afb', '06');
    expect(fixes.length).toBe(2);
    expect(fixes[0]?.name).toBe('RW06-FAF');
    expect(Math.abs(fixes[0]!.altitudeM - 1070)).toBeLessThan(1);
    expect(Math.abs(fixes[0]!.pos.x - -7436.1)).toBeLessThan(1);
    expect(fixes[1]?.name).toBe('RW06-IAF');
    expect(Math.abs(fixes[1]!.altitudeM - 1520)).toBeLessThan(1);
  });

  it('approachFixes returns [] for an unknown runway id', () => {
    const db = createAirportNavDb([rangpur, konarak]);
    expect(db.approachFixes('rangpur-afb', 'doesnotexist')).toEqual([]);
  });

  it('every RunwayInfo has ils defined exactly for the runway ids that declared it in source JSON', () => {
    const db = createAirportNavDb([rangpur, konarak]);
    const withIls = new Set(['06', '09L', '09R']);
    const withoutIls = new Set(['24', '27L', '27R']);
    for (const airport of db.listAirports()) {
      for (const runway of airport.runways) {
        if (withIls.has(runway.id)) expect(runway.ils).toBeDefined();
        if (withoutIls.has(runway.id)) expect(runway.ils).toBeUndefined();
      }
    }
  });
});
