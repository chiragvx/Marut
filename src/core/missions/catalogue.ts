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
  /** Not fully tested yet: the menus tag the base (and its missions) so players expect bugs. */
  untested?: boolean;
}

/** The tag and the line the menus show for an untested base. */
export const UNTESTED_BADGE = 'Not fully tested';
export const UNTESTED_NOTE = 'This base has not been fully tested yet: you may run into bugs here.';

export const BASES: readonly BaseInfo[] = [
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
  {
    id: 'hansa',
    name: 'INS Hansa',
    place: 'Goa',
    blurb: 'Coastal air station on a plateau above the Zuari estuary: beaches, headlands and the Western Ghats inland.',
    airportId: 'ins-hansa',
    freeMissionId: 'konkan-free',
    parkingSpotId: 'PARK-1',
    parkedLabel: 'on the apron',
    untested: true,
  },
];

export interface MissionEntry {
  /** The mission file's id. */
  id: BuiltinMissionId;
  title: string;
  baseId: BaseId;
  bandits: number;
  /** Ground targets to destroy (strike missions); shown instead of bandits when set. */
  targets?: number;
  /** One line for the list. */
  objective: string;
  /** Two or three sentences for the briefing. */
  situation: string;
  /** Shown first and marked as the one to start with. */
  recommended?: boolean;
}

export const MISSIONS: readonly MissionEntry[] = [
  {
    id: 'border-duel',
    title: 'Border Duel',
    baseId: 'bathinda',
    bandits: 1,
    objective: 'Meet one intruder over the Punjab plains.',
    situation: 'A PAF JF-17 (PL-5E II and SD-10A) has crossed the border and is heading for Bathinda. Take off from runway 13 and shoot it down before it reaches the base. It carries flares and chaff: expect it to decoy your missiles.',
    recommended: true,
  },
  {
    id: 'border-intercept',
    title: 'Border Intercept',
    baseId: 'bathinda',
    bandits: 2,
    objective: 'Scramble from the shelters and stop two aircraft.',
    situation: 'Two JF-17s with SD-10A radar missiles are inbound from the west. You are in shelter HAS-7: taxi out (press H for taxi guidance), take off and destroy both.',
  },
  {
    id: 'border-range',
    title: 'Range Day',
    baseId: 'bathinda',
    bandits: 0,
    targets: 19,
    objective: 'Strafe a convoy and targets on the Bathinda range.',
    situation: 'Weapons practice on the range north of Bathinda: a convoy of eight trucks on the range road and a spread of targets (trucks, armour, a bunker, buildings, a dummy SAM site). You start in the air to the south. Trucks die to a gun burst; armour and bunkers need bombs.',
  },
  {
    id: 'border-strike',
    title: 'Precision Strike',
    baseId: 'bathinda',
    bandits: 0,
    targets: 5,
    objective: 'Laser-guided bombs on the PAF Shahbaz fuel depot.',
    situation: 'Two Griffin LGBs and the Litening pod against the PAF Shahbaz fuel depot, 45 km west. It is defended: an LY-80 battery west of the base (cued by an early-warning radar), an FM-90 section, 35 mm guns and MANPADS round the depot. Watch the RWR (bottom left); fly low to stay under the radars, pop up to designate (Y pod view, arrows, I) and release inside the launch zone (IN RNG): the pod lases for the bombs. Destroy four of the five depot targets.',
  },
  {
    id: 'border-sead',
    title: 'SEAD',
    baseId: 'bathinda',
    bandits: 0,
    targets: 1,
    objective: 'Keep an LY-80 battery silent for 60 seconds.',
    situation: 'A strike package needs the LY-80 battery 65 km west kept quiet. You carry two Rudram-1 anti-radiation missiles. Tab to RUDRAM, press T to step through the radars your RWR hears (L8), wait for LOCK and fire. A battery that sees a Rudram coming may shut its radars down: that is the job done too, as long as it stays quiet (its missiles cannot guide without them). Keep it suppressed for 60 seconds in all.',
  },
  {
    id: 'border-dead',
    title: 'DEAD',
    baseId: 'bathinda',
    bandits: 0,
    targets: 2,
    objective: 'Destroy the radars of an LY-80 battery.',
    situation: 'Destroy the LY-80 battery search and engagement radars, 65 km west; an FM-90 section covers it. A Rudram fired from far out at a radar that shuts down will miss: get closer, use the pod (Y) to find the radars and designate one (I), then fire a Rudram at the designated point (pre-briefed: it looks for a radar there) or bomb it.',
  },
  {
    id: 'border-lowlevel',
    title: 'Low Level',
    baseId: 'bathinda',
    bandits: 0,
    targets: 2,
    objective: 'Destroy the PAF Shahbaz control tower and radar, flying under the radar.',
    situation: 'Shahbaz is covered by an HQ-9 and an LY-80 battery: above a few hundred metres you will be seen and shot at long before the target. Stay low (the HUD R readout is your height above the ground; PULL UP with a big X means pull now) and follow the route: Canal, IP, then the target, on time (the HUD shows how early or late you are and the groundspeed to fly). Your four HSLD-250R retarded bombs are released from low level: the target steerpoint is the designated point, so hold the release button and the CCRP sight drops on the tower. Then the radar, 900 m east of it. AAA and MANPADS guard the airfield: get in fast, get out low.',
  },
  {
    id: 'border-highalt',
    title: 'Runway Denial',
    baseId: 'bathinda',
    bandits: 0,
    targets: 2,
    objective: 'Close both PAF Shahbaz runways with SAAW glide bombs from high altitude.',
    situation: 'Four SAAW glide bombs, released from 9 km, glide 40 km and more onto pre-planned aim points: two cuts across each Shahbaz runway leave no strip long enough to fly from. The LY-80 battery at Shahbaz reaches 40 km: stay outside it. Fly to the LAR (launch area) steerpoint; when you pass it the runway aim points load as the designated point (the pod looks at them, the DLZ cue shows IN RANGE). Tab to SAAW and press the release button four times: each bomb takes the next aim point. Then turn for home.',
  },
  {
    id: 'konkan-dogfight',
    title: 'Sea Duel',
    baseId: 'hansa',
    bandits: 1,
    objective: 'Shoot down one aircraft over the Arabian Sea.',
    situation: 'A single F-16 (AIM-9M and AIM-120C) is working off the Goa coast. Take off from INS Hansa, find it on radar and shoot it down. Beam its AMRAAMs and drop chaff (C); flares (F) against Sidewinders.',
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
