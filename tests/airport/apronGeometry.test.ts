import { describe, expect, it } from 'vitest';
import { generateApronGeometry } from '../../src/airport/apronGeometry';
import type { ApronDef } from '../../src/contracts/airport';

describe('generateApronGeometry', () => {
  it('builds a closed polygon outline for a square apron', () => {
    const apron: ApronDef = {
      id: 'APRON-1',
      points: [
        { worldX: 0, worldZ: 0 },
        { worldX: 10, worldZ: 0 },
        { worldX: 10, worldZ: 10 },
        { worldX: 0, worldZ: 10 },
      ],
    };
    const geo = generateApronGeometry(apron, 20);
    expect(geo.apronId).toBe('APRON-1');
    expect(geo.outline.points.length).toBe(8);
    expect(geo.outline.points[0]).toEqual({ x: 0, y: 20, z: 0 });
    expect(geo.outline.points[1]).toEqual({ x: 10, y: 20, z: 0 });
  });
});
