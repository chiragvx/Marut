/**
 * src/catalog/sensors.ts — the sensor catalogue: fire-control radars by id (and, from Phase B, IFF,
 * radar-warning and jammer entries). Pure data (depends on src/contracts only).
 */
import type { RadarProfile } from '../contracts/combat';
import { GENERIC_RADAR_PROFILE } from './weapons';

export const RADARS: Readonly<Record<string, RadarProfile>> = {
  generic: GENERIC_RADAR_PROFILE,
  // Elta EL/M-2052 AESA (Tejas Mk1A, early production): X-band, ~64 tracks. Performance still the
  // generic radar's until the radar work (Phase B) gives it its real detection ranges and modes.
  'elm-2052': { ...GENERIC_RADAR_PROFILE, id: 'elm-2052', name: 'EL/M-2052', maxTracks: 64 },
};
