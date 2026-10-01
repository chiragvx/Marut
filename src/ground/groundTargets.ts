/**
 * src/ground/groundTargets.ts — every ground target in the mission (ground units and airbase
 * structures) in one table: oriented boxes with an armour class and hit points, a uniform grid for
 * spatial queries, projectile-vs-box hit tests, and the damage model (blast by scaled distance, gun
 * rounds by armour; contracts/ground.ts). Pure and deterministic; runs in the sim worker.
 *
 * Damage produces events through the `out` array: `targetState` (a static target is damaged or
 * destroyed), `groundKill` (any target destroyed, credited to the last shooter). The World keeps
 * ground-unit entities in step with their targets (hp, flags).
 */
import type { EntityId, SimEvent, Team, Vec3Like } from '../contracts/core';
import {
  BLAST_KILL_Z,
  GUN_ROUND_DAMAGE,
  PENETRATOR_HARDENED_KILL_Z,
  TargetStateCode,
  type ArmorClass,
  type WarheadProfile,
} from '../contracts/ground';

export interface GroundTarget {
  /** Index in the set. */
  key: number;
  /** Ground unit: its entity id; static target: -1. */
  entityId: EntityId;
  /** Stable id: "unit:<group>:<n>" or "<airportId>:<structureId>". */
  targetId: string;
  /** Unit type id, or structure kind. */
  typeId: string;
  /** Mission group id, or the layout's structure group. */
  groupId: string;
  team: Team;
  armor: ArmorClass;
  toughness: number;
  burnSec: number;
  /** Box centre, world m. */
  pos: Vec3Like;
  headingRad: number;
  /** Box half-extents: x along the heading, y up, z across. */
  half: Vec3Like;
  /** Hit points, 1 (intact) .. 0 (destroyed). */
  hp: number;
  state: TargetStateCode;
  /** Seconds left burning after destruction. */
  burnLeftSec: number;
  lastSourceId: EntityId | undefined;
}

/** Below this many hit points a target counts as damaged. */
export const DAMAGED_HP = 0.6;
const CELL_M = 250;

export interface GroundHit {
  key: number;
  /** Fraction along the tested segment where it enters the box. */
  t: number;
}

export class GroundTargetSet {
  readonly targets: GroundTarget[] = [];
  private readonly grid = new Map<number, number[]>();
  private readonly queryScratch: number[] = [];
  private querySerial = 0;
  private readonly seen: number[] = [];

  private readonly byEntity = new Map<EntityId, number>();

  add(t: Omit<GroundTarget, 'key' | 'hp' | 'state' | 'burnLeftSec' | 'lastSourceId'>): GroundTarget {
    const target: GroundTarget = { ...t, key: this.targets.length, hp: 1, state: TargetStateCode.Intact, burnLeftSec: 0, lastSourceId: undefined };
    this.targets.push(target);
    if (t.entityId >= 0) this.byEntity.set(t.entityId, target.key);
    this.seen.push(-1);
    const r = Math.hypot(t.half.x, t.half.z);
    for (let cx = cellOf(t.pos.x - r); cx <= cellOf(t.pos.x + r); cx++) {
      for (let cz = cellOf(t.pos.z - r); cz <= cellOf(t.pos.z + r); cz++) {
        const k = cellKey(cx, cz);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(target.key);
      }
    }
    return target;
  }

  /** Keys of targets whose grid cells overlap the square round (x, z) of half-size r (callers filter by exact distance). Reuses one array. */
  near(x: number, z: number, r: number): readonly number[] {
    const out = this.queryScratch;
    out.length = 0;
    const serial = ++this.querySerial;
    for (let cx = cellOf(x - r); cx <= cellOf(x + r); cx++) {
      for (let cz = cellOf(z - r); cz <= cellOf(z + r); cz++) {
        const list = this.grid.get(cellKey(cx, cz));
        if (!list) continue;
        for (const k of list) {
          if (this.seen[k] === serial) continue;
          this.seen[k] = serial;
          out.push(k);
        }
      }
    }
    return out;
  }

  private readonly hitScratch: GroundHit = { key: -1, t: 0 };

  /** The first intact target box the segment a -> b enters, or null. The result object is reused. */
  segmentHit(a: Vec3Like, b: Vec3Like): GroundHit | null {
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const r = Math.hypot(b.x - a.x, b.z - a.z) / 2 + 1;
    const hit = this.hitScratch;
    hit.key = -1;
    hit.t = 2;
    const keys = this.near(mx, mz, r);
    for (let i = 0; i < keys.length; i++) {
      const tg = this.targets[keys[i]!]!;
      if (tg.state === TargetStateCode.Destroyed) continue;
      const t = segmentBoxEntry(a, b, tg);
      if (t >= 0 && t < hit.t) {
        hit.key = tg.key;
        hit.t = t;
      }
    }
    return hit.key >= 0 ? hit : null;
  }

  /** One gun round strikes target `key`. */
  gunHit(key: number, sourceId: EntityId | undefined, out: SimEvent[]): void {
    const tg = this.targets[key]!;
    this.damage(tg, GUN_ROUND_DAMAGE[tg.armor] / tg.toughness, sourceId, out);
  }

  /**
   * A warhead of `w` detonates at `pos`: every target whose box is within reach takes blast damage by
   * scaled distance (1 = destroyed at BLAST_KILL_Z, falling to 0 at twice that); `directKey` (the
   * target struck, if any) is treated as at zero distance.
   */
  blast(pos: Vec3Like, w: WarheadProfile, sourceId: EntityId | undefined, out: SimEvent[], directKey = -1): void {
    const cube = Math.cbrt(Math.max(0.1, w.explosiveKg));
    const reach = 2 * BLAST_KILL_Z.soft * cube;
    const keys = this.near(pos.x, pos.z, reach);
    for (let i = 0; i < keys.length; i++) {
      const tg = this.targets[keys[i]!]!;
      if (tg.state === TargetStateCode.Destroyed) continue;
      const d = tg.key === directKey ? 0 : distanceToBox(pos, tg);
      const killZ = tg.armor === 'hardened' && w.penetrator ? PENETRATOR_HARDENED_KILL_Z : BLAST_KILL_Z[tg.armor];
      const z = d / cube;
      const dmg = Math.min(1, Math.max(0, 2 - z / killZ));
      if (dmg > 0) this.damage(tg, dmg / tg.toughness, sourceId, out);
    }
  }

  /** Whether ground unit `entityId` has been destroyed (false for anything that isn't a ground unit). */
  isDestroyed(entityId: EntityId): boolean {
    const k = this.byEntity.get(entityId);
    return k !== undefined && this.targets[k]!.state === TargetStateCode.Destroyed;
  }

  /** Burn timers (fires go out). */
  step(dtSec: number): void {
    for (const tg of this.targets) if (tg.burnLeftSec > 0) tg.burnLeftSec = Math.max(0, tg.burnLeftSec - dtSec);
  }

  /** Destroyed / total of the targets that match. */
  count(match: (t: GroundTarget) => boolean): { destroyed: number; total: number } {
    let destroyed = 0, total = 0;
    for (const tg of this.targets) {
      if (!match(tg)) continue;
      total++;
      if (tg.state === TargetStateCode.Destroyed) destroyed++;
    }
    return { destroyed, total };
  }

  private damage(tg: GroundTarget, amount: number, sourceId: EntityId | undefined, out: SimEvent[]): void {
    if (amount <= 0 || tg.state === TargetStateCode.Destroyed) return;
    if (sourceId !== undefined) tg.lastSourceId = sourceId;
    tg.hp = Math.max(0, tg.hp - amount);
    const pos = { x: tg.pos.x, y: tg.pos.y, z: tg.pos.z };
    if (tg.hp <= 1e-6) {
      tg.hp = 0;
      tg.state = TargetStateCode.Destroyed;
      tg.burnLeftSec = tg.burnSec;
      if (tg.entityId < 0) out.push({ type: 'targetState', targetId: tg.targetId, state: TargetStateCode.Destroyed, pos, ...(tg.lastSourceId !== undefined ? { sourceId: tg.lastSourceId } : {}) });
      out.push({ type: 'groundKill', entityId: tg.entityId, targetId: tg.targetId, typeId: tg.typeId, groupId: tg.groupId, team: tg.team, sourceId: tg.lastSourceId, pos, burnSec: tg.burnSec });
    } else if (tg.hp < DAMAGED_HP && tg.state === TargetStateCode.Intact) {
      tg.state = TargetStateCode.Damaged;
      if (tg.entityId < 0) out.push({ type: 'targetState', targetId: tg.targetId, state: TargetStateCode.Damaged, pos, ...(tg.lastSourceId !== undefined ? { sourceId: tg.lastSourceId } : {}) });
    }
  }
}

function cellOf(v: number): number {
  return Math.floor(v / CELL_M);
}
function cellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}

/** A world point in the target's box frame (x along its heading, z across; heading 0 = north = -z, +x east). */
function toBox(p: Vec3Like, tg: GroundTarget, out: Vec3Like): Vec3Like {
  const dx = p.x - tg.pos.x, dz = p.z - tg.pos.z;
  const s = Math.sin(tg.headingRad), c = Math.cos(tg.headingRad);
  // forward = (s, -c), right = (c, s)
  out.x = dx * s - dz * c;
  out.y = p.y - tg.pos.y;
  out.z = dx * c + dz * s;
  return out;
}

const _pa = { x: 0, y: 0, z: 0 };
const _pb = { x: 0, y: 0, z: 0 };

/** Distance from a point to the target's box (0 inside). */
export function distanceToBox(p: Vec3Like, tg: GroundTarget): number {
  toBox(p, tg, _pa);
  const ex = Math.max(0, Math.abs(_pa.x) - tg.half.x);
  const ey = Math.max(0, Math.abs(_pa.y) - tg.half.y);
  const ez = Math.max(0, Math.abs(_pa.z) - tg.half.z);
  return Math.sqrt(ex * ex + ey * ey + ez * ez);
}

/** Slab test: where along a -> b (0..1) the segment enters the target's box, or -1. */
export function segmentBoxEntry(a: Vec3Like, b: Vec3Like, tg: GroundTarget): number {
  toBox(a, tg, _pa);
  toBox(b, tg, _pb);
  let t0 = 0, t1 = 1;
  for (let axis = 0; axis < 3; axis++) {
    const p0 = axis === 0 ? _pa.x : axis === 1 ? _pa.y : _pa.z;
    const p1 = axis === 0 ? _pb.x : axis === 1 ? _pb.y : _pb.z;
    const h = axis === 0 ? tg.half.x : axis === 1 ? tg.half.y : tg.half.z;
    const d = p1 - p0;
    if (Math.abs(d) < 1e-9) {
      if (p0 < -h || p0 > h) return -1;
      continue;
    }
    let ta = (-h - p0) / d, tb = (h - p0) / d;
    if (ta > tb) {
      const x = ta;
      ta = tb;
      tb = x;
    }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  return t0;
}
