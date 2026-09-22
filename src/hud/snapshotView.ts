/**
 * src/hud/snapshotView.ts
 *
 * Internal, allocation-free Float64Array parsing helpers shared by every HUD
 * widget file: header/entity/HUD-block field readers, player-index lookup,
 * target-id scan. Independent copy of src/render/snapshotInterpolation.ts's
 * ingest/id-match logic (src/hud cannot import src/render — 08-render.md
 * section 1 / section 9 item 7).
 */

import type { QuatLike, Vec3Like } from '../contracts/core';
import {
  ENTITY_INDEX_RADIX,
  HUD_BLOCK_FLOATS,
  HUD_BLOCK_START,
  MAX_ENTITIES,
  NO_ENTITY_ID,
  SNAPSHOT_HZ,
  SnapshotEntity,
  SnapshotHeader,
  entityFieldOffset,
} from '../contracts/core';
import { clamp, lerp, nlerpHud } from './mathInternal';

export interface HudSnapshotFrame {
  tick: number;
  simTimeSec: number;
  arrivalMs: number;
  entityCount: number;
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
  /** Copy of the HUD_BLOCK_FLOATS-length HUD block, curr only in practice. */
  hud: Float64Array;
}

export function createHudSnapshotFrame(): HudSnapshotFrame {
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
    hud: new Float64Array(HUD_BLOCK_FLOATS),
  };
}

/** Parses one Snapshot Float64Array `view` into `out`, allocation-free. */
export function ingestHudSnapshotFrame(view: Float64Array, out: HudSnapshotFrame, nowMs: number): void {
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
    out.alive[i] = view[entityFieldOffset(i, SnapshotEntity.ALIVE)]!;
  }

  for (let f = 0; f < HUD_BLOCK_FLOATS; f++) {
    out.hud[f] = view[HUD_BLOCK_START + f]!;
  }
}

// -----------------------------------------------------------------------------
// Entity id matching — independent copy of src/render/snapshotInterpolation.ts's
// algorithm (08-render.md section 4.1).
// -----------------------------------------------------------------------------

export interface IdMatchTable {
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

export function rebuildMatchTable(table: IdMatchTable, prev: Pick<HudSnapshotFrame, 'entityCount' | 'id'>): void {
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

export function findPrevSlot(table: IdMatchTable, prev: Pick<HudSnapshotFrame, 'id'>, currId: number): number {
  const key = currId % ENTITY_INDEX_RADIX;
  const candidate = table.hash[key]!;
  if (candidate === -1) return -1;
  return prev.id[candidate] === currId ? candidate : -1;
}

// -----------------------------------------------------------------------------
// Double buffer.
// -----------------------------------------------------------------------------

export interface HudSnapshotDoubleBuffer {
  prev: HudSnapshotFrame;
  curr: HudSnapshotFrame;
  matchTable: IdMatchTable;
  hasData: boolean;
}

export function createHudSnapshotDoubleBuffer(): HudSnapshotDoubleBuffer {
  return {
    prev: createHudSnapshotFrame(),
    curr: createHudSnapshotFrame(),
    matchTable: createIdMatchTable(),
    hasData: false,
  };
}

export function ingestSnapshotIntoHudBuffer(buf: HudSnapshotDoubleBuffer, view: Float64Array, nowMs: number): void {
  const swap = buf.prev;
  buf.prev = buf.curr;
  buf.curr = swap;
  ingestHudSnapshotFrame(view, buf.curr, nowMs);
  rebuildMatchTable(buf.matchTable, buf.prev);
  buf.hasData = true;
}

export function computeInterpFraction(nowMs: number, arrivalMs: number): number {
  return clamp((nowMs - arrivalMs) / (1000 / SNAPSHOT_HZ), 0, 1);
}

// -----------------------------------------------------------------------------
// Per-entity interpolation (position + orientation only — the HUD never needs
// elevon/gear/throttle, those are 3D-wireframe-only concerns).
// -----------------------------------------------------------------------------

export interface InterpolatedHudEntity {
  pos: Vec3Like;
  rot: QuatLike;
}

export function createInterpolatedHudEntity(): InterpolatedHudEntity {
  return { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 } };
}

const scratchPrevRot: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
const scratchCurrRot: QuatLike = { x: 0, y: 0, z: 0, w: 1 };

export function interpolateHudEntity(buf: HudSnapshotDoubleBuffer, currIdx: number, f: number, out: InterpolatedHudEntity): InterpolatedHudEntity {
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
    nlerpHud(scratchPrevRot, scratchCurrRot, f, out.rot);
  } else {
    out.pos.x = curr.posX[currIdx]!;
    out.pos.y = curr.posY[currIdx]!;
    out.pos.z = curr.posZ[currIdx]!;
    out.rot.x = curr.rotX[currIdx]!;
    out.rot.y = curr.rotY[currIdx]!;
    out.rot.z = curr.rotZ[currIdx]!;
    out.rot.w = curr.rotW[currIdx]!;
  }
  return out;
}

/** Linear scan (bounded by entityCount <= MAX_ENTITIES) for the array index of `entityId` in `curr`, or -1. */
export function findEntitySlotById(curr: Pick<HudSnapshotFrame, 'entityCount' | 'id'>, entityId: number): number {
  if (entityId === NO_ENTITY_ID) return -1;
  for (let i = 0; i < curr.entityCount; i++) {
    if (curr.id[i] === entityId) return i;
  }
  return -1;
}
