/**
 * src/combat/countermeasures.ts — flares and chaff: release programs, decoy flight, and the chance a
 * missile seeker is seduced by a decoy.
 *
 * Model: each press of the flare / chaff key releases a pair. A released decoy flies on its own
 * (flares fall and burn for FLARE_LIFE_SEC; chaff blooms and stops in the air within half a second, lasting
 * CHAFF_LIFE_SEC). At release, every enemy missile guiding on the aircraft gets one roll per decoy:
 *   - IR missiles (homing): (1 - seeker.flareResistance) x aspect factor (a flare competes best
 *     against a cold nose/beam aspect, worst against a hot tailpipe) x 0.6 if the afterburner is lit.
 *   - Radar missiles, active seeker only: (1 - seeker.chaffResistance) x a Doppler factor (chaff
 *     hangs in the air, so it only competes when the target is beaming, i.e. in the notch).
 * A seduced missile guides on the decoy; when the decoy burns out it has lost its target.
 * Allocation-free in the step functions.
 */
import type { EntityId, QuatLike, Vec3Like } from '../contracts/core';
import { JAMMER_CHAFF_FACTOR } from '../contracts/combat';

export type DecoyKind = 'flare' | 'chaff';

export const FLARE_LIFE_SEC = 4.0;
export const CHAFF_LIFE_SEC = 6.0;
/** Decoys released per key press. */
export const DECOYS_PER_PROGRAM = 2;
/** Seconds between programs while the key is held (one program per press otherwise). */
export const DECOY_PROGRAM_INTERVAL_SEC = 0.6;
/** Ejection speed away from the aircraft (down and to the side), m/s. */
const EJECT_SPEED_MPS = 25;
/** Flare: falls to ~40 m/s, slows with this time constant. Chaff: slows to drifting in 0.35 s. */
const FLARE_TAU_SEC = 1.5;
const FLARE_TERMINAL_MPS = 40;
const CHAFF_TAU_SEC = 0.2;
const CHAFF_FALL_MPS = 2;

export interface Decoy {
  active: boolean;
  /** Pseudo entity id (DECOY_ID_BASE + serial): missiles guide on it like on an aircraft. */
  id: EntityId;
  kind: DecoyKind;
  ownerId: EntityId;
  pos: Vec3Like;
  vel: Vec3Like;
  ageSec: number;
}

/** Decoy ids live far above any pool EntityId. */
export const DECOY_ID_BASE = 1 << 30;

export function createDecoyPool(size: number): Decoy[] {
  const out: Decoy[] = [];
  for (let i = 0; i < size; i++) out.push({ active: false, id: -1, kind: 'flare', ownerId: -1, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, ageSec: 0 });
  return out;
}

/**
 * The dispensers: flush in the underside of the rear fuselage either side of the keel, ahead of
 * the nozzle (body frame, m: +X nose, +Y up, +Z right; `side` -1 port, +1 starboard). The
 * cartridges fire out of them down and outboard, a little aft.
 */
export function dispenserBody(side: number, out: Vec3Like): Vec3Like {
  out.x = -4.25;
  out.y = -0.6;
  out.z = 0.36 * side;
  return out;
}
export function ejectDirBody(side: number, out: Vec3Like): Vec3Like {
  out.x = -0.17;
  out.y = -0.83;
  out.z = 0.53 * side;
  return out;
}

/** v rotated by unit quaternion q, into out. */
function rotateQ(q: QuatLike, v: Vec3Like, out: Vec3Like): Vec3Like {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  const vx = v.x, vy = v.y, vz = v.z;
  out.x = vx + q.w * tx + (q.y * tz - q.z * ty);
  out.y = vy + q.w * ty + (q.z * tx - q.x * tz);
  out.z = vz + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}
const _b = { x: 0, y: 0, z: 0 };
const _w = { x: 0, y: 0, z: 0 };

/**
 * Initialises decoy `d` released from an aircraft at `pos`/`vel` with attitude `rot` (body to
 * world), out of its `side` dispenser (-1 port, +1 starboard: a pair goes out either side).
 */
export function launchDecoy(d: Decoy, id: EntityId, kind: DecoyKind, ownerId: EntityId, pos: Vec3Like, vel: Vec3Like, rot: QuatLike, side: number): void {
  d.active = true;
  d.id = id;
  d.kind = kind;
  d.ownerId = ownerId;
  d.ageSec = 0;
  rotateQ(rot, dispenserBody(side, _b), _w);
  d.pos.x = pos.x + _w.x;
  d.pos.y = pos.y + _w.y;
  d.pos.z = pos.z + _w.z;
  rotateQ(rot, ejectDirBody(side, _b), _w);
  d.vel.x = vel.x + _w.x * EJECT_SPEED_MPS;
  d.vel.y = vel.y + _w.y * EJECT_SPEED_MPS;
  d.vel.z = vel.z + _w.z * EJECT_SPEED_MPS;
}

/** Advances one decoy; returns false once it has burnt out / dispersed (the caller frees it). */
export function stepDecoy(d: Decoy, dtSec: number): boolean {
  d.ageSec += dtSec;
  if (d.ageSec >= (d.kind === 'flare' ? FLARE_LIFE_SEC : CHAFF_LIFE_SEC)) {
    d.active = false;
    return false;
  }
  const tau = d.kind === 'flare' ? FLARE_TAU_SEC : CHAFF_TAU_SEC;
  const fall = d.kind === 'flare' ? FLARE_TERMINAL_MPS : CHAFF_FALL_MPS;
  const k = Math.min(1, dtSec / tau);
  d.vel.x -= d.vel.x * k;
  d.vel.y += (-fall - d.vel.y) * k;
  d.vel.z -= d.vel.z * k;
  d.pos.x += d.vel.x * dtSec;
  d.pos.y += d.vel.y * dtSec;
  d.pos.z += d.vel.z * dtSec;
  return true;
}

/** Cosine of the angle at the target between its heading and the direction to the missile (1 = missile dead ahead). */
function aspectCos(missilePos: Vec3Like, targetPos: Vec3Like, targetVel: Vec3Like): number {
  const dx = missilePos.x - targetPos.x, dy = missilePos.y - targetPos.y, dz = missilePos.z - targetPos.z;
  const d = Math.hypot(dx, dy, dz);
  const v = Math.hypot(targetVel.x, targetVel.y, targetVel.z);
  if (d < 1e-6 || v < 1e-6) return 0;
  return (dx * targetVel.x + dy * targetVel.y + dz * targetVel.z) / (d * v);
}

/** Chance one flare seduces an IR seeker (see the file header). */
export function flareSeductionChance(flareResistance: number | undefined, missilePos: Vec3Like, targetPos: Vec3Like, targetVel: Vec3Like, afterburnerOn: boolean): number {
  // Missile ahead of the target (head-on, cool nose): 1; behind it (hot tailpipe in view): 0.5.
  const aspect = 0.75 + 0.25 * aspectCos(missilePos, targetPos, targetVel);
  return (1 - (flareResistance ?? 0.5)) * aspect * (afterburnerOn ? 0.6 : 1);
}

/**
 * Chance one chaff bundle seduces an active radar seeker (see the file header). `targetJamming`: the
 * target carries a self-protection jammer, whose deception makes the chaff JAMMER_CHAFF_FACTOR times
 * likelier to take the seeker (capped at 1).
 */
export function chaffSeductionChance(chaffResistance: number | undefined, missilePos: Vec3Like, targetPos: Vec3Like, targetVel: Vec3Like, targetJamming = false): number {
  const c = aspectCos(missilePos, targetPos, targetVel);
  // 1 when beaming (no closure for the Doppler filter to separate), 0.2 nose- or tail-on.
  const notch = 0.2 + 0.8 * (1 - Math.abs(c));
  const p = (1 - (chaffResistance ?? 0.5)) * notch;
  return targetJamming ? Math.min(1, p * JAMMER_CHAFF_FACTOR) : p;
}
