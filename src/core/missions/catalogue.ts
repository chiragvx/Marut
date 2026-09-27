/**
 * src/core/missions/catalogue.ts — what the menus offer: the bases for Free Flight and the missions,
 * with the words the player reads. The one place menu text lives (the mission JSON files hold the
 * simulation setup). Missions not listed here (Adampur, the two test maps) still exist but are not
 * offered in this build.
 */
import type { AirportLayout } from '../../contracts/airport';
import type { Mission, Vec3Like } from '../../contracts/core';
import { activeRunway } from '../../airport/taxiGraph';
import { resolveBuiltinMission, type BuiltinMissionId } from './index';

export type BaseId = 'hansa' | 'bathinda';
export type StartMode = 'parked' | 'runway' | 'air';

export interface BaseInfo {
  id: BaseId;
  name: string;
  place: string;
  /** One line on what makes it worth flying. */
  blurb: string;
  airportId: string;
  /** The Free Flight mission that sets up this base's world. */
  freeMissionId: BuiltinMissionId;
  /** Where "Parked" starts. */
  parkingSpotId: string;
  parkedLabel: string;
}

export const BASES: readonly BaseInfo[] = [
  {
    id: 'hansa',
    name: 'INS Hansa',
    place: 'Goa',
    blurb: 'Coastal air station on a plateau above the Zuari estuary: beaches, headlands and the Western Ghats inland.',
    airportId: 'ins-hansa',
    freeMissionId: 'konkan-free',
    parkingSpotId: 'PARK-1',
    parkedLabel: 'on the apron',
  },
  {
    id: 'bathinda',
    name: 'Bhisiana AFS',
    place: 'Bathinda, Punjab',
    blurb: 'Fighter base on the Punjab plains with hardened shelters, 60 km from the border.',
    airportId: 'bhisiana-afs',
    freeMissionId: 'border-free',
    parkingSpotId: 'HAS-7',
    parkedLabel: 'in shelter HAS-7',
  },
];

export interface MissionEntry {
  /** The mission file's id. */
  id: BuiltinMissionId;
  title: string;
  baseId: BaseId;
  bandits: number;
  /** One line for the list. */
  objective: string;
  /** Two or three sentences for the briefing. */
  situation: string;
  /** Shown first and marked as the one to start with. */
  recommended?: boolean;
}

export const MISSIONS: readonly MissionEntry[] = [
  {
    id: 'konkan-dogfight',
    title: 'Sea Duel',
    baseId: 'hansa',
    bandits: 1,
    objective: 'Shoot down one aircraft over the Arabian Sea.',
    situation: 'A single hostile fighter is working off the Goa coast. Take off from INS Hansa, find it on radar and shoot it down.',
    recommended: true,
  },
  {
    id: 'border-duel',
    title: 'Border Duel',
    baseId: 'bathinda',
    bandits: 1,
    objective: 'Meet one intruder over the Punjab plains.',
    situation: 'One intruder has crossed the border and is heading for Bathinda. Take off from runway 13 and shoot it down before it reaches the base.',
  },
  {
    id: 'border-intercept',
    title: 'Border Intercept',
    baseId: 'bathinda',
    bandits: 2,
    objective: 'Scramble from the shelters and stop two aircraft.',
    situation: 'Two hostile aircraft are inbound from the west. You are in shelter HAS-7: taxi out (press H for taxi guidance), take off and destroy both.',
  },
];

export function baseInfo(id: BaseId): BaseInfo {
  return BASES.find((b) => b.id === id) ?? BASES[0]!;
}

export function missionEntry(id: string): MissionEntry | undefined {
  return MISSIONS.find((m) => m.id === id);
}

/** Air start: this far out on the runway's approach, this high above the field, at this speed. */
export const AIR_START = { distanceM: 9000, heightM: 3000, speedMps: 180 } as const;

/**
 * The Free Flight mission for a base and start: parked (its parking spot), on the runway in use
 * (into the wind), or in the air on the approach to that runway.
 */
export function freeFlightMission(baseId: BaseId, start: StartMode): Mission {
  const base = baseInfo(baseId);
  const m = resolveBuiltinMission(base.freeMissionId);
  const layout = (m.world.airports as readonly AirportLayout[]).find((a) => a.id === base.airportId);
  const aircraftId = m.playerStart.aircraftId;
  const common = { airportId: base.airportId, ...(aircraftId ? { aircraftId } : {}) };
  if (start === 'parked' || !layout) return { ...m, playerStart: { ...common, parkingSpotId: base.parkingSpotId, speedMps: 0 } };
  const rwy = activeRunway(layout, { x: m.weather.windWorldMps.x, z: m.weather.windWorldMps.z });
  const runway = layout.runways.find((r) => r.id === rwy) ?? layout.runways[0]!;
  if (start === 'runway') return { ...m, playerStart: { ...common, runwayId: runway.id, speedMps: 0 } };
  // Heading 0 = north, +x east, -z north: the approach is behind the threshold.
  const dirX = Math.sin(runway.headingRad);
  const dirZ = -Math.cos(runway.headingRad);
  const pos: Vec3Like = {
    x: runway.thresholdWorldX - dirX * AIR_START.distanceM,
    y: layout.elevationM + AIR_START.heightM,
    z: runway.thresholdWorldZ - dirZ * AIR_START.distanceM,
  };
  return { ...m, playerStart: { ...(aircraftId ? { aircraftId } : {}), pos, headingRad: runway.headingRad, speedMps: AIR_START.speedMps } };
}
