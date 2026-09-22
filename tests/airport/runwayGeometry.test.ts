import { describe, expect, it } from 'vitest';
import { generateRunwayGeometry } from '../../src/airport/runwayGeometry';
import type { RunwayDef } from '../../src/contracts/airport';

function runway(overrides: Partial<RunwayDef> = {}): RunwayDef {
  return {
    id: '09',
    thresholdWorldX: 1000,
    thresholdWorldZ: 2000,
    elevationM: 50,
    headingRad: 0,
    lengthM: 3000,
    widthM: 45,
    surface: 'concrete',
    ...overrides,
  };
}

describe('generateRunwayGeometry', () => {
  it('builds the 8-point closed-rectangle outline per section 4.4 exactly', () => {
    const geo = generateRunwayGeometry(runway());
    expect(geo.outline.points.length).toBe(8);
    expect(geo.outline.points[0]).toEqual({ x: 977.5, y: 50, z: 2000 });
    expect(geo.outline.points[1]).toEqual({ x: 1022.5, y: 50, z: 2000 });
    // Full outline: c0,c1, c1,c2, c2,c3, c3,c0 with c2=(1022.5,50,-1000), c3=(977.5,50,-1000).
    expect(geo.outline.points).toEqual([
      { x: 977.5, y: 50, z: 2000 },
      { x: 1022.5, y: 50, z: 2000 },
      { x: 1022.5, y: 50, z: 2000 },
      { x: 1022.5, y: 50, z: -1000 },
      { x: 1022.5, y: 50, z: -1000 },
      { x: 977.5, y: 50, z: -1000 },
      { x: 977.5, y: 50, z: -1000 },
      { x: 977.5, y: 50, z: 2000 },
    ]);
  });

  it('produces exactly 2 dashes (4 points) for a 100 m runway', () => {
    const geo = generateRunwayGeometry(runway({ lengthM: 100 }));
    expect(geo.centerlineDashes.points.length).toBe(4);
  });

  it('produces 16 threshold-bar points (8 stripes x 2)', () => {
    const geo = generateRunwayGeometry(runway());
    expect(geo.thresholdBar.points.length).toBe(16);
  });

  it('carries the runway id through', () => {
    const geo = generateRunwayGeometry(runway({ id: '27' }));
    expect(geo.runwayId).toBe('27');
  });
});
