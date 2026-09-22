/**
 * Adversarial-review probe (not part of the delivered suite): does JSON
 * produced by src/ui's airport editor (`exportEditorLayout`) actually load
 * through the real game airport loader (`src/airport`'s `loadAirportLayout`)?
 * This is the check the review task asked for explicitly: "confirm ... the
 * airport editor exports valid JSON that the loader accepts".
 */
import { describe, it, expect } from 'vitest';
import { exportEditorLayout } from '../../src/ui/airportEditorExport';
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

describe('airport editor export -> real airport loader', () => {
  it('the JSON produced by exportEditorLayout is accepted by loadAirportLayout', () => {
    const exported = exportEditorLayout(fixture());
    const parsed: unknown = JSON.parse(exported);
    const result = loadAirportLayout(parsed);
    // eslint-disable-next-line no-console
    if (!result.ok) console.log('loadAirportLayout rejected editor export:', JSON.stringify(result.error));
    expect(result.ok).toBe(true);
  });
});
