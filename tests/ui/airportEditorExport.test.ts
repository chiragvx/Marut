import { describe, it, expect } from 'vitest';
import { exportEditorLayout, importEditorLayout } from '../../src/ui/airportEditorExport';
import { runwayDesignator } from '../../src/ui/airportEditorGeometry';
import type { EditorAirportLayout } from '../../src/contracts/ui';

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

describe('ExportEditorLayout / ImportEditorLayout', () => {
  it('has formatVersion 1', () => {
    const parsed = JSON.parse(exportEditorLayout(fixture()));
    expect(parsed.formatVersion).toBe(1);
  });

  it('runway primaryDesignator matches RunwayDesignator', () => {
    const layout = fixture();
    const parsed = JSON.parse(exportEditorLayout(layout));
    expect(parsed.runways[0].primaryDesignator).toBe(runwayDesignator(layout.runways[0]!.headingRad));
    expect(parsed.runways[0].primaryDesignator).toBe('36');
  });

  it('flattenZones has one entry per runway plus apron', () => {
    const layout = fixture();
    const parsed = JSON.parse(exportEditorLayout(layout));
    expect(parsed.flattenZones.length).toBe(layout.runways.length + layout.aprons.length);
    expect(parsed.flattenZones.length).toBe(2);
  });

  it('round-trips through import', () => {
    const layout = fixture();
    const result = importEditorLayout(exportEditorLayout(layout));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(layout.id);
      expect(result.value.runways.length).toBe(1);
      expect('primaryDesignator' in result.value.runways[0]!).toBe(false);
      expect('flattenZones' in result.value).toBe(false);
    }
  });

  it('rejects invalid JSON', () => {
    expect(importEditorLayout('{not valid json').ok).toBe(false);
  });

  it('rejects an unsupported formatVersion', () => {
    const parsed = JSON.parse(exportEditorLayout(fixture()));
    const result = importEditorLayout(JSON.stringify({ ...parsed, formatVersion: 99 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('formatVersion');
  });

  it('round-trips a runway with both ILS ends, one taxiway and one apron', () => {
    const layout = fixture();
    layout.runways[0]!.ilsPrimary = { frequencyMhz: 110.3, glideslopeAngleRad: 0.05236 };
    layout.runways[0]!.ilsReciprocal = { frequencyMhz: 109.5, glideslopeAngleRad: 0.05236 };
    const result = importEditorLayout(exportEditorLayout(layout));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(layout);
    }
  });
});
