/**
 * src/render/aircraftModels/c17Pose.ts — what the C-17's moving parts show, per aircraft (renderer side).
 *
 * The C-17 model (c17Model.ts) moves its parts by its source's own keyframes (trackRig.ts); this is
 * the small pose that picks them: one value per part group, with the renderer's state as input.
 *
 * Inputs, from MeshAircraftState (meshAircraftRenderer.ts):
 * - wired now: gear (gearPos), spoilers (the AirbrakeOut flag, until a deflection exists), ailerons
 *   (the roll part of elevonL/R), fans (throttle, until N1 exists);
 * - waiting for the C-17 flight model: MeshAircraftState's optional `flaps`, `slats`, `spoilers`,
 *   `reversers`, `ramp`, `troopDoors`, `crewDoor`, `n1`. Each is one line in render/scene.ts where
 *   the snapshot is copied into the state (search "C-17 HOOKUP"); until then they rest stowed.
 *
 * Engines are numbered 0..3 from the left wingtip to the right (the C-17's engines 1..4).
 */
import type { MeshAircraftState } from '../meshAircraftRenderer';

export const C17_ENGINES = 4;

export interface C17Pose {
  /** 0 = up .. 1 = down (the sim's gearPos). */
  gear: number;
  /** Deployed fraction, 0..1 (full = the model's landing setting). */
  flaps: number;
  slats: number;
  spoilers: number;
  /** Per engine, 0 stowed .. 1 deployed. */
  reversers: number[];
  /** Cargo ramp and aft door, 0 closed .. 1 open (the ramp down). */
  ramp: number;
  /** Paratroop doors, aft fuselage sides. */
  troopDoors: number;
  /** Crew entry door, forward fuselage. */
  crewDoor: number;
  /** Ailerons, rad, + = trailing edge down. */
  aileronL: number;
  aileronR: number;
  /** Per engine fan speed (N1), 0..1, and the fan's angle, rad (accumulated). */
  n1: number[];
  fanAngle: number[];
}

export function createC17Pose(): C17Pose {
  return {
    gear: 1,
    flaps: 0,
    slats: 0,
    spoilers: 0,
    reversers: [0, 0, 0, 0],
    ramp: 0,
    troopDoors: 0,
    crewDoor: 0,
    aileronL: 0,
    aileronR: 0,
    n1: [0, 0, 0, 0],
    fanAngle: [0, 0, 0, 0],
  };
}

/** Fan N1 at idle (fraction): ground idle on the PW F117 is about a quarter of full N1. */
export const C17_IDLE_N1 = 0.25;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** The pose the renderer's state asks for (fan angles untouched). */
export function c17PoseTarget(s: Readonly<MeshAircraftState>, out: C17Pose): C17Pose {
  out.gear = clamp01(s.gearPos);
  out.flaps = clamp01(s.flaps ?? 0);
  // The C-17's slats run out with the first flap setting.
  out.slats = clamp01(s.slats ?? (out.flaps > 0 ? 1 : 0));
  out.spoilers = clamp01(s.spoilers ?? (s.airbrakeOut ? 1 : 0));
  for (let e = 0; e < C17_ENGINES; e++) {
    out.reversers[e] = clamp01(s.reversers?.[e] ?? 0);
    out.n1[e] = clamp01(s.n1?.[e] ?? C17_IDLE_N1 + (1 - C17_IDLE_N1) * clamp01(s.throttle));
  }
  out.ramp = clamp01(s.ramp ?? 0);
  out.troopDoors = clamp01(s.troopDoors ?? 0);
  out.crewDoor = clamp01(s.crewDoor ?? 0);
  // Ailerons: the roll part of the elevon commands (as the JF-17's flaperons).
  out.aileronL = (s.elevonL - s.elevonR) / 2;
  out.aileronR = (s.elevonR - s.elevonL) / 2;
  return out;
}

/** Full travel time of each group, s (the drawn parts never move faster than this). */
export const C17_TRAVEL_SEC = { flaps: 6, slats: 3, spoilers: 1, reversers: 2, ramp: 8, troopDoors: 3, crewDoor: 3 } as const;
/** Fan spin, revolutions per second per unit N1 (a picture rate: the real ~55 rev/s would strobe). */
export const C17_FAN_REV_PER_SEC = 7;
/** Fan spool rate, N1 fraction per second. */
const N1_RATE = 0.35;

function approach(cur: number, target: number, travelSec: number, dt: number): number {
  const step = dt / travelSec;
  return target > cur ? Math.min(target, cur + step) : Math.max(target, cur - step);
}

/**
 * Moves the drawn pose `cur` towards `target` over `dt` s (each group at its travel rate; gear and
 * ailerons follow at once, the sim moves them), and turns the fans. `snap` jumps straight there.
 */
export function stepC17Pose(cur: C17Pose, target: Readonly<C17Pose>, dt: number, snap: boolean): void {
  cur.gear = target.gear;
  cur.aileronL = target.aileronL;
  cur.aileronR = target.aileronR;
  const k = snap ? 1e9 : dt;
  cur.flaps = approach(cur.flaps, target.flaps, C17_TRAVEL_SEC.flaps, k);
  cur.slats = approach(cur.slats, target.slats, C17_TRAVEL_SEC.slats, k);
  cur.spoilers = approach(cur.spoilers, target.spoilers, C17_TRAVEL_SEC.spoilers, k);
  cur.ramp = approach(cur.ramp, target.ramp, C17_TRAVEL_SEC.ramp, k);
  cur.troopDoors = approach(cur.troopDoors, target.troopDoors, C17_TRAVEL_SEC.troopDoors, k);
  cur.crewDoor = approach(cur.crewDoor, target.crewDoor, C17_TRAVEL_SEC.crewDoor, k);
  for (let e = 0; e < C17_ENGINES; e++) {
    cur.reversers[e] = approach(cur.reversers[e]!, target.reversers[e]!, C17_TRAVEL_SEC.reversers, k);
    cur.n1[e] = snap ? target.n1[e]! : approach(cur.n1[e]!, target.n1[e]!, 1 / N1_RATE, dt);
    cur.fanAngle[e] = (cur.fanAngle[e]! + cur.n1[e]! * C17_FAN_REV_PER_SEC * 2 * Math.PI * dt) % (2 * Math.PI);
  }
}

/**
 * A rig group's value in the pose: deployed fraction for keyframed groups, an angle (rad) for
 * 'aileronL'/'aileronR' and 'fan0'..'fan3'. Unknown groups rest stowed (0).
 */
export function c17GroupValue(p: Readonly<C17Pose>, group: string): number {
  switch (group) {
    case 'gear':
      return p.gear;
    case 'flaps':
      return p.flaps;
    case 'slats':
      return p.slats;
    case 'spoilers':
      return p.spoilers;
    case 'ramp':
      return p.ramp;
    case 'troopDoors':
      return p.troopDoors;
    case 'crewDoor':
      return p.crewDoor;
    case 'aileronL':
      return p.aileronL;
    case 'aileronR':
      return p.aileronR;
    default: {
      const m = /^(reverser|fan)(\d)$/.exec(group);
      if (!m) return 0;
      const e = Number(m[2]);
      return m[1] === 'fan' ? (p.fanAngle[e] ?? 0) : (p.reversers[e] ?? 0);
    }
  }
}

/** A source node's pose group and how it is driven (trackRig.ts RigMode); `hide`: hidden when stowed; `split`: one mesh for all engines. */
export type C17RigGroup = { group: string; mode: 'track' | 'spin' | 'hinge'; hide?: boolean; split?: boolean };

/** Pose group of a source node, by its (three.js-sanitised) name. Engine-specific groups get their
 *  engine number later (by position). */
export function c17GroupOf(name: string): C17RigGroup | undefined {
  const n = name.toLowerCase();
  if (n.startsWith('aileron')) return { group: 'aileron', mode: 'hinge' };
  if (n.startsWith('airbreak')) return { group: 'spoilers', mode: 'track' };
  if (n.startsWith('flaps')) return { group: 'flaps', mode: 'track' };
  if (n.startsWith('wingedge')) return { group: 'slats', mode: 'track' };
  if (n.startsWith('insidepushback')) return { group: 'reverser', mode: 'track', hide: true };
  if (n.startsWith('pushback')) return { group: 'reverser', mode: 'track', split: true };
  if (n.startsWith('bearing')) return { group: 'fan', mode: 'spin' };
  if (/^(tialdoor|taildoor)/.test(n)) return { group: 'ramp', mode: 'track' };
  if (/^(backdoor|glass3)/.test(n)) return { group: 'troopDoors', mode: 'track' };
  if (/^(frontdoor|glass5)/.test(n)) return { group: 'crewDoor', mode: 'track' };
  if (/cowl/.test(n)) return { group: 'gear', mode: 'track' };
  if (/^(backlandgear|frontlandgear)/.test(n)) return { group: 'gear', mode: 'track', hide: true };
  // The one other moving part (a non-ASCII name in the source): the beam over the ramp's hinge.
  if (/^[^\x00-\x7f]/.test(n)) return { group: 'ramp', mode: 'track' };
  return undefined;
}

/** Fields a dev pose override may set (c17PoseOverride). */
export interface C17PoseOverride {
  gear?: number;
  flaps?: number;
  slats?: number;
  spoilers?: number;
  reversers?: number;
  ramp?: number;
  troopDoors?: number;
  crewDoor?: number;
  n1?: number;
  /** Run every group through its travel in turn (see c17PoseCycle). */
  cycle?: boolean;
}

const OVERRIDE_KEYS: Record<string, keyof C17PoseOverride> = {
  gear: 'gear',
  flaps: 'flaps',
  slats: 'slats',
  spoilers: 'spoilers',
  rev: 'reversers',
  reversers: 'reversers',
  ramp: 'ramp',
  troop: 'troopDoors',
  troopdoors: 'troopDoors',
  door: 'crewDoor',
  crewdoor: 'crewDoor',
  n1: 'n1',
};

/**
 * Dev aid: `?pose=flaps:1,ramp:1,gear:0` (values 0..1; keys gear, flaps, slats, spoilers, rev,
 * ramp, troop, door, n1) or `?pose=cycle`. Unknown keys and bad numbers are ignored.
 */
export function parseC17PoseOverride(raw: string | null | undefined): C17PoseOverride | undefined {
  if (!raw) return undefined;
  const out: C17PoseOverride = {};
  for (const item of raw.split(',')) {
    const [k, v] = item.split(':');
    const key = (k ?? '').trim().toLowerCase();
    if (key === 'cycle') {
      out.cycle = true;
      continue;
    }
    const field = OVERRIDE_KEYS[key];
    const n = Number(v);
    if (!field || field === 'cycle' || v === undefined || !Number.isFinite(n)) continue;
    out[field] = clamp01(n);
  }
  return Object.keys(out).length ? out : undefined;
}

/** The cycle's steps: each group runs out and back in over STEP_SEC, one after another. */
export const C17_CYCLE_STEPS = ['gear', 'flaps', 'slats', 'spoilers', 'reversers', 'ramp', 'troopDoors', 'crewDoor', 'ailerons', 'n1'] as const;
export const C17_CYCLE_STEP_SEC = 6;

/** Dev cycle at time t (s): writes the step's group into `s` (others stowed, gear down). Returns the step's name. */
export function c17PoseCycle(t: number, s: MeshAircraftState): string {
  const n = C17_CYCLE_STEPS.length;
  const i = Math.floor(t / C17_CYCLE_STEP_SEC) % n;
  const ph = (t % C17_CYCLE_STEP_SEC) / C17_CYCLE_STEP_SEC;
  // Out over the first half, back over the second (held a moment at each end).
  const v = clamp01(ph < 0.5 ? (ph - 0.05) / 0.35 : (0.95 - ph) / 0.35);
  const step = C17_CYCLE_STEPS[i]!;
  s.gearPos = step === 'gear' ? 1 - v : 1;
  s.flaps = step === 'flaps' ? v : 0;
  s.slats = step === 'slats' ? v : 0;
  s.spoilers = step === 'spoilers' ? v : 0;
  s.reversers = step === 'reversers' ? [v, v, v, v] : [0, 0, 0, 0];
  s.ramp = step === 'ramp' ? v : 0;
  s.troopDoors = step === 'troopDoors' ? v : 0;
  s.crewDoor = step === 'crewDoor' ? v : 0;
  const ail = step === 'ailerons' ? 0.35 * Math.sin(ph * 2 * Math.PI) : 0;
  s.elevonL = ail;
  s.elevonR = -ail;
  s.n1 = step === 'n1' ? [v, v, v, v] : [C17_IDLE_N1, C17_IDLE_N1, C17_IDLE_N1, C17_IDLE_N1];
  return step;
}

/** Applies a static override to the state (the pose fields it names). */
export function applyC17PoseOverride(o: Readonly<C17PoseOverride>, s: MeshAircraftState): void {
  if (o.gear !== undefined) s.gearPos = o.gear;
  if (o.flaps !== undefined) s.flaps = o.flaps;
  if (o.slats !== undefined) s.slats = o.slats;
  if (o.spoilers !== undefined) s.spoilers = o.spoilers;
  if (o.reversers !== undefined) s.reversers = [o.reversers, o.reversers, o.reversers, o.reversers];
  if (o.ramp !== undefined) s.ramp = o.ramp;
  if (o.troopDoors !== undefined) s.troopDoors = o.troopDoors;
  if (o.crewDoor !== undefined) s.crewDoor = o.crewDoor;
  if (o.n1 !== undefined) s.n1 = [o.n1, o.n1, o.n1, o.n1];
}
