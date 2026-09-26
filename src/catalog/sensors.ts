/**
 * src/catalog/sensors.ts — the sensor catalogue: fire-control radars by id (and, from Phase B, IFF,
 * radar-warning and jammer entries). Pure data (depends on src/contracts only).
 */
import type { RadarProfile } from '../contracts/combat';
import { GENERIC_RADAR_PROFILE } from './weapons';

export const RADARS: Readonly<Record<string, RadarProfile>> = {
  generic: GENERIC_RADAR_PROFILE,
  // Elta EL/M-2052 AESA (Tejas Mk1A, early production): X-band, electronically scanned +-60 deg,
  // ~200 km instrumented, 64 tracks. Public figures only: ~130 km against a 5 m^2 fighter (so ~100 km
  // against a clean Tejas-size target nose-on). Fast electronic scan: quick locks, wide track field.
  'elm-2052': {
    ...GENERIC_RADAR_PROFILE,
    id: 'elm-2052',
    name: 'EL/M-2052',
    referenceRangeM: 130000,
    referenceRcsM2: 5,
    maxRangeM: 200000,
    scanAzHalfAngleRad: (60 * Math.PI) / 180,
    scanElHalfAngleRad: (35 * Math.PI) / 180,
    trackHalfAngleRad: (60 * Math.PI) / 180,
    lockTimeSec: 1.5,
    maxTracks: 64,
    iffRangeM: 110000,
    nctrRangeM: 60000,
    acmRangeM: 18000,
    trackMemorySec: 5,
  },
};
