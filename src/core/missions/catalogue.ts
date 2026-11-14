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

export type BaseId = 'hansa' | 'bathinda' | 'fukche';
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
  /** Not open in this build: shown, locked (and its missions with it). */
  locked?: boolean;
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
    locked: true,
  },
  {
    id: 'fukche',
    name: 'Fukche ALG',
    place: 'Ladakh, Himalaya',
    blurb: 'A 2.6 km strip at 4,176 m in a high desert valley: the Ngari Gunsa air base 40 km east, Kailash and Mansarovar beyond, 7,000 m peaks all round.',
    airportId: 'fukche-alg',
    freeMissionId: 'himalaya-free',
    parkingSpotId: 'STAND-1',
    parkedLabel: 'at the dispersal',
    untested: true,
  },
];

/** What the menus say on something locked. */
export const LOCKED_NOTE = 'Unlocks in a later update';

/**
 * The missions this build opens, in order: one air-to-air, one ground strike, both over Punjab.
 * The rest are listed, locked.
 */
export const PLAYABLE_MISSIONS: readonly BuiltinMissionId[] = ['border-duel', 'border-strike'];

export function missionLocked(id: string): boolean {
  if (isTraining(id)) return false;
  return !PLAYABLE_MISSIONS.includes(id as BuiltinMissionId);
}

/** One Flight School lesson (src/script/missions/training.ts runs it). */
export interface TrainingEntry {
  id: BuiltinMissionId;
  /** 1-based lesson number. */
  lesson: number;
  title: string;
  /** One line for the lesson tile. */
  blurb: string;
  /** What it teaches, as short tags. */
  skills: readonly string[];
  /** The briefing: two or three sentences. */
  situation: string;
  /** About how long it takes, minutes. */
  minutes: number;
  /** The look of the sky (the sim's wind and gusts are in the mission file). Absent: clear. */
  weather?: 'clear' | 'hazy' | 'fog' | 'overcast' | 'rain';
  timeOfDayH?: number;
  /** An air start's throttle lever (default 0.8). */
  startThrottle?: number;
}

/** Flight School: four short lessons with an instructor on the radio, in order. */
export const TRAINING: readonly TrainingEntry[] = [
  {
    id: 'train-takeoff',
    lesson: 1,
    title: 'Takeoff & Handling',
    blurb: 'Power up, rotate, raise the gear, climb and turn. Learn the views.',
    skills: ['Throttle', 'Afterburner', 'Takeoff', 'Gear', 'Climb & turn', 'Camera'],
    situation: 'You are lined up on runway 13 at Bhisiana with a clean jet. Your instructor, Guru, talks you through the takeoff, a climb, a level turn and the camera views. Do what the prompt at the bottom of the screen asks: the button to press glows on the left.',
    minutes: 4,
  },
  {
    id: 'train-landing',
    lesson: 2,
    title: 'Approach & Landing',
    blurb: 'Fly a straight-in approach: gear, airbrake, the PAPI lights, flare and stop.',
    skills: ['Speed control', 'Gear & airbrake', 'Glide path', 'PAPI', 'Flare', 'Braking'],
    startThrottle: 0.3,
    situation: 'You start 12 km out on the final approach to runway 13, a little high and fast. Slow down, lower the gear, follow the glide path down using the PAPI lights beside the runway, flare and stop on the runway.',
    minutes: 4,
  },
  {
    id: 'train-weather',
    lesson: 3,
    title: 'Bad-Weather Landing',
    blurb: 'Down through the cloud in rain and a gusty crosswind, on the ILS.',
    skills: ['Instrument approach', 'ILS needles', 'Crosswind', 'Decision height'],
    startThrottle: 0.3,
    situation: 'Rain, a low cloud deck and a gusty crosswind from the right. You start above the cloud, 20 km out. Descend through it, capture the ILS for runway 13 and fly the needles until the runway lights appear. At decision height, land if you can see the runway, or go around.',
    minutes: 6,
    weather: 'rain',
    timeOfDayH: 16.5,
  },
  {
    id: 'train-drone',
    lesson: 4,
    title: 'Radar & Target Drones',
    blurb: 'Radar scan modes, the warning tones, locks, then a missile and a gun kill.',
    skills: ['Radar scope', 'Scan modes', 'RWR tones', 'Lock', 'Missile', 'Gun'],
    situation: 'Two target drones are orbiting over the range north of Bathinda. They are unarmed, but they carry a radar emitter so you hear your radar warning receiver. Guru walks you through the radar, then you shoot the first drone with a missile and the second with the gun.',
    minutes: 6,
  },
];

export function isTraining(id: string): boolean {
  return TRAINING.some((t) => t.id === id);
}

export function trainingEntry(id: string): TrainingEntry | undefined {
  return TRAINING.find((t) => t.id === id);
}

/** The open missions, in PLAYABLE_MISSIONS order. */
export function playableMissions(): MissionEntry[] {
  return PLAYABLE_MISSIONS.map((id) => MISSIONS.find((m) => m.id === id)!).filter(Boolean);
}

/** Air-to-air or ground strike, for the mission tiles. */
export function missionKind(m: MissionEntry): string {
  return m.targets !== undefined ? 'Ground strike' : 'Air-to-air';
}

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
    id: 'border-defence',
    title: 'Base Defence',
    baseId: 'bathinda',
    bandits: 6,
    objective: 'Break up a PAF raid on Bhisiana: strike, SEAD and escort.',
    situation: 'Six JF-17s are coming for Bhisiana. A strike pair is running in at low level, under the radar, with Mk 82 Snakeye bombs for the fuel depot and the technical area. A SEAD pair at 6,500 m carries MAR-1 anti-radiation missiles for our Akash battery west of the base. Two more JF-17s escort them with SD-10s. Our MR-SAM east of the base covers high and far, Akash and SPYDER the base itself; the low-level strikers are your job. Keep the fuel depot, the technical area and the Akash battery standing, and destroy the raid.',
  },
  {
    id: 'border-scramble',
    title: 'Scramble',
    baseId: 'bathinda',
    bandits: 6,
    objective: 'Scramble from the shelter and stop the raid before it reaches the base.',
    situation: 'The same raid, and you are on alert in your shelter. Start up, taxi (H for guidance), take off and find the low-level strikers before they reach the fuel depot: about five minutes out. The air defences will hold the high threats while you get airborne.',
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
