import { describe, it, expect } from 'vitest';
import { runwayDesignator, rectanglesOverlap, polygonAreaM2, polygonCentroid, computeFlattenZones } from '../../src/ui/airportEditorGeometry';
import type { EditorAirportLayout, EditorPoint } from '../../src/contracts/ui';

describe('airportEditorGeometry', () => {
  it('runwayDesignator', () => {
    expect(runwayDesignator(0)).toBe('36');
    expect(runwayDesignator(Math.PI / 2)).toBe('09');
    expect(runwayDesignator(Math.PI)).toBe('18');
    expect(runwayDesignator((3 * Math.PI) / 2)).toBe('27');
    expect(runwayDesignator(0.05)).toBe('36');
  });

  it('rectanglesOverlap: identical rectangles overlap', () => {
    const a = { centerXM: 0, centerZM: 0, headingRad: 0, halfLengthM: 1250, halfWidthM: 22.5 };
    const b = { centerXM: 0, centerZM: 0, headingRad: 0, halfLengthM: 1250, halfWidthM: 22.5 };
    expect(rectanglesOverlap(a, b)).toBe(true);
  });

  it('rectanglesOverlap: clearly separated rectangles do not overlap', () => {
    const a = { centerXM: 0, centerZM: 0, headingRad: 0, halfLengthM: 1250, halfWidthM: 22.5 };
    const b = { centerXM: 5000, centerZM: 0, headingRad: 0, halfLengthM: 1250, halfWidthM: 22.5 };
    expect(rectanglesOverlap(a, b)).toBe(false);
  });

  it('polygonAreaM2', () => {
    const pts: EditorPoint[] = [
      { xM: 0, zM: 0 },
      { xM: 100, zM: 0 },
      { xM: 100, zM: 50 },
      { xM: 0, zM: 50 },
    ];
    expect(polygonAreaM2(pts)).toBeCloseTo(5000, 6);
  });

  it('polygonCentroid', () => {
    const pts: EditorPoint[] = [
      { xM: 0, zM: 0 },
      { xM: 10, zM: 0 },
      { xM: 10, zM: 10 },
      { xM: 0, zM: 10 },
    ];
    const out: EditorPoint = { xM: 0, zM: 0 };
    polygonCentroid(pts, out);
    expect(out.xM).toBe(5);
    expect(out.zM).toBe(5);
  });

  it('computeFlattenZones: single runway', () => {
    const layout: EditorAirportLayout = {
      id: 'test-field',
      name: 'Test Field',
      referenceXM: 0,
      referenceZM: 0,
      elevationM: 12,
      runways: [{ id: 'runway-1', centerXM: 0, centerZM: 0, headingRad: 0, lengthM: 2500, widthM: 45, elevationM: 12 }],
      taxiways: [],
      aprons: [],
    };
    const zones = computeFlattenZones(layout);
    expect(zones.length).toBe(1);
    expect(zones[0]?.flatRadiusM).toBeCloseTo(Math.hypot(1250, 22.5) + 15, 1);
    expect(zones[0]?.blendRadiusM).toBe(40);
    expect(zones[0]?.elevationM).toBe(12);
  });
});
