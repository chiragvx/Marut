/**
 * tests/ui/airportEditorGameLayout.test.ts — regression coverage for the
 * EditorAirportLayout -> AirportLayout adapter (src/ui/airportEditorGameLayout.ts).
 * Reviewers flagged that exported editor JSON never reconciled field names
 * with contracts/airport.ts's real schema, so nothing built from the editor
 * could actually be flown; this asserts the adapter's output is accepted by
 * the real src/airport loader, not just structurally plausible.
 */
import { describe, it, expect } from 'vitest';
import { toGameAirportLayout } from '../../src/ui/airportEditorGameLayout';
import type { EditorAirportLayout } from '../../src/contracts/ui';
import { loadAirportLayout } from '../../src/airport/validator';

function fixture(): EditorAirportLayout {
  return {
    id: 'test-field',
    name: 'Test Field',
    referenceXM: 0,
    referenceZM: 0,
    elevationM: 10,
    runways: [{ id: 'runway-1', centerXM: 0, centerZM: 0, headingRad: 0, lengthM: 2500, widthM: 45, elevationM: 10 }],
    taxiways: [{ id: 'taxiway-1', widthM: 20, points: [{ xM: 0, zM: 0 }, { xM: 100, zM: 0 }] }],
    aprons: [{ id: 'apron-1', elevationM: 10, points: [{ xM: 0, zM: 200 }, { xM: 80, zM: 200 }, { xM: 80, zM: 260 }, { xM: 0, zM: 260 }] }],
  };
}

describe('toGameAirportLayout', () => {
  it('produces the real AirportLayout field names, not the editor-local ones', () => {
    const game = toGameAirportLayout(fixture());
    expect(game.referenceWorldX).toBe(0);
    expect(game.referenceWorldZ).toBe(0);
    expect(game.parkingSpots).toEqual([]);
    expect(game.taxiways[0]!.points[0]).toEqual({ worldX: 0, worldZ: 0 });
    expect(game.aprons[0]!.points[0]).toEqual({ worldX: 0, worldZ: 200 });
  });

  it('expands one EditorRunway into two reciprocal-linked RunwayDef entries with a threshold lengthM apart', () => {
    const game = toGameAirportLayout(fixture());
    expect(game.runways.length).toBe(2);
    const [a, b] = game.runways as [typeof game.runways[0], typeof game.runways[0]];
    expect(a.reciprocalId).toBe(b.id);
    expect(b.reciprocalId).toBe(a.id);
    expect(a.surface).toBe('asphalt');
    const distM = Math.hypot(a.thresholdWorldX - b.thresholdWorldX, a.thresholdWorldZ - b.thresholdWorldZ);
    expect(distM).toBeCloseTo(2500, 6);
  });

  it('splits ilsPrimary/ilsReciprocal onto each direction\'s own ils field', () => {
    const layout = fixture();
    layout.runways[0]!.ilsPrimary = { frequencyMhz: 110.3, glideslopeAngleRad: 0.05236 };
    layout.runways[0]!.ilsReciprocal = { frequencyMhz: 109.5, glideslopeAngleRad: 0.05236 };
    const game = toGameAirportLayout(layout);
    const primary = game.runways.find((r) => r.headingRad === 0)!;
    const reciprocal = game.runways.find((r) => r.headingRad !== 0)!;
    expect(primary.ils?.frequencyMhz).toBe(110.3);
    expect(reciprocal.ils?.frequencyMhz).toBe(109.5);
  });

  it('round-trips through the REAL game airport loader (src/airport/validator.loadAirportLayout)', () => {
    const game = toGameAirportLayout(fixture());
    const result = loadAirportLayout(game);
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.log('loadAirportLayout rejected the converted editor layout:', JSON.stringify(result.error));
    }
    expect(result.ok).toBe(true);
  });

  it('round-trips through the loader after a JSON.stringify/parse cycle (the shape the editor would actually hand off)', () => {
    const game = toGameAirportLayout(fixture());
    const parsed: unknown = JSON.parse(JSON.stringify(game));
    const result = loadAirportLayout(parsed);
    expect(result.ok).toBe(true);
  });
});
