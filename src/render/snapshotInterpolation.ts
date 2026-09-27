/**
 * src/render/snapshotInterpolation.ts
 *
 * Snapshot double-buffer ingest + entity id matching + lerp/nlerp, per
 * 08-render.md section 4.1. Allocation-free after construction: every typed
 * array here is pre-sized to MAX_ENTITIES once, at `createSnapshotFrame`/
 * `createIdMatchTable` time.
 */

import type { QuatLike, Vec3Like } from '../contracts/core';
import {
  ENTITY_INDEX_RADIX,
  HUD_BLOCK_FLOATS,
  HUD_BLOCK_START,
  MAX_ENTITIES,
  SNAPSHOT_HZ,
  SnapshotEntity,
  SnapshotHeader,
  entityFieldOffset,
} from '../contracts/core';
import { clamp, lerp, quatNlerp } from './mathInternal';

// -----------------------------------------------------------------------------
// SnapshotFrame: struct-of-arrays mirroring one ingested Snapshot buffer.
// -----------------------------------------------------------------------------

export interface SnapshotFrame {
  tick: number;
  simTimeSec: number;
  /** performance.now() (or an injected clock) when this frame was ingested. */
  arrivalMs: number;
  entityCount: number;
  /** Index into the arrays below, or -1. */
  playerSlot: number;
  id: Float64Array;
  kind: Uint8Array;
  team: Uint8Array;
  alive: Uint8Array;
  posX: Float64Array;
  posY: Float64Array;
  posZ: Float64Array;
  rotX: Float32Array;
  rotY: Float32Array;
  rotZ: Float32Array;
  rotW: Float32Array;
  velX: Float32Array;
  velY: Float32Array;
  velZ: Float32Array;
  elevonL: Float32Array;
  elevonR: Float32Array;
  rudder: Float32Array;
  gearPos: Float32Array;
  throttle: Float32Array;
  afterburnerOn: Uint8Array;
  flags: Float64Array;
  /** Packed stores (aircraft) / store code (missiles). */
  stores: Float64Array;
  /** Copy of the HUD_BLOCK_FLOATS-length HUD block, curr only in practice. */
  hud: Float64Array;
}

export function createSnapshotFrame(): SnapshotFrame {
  return {
    tick: 0,
    simTimeSec: 0,
    arrivalMs: 0,
    entityCount: 0,
    playerSlot: -1,
    id: new Float64Array(MAX_ENTITIES),
    kind: new Uint8Array(MAX_ENTITIES),
    team: new Uint8Array(MAX_ENTITIES),
    alive: new Uint8Array(MAX_ENTITIES),
    posX: new Float64Array(MAX_ENTITIES),
    posY: new Float64Array(MAX_ENTITIES),
    posZ: new Float64Array(MAX_ENTITIES),
    rotX: new Float32Array(MAX_ENTITIES),
    rotY: new Float32Array(MAX_ENTITIES),
    rotZ: new Float32Array(MAX_ENTITIES),
    rotW: new Float32Array(MAX_ENTITIES),
    velX: new Float32Array(MAX_ENTITIES),
    velY: new Float32Array(MAX_ENTITIES),
    velZ: new Float32Array(MAX_ENTITIES),
    elevonL: new Float32Array(MAX_ENTITIES),
    elevonR: new Float32Array(MAX_ENTITIES),
    rudder: new Float32Array(MAX_ENTITIES),
    gearPos: new Float32Array(MAX_ENTITIES),
    throttle: new Float32Array(MAX_ENTITIES),
    afterburnerOn: new Uint8Array(MAX_ENTITIES),
    flags: new Float64Array(MAX_ENTITIES),
    stores: new Float64Array(MAX_ENTITIES),
    hud: new Float64Array(HUD_BLOCK_FLOATS),
  };
}

/** 08-render.md section 4.1 steps 2-4. Writes `out` in place from `view`. */
export function ingestSnapshotFrame(view: Float64Array, out: SnapshotFrame, nowMs: number): void {
  out.tick = view[SnapshotHeader.TICK_OFFSET]!;
  out.simTimeSec = view[SnapshotHeader.SIM_TIME_SEC_OFFSET]!;
  out.entityCount = view[SnapshotHeader.ENTITY_COUNT_OFFSET]!;
  out.playerSlot = view[SnapshotHeader.PLAYER_INDEX_OFFSET]!;
  out.arrivalMs = nowMs;

  const n = out.entityCount;
  for (let i = 0; i < n; i++) {
    out.id[i] = view[entityFieldOffset(i, SnapshotEntity.ID)]!;
    out.kind[i] = view[entityFieldOffset(i, SnapshotEntity.KIND)]!;
    out.team[i] = view[entityFieldOffset(i, SnapshotEntity.TEAM)]!;
    out.posX[i] = view[entityFieldOffset(i, SnapshotEntity.POS_X)]!;
    out.posY[i] = view[entityFieldOffset(i, SnapshotEntity.POS_Y)]!;
    out.posZ[i] = view[entityFieldOffset(i, SnapshotEntity.POS_Z)]!;
    out.rotX[i] = view[entityFieldOffset(i, SnapshotEntity.ROT_X)]!;
    out.rotY[i] = view[entityFieldOffset(i, SnapshotEntity.ROT_Y)]!;
    out.rotZ[i] = view[entityFieldOffset(i, SnapshotEntity.ROT_Z)]!;
    out.rotW[i] = view[entityFieldOffset(i, SnapshotEntity.ROT_W)]!;
    out.velX[i] = view[entityFieldOffset(i, SnapshotEntity.VEL_X)]!;
    out.velY[i] = view[entityFieldOffset(i, SnapshotEntity.VEL_Y)]!;
    out.velZ[i] = view[entityFieldOffset(i, SnapshotEntity.VEL_Z)]!;
    out.alive[i] = view[entityFieldOffset(i, SnapshotEntity.ALIVE)]!;
    out.elevonL[i] = view[entityFieldOffset(i, SnapshotEntity.ELEVON_L)]!;
    out.elevonR[i] = view[entityFieldOffset(i, SnapshotEntity.ELEVON_R)]!;
    out.rudder[i] = view[entityFieldOffset(i, SnapshotEntity.RUDDER)]!;
    out.gearPos[i] = view[entityFieldOffset(i, SnapshotEntity.GEAR_POS)]!;
    out.throttle[i] = view[entityFieldOffset(i, SnapshotEntity.THROTTLE)]!;
    out.afterburnerOn[i] = view[entityFieldOffset(i, SnapshotEntity.AFTERBURNER_ON)]!;
    out.flags[i] = view[entityFieldOffset(i, SnapshotEntity.FLAGS)]!;
    out.stores[i] = view[entityFieldOffset(i, SnapshotEntity.STORES)]!;
  }

  for (let f = 0; f < HUD_BLOCK_FLOATS; f++) {
    out.hud[f] = view[HUD_BLOCK_START + f]!;
  }
}

// -----------------------------------------------------------------------------
// Entity id matching (08-render.md section 4.1's exact algorithm).
// -----------------------------------------------------------------------------

export interface IdMatchTable {
  /** key = id % ENTITY_INDEX_RADIX -> prev array index, or -1. */
  hash: Int32Array;
  touched: Int32Array;
  touchedCount: number;
}

export function createIdMatchTable(): IdMatchTable {
  return {
    hash: new Int32Array(ENTITY_INDEX_RADIX).fill(-1),
    touched: new Int32Array(MAX_ENTITIES),
    touchedCount: 0,
  };
}

/** Rebuilds `table` from `prev`'s ids. O(prev.entityCount), not O(ENTITY_INDEX_RADIX). */
export function rebuildMatchTable(table: IdMatchTable, prev: Pick<SnapshotFrame, 'entityCount' | 'id'>): void {
  for (let k = 0; k < table.touchedCount; k++) {
    table.hash[table.touched[k]!] = -1;
  }
  table.touchedCount = 0;
  for (let i = 0; i < prev.entityCount; i++) {
    const key = prev.id[i]! % ENTITY_INDEX_RADIX;
    table.hash[key] = i;
    table.touched[table.touchedCount++] = key;
  }
}

/** Returns `prev`'s array index for `currId`, or -1 (exact-id re-check rejects hash collisions). */
export function findPrevSlot(table: IdMatchTable, prev: Pick<SnapshotFrame, 'id'>, currId: number): number {
  const key = currId % ENTITY_INDEX_RADIX;
  const candidate = table.hash[key]!;
  if (candidate === -1) return -1;
  return prev.id[candidate] === currId ? candidate : -1;
}

// -----------------------------------------------------------------------------
// Double buffer.
// -----------------------------------------------------------------------------

export interface SnapshotDoubleBuffer {
  prev: SnapshotFrame;
  curr: SnapshotFrame;
  matchTable: IdMatchTable;
  /** True once at least one snapshot has been ingested. */
  hasData: boolean;
}

export function createSnapshotDoubleBuffer(): SnapshotDoubleBuffer {
  return {
    prev: createSnapshotFrame(),
    curr: createSnapshotFrame(),
    matchTable: createIdMatchTable(),
    hasData: false,
  };
}

/** 08-render.md section 4.1 `ingestSnapshot` algorithm, steps 1+5 (steps 2-4 are `ingestSnapshotFrame`). */
export function ingestSnapshotIntoBuffer(buf: SnapshotDoubleBuffer, view: Float64Array, nowMs: number): void {
  const swap = buf.prev;
  buf.prev = buf.curr;
  buf.curr = swap;
  ingestSnapshotFrame(view, buf.curr, nowMs);
  rebuildMatchTable(buf.matchTable, buf.prev);
  buf.hasData = true;
}

/**
 * `f = clamp((nowMs - arrivalMs) / (1000 / SNAPSHOT_HZ), 0, 1)` — clamped to
 * 1, never extrapolated past the newest snapshot (08-render.md section 4.1).
 */
export function computeInterpFraction(nowMs: number, arrivalMs: number): number {
  return clamp((nowMs - arrivalMs) / (1000 / SNAPSHOT_HZ), 0, 1);
}

// -----------------------------------------------------------------------------
// Per-entity interpolation.
// -----------------------------------------------------------------------------

export interface InterpolatedEntity {
  pos: Vec3Like;
  rot: QuatLike;
  vel: Vec3Like;
  elevonL: number;
  elevonR: number;
  rudder: number;
  gearPos: number;
  throttle: number;
}

export function createInterpolatedEntity(): InterpolatedEntity {
  return {
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    gearPos: 0,
    throttle: 0,
  };
}

const scratchPrevRot: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
const scratchCurrRot: QuatLike = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Interpolates `curr`'s entity at `currIdx` against its matched `prev` slot
 * (found via `buf.matchTable`) by fraction `f`. If unmatched (new spawn, or
 * first snapshot), `curr`'s raw values are used directly (no blending), per
 * 08-render.md section 4.1. Allocation-free (uses two module-scratch quats).
 */
export function interpolateEntity(buf: SnapshotDoubleBuffer, currIdx: number, f: number, out: InterpolatedEntity): InterpolatedEntity {
  const curr = buf.curr;
  const id = curr.id[currIdx]!;
  const prevSlot = findPrevSlot(buf.matchTable, buf.prev, id);

  if (prevSlot >= 0) {
    const prev = buf.prev;
    out.pos.x = lerp(prev.posX[prevSlot]!, curr.posX[currIdx]!, f);
    out.pos.y = lerp(prev.posY[prevSlot]!, curr.posY[currIdx]!, f);
    out.pos.z = lerp(prev.posZ[prevSlot]!, curr.posZ[currIdx]!, f);

    scratchPrevRot.x = prev.rotX[prevSlot]!;
    scratchPrevRot.y = prev.rotY[prevSlot]!;
    scratchPrevRot.z = prev.rotZ[prevSlot]!;
    scratchPrevRot.w = prev.rotW[prevSlot]!;
    scratchCurrRot.x = curr.rotX[currIdx]!;
    scratchCurrRot.y = curr.rotY[currIdx]!;
    scratchCurrRot.z = curr.rotZ[currIdx]!;
    scratchCurrRot.w = curr.rotW[currIdx]!;
    quatNlerp(scratchPrevRot, scratchCurrRot, f, out.rot);

    out.vel.x = lerp(prev.velX[prevSlot]!, curr.velX[currIdx]!, f);
    out.vel.y = lerp(prev.velY[prevSlot]!, curr.velY[currIdx]!, f);
    out.vel.z = lerp(prev.velZ[prevSlot]!, curr.velZ[currIdx]!, f);

    out.elevonL = lerp(prev.elevonL[prevSlot]!, curr.elevonL[currIdx]!, f);
    out.elevonR = lerp(prev.elevonR[prevSlot]!, curr.elevonR[currIdx]!, f);
    out.rudder = lerp(prev.rudder[prevSlot]!, curr.rudder[currIdx]!, f);
    out.gearPos = lerp(prev.gearPos[prevSlot]!, curr.gearPos[currIdx]!, f);
    out.throttle = lerp(prev.throttle[prevSlot]!, curr.throttle[currIdx]!, f);
  } else {
    out.pos.x = curr.posX[currIdx]!;
    out.pos.y = curr.posY[currIdx]!;
    out.pos.z = curr.posZ[currIdx]!;
    out.rot.x = curr.rotX[currIdx]!;
    out.rot.y = curr.rotY[currIdx]!;
    out.rot.z = curr.rotZ[currIdx]!;
    out.rot.w = curr.rotW[currIdx]!;
    out.vel.x = curr.velX[currIdx]!;
    out.vel.y = curr.velY[currIdx]!;
    out.vel.z = curr.velZ[currIdx]!;
    out.elevonL = curr.elevonL[currIdx]!;
    out.elevonR = curr.elevonR[currIdx]!;
    out.rudder = curr.rudder[currIdx]!;
    out.gearPos = curr.gearPos[currIdx]!;
    out.throttle = curr.throttle[currIdx]!;
  }
  return out;
}
