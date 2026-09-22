import { describe, expect, it } from 'vitest';
import { generateTaxiwayGeometry } from '../../src/airport/taxiwayGeometry';
import type { TaxiwayDef } from '../../src/contracts/airport';

describe('generateTaxiwayGeometry', () => {
  it('builds two parallel edge lines for a single-segment taxiway', () => {
    const taxiway: TaxiwayDef = {
      id: 'TWY-1',
      widthM: 10,
      points: [
        { worldX: 0, worldZ: 0 },
        { worldX: 0, worldZ: -100 },
      ],
    };
    const geo = generateTaxiwayGeometry(taxiway, 50);
    expect(geo.taxiwayId).toBe('TWY-1');
    expect(geo.edges.points.length).toBe(4);
    expect(geo.edges.points).toEqual([
      { x: 5, y: 50, z: 0 },
      { x: 5, y: 50, z: -100 },
      { x: -5, y: 50, z: 0 },
      { x: -5, y: 50, z: -100 },
    ]);
  });

  it('does not mitre joints: a 3-point polyline yields two independent segment pairs (8 points)', () => {
    const taxiway: TaxiwayDef = {
      id: 'TWY-2',
      widthM: 10,
      points: [
        { worldX: 0, worldZ: 0 },
        { worldX: 100, worldZ: 0 },
        { worldX: 100, worldZ: -100 },
      ],
    };
    const geo = generateTaxiwayGeometry(taxiway, 0);
    expect(geo.edges.points.length).toBe(8);
  });
});
