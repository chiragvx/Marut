/**
 * src/airport/navDb.ts — implements core.ts's AirportNavDb (extended with
 * nearestRunway/approachFixes per contracts/airport.ts's
 * AirportNavDbExtended) over one or more already-validated AirportLayouts.
 * Not a hot path: builds a lookup table once, THROWS on a duplicate layout
 * id (programmer-error class, 00-architecture.md's error-handling rule).
 */

import type { AirportInfo, IlsInfo, RunwayInfo, Vec3Like } from '../contracts/core';
import { ILS_DEFAULT_GLIDESLOPE_RAD } from '../contracts/core';
import type { AirportNavDbExtended, ApproachFix, CreateAirportNavDb, RunwayDef } from '../contracts/airport';
import { APPROACH_FAF_ALT_AGL_M, APPROACH_IAF_ALT_AGL_M, ILS_GLIDESLOPE_DEFAULT_OFFSET_M, ILS_LOCALISER_DEFAULT_OFFSET_M } from '../contracts/airport';

function buildIlsInfo(r: RunwayDef): IlsInfo {
  const ils = r.ils!;
  const dx = Math.sin(r.headingRad);
  const dz = -Math.cos(r.headingRad);
  const farEndX = r.thresholdWorldX + dx * r.lengthM;
  const farEndZ = r.thresholdWorldZ + dz * r.lengthM;
  const locOffset = ils.localiserOffsetBeyondFarEndM ?? ILS_LOCALISER_DEFAULT_OFFSET_M;
  const gsOffset = ils.glideslopeOffsetFromThresholdM ?? ILS_GLIDESLOPE_DEFAULT_OFFSET_M;

  return {
    frequencyMhz: ils.frequencyMhz,
    localiserHeadingRad: r.headingRad,
    glideslopeAngleRad: ils.glideslopeAngleRad ?? ILS_DEFAULT_GLIDESLOPE_RAD,
    localiserOriginPos: { x: farEndX + dx * locOffset, y: r.elevationM, z: farEndZ + dz * locOffset },
    glideslopeOriginPos: { x: r.thresholdWorldX + dx * gsOffset, y: r.elevationM, z: r.thresholdWorldZ + dz * gsOffset },
  };
}

function buildRunwayInfo(r: RunwayDef): RunwayInfo {
  const info: RunwayInfo = {
    id: r.id,
    thresholdPos: { x: r.thresholdWorldX, y: r.elevationM, z: r.thresholdWorldZ },
    headingRad: r.headingRad,
    lengthM: r.lengthM,
    widthM: r.widthM,
    elevationM: r.elevationM,
  };
  if (r.ils !== undefined) info.ils = buildIlsInfo(r);
  return info;
}

export const createAirportNavDb: CreateAirportNavDb = (layouts) => {
  const airports = new Map<string, AirportInfo>();

  for (const layout of layouts) {
    if (airports.has(layout.id)) {
      throw new Error(`createAirportNavDb: duplicate airport id '${layout.id}'`);
    }
    const runways: RunwayInfo[] = layout.runways.map(buildRunwayInfo);
    const info: AirportInfo = {
      id: layout.id,
      name: layout.name,
      referencePos: { x: layout.referenceWorldX, y: layout.elevationM, z: layout.referenceWorldZ },
      elevationM: layout.elevationM,
      runways,
    };
    airports.set(layout.id, info);
  }

  function getAirport(id: string): AirportInfo | undefined {
    return airports.get(id);
  }

  function listAirports(): readonly AirportInfo[] {
    return Array.from(airports.values());
  }

  function nearestAirport(pos: Vec3Like): AirportInfo | undefined {
    let best: AirportInfo | undefined;
    let bestD = Infinity;
    for (const a of airports.values()) {
      const d = Math.hypot(pos.x - a.referencePos.x, pos.z - a.referencePos.z);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  function getRunway(airportId: string, runwayId: string): RunwayInfo | undefined {
    const a = airports.get(airportId);
    if (a === undefined) return undefined;
    return a.runways.find((r) => r.id === runwayId);
  }

  function nearestRunway(pos: Vec3Like): { airportId: string; runway: RunwayInfo } | undefined {
    let best: { airportId: string; runway: RunwayInfo } | undefined;
    let bestD = Infinity;
    for (const a of airports.values()) {
      for (const r of a.runways) {
        const d = Math.hypot(pos.x - r.thresholdPos.x, pos.z - r.thresholdPos.z);
        if (d < bestD) {
          bestD = d;
          best = { airportId: a.id, runway: r };
        }
      }
    }
    return best;
  }

  function approachFixes(airportId: string, runwayId: string): readonly ApproachFix[] {
    const a = airports.get(airportId);
    if (a === undefined) return [];
    const runway = a.runways.find((r) => r.id === runwayId);
    if (runway === undefined) return [];

    const glideslopeAngleRad = runway.ils?.glideslopeAngleRad ?? ILS_DEFAULT_GLIDESLOPE_RAD;
    const dx = Math.sin(runway.headingRad);
    const dz = -Math.cos(runway.headingRad);
    const specs: readonly [string, number][] = [
      ['FAF', APPROACH_FAF_ALT_AGL_M],
      ['IAF', APPROACH_IAF_ALT_AGL_M],
    ];

    const fixes: ApproachFix[] = [];
    for (const [name, altAglM] of specs) {
      const distM = altAglM / Math.tan(glideslopeAngleRad);
      const posY = runway.elevationM + altAglM;
      const pos: Vec3Like = {
        x: runway.thresholdPos.x - dx * distM,
        y: posY,
        z: runway.thresholdPos.z - dz * distM,
      };
      fixes.push({ name: `RW${runway.id}-${name}`, pos, altitudeM: posY });
    }
    return fixes;
  }

  const db: AirportNavDbExtended = { getAirport, listAirports, nearestAirport, getRunway, nearestRunway, approachFixes };
  return db;
};
