/**
 * src/hud/controlSurfaceDebug.ts
 *
 * Debug-only overlay: live elevonL/elevonR/rudder deflection as text plus a
 * small bar gauge per surface, so FCS control-law changes can be sanity-checked
 * visually while flying instead of only from tools/log traces. Toggled by
 * HudRenderer.setDebugSurfacesEnabled (off by default) — not a player-facing
 * Settings option, see hudCanvas.ts's own comment at that method.
 */

const RAD2DEG = 180 / Math.PI;

/** Fixed display range for the bar gauges, deg — comfortably past this aircraft's real authority (~25deg elevon, ~20deg rudder) so a saturated surface visibly pins the bar at its end rather than clipping off-scale. */
const GAUGE_RANGE_DEG = 30;
const GAUGE_WIDTH_PX = 90;
const GAUGE_HEIGHT_PX = 10;
const ROW_SPACING_PX = 22;

/** `deg` as a fraction of `rangeDeg`, clamped to [-1,1] — the gauge's fill amount, positive filling right of center. Pure, exported for unit testing (see this file's own comment on why the draw calls themselves aren't). */
export function gaugeFraction(deg: number, rangeDeg: number): number {
  return Math.max(-1, Math.min(1, deg / rangeDeg));
}

/** One centered bar gauge: a full-width track, a center tick, and a filled bar from center to the current value (clamped to the track). */
function drawGauge(ctx: CanvasRenderingContext2D, label: string, deg: number, xPx: number, yPx: number): void {
  const halfW = GAUGE_WIDTH_PX / 2;
  const frac = gaugeFraction(deg, GAUGE_RANGE_DEG);
  const fillW = frac * halfW;

  ctx.strokeStyle = '#2a6b3a';
  ctx.strokeRect(xPx, yPx, GAUGE_WIDTH_PX, GAUGE_HEIGHT_PX);
  ctx.fillStyle = Math.abs(frac) >= 0.98 ? '#ff5040' : '#40ff60';
  if (fillW >= 0) ctx.fillRect(xPx + halfW, yPx, fillW, GAUGE_HEIGHT_PX);
  else ctx.fillRect(xPx + halfW + fillW, yPx, -fillW, GAUGE_HEIGHT_PX);
  ctx.strokeStyle = '#40ff60';
  ctx.beginPath();
  ctx.moveTo(xPx + halfW, yPx - 2);
  ctx.lineTo(xPx + halfW, yPx + GAUGE_HEIGHT_PX + 2);
  ctx.stroke();

  ctx.fillStyle = '#40ff60';
  ctx.fillText(`${label} ${deg >= 0 ? '+' : ''}${deg.toFixed(1)}`, xPx + GAUGE_WIDTH_PX + 8, yPx + GAUGE_HEIGHT_PX - 1);
}

export function drawControlSurfaceDebug(
  ctx: CanvasRenderingContext2D,
  elevonLRad: number,
  elevonRRad: number,
  rudderRad: number,
  xPx: number,
  yPx: number
): void {
  ctx.save();
  ctx.font = '11px monospace';
  ctx.fillStyle = '#40ff60';
  ctx.fillText('CONTROL SURFACES (F9)', xPx, yPx - 6);
  drawGauge(ctx, 'ELEV-L', elevonLRad * RAD2DEG, xPx, yPx + 6);
  drawGauge(ctx, 'ELEV-R', elevonRRad * RAD2DEG, xPx, yPx + 6 + ROW_SPACING_PX);
  drawGauge(ctx, 'RUDDER', rudderRad * RAD2DEG, xPx, yPx + 6 + ROW_SPACING_PX * 2);
  ctx.restore();
}
