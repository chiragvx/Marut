/**
 * src/hud/targetBox.ts
 *
 * World->screen projection (shared helper, 08-render.md section 4.6), target
 * bounding box, and lead-computing sight pipper (section 4.8). `src/hud`
 * computes NO ballistics of its own — the pipper world point is read
 * straight off the Snapshot HUD block's PIPPER_* fields.
 */

import { NO_ENTITY_ID, WeaponKindCode, type Vec3Like } from '../contracts/core';
import { GUN_MAX_EFFECTIVE_RANGE_M, type CameraState } from '../contracts/render';
import { SnapshotHud } from '../contracts/core';

/** Table 5.4 (this module's own internal layout constant — not in the contract). */
export const TARGET_BOX_SIZE_PX = 40;

export interface ScreenProjection {
  xPx: number;
  yPx: number;
  visible: boolean;
}

export function createScreenProjection(): ScreenProjection {
  return { xPx: 0, yPx: 0, visible: false };
}

/**
 * 08-render.md section 4.6, exact formula. `camera.viewProjectionMatrix`
 * operates on RENDER-SPACE coordinates: `worldPosAbs - camera.originWorld`
 * is computed first.
 */
export function projectWorldToScreen(
  camera: CameraState,
  worldPosAbs: Readonly<Vec3Like>,
  canvasWidthPx: number,
  canvasHeightPx: number,
  out: ScreenProjection
): ScreenProjection {
  const lx = worldPosAbs.x - camera.originWorld.x;
  const ly = worldPosAbs.y - camera.originWorld.y;
  const lz = worldPosAbs.z - camera.originWorld.z;
  const m = camera.viewProjectionMatrix;
  const clipX = m[0]! * lx + m[4]! * ly + m[8]! * lz + m[12]!;
  const clipY = m[1]! * lx + m[5]! * ly + m[9]! * lz + m[13]!;
  const clipW = m[3]! * lx + m[7]! * ly + m[11]! * lz + m[15]!;
  if (clipW <= 1e-6) {
    out.visible = false;
    return out;
  }
  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;
  out.xPx = (ndcX * 0.5 + 0.5) * canvasWidthPx;
  out.yPx = (1 - (ndcY * 0.5 + 0.5)) * canvasHeightPx;
  out.visible = ndcX >= -1.2 && ndcX <= 1.2 && ndcY >= -1.2 && ndcY <= 1.2;
  return out;
}

// -----------------------------------------------------------------------------
// Target box.
// -----------------------------------------------------------------------------

export function drawTargetBox(
  ctx: CanvasRenderingContext2D,
  camera: CameraState,
  targetWorldPos: Readonly<Vec3Like>,
  canvasWidthPx: number,
  canvasHeightPx: number,
  rangeM: number,
  closureMps: number,
  scratch: ScreenProjection
): void {
  projectWorldToScreen(camera, targetWorldPos, canvasWidthPx, canvasHeightPx, scratch);
  if (!scratch.visible) return;

  const half = TARGET_BOX_SIZE_PX / 2;
  ctx.save();
  ctx.strokeStyle = '#ff4040';
  ctx.lineWidth = 2;
  ctx.strokeRect(scratch.xPx - half, scratch.yPx - half, TARGET_BOX_SIZE_PX, TARGET_BOX_SIZE_PX);

  ctx.fillStyle = '#ff4040';
  ctx.font = '12px monospace';
  ctx.textBaseline = 'top';
  ctx.fillText(`${rangeM.toFixed(0)}M`, scratch.xPx + half + 4, scratch.yPx - half);
  ctx.fillText(`${closureMps >= 0 ? '+' : ''}${closureMps.toFixed(0)}`, scratch.xPx + half + 4, scratch.yPx - half + 14);
  ctx.restore();
}

/** `TARGET_ID !== NO_ENTITY_ID` gate shared by callers that decide whether to look up + draw the target box. */
export function hasTarget(targetId: number): boolean {
  return targetId !== NO_ENTITY_ID;
}

// -----------------------------------------------------------------------------
// Lead-computing gunsight pipper. 08-render.md section 4.8.
// -----------------------------------------------------------------------------

export interface PipperGateFields {
  pipperValid: number;
  weaponIdx: number;
  targetRangeM: number;
  pipperX: number;
  pipperY: number;
  pipperZ: number;
}

/**
 * Reads the visibility-gated world point of the lead-sight pipper straight
 * off HUD-block fields, or returns `null` if any gate fails. Performs NO
 * ballistics of its own.
 */
export function computePipperWorldPoint(fields: Readonly<PipperGateFields>, out: Vec3Like): Vec3Like | null {
  if (fields.pipperValid === 0) return null;
  if (fields.weaponIdx !== WeaponKindCode.gun) return null;
  if (fields.targetRangeM > GUN_MAX_EFFECTIVE_RANGE_M) return null;
  out.x = fields.pipperX;
  out.y = fields.pipperY;
  out.z = fields.pipperZ;
  return out;
}

export function pipperGateFieldsFromHud(hud: Float64Array): PipperGateFields {
  return {
    pipperValid: hud[SnapshotHud.PIPPER_VALID]!,
    weaponIdx: hud[SnapshotHud.WEAPON_IDX]!,
    targetRangeM: hud[SnapshotHud.TARGET_RANGE_M]!,
    pipperX: hud[SnapshotHud.PIPPER_X]!,
    pipperY: hud[SnapshotHud.PIPPER_Y]!,
    pipperZ: hud[SnapshotHud.PIPPER_Z]!,
  };
}

const scratchPipperPoint: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchPipperProjection: ScreenProjection = { xPx: 0, yPx: 0, visible: false };

export function drawLeadSight(ctx: CanvasRenderingContext2D, camera: CameraState, hud: Float64Array, canvasWidthPx: number, canvasHeightPx: number): void {
  const fields = pipperGateFieldsFromHud(hud);
  const point = computePipperWorldPoint(fields, scratchPipperPoint);
  if (!point) return;

  projectWorldToScreen(camera, point, canvasWidthPx, canvasHeightPx, scratchPipperProjection);
  if (!scratchPipperProjection.visible) return;

  const r = 8;
  ctx.save();
  ctx.strokeStyle = '#40ff60';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(scratchPipperProjection.xPx, scratchPipperProjection.yPx, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(scratchPipperProjection.xPx - r - 6, scratchPipperProjection.yPx);
  ctx.lineTo(scratchPipperProjection.xPx - r, scratchPipperProjection.yPx);
  ctx.moveTo(scratchPipperProjection.xPx + r, scratchPipperProjection.yPx);
  ctx.lineTo(scratchPipperProjection.xPx + r + 6, scratchPipperProjection.yPx);
  ctx.stroke();
  ctx.restore();
}
