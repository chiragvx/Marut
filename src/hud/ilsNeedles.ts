/**
 * src/hud/ilsNeedles.ts
 *
 * Localiser/glideslope needle deflection from ILS_LOC/ILS_GS. 08-render.md
 * section 4.10, table 5.6. The HUD block already carries the finished,
 * normalised [-1,1] deviation values (src/core computed them) — this widget
 * performs NO ILS math of its own.
 */

import { SnapshotHud } from '../contracts/core';
import { clamp } from './mathInternal';

export const ILS_NEEDLE_MAX_OFFSET_PX = 80;

export function ilsOffsetPx(normalizedDeviation: number): number {
  return clamp(normalizedDeviation, -1, 1) * ILS_NEEDLE_MAX_OFFSET_PX;
}

export function drawIlsNeedles(ctx: CanvasRenderingContext2D, hud: Float64Array, canvasWidthPx: number, canvasHeightPx: number): void {
  const locOffsetPx = ilsOffsetPx(hud[SnapshotHud.ILS_LOC]!);
  const gsOffsetPx = ilsOffsetPx(hud[SnapshotHud.ILS_GS]!);

  const centerX = canvasWidthPx * 0.5;
  const centerY = canvasHeightPx * 0.5;
  const barHalfLenPx = 70;

  ctx.save();
  ctx.strokeStyle = '#ffdd40';
  ctx.lineWidth = 2;

  // Localiser: vertical bar, horizontal offset.
  ctx.beginPath();
  ctx.moveTo(centerX + locOffsetPx, centerY - barHalfLenPx);
  ctx.lineTo(centerX + locOffsetPx, centerY + barHalfLenPx);
  ctx.stroke();

  // Glideslope: horizontal bar, vertical offset.
  ctx.beginPath();
  ctx.moveTo(centerX - barHalfLenPx, centerY + gsOffsetPx);
  ctx.lineTo(centerX + barHalfLenPx, centerY + gsOffsetPx);
  ctx.stroke();

  ctx.restore();
}
