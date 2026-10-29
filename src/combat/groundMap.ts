/**
 * src/combat/groundMap.ts — the radar's ground-map mode, for the pilot's air-to-ground attacks: the
 * mission's targets ahead that would show on it, for the target key to step the designated point
 * (SPI) through (weaponStation.ts stepGroundDesignation), so a level CCRP attack needs no dive to
 * put the pipper on the target first.
 *
 * A sweep (GROUND_MAP_HZ) keeps the candidates inside the scan (GROUND_MAP_AZ_HALF_RAD either side of
 * the nose, horizontally), out to the range their return is seen at
 * (GROUND_MAP_REF_RANGE_M * (rcs / GROUND_MAP_REF_RCS_M2)^(1/4), capped at GROUND_MAP_MAX_RANGE_M),
 * with the terrain not in the way, at most MAX_GROUND_CONTACTS less the briefed aim points. A
 * target hidden behind a ridge, or too small for its range, is not on it. The list (and so the target
 * key's order) has the nearest unit of each target group first, groups nearest first, then the
 * rest nearest first: a convoy's trucks don't crowd the other targets off the map.
 *
 * Only the player's aircraft carries one (WeaponsState.groundMap); the AI strike aircraft are
 * handed their point (armStrike). Allocation-free after creation (the sweep sorts in place).
 */
import { MAX_GROUND_CONTACTS, type HeightSampler, type Vec3Like } from '../contracts/core';
import type { GroundMapCandidate, GroundMapState, WeaponsState } from '../contracts/combat';
import { terrainLineOfSight } from './lineOfSight';

export const GROUND_MAP_HZ = 1;
export const GROUND_MAP_AZ_HALF_RAD = (60 * Math.PI) / 180;
export const GROUND_MAP_MAX_RANGE_M = 40000;
/** A GROUND_MAP_REF_RCS_M2 return (a truck) shows out to this range, m. */
export const GROUND_MAP_REF_RANGE_M = 25000;
export const GROUND_MAP_REF_RCS_M2 = 10;
/** A designated point this close to a map entry is that entry, m (horizontal). */
export const GROUND_MAP_MATCH_M = 30;

export function createGroundMapState(): GroundMapState {
  const contacts: GroundMapCandidate[] = [];
  for (let i = 0; i < MAX_GROUND_CONTACTS; i++) contacts.push({ key: -1, group: -1, x: 0, y: 0, z: 0, rcsM2: 0, kind: 0 });
  return { contacts, count: 0, dueSec: 0, briefed: [] };
}

const _order: number[] = [];
const _range: number[] = [];
/** Per sorted candidate: line of sight (-1 not yet tested, 0 blocked, 1 clear); taken this sweep. */
const _los: number[] = [];
const _taken: boolean[] = [];
const _groups: number[] = [];
const _from: Vec3Like = { x: 0, y: 0, z: 0 };
const _to: Vec3Like = { x: 0, y: 0, z: 0 };

/**
 * One sweep, when due: `candidates[0..count)` are the targets that could show (src/core: the
 * mission's intact hostile ground targets). `headingRad` is the aircraft's heading.
 */
export function updateGroundMap(map: GroundMapState, ownPos: Readonly<Vec3Like>, headingRad: number, candidates: readonly GroundMapCandidate[], count: number, sampler: HeightSampler, dtSec: number): void {
  map.dueSec -= dtSec;
  if (map.dueSec > 0) return;
  map.dueSec = 1 / GROUND_MAP_HZ;
  const fx = Math.sin(headingRad), fz = -Math.cos(headingRad);
  const cosAz = Math.cos(GROUND_MAP_AZ_HALF_RAD);
  _order.length = 0;
  for (let i = 0; i < count; i++) {
    const c = candidates[i]!;
    const dx = c.x - ownPos.x, dz = c.z - ownPos.z;
    const r = Math.hypot(dx, dz);
    if (r < 1 || (dx * fx + dz * fz) / r < cosAz) continue;
    const seenM = Math.min(GROUND_MAP_MAX_RANGE_M, GROUND_MAP_REF_RANGE_M * Math.pow(Math.max(0.01, c.rcsM2) / GROUND_MAP_REF_RCS_M2, 0.25));
    if (r > seenM) continue;
    _range[i] = r;
    _order.push(i);
  }
  _order.sort((a, b) => _range[a]! - _range[b]!);
  const room = Math.max(0, MAX_GROUND_CONTACTS - map.briefed.length);
  _from.x = ownPos.x;
  _from.y = ownPos.y;
  _from.z = ownPos.z;
  for (let k = 0; k < _order.length; k++) {
    _los[k] = -1;
    _taken[k] = false;
  }
  _groups.length = 0;
  let n = 0;
  // First the nearest unit of each group, then the rest.
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < _order.length && n < room; k++) {
      if (_taken[k]) continue;
      const c = candidates[_order[k]!]!;
      if (pass === 0 && _groups.includes(c.group)) continue;
      if (_los[k] === -1) {
        _to.x = c.x;
        _to.y = c.y + 2;
        _to.z = c.z;
        _los[k] = terrainLineOfSight(sampler, _from, _to) ? 1 : 0;
      }
      if (_los[k] === 0) continue;
      _taken[k] = true;
      if (pass === 0) _groups.push(c.group);
      const o = map.contacts[n++]!;
      o.key = c.key;
      o.group = c.group;
      o.x = c.x;
      o.y = c.y;
      o.z = c.z;
      o.rcsM2 = c.rcsM2;
      o.kind = c.kind;
    }
  }
  map.count = n;
}

/** Where the designated point is in the map's order (briefed aim points, then contacts), or -1. */
export function designatedMapIndex(state: WeaponsState): number {
  const map = state.groundMap;
  if (!map || !state.spiValid) return -1;
  const nb = map.briefed.length;
  for (let i = 0; i < nb + map.count; i++) {
    const p = i < nb ? map.briefed[i]! : map.contacts[i - nb]!;
    if (Math.hypot(p.x - state.spi.x, p.z - state.spi.z) <= GROUND_MAP_MATCH_M) return i;
  }
  return -1;
}

/** The map contact nearest `p` within `radiusM` (horizontal), or undefined: a designation near a target snaps onto it. */
export function nearestGroundContact(map: GroundMapState, p: Readonly<Vec3Like>, radiusM: number): GroundMapCandidate | undefined {
  let best: GroundMapCandidate | undefined;
  let bestD = radiusM;
  for (let i = 0; i < map.count; i++) {
    const c = map.contacts[i]!;
    const d = Math.hypot(c.x - p.x, c.z - p.z);
    if (d <= bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
