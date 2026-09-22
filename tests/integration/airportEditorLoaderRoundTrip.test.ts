/**
 * Adversarial-review probe (not part of the delivered suite): does JSON
 * produced by src/ui's airport editor (`exportEditorLayout`) end up, through
 * the app's real code paths, loadable by the game airport loader
 * (`src/airport`'s `loadAirportLayout`)?
 *
 * `exportEditorLayout`'s JSON is the editor's own save/share file format
 * (`EditorAirportLayoutExport` in contracts/ui.ts — centerXM/centerZM,
 * xM/zM, no `surface`, no `parkingSpots`, ...). It is NOT the same schema as
 * `contracts/airport.ts`'s `AirportLayout` that `loadAirportLayout` parses
 * (thresholdWorldX/thresholdWorldZ, worldX/worldZ, required `surface`,
 * required `parkingSpots`, ...) — contracts/ui.ts section 5 and 11-ui.md
 * section 9 both flag this as a known, deliberate gap, reconciled by a
 * dedicated integration-time adapter rather than by the export format
 * itself. That adapter is `toGameAirportLayout`
 * (src/ui/airportEditorGameLayout.ts), which is exactly what the real
 * "Test Fly" flow (src/main.ts) runs an editor layout through before
 * handing it to the game loader.
 *
 * So the real, end-to-end version of "the airport editor exports valid JSON
 * that the loader accepts" is: export -> import back into the editor's own
 * shape -> run the documented adapter -> load. That is what this probes.
 */
import { describe, it, expect } from 'vitest';
import { exportEditorLayout, importEditorLayout } from '../../src/ui/airportEditorExport';
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

describe('airport editor export -> real airport loader', () => {
  it('the JSON produced by exportEditorLayout, imported and adapted via toGameAirportLayout, is accepted by loadAirportLayout', () => {
    const exported = exportEditorLayout(fixture());

    const imported = importEditorLayout(exported);
    // eslint-disable-next-line no-console
    if (!imported.ok) console.log('importEditorLayout rejected editor export:', imported.error);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    const game = toGameAirportLayout(imported.value);
    const result = loadAirportLayout(game);
    // eslint-disable-next-line no-console
    if (!result.ok) console.log('loadAirportLayout rejected the adapted editor export:', JSON.stringify(result.error));
    expect(result.ok).toBe(true);
  });
});
