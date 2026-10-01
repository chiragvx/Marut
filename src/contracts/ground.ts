/**
 * =============================================================================
 * MARUT — GROUND CONTRACT (src/contracts/ground.ts)
 * =============================================================================
 * Everything on the ground that can be seen, shot at or shoot back: unit types (vehicles, launchers,
 * radars, guns, bunkers) as catalogue data, site templates (a SAM battery, a convoy), the groups a
 * mission places, the damage model's armour classes and warheads, and the static targets an airbase
 * layout provides (shelters, hangars, fuel tanks...).
 *
 * Two kinds of ground target, one damage model:
 *   - Ground UNITS are pool entities (EntityKind 'ground'): they move, emit and shoot, so they ride
 *     in the per-tick snapshot (STORES = GROUND_TYPE_IDS code, FLAGS = GroundFlag bits).
 *   - STATIC targets (airbase structures, and mission static objects later) never move: a sim-side
 *     table with damage state, sent to the renderer as `targetState` events only when it changes.
 * Both are "ground targets" to weapons: a box with an armour class and hit points.
 *
 * Imports only './core'. Pure types and constants.
 * =============================================================================
 */
import type { EntityId, Team, Vec3Like } from './core';

// -----------------------------------------------------------------------------
// 1. Armour and warheads
// -----------------------------------------------------------------------------

/**
 * How hard a target is to damage. Blast kills out to a scaled distance Z = R / W^(1/3) (m/kg^1/3,
 * W = explosive mass) that shrinks with armour (BLAST_KILL_Z); guns barely scratch armour.
 */
export const ArmorClass = {
  /** Trucks, radars, antennas, people, parked aircraft, fuel tanks. */
  Soft: 'soft',
  /** APCs, SAM launchers, AAA guns, light buildings. */
  Light: 'light',
  /** Tanks, heavy buildings, bridges. */
  Armored: 'armored',
  /** Hardened shelters, bunkers, magazines: only a penetrating (hard-target) warhead hurts them much. */
  Hardened: 'hardened',
} as const;
export type ArmorClass = (typeof ArmorClass)[keyof typeof ArmorClass];

/** Scaled distance (m/kg^1/3) inside which a blast destroys a target outright; damage falls to 0 at twice this. */
export const BLAST_KILL_Z: Readonly<Record<ArmorClass, number>> = { soft: 9, light: 5, armored: 2.2, hardened: 0.6 };
/** A penetrating warhead (WarheadProfile.penetrator) against hardened targets uses this instead. */
export const PENETRATOR_HARDENED_KILL_Z = 2.4;
/** Hit points a single gun round removes, by armour class (hit points are 0..1). */
export const GUN_ROUND_DAMAGE: Readonly<Record<ArmorClass, number>> = { soft: 0.07, light: 0.025, armored: 0.003, hardened: 0 };

/** What a weapon's explosive does to the ground (and to aircraft parked on it). */
export interface WarheadProfile {
  /** TNT-equivalent explosive mass, kg. */
  explosiveKg: number;
  /** Hard-target penetrator (e.g. a bunker-busting bomb): reaches hardened targets. */
  penetrator?: boolean;
}

// -----------------------------------------------------------------------------
// 2. Unit types and site templates (catalogue data, src/catalog/groundUnits.ts)
// -----------------------------------------------------------------------------

export const GroundCategory = {
  Vehicle: 'vehicle',
  Armor: 'armor',
  SamLauncher: 'sam_launcher',
  Radar: 'radar',
  Aaa: 'aaa',
  Manpads: 'manpads',
  Command: 'command',
  Structure: 'structure',
} as const;
export type GroundCategory = (typeof GroundCategory)[keyof typeof GroundCategory];

export interface GroundUnitType {
  /** Catalogue id, e.g. 'truck-cargo', 'tank-mbt'. */
  id: string;
  name: string;
  category: GroundCategory;
  /** Render model id (src/render/groundModels.ts). */
  model: string;
  armor: ArmorClass;
  /** Box half-extents, m: x along its heading (length/2), y height/2, z width/2. */
  halfExtentsM: Vec3Like;
  /** Hit points multiplier (1 = the armour class's usual toughness; big buildings take several kills' worth). */
  toughness: number;
  /** How hot it looks to IR sensors, 0..1 (engine running, radar transmitter...). */
  heat: number;
  /** Radar cross-section, m^2 (for ground-mapping radar and ARMs later). */
  rcsM2: number;
  /** Top road speed, m/s (0 = static). */
  maxSpeedMps: number;
  /** Burns (fire and smoke) when destroyed, s; 0 = just a wreck. */
  burnSec: number;
  /** Launchers: missiles ready to fire; guns: bursts of ammunition; MANPADS teams: missiles. */
  rounds?: number;
}

/**
 * A site's air-defence system (SiteTemplate.airDefence): how its radars see and its launchers or
 * guns engage (src/ground/airDefence.ts). Unit roles come from their types: radar-search /
 * radar-ew = search, radar-track = engagement radar, sam_launcher = launcher, aaa = gun,
 * manpads = MANPADS team.
 */
export interface AirDefenceSystem {
  name: string;
  /** Radar-warning receiver symbol ('' = no emissions, e.g. MANPADS). */
  rwrSymbol: string;
  /** How it sees: its radars, or by eye / IR (guns without radar, MANPADS). */
  sensor: 'radar' | 'optical';
  /** The missile its launchers fire, or the gun's round (catalogue weapon id); none = a sensor-only site (EW). */
  weapon?: string;
  /** Search and engagement radar detection ranges against a 5 m^2 target, m (scale with RCS^1/4). */
  searchRangeM: number;
  trackRangeM: number;
  /** Engagement envelope: slant range, and the target's height above the site. */
  minRangeM: number;
  maxRangeM: number;
  maxAltM: number;
  /** It can't see a target lower than this above the ground (radar clutter / horizon), m. */
  minAltAglM: number;
  /** Seconds of continuous track before a firing solution. */
  lockTimeSec: number;
  /** Missiles in the air at one target at once, and seconds between launches. */
  salvo: number;
  salvoIntervalSec: number;
}

/** One unit of a site template: its type and place relative to the site's origin and heading. */
export interface SiteUnit {
  type: string;
  /** Offset, m, in the site frame: +x along the site heading, +z to its right. */
  dx: number;
  dz: number;
  /** Heading relative to the site's, rad. */
  headingRad?: number;
}

export interface SiteTemplate {
  id: string;
  name: string;
  units: readonly SiteUnit[];
  /** Air-defence sites: the system that fights with these units. */
  airDefence?: AirDefenceSystem;
}

// -----------------------------------------------------------------------------
// 3. Mission placement
// -----------------------------------------------------------------------------

/** A group of ground units a mission places: a template or explicit units, at a place and heading. */
export interface MissionGroundGroup {
  id: string;
  team: Team;
  /** SiteTemplate id; its units are placed round `pos`. */
  template?: string;
  /** Explicit units (added to the template's, if both). */
  units?: readonly SiteUnit[];
  /** Site origin, world m (y is taken from the terrain). */
  pos: { x: number; z: number };
  headingRad: number;
  /** Display name for briefings and the debrief ("SA site Alpha"). */
  name?: string;
  /** Air-defence sites: 'active' radars search all the time; 'ambush' keeps them silent until the
   *  early-warning network reports a target near the engagement envelope. Default 'active'. */
  emcon?: 'active' | 'ambush';
}

/** Objective kinds that involve ground targets (MissionObjective.kind; params below). */
export const GroundObjectiveKind = {
  /** params: { group: string, fraction?: number (default 1), types?: string (comma-separated unit type ids, e.g. 'radar-search,radar-track') } — destroy that share of a ground group (of those types). */
  DestroyGroup: 'destroy_group',
  /** params: { airportId: string, group?: string (layout group, e.g. 'fuel-depot'), fraction?: number } — destroy airbase structures. */
  DestroyStructures: 'destroy_structures',
  /** params: { group: string, fraction?: number (default 0.5) } — the mission fails if more than 1 - fraction of the group is lost. */
  ProtectGroup: 'protect_group',
  /** params: { group: string, seconds: number } — an air-defence site kept suppressed (radars silenced by ARMs or destroyed) for that long in total (SEAD). */
  SuppressGroup: 'suppress_group',
  /** params: { airportId: string, runwayId?: string } — every runway of the airport (or that one) cratered so no minimum operating strip is left. */
  CloseRunway: 'close_runway',
} as const;
export type GroundObjectiveKind = (typeof GroundObjectiveKind)[keyof typeof GroundObjectiveKind];

// -----------------------------------------------------------------------------
// 4. Snapshot / events
// -----------------------------------------------------------------------------

/** Unit type ids by code: the code a ground entity's snapshot STORES field carries. 0 = none. Append only. */
export const GROUND_TYPE_IDS: readonly string[] = [
  '',
  'truck-cargo',
  'truck-fuel',
  'apc',
  'tank-mbt',
  'sam-tel',
  'radar-search',
  'radar-track',
  'aaa-35',
  'command-post',
  'bunker',
  'building-target',
  'jeep',
  'manpads-team',
  'radar-ew',
  'sam-tel-lr',
  'sam-tel-sr',
  'generator',
];

/** Ground entities' EntityFlags bits (above the aircraft light bits, which ground units never set). */
export const GroundFlag = {
  /** Destroyed: drawn as a wreck, no longer a target. */
  Destroyed: 1 << 8,
  /** Radar transmitting (for the RWR, ARMs and the rotating antenna). */
  Emitting: 1 << 9,
  /** Burning (fire and smoke). */
  Burning: 1 << 10,
  /** Damaged (smoking) but still working. */
  Damaged: 1 << 11,
} as const;

/** Static (airbase) target states, as sent in `targetState` events. */
export const TargetStateCode = { Intact: 0, Damaged: 1, Destroyed: 2 } as const;
export type TargetStateCode = (typeof TargetStateCode)[keyof typeof TargetStateCode];

/** A static target changed state (damaged/destroyed): the renderer shows it, the debrief counts it. */
export interface TargetStateEvent {
  type: 'targetState';
  /** The static target's id: "<airportId>:<structureId>". */
  targetId: string;
  state: TargetStateCode;
  pos: Vec3Like;
  /** Who did it (last hit), if known. */
  sourceId?: EntityId;
}

/** A ground unit or static target was destroyed (the air-to-ground counterpart of `kill`). */
export interface GroundKillEvent {
  type: 'groundKill';
  /** Unit: its entity id; static target: -1 (see `targetId`). */
  entityId: EntityId;
  targetId: string;
  /** Unit type id or structure kind, and its group (mission group id / layout group). */
  typeId: string;
  groupId: string;
  team: Team;
  sourceId: EntityId | undefined;
  pos: Vec3Like;
  /** How long it burns (fire and smoke), s; 0 = no fire. */
  burnSec: number;
}

/** A weapon cratered a runway (the renderer draws the crater). */
export interface RunwayCraterEvent {
  type: 'runwayCrater';
  airportId: string;
  /** The runway (one end's id; both ends of a strip share its craters). */
  runwayId: string;
  pos: Vec3Like;
  radiusM: number;
}

/** A runway has no minimum operating strip left (aircraft cannot take off or land on it). */
export interface RunwayClosedEvent {
  type: 'runwayClosed';
  airportId: string;
  /** "15R/33L": both ends of the strip. */
  runwayName: string;
}

/** An explosion on or near the ground (bomb, missile or shell impact): the renderer's fireball, dust and crater. */
export interface GroundImpactEvent {
  type: 'groundImpact';
  pos: Vec3Like;
  explosiveKg: number;
}
