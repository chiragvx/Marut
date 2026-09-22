/**
 * src/hud/radarScope.ts
 *
 * Simplified top-down contact scope. 08-render.md section 4.7, table 5.5.
 * Reads snapshot entities directly (omniscient, cosmetic-only — see
 * 08-render.md section 9 item 4), NOT src/combat's real sensor model.
 */

import { EntityKindCode, MAX_ENTITIES, type Vec3Like } from '../contracts/core';
import type { HudSnapshotFrame } from './snapshotView';

export const RADAR_SCOPE_RANGE_M = 20000;
export const RADAR_SCOPE_RENDER_PX = 90;

export function forwardWorldFromHeading(headingRad: number): Vec3Like {
  return { x: Math.sin(headingRad), y: 0, z: -Math.cos(headingRad) };
}

export function rightWorldFromHeading(headingRad: number): Vec3Like {
  return { x: Math.cos(headingRad), y: 0, z: Math.sin(headingRad) };
}

/** Non-allocating variant of `forwardWorldFromHeading`: writes into `out` and returns it. */
export function forwardWorldFromHeadingInto(headingRad: number, out: Vec3Like): Vec3Like {
  out.x = Math.sin(headingRad);
  out.y = 0;
  out.z = -Math.cos(headingRad);
  return out;
}

/** Non-allocating variant of `rightWorldFromHeading`: writes into `out` and returns it. */
export function rightWorldFromHeadingInto(headingRad: number, out: Vec3Like): Vec3Like {
  out.x = Math.cos(headingRad);
  out.y = 0;
  out.z = Math.sin(headingRad);
  return out;
}

export interface BearingRange {
  rangeM: number;
  bearingRad: number;
}

/**
 * Non-allocating core of `computeBearingAndRange`: takes pre-computed
 * forward/right world vectors instead of a heading, so a caller iterating
 * many contacts at the same heading (e.g. `gatherRadarCandidates` below)
 * computes `forward`/`right` once and reuses them, instead of recomputing
 * and reallocating them on every candidate.
 */
export function computeBearingAndRangeFR(
  playerPos: Readonly<Vec3Like>,
  forwardWorld: Readonly<Vec3Like>,
  rightWorld: Readonly<Vec3Like>,
  contactPos: Readonly<Vec3Like>,
  out: BearingRange
): BearingRange {
  const relX = contactPos.x - playerPos.x;
  const relY = contactPos.y - playerPos.y;
  const relZ = contactPos.z - playerPos.z;
  out.rangeM = Math.sqrt(relX * relX + relY * relY + relZ * relZ);
  const dotRight = relX * rightWorld.x + relY * rightWorld.y + relZ * rightWorld.z;
  const dotForward = relX * forwardWorld.x + relY * forwardWorld.y + relZ * forwardWorld.z;
  out.bearingRad = Math.atan2(dotRight, dotForward);
  return out;
}

/** `bearingRad = atan2(dot(relWorld,rightWorld), dot(relWorld,forwardWorld))`, `rangeM = |relWorld|` (08-render.md section 4.7). */
export function computeBearingAndRange(playerPos: Readonly<Vec3Like>, headingRad: number, contactPos: Readonly<Vec3Like>, out: BearingRange): BearingRange {
  const fwd = forwardWorldFromHeading(headingRad);
  const right = rightWorldFromHeading(headingRad);
  return computeBearingAndRangeFR(playerPos, fwd, right, contactPos, out);
}

export interface RadarCandidate {
  id: number;
  team: number;
  rangeM: number;
  bearingRad: number;
}

/**
 * Sorts `candidates` ascending by `rangeM` (in place) and returns, via
 * `outCount.value`, how many of the nearest `cap` to keep. Pure/testable
 * form of the selection step (08-render.md section 4.7's pseudocode); the
 * real per-frame `drawRadarScope` below uses its own allocation-free,
 * bounded-range variant instead of calling this on its full scratch pool.
 */
export function selectNearestContacts(candidates: RadarCandidate[], cap: number, outCount: { value: number }): void {
  candidates.sort((a, b) => a.rangeM - b.rangeM);
  outCount.value = Math.min(cap, candidates.length);
}

// -----------------------------------------------------------------------------
// Hot-path gather + draw. Pre-sized scratch pool, reused every frame.
// -----------------------------------------------------------------------------

const scratchCandidates: RadarCandidate[] = [];
for (let i = 0; i < MAX_ENTITIES; i++) {
  scratchCandidates.push({ id: 0, team: 0, rangeM: 0, bearingRad: 0 });
}
const scratchPlayerPos: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchContactPos: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchBearingRange: BearingRange = { rangeM: 0, bearingRad: 0 };
/** Player heading's forward/right world vectors, recomputed once per `gatherRadarCandidates` call (not per candidate). */
const scratchForwardWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchRightWorld: Vec3Like = { x: 0, y: 0, z: 0 };

/** In-place insertion sort restricted to `[0, count)` — avoids touching stale scratch-pool entries beyond `count`. */
function sortByRangeInPlace(arr: RadarCandidate[], count: number): void {
  for (let i = 1; i < count; i++) {
    const key = arr[i]!;
    let j = i - 1;
    while (j >= 0 && arr[j]!.rangeM > key.rangeM) {
      arr[j + 1] = arr[j]!;
      j--;
    }
    arr[j + 1] = key;
  }
}

function gatherRadarCandidates(curr: HudSnapshotFrame, playerSlot: number, headingRad: number): number {
  scratchPlayerPos.x = curr.posX[playerSlot]!;
  scratchPlayerPos.y = curr.posY[playerSlot]!;
  scratchPlayerPos.z = curr.posZ[playerSlot]!;
  // headingRad is constant across this whole call, so forward/right are computed
  // once here rather than recomputed (and reallocated) per candidate below.
  forwardWorldFromHeadingInto(headingRad, scratchForwardWorld);
  rightWorldFromHeadingInto(headingRad, scratchRightWorld);

  let count = 0;
  for (let i = 0; i < curr.entityCount && count < MAX_ENTITIES; i++) {
    if (i === playerSlot) continue;
    const kind = curr.kind[i];
    if (kind !== EntityKindCode.aircraft && kind !== EntityKindCode.missile) continue;
    if (curr.alive[i] !== 1) continue;

    scratchContactPos.x = curr.posX[i]!;
    scratchContactPos.y = curr.posY[i]!;
    scratchContactPos.z = curr.posZ[i]!;
    computeBearingAndRangeFR(scratchPlayerPos, scratchForwardWorld, scratchRightWorld, scratchContactPos, scratchBearingRange);
    if (scratchBearingRange.rangeM > RADAR_SCOPE_RANGE_M) continue;

    const c = scratchCandidates[count]!;
    c.id = curr.id[i]!;
    c.team = curr.team[i]!;
    c.rangeM = scratchBearingRange.rangeM;
    c.bearingRad = scratchBearingRange.bearingRad;
    count++;
  }
  return count;
}

export function drawRadarScope(
  ctx: CanvasRenderingContext2D,
  curr: HudSnapshotFrame,
  playerSlot: number,
  headingRad: number,
  playerTeam: number,
  contactCap: number,
  centerX: number,
  centerY: number,
  radiusPx: number = RADAR_SCOPE_RENDER_PX
): void {
  ctx.save();
  ctx.strokeStyle = '#2a6b3a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radiusPx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(centerX - radiusPx, centerY);
  ctx.lineTo(centerX + radiusPx, centerY);
  ctx.moveTo(centerX, centerY - radiusPx);
  ctx.lineTo(centerX, centerY + radiusPx);
  ctx.stroke();

  if (playerSlot < 0) {
    ctx.restore();
    return;
  }

  const gathered = gatherRadarCandidates(curr, playerSlot, headingRad);
  sortByRangeInPlace(scratchCandidates, gathered);
  const shown = Math.min(contactCap, gathered);

  for (let i = 0; i < shown; i++) {
    const c = scratchCandidates[i]!;
    const scopeX = centerX + Math.sin(c.bearingRad) * (c.rangeM / RADAR_SCOPE_RANGE_M) * radiusPx;
    const scopeY = centerY - Math.cos(c.bearingRad) * (c.rangeM / RADAR_SCOPE_RANGE_M) * radiusPx;
    ctx.fillStyle = c.team === playerTeam ? '#40ff60' : '#ff4040';
    ctx.beginPath();
    ctx.arc(scopeX, scopeY, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
