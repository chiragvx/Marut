/**
 * src/hud/ladder.ts
 *
 * Pitch ladder + flight-path marker. 08-render.md section 4.9, table 5.6.
 * Uses only HUD-block telemetry — independent of the 3D camera. Drawn only
 * when the active camera mode is Cockpit or Chase (caller's responsibility
 * to gate — see src/hud/hudCanvas.ts).
 */

import { SnapshotHud } from '../contracts/core';

export const HUD_BORESIGHT_FOV_VERT_DEG = 30;
export const PITCH_LADDER_RUNG_STEP_DEG = 10;
export const DEG2RAD = Math.PI / 180;

/** Pixels-per-radian scale for the boresight-referenced ladder/FPM, given the canvas height and vertical FOV span. */
export function pxPerRadFor(canvasHeightPx: number, fovVertDeg: number = HUD_BORESIGHT_FOV_VERT_DEG): number {
  return canvasHeightPx * 0.5 / (fovVertDeg * 0.5 * DEG2RAD);
}

/** Screen Y (px) for a pitch-ladder rung at `rungDeg`, given the current `pitchRad`. */
export function screenYForPitchRung(rungDeg: number, pitchRad: number, canvasHeightPx: number, fovVertDeg: number = HUD_BORESIGHT_FOV_VERT_DEG): number {
  const pxPerRad = pxPerRadFor(canvasHeightPx, fovVertDeg);
  return canvasHeightPx * 0.5 - (rungDeg * DEG2RAD - pitchRad) * pxPerRad;
}

/** Flight-path-marker screen offset from boresight centre (small-angle approximation, valid near boresight only). */
export function computeFpmOffset(betaRad: number, aoaRad: number, canvasHeightPx: number, fovVertDeg: number = HUD_BORESIGHT_FOV_VERT_DEG): { dxPx: number; dyPx: number } {
  const pxPerRad = pxPerRadFor(canvasHeightPx, fovVertDeg);
  return { dxPx: -betaRad * pxPerRad, dyPx: aoaRad * pxPerRad };
}

function drawRung(ctx: CanvasRenderingContext2D, rungDeg: number, centerX: number, yPx: number, halfWidthPx: number): void {
  const gapPx = rungDeg === 0 ? 0 : 10;
  ctx.beginPath();
  if (rungDeg < 0) {
    // Dashed below-horizon rungs: short dash pattern.
    ctx.setLineDash([6, 6]);
  } else {
    ctx.setLineDash([]);
  }
  ctx.moveTo(centerX - halfWidthPx, yPx);
  ctx.lineTo(centerX - gapPx, yPx);
  ctx.moveTo(centerX + gapPx, yPx);
  ctx.lineTo(centerX + halfWidthPx, yPx);
  ctx.stroke();
  ctx.setLineDash([]);
  if (rungDeg !== 0) {
    ctx.fillText(`${Math.abs(rungDeg)}`, centerX - halfWidthPx - 18, yPx - 5);
    ctx.fillText(`${Math.abs(rungDeg)}`, centerX + halfWidthPx + 4, yPx - 5);
  }
}

export function drawLadder(ctx: CanvasRenderingContext2D, hud: Float64Array, canvasWidthPx: number, canvasHeightPx: number): void {
  const pitchRad = hud[SnapshotHud.PITCH_RAD]!;
  const rollRad = hud[SnapshotHud.ROLL_RAD]!;
  const betaRad = hud[SnapshotHud.BETA_RAD]!;
  const aoaRad = hud[SnapshotHud.AOA_RAD]!;

  const centerX = canvasWidthPx * 0.5;
  const centerY = canvasHeightPx * 0.5;

  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(-rollRad);
  ctx.translate(-centerX, -centerY);

  ctx.strokeStyle = '#40ff60';
  ctx.fillStyle = '#40ff60';
  ctx.font = '11px monospace';
  ctx.lineWidth = 1.5;

  for (let rungDeg = -90; rungDeg <= 90; rungDeg += PITCH_LADDER_RUNG_STEP_DEG) {
    const yPx = screenYForPitchRung(rungDeg, pitchRad, canvasHeightPx);
    if (yPx < -20 || yPx > canvasHeightPx + 20) continue;
    const halfWidth = rungDeg === 0 ? 60 : 30;
    drawRung(ctx, rungDeg, centerX, yPx, halfWidth);
  }
  ctx.restore();

  // Flight-path marker (not rotated by roll — stays screen-referenced).
  const fpm = computeFpmOffset(betaRad, aoaRad, canvasHeightPx);
  const fx = centerX + fpm.dxPx;
  const fy = centerY + fpm.dyPx;
  ctx.save();
  ctx.strokeStyle = '#40ff60';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(fx, fy, 6, 0, Math.PI * 2);
  ctx.moveTo(fx - 12, fy);
  ctx.lineTo(fx - 6, fy);
  ctx.moveTo(fx + 6, fy);
  ctx.lineTo(fx + 12, fy);
  ctx.moveTo(fx, fy - 9);
  ctx.lineTo(fx, fy - 6);
  ctx.stroke();
  ctx.restore();
}
