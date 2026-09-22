/**
 * src/hud/warnings.ts
 *
 * WarningBits -> on-screen warning text/flashers. 08-render.md section 4.9.
 * `WARNING_DISPLAY` (contracts/render.ts) is already sorted by `priority`
 * ascending.
 */

import { SnapshotHud } from '../contracts/core';
import { WARNING_DISPLAY, type WarningDisplayEntry } from '../contracts/render';

export function isWarningVisible(entry: Readonly<WarningDisplayEntry>, nowMs: number): boolean {
  return entry.flashHz === 0 || Math.floor(nowMs / (500 / entry.flashHz)) % 2 === 0;
}

const WARNING_ROW_HEIGHT_PX = 18;

export function drawWarnings(ctx: CanvasRenderingContext2D, hud: Float64Array, nowMs: number, xPx: number, yPx: number): void {
  const bits = hud[SnapshotHud.WARNING_BITS]!;
  ctx.save();
  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = '#ff4040';
  ctx.textAlign = 'center';

  let row = 0;
  for (let i = 0; i < WARNING_DISPLAY.length; i++) {
    const entry = WARNING_DISPLAY[i]!;
    if ((bits & entry.bit) === 0) continue;
    if (isWarningVisible(entry, nowMs)) {
      ctx.fillText(entry.text, xPx, yPx + row * WARNING_ROW_HEIGHT_PX);
    }
    row++;
  }
  ctx.restore();
}
