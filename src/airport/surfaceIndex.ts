/**
 * src/airport/surfaceIndex.ts — paved-surface friction lookup for
 * landing-gear physics (05-airport.md section 4.6). `frictionAt` is
 * documented as allocation-free and cheap: it always returns a reference to
 * one of 4 pre-built shared SurfaceFriction singletons, never a fresh object.
 */

import type { AirportSurfaceIndex, CreateAirportSurfaceIndex, SurfaceFriction } from '../contracts/airport';
import { SURFACE_BRAKING_FRICTION_PAVED_DRY, SURFACE_BRAKING_FRICTION_UNPAVED_DRY, SURFACE_ROLLING_FRICTION_PAVED, SURFACE_ROLLING_FRICTION_UNPAVED, SurfaceKind } from '../contracts/airport';
import { isUnpaved } from './surfaces';
import { pointInPolygon, pointToSegmentDistanceXZ } from './geomUtils';

interface RunwayFootprint {
  thresholdWorldX: number;
  thresholdWorldZ: number;
  dx: number;
  dz: number;
  rx: number;
  rz: number;
  lengthM: number;
  halfWidthM: number;
}

export const createAirportSurfaceIndex: CreateAirportSurfaceIndex = (layout) => {
  const pavedRunway: SurfaceFriction = {
    kind: SurfaceKind.PavedRunway,
    rollingCoeff: SURFACE_ROLLING_FRICTION_PAVED,
    brakingCoeff: SURFACE_BRAKING_FRICTION_PAVED_DRY,
  };
  const pavedTaxiway: SurfaceFriction = {
    kind: SurfaceKind.PavedTaxiway,
    rollingCoeff: SURFACE_ROLLING_FRICTION_PAVED,
    brakingCoeff: SURFACE_BRAKING_FRICTION_PAVED_DRY,
  };
  const pavedApron: SurfaceFriction = {
    kind: SurfaceKind.PavedApron,
    rollingCoeff: SURFACE_ROLLING_FRICTION_PAVED,
    brakingCoeff: SURFACE_BRAKING_FRICTION_PAVED_DRY,
  };

  const unpaved: SurfaceFriction = {
    kind: SurfaceKind.Unpaved,
    rollingCoeff: SURFACE_ROLLING_FRICTION_UNPAVED,
    brakingCoeff: SURFACE_BRAKING_FRICTION_UNPAVED_DRY,
  };

  const runwayFootprints: (RunwayFootprint & { unpaved: boolean })[] = layout.runways.map((r) => ({
    thresholdWorldX: r.thresholdWorldX,
    thresholdWorldZ: r.thresholdWorldZ,
    dx: Math.sin(r.headingRad),
    dz: -Math.cos(r.headingRad),
    rx: Math.cos(r.headingRad),
    rz: Math.sin(r.headingRad),
    lengthM: r.lengthM,
    halfWidthM: r.widthM / 2,
    unpaved: isUnpaved(r.surface),
  }));

  const taxiways = layout.taxiways;
  const aprons = layout.aprons;

  function frictionAt(worldX: number, worldZ: number): SurfaceFriction | undefined {
    for (let i = 0; i < runwayFootprints.length; i++) {
      const f = runwayFootprints[i]!;
      const relX = worldX - f.thresholdWorldX;
      const relZ = worldZ - f.thresholdWorldZ;
      const along = relX * f.dx + relZ * f.dz;
      const cross = relX * f.rx + relZ * f.rz;
      if (along >= 0 && along <= f.lengthM && Math.abs(cross) <= f.halfWidthM) {
        return f.unpaved ? unpaved : pavedRunway;
      }
    }

    for (let i = 0; i < taxiways.length; i++) {
      const t = taxiways[i]!;
      const halfW = t.widthM / 2;
      for (let j = 0; j < t.points.length - 1; j++) {
        const p0 = t.points[j]!;
        const p1 = t.points[j + 1]!;
        const dist = pointToSegmentDistanceXZ(worldX, worldZ, p0.worldX, p0.worldZ, p1.worldX, p1.worldZ);
        if (dist <= halfW) return isUnpaved(t.surface) ? unpaved : pavedTaxiway;
      }
    }

    for (let i = 0; i < aprons.length; i++) {
      const a = aprons[i]!;
      if (pointInPolygon(worldX, worldZ, a.points)) return isUnpaved(a.surface) ? unpaved : pavedApron;
    }

    return undefined;
  }

  const index: AirportSurfaceIndex = { frictionAt };
  return index;
};
