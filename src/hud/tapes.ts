/**
 * src/hud/tapes.ts
 *
 * Speed tape, altitude tape, heading tape, AoA/g digital readout.
 * 08-render.md section 4.9, table 5.6.
 */

import { SnapshotHud, SpeedUnit } from '../contracts/core';

export const SPEED_TAPE_PX_PER_MPS = 4;
export const SPEED_TAPE_MINOR_TICK_MPS = 10;
export const SPEED_TAPE_MAJOR_TICK_MPS = 50;

/** 1 knot in m/s (1 nautical mile/hour, exact by international definition). */
export const MPS_PER_KNOT = 0.514444;

/** Converts an m/s airspeed (the wire unit, SnapshotHud.IAS_MPS) to knots for display. */
export function mpsToKnots(mps: number): number {
  return mps / MPS_PER_KNOT;
}

// Same physical-speed-per-pixel density as the m/s tape (SPEED_TAPE_PX_PER_MPS), just expressed
// per knot, so switching units doesn't change how fast the tape visually scrolls for a given
// real acceleration. Minor/major tick spacing (20/100 kt) mirrors common real HUD speed-tape
// granularity rather than a direct unit-for-unit translation of the 10/50 m/s spacing above.
export const SPEED_TAPE_PX_PER_KT = SPEED_TAPE_PX_PER_MPS * MPS_PER_KNOT;
export const SPEED_TAPE_MINOR_TICK_KT = 20;
export const SPEED_TAPE_MAJOR_TICK_KT = 100;

export const ALT_TAPE_PX_PER_M = 0.6;
export const ALT_TAPE_MINOR_TICK_M = 20;
export const ALT_TAPE_MAJOR_TICK_M = 100;
export const HEADING_TAPE_PX_PER_DEG = 6;

const RAD2DEG = 180 / Math.PI;

/** Wraps a heading in degrees into `[0, 360)`. */
export function wrapHeadingDeg(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** `tickScreenY = centerY - (tickValue - currentValue) * pxPerUnit` (vertical tapes). */
export function tapeScreenCoord(tickValue: number, currentValue: number, centerCoord: number, pxPerUnit: number): number {
  return centerCoord - (tickValue - currentValue) * pxPerUnit;
}

function drawVerticalTape(
  ctx: CanvasRenderingContext2D,
  currentValue: number,
  centerX: number,
  centerY: number,
  halfHeightPx: number,
  pxPerUnit: number,
  minorTick: number,
  majorTick: number,
  labelSide: 'left' | 'right'
): void {
  ctx.save();
  ctx.strokeStyle = '#40ff60';
  ctx.fillStyle = '#40ff60';
  ctx.font = '11px monospace';
  ctx.lineWidth = 1;

  const firstTick = Math.floor((currentValue - halfHeightPx / pxPerUnit) / minorTick) * minorTick;
  const lastTick = currentValue + halfHeightPx / pxPerUnit;
  const tickX = labelSide === 'right' ? centerX : centerX;
  const dir = labelSide === 'right' ? 1 : -1;

  for (let v = firstTick; v <= lastTick; v += minorTick) {
    const y = tapeScreenCoord(v, currentValue, centerY, pxPerUnit);
    if (y < centerY - halfHeightPx || y > centerY + halfHeightPx) continue;
    const isMajor = Math.abs(v % majorTick) < 1e-6;
    const len = isMajor ? 14 : 7;
    ctx.beginPath();
    ctx.moveTo(tickX, y);
    ctx.lineTo(tickX + dir * len, y);
    ctx.stroke();
    if (isMajor) ctx.fillText(`${Math.round(v)}`, tickX + dir * (len + 4), y + 4);
  }

  // Boxed current-value readout at centre.
  ctx.strokeRect(centerX - dir * 45 - (dir > 0 ? 0 : 45), centerY - 9, 45, 18);
  ctx.fillText(`${Math.round(currentValue)}`, centerX - dir * 40 - (dir > 0 ? -2 : 40), centerY + 4);
  ctx.restore();
}

export function drawSpeedTape(
  ctx: CanvasRenderingContext2D,
  hud: Float64Array,
  centerX: number,
  centerY: number,
  halfHeightPx: number,
  unit: SpeedUnit = SpeedUnit.Mps
): void {
  const iasMps = hud[SnapshotHud.IAS_MPS]!;
  if (unit === SpeedUnit.Knots) {
    drawVerticalTape(ctx, mpsToKnots(iasMps), centerX, centerY, halfHeightPx, SPEED_TAPE_PX_PER_KT, SPEED_TAPE_MINOR_TICK_KT, SPEED_TAPE_MAJOR_TICK_KT, 'left');
  } else {
    drawVerticalTape(ctx, iasMps, centerX, centerY, halfHeightPx, SPEED_TAPE_PX_PER_MPS, SPEED_TAPE_MINOR_TICK_MPS, SPEED_TAPE_MAJOR_TICK_MPS, 'left');
  }
  // Small unit tag just below the boxed readout (that box spans [centerX, centerX+45] for the
  // 'left'-labelled tape drawVerticalTape always uses here) so switching units in Settings is
  // visible on the HUD itself, not just a guess from the number's scale.
  ctx.save();
  ctx.fillStyle = '#40ff60';
  ctx.font = '9px monospace';
  ctx.fillText(unit === SpeedUnit.Knots ? 'KT' : 'M/S', centerX + 10, centerY + 22);
  ctx.restore();
}

export function drawAltitudeTape(ctx: CanvasRenderingContext2D, hud: Float64Array, centerX: number, centerY: number, halfHeightPx: number): void {
  drawVerticalTape(ctx, hud[SnapshotHud.ALT_MSL_M]!, centerX, centerY, halfHeightPx, ALT_TAPE_PX_PER_M, ALT_TAPE_MINOR_TICK_M, ALT_TAPE_MAJOR_TICK_M, 'right');
}

export function drawHeadingTape(ctx: CanvasRenderingContext2D, hud: Float64Array, centerX: number, topY: number, halfWidthPx: number): void {
  const headingDeg = wrapHeadingDeg(hud[SnapshotHud.HEADING_RAD]! * RAD2DEG);
  ctx.save();
  ctx.strokeStyle = '#40ff60';
  ctx.fillStyle = '#40ff60';
  ctx.font = '11px monospace';

  const firstTick = Math.floor((headingDeg - halfWidthPx / HEADING_TAPE_PX_PER_DEG) / 10) * 10;
  const lastTick = headingDeg + halfWidthPx / HEADING_TAPE_PX_PER_DEG;
  for (let h = firstTick; h <= lastTick; h += 10) {
    const wrapped = wrapHeadingDeg(h);
    const x = centerX - (h - headingDeg) * HEADING_TAPE_PX_PER_DEG;
    if (x < centerX - halfWidthPx || x > centerX + halfWidthPx) continue;
    ctx.beginPath();
    ctx.moveTo(x, topY);
    ctx.lineTo(x, topY + 8);
    ctx.stroke();
    ctx.fillText(`${Math.round(wrapped)}`, x - 8, topY + 20);
  }
  ctx.strokeRect(centerX - 20, topY - 2, 40, 18);
  ctx.fillText(`${Math.round(headingDeg)}`, centerX - 12, topY + 12);
  ctx.restore();
}

export function drawAoaGReadout(ctx: CanvasRenderingContext2D, hud: Float64Array, xPx: number, yPx: number): void {
  const aoaDeg = hud[SnapshotHud.AOA_RAD]! * RAD2DEG;
  const g = hud[SnapshotHud.G_LOAD]!;
  ctx.save();
  ctx.fillStyle = '#40ff60';
  ctx.font = '12px monospace';
  ctx.fillText(`AOA ${aoaDeg.toFixed(1)}`, xPx, yPx);
  ctx.fillText(`G ${g.toFixed(1)}`, xPx, yPx + 16);
  ctx.restore();
}

/**
 * Throttle % and afterburner-engaged cue. Added because the HUD previously gave the player NO
 * indication of throttle setting or afterburner state at all — engine.ts's afterburner detent
 * only engages when PilotInputs.afterburner (a separate key from the 0..1 throttle axis) is held
 * AND throttle is already at/near max, and every sim-check-validated performance target (Vmax,
 * climb rate, takeoff roll) assumes afterburner is engaged, so a player flying military-power-only
 * without ever knowing afterburner exists as a separate control would reasonably perceive the
 * aircraft as underpowered. `throttleFrac`/`afterburnerOn` come straight off the player's own
 * entity block in the raw snapshot (SnapshotEntity.THROTTLE/AFTERBURNER_ON) — not the HUD block,
 * which has no afterburner field (see hudCanvas.ts's ingestSnapshot for how these are read).
 */
/** Clamps a raw throttle fraction to [0,1] and rounds to an integer percent for display. */
export function throttlePercent(throttleFrac: number): number {
  return Math.round(Math.max(0, Math.min(1, throttleFrac)) * 100);
}

export function drawPowerIndicator(ctx: CanvasRenderingContext2D, throttleFrac: number, afterburnerOn: boolean, xPx: number, yPx: number): void {
  const pct = throttlePercent(throttleFrac);
  ctx.save();
  ctx.font = '12px monospace';
  ctx.fillStyle = '#40ff60';
  ctx.fillText(`THR ${pct}%`, xPx, yPx);
  if (afterburnerOn) {
    ctx.fillStyle = '#ff9040';
    ctx.fillText('AB', xPx, yPx + 16);
  }
  ctx.restore();
}
