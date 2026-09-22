import { describe, it, expect } from 'vitest';
import { validateEditorLayout } from '../../src/ui/airportEditorValidate';
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

describe('validateEditorLayout', () => {
  it('returns no issues for the fixture layout', () => {
    expect(validateEditorLayout(fixture()).length).toBe(0);
  });

  it('flags an undersized runway length', () => {
    const layout = fixture();
    layout.runways[0]!.lengthM = 400;
    const issues = validateEditorLayout(layout);
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toContain('length');
  });

  it('flags overlapping runways', () => {
    const layout = fixture();
    layout.runways = [...layout.runways, { id: 'runway-2', centerXM: 0, centerZM: 0, headingRad: 0, lengthM: 2500, widthM: 45, elevationM: 10 }];
    const issues = validateEditorLayout(layout);
    const overlap = issues.find((i) => i.severity === 'error' && i.featureType === 'runway' && i.message.includes('overlap'));
    expect(overlap).toBeDefined();
  });

  it('warns on an undersized apron', () => {
    const layout = fixture();
    layout.aprons[0]!.points = [{ xM: 0, zM: 0 }, { xM: 2, zM: 0 }, { xM: 2, zM: 2 }, { xM: 0, zM: 2 }];
    const issues = validateEditorLayout(layout);
    const warning = issues.find((i) => i.severity === 'warning' && i.message.includes('area'));
    expect(warning).toBeDefined();
  });

  it('flags an out-of-range ILS frequency', () => {
    const layout = fixture();
    layout.runways[0]!.ilsPrimary = { frequencyMhz: 105.0, glideslopeAngleRad: 0.05236 };
    const issues = validateEditorLayout(layout);
    const error = issues.find((i) => i.severity === 'error' && i.message.includes('frequency'));
    expect(error).toBeDefined();
  });
});
