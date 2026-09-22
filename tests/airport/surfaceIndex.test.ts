import { describe, expect, it } from 'vitest';
import { createAirportSurfaceIndex } from '../../src/airport/surfaceIndex';
import type { AirportLayout, RunwayDef } from '../../src/contracts/airport';

function runway(): RunwayDef {
  return {
    id: '09',
    thresholdWorldX: 0,
    thresholdWorldZ: 0,
    elevationM: 50,
    headingRad: 0,
    lengthM: 1000,
    widthM: 40,
    surface: 'concrete',
  };
}

function layoutWith(overrides: Partial<AirportLayout> = {}): AirportLayout {
  return {
    id: 'test',
    name: 'Test',
    referenceWorldX: 0,
    referenceWorldZ: 0,
    elevationM: 50,
    flattenZones: [],
    runways: [runway()],
    taxiways: [],
    aprons: [],
    parkingSpots: [],
    ...overrides,
  };
}

describe('createAirportSurfaceIndex', () => {
  it('resolves on-runway points to a paved_runway friction singleton', () => {
    const index = createAirportSurfaceIndex(layoutWith());
    const f = index.frictionAt(0, -500);
    expect(f).toBeDefined();
    expect(f?.kind).toBe('paved_runway');
    expect(f?.rollingCoeff).toBe(0.02);
    expect(f?.brakingCoeff).toBe(0.6);
  });

  it('returns undefined 30 m off centerline (half-width is 20 m)', () => {
    const index = createAirportSurfaceIndex(layoutWith());
    expect(index.frictionAt(30, -500)).toBeUndefined();
  });

  it('returns undefined behind the threshold', () => {
    const index = createAirportSurfaceIndex(layoutWith());
    expect(index.frictionAt(0, 100)).toBeUndefined();
  });

  it('returns the same object reference across calls (no per-call allocation)', () => {
    const index = createAirportSurfaceIndex(layoutWith());
    const a = index.frictionAt(0, -100);
    const b = index.frictionAt(0, -900);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(Object.is(a, b)).toBe(true);
  });

  it('resolves a taxiway centerline point to paved_taxiway', () => {
    const index = createAirportSurfaceIndex(
      layoutWith({
        runways: [],
        taxiways: [
          {
            id: 'T1',
            widthM: 10,
            points: [
              { worldX: 500, worldZ: 500 },
              { worldX: 600, worldZ: 500 },
            ],
          },
        ],
      })
    );
    const f = index.frictionAt(550, 500);
    expect(f?.kind).toBe('paved_taxiway');
  });

  it('resolves a point inside an apron polygon to paved_apron', () => {
    const index = createAirportSurfaceIndex(
      layoutWith({
        runways: [],
        aprons: [
          {
            id: 'A1',
            points: [
              { worldX: 0, worldZ: 0 },
              { worldX: 10, worldZ: 0 },
              { worldX: 10, worldZ: 10 },
              { worldX: 0, worldZ: 10 },
            ],
          },
        ],
      })
    );
    const f = index.frictionAt(5, 5);
    expect(f?.kind).toBe('paved_apron');
  });

  it('returns undefined far outside every declared surface', () => {
    const index = createAirportSurfaceIndex(layoutWith());
    expect(index.frictionAt(100000, 100000)).toBeUndefined();
  });
});
