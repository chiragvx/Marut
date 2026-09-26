/**
 * src/hud/autopilotHud.ts — the autopilot on the HUD: a mode/target line under the heading tape
 * (AP, HDG, ALT or VS with the armed altitude, A/T speed; AP OFF / A/T OFF flashing after a
 * disconnect) and bug marks on the heading, altitude and speed tapes.
 */
import { AutopilotFlag, SnapshotHud, SpeedUnit } from '../contracts/core';
import { ALT_TAPE_PX_PER_M, HEADING_TAPE_PX_PER_DEG, SPEED_TAPE_PX_PER_MPS, mpsToKnots, wrapHeadingDeg } from './tapes';

const GREEN = '#40ff60';
const DIM = 'rgba(64, 255, 96, 0.55)';
const AMBER = '#ffc040';
const RAD2DEG = 180 / Math.PI;

function fmtSpeed(mps: number, unit: SpeedUnit): string {
  return unit === SpeedUnit.Knots ? `${Math.round(mpsToKnots(mps))}` : `${Math.round(mps)}`;
}

/** The mode line, centred at (centerX, y). */
export function drawAutopilotStatus(ctx: CanvasRenderingContext2D, hud: Float64Array, centerX: number, y: number, unit: SpeedUnit, nowMs: number): void {
  const f = hud[SnapshotHud.AP_FLAGS]! | 0;
  const ap = (f & AutopilotFlag.Engaged) !== 0;
  const at = (f & AutopilotFlag.Autothrottle) !== 0;
  const blink = Math.floor(nowMs / 400) % 2 === 0;
  const parts: { text: string; color: string; box?: boolean }[] = [];
  if (ap) {
    parts.push({ text: 'AP', color: GREEN, box: true });
    parts.push({ text: `HDG ${String(Math.round(wrapHeadingDeg(hud[SnapshotHud.AP_HDG_RAD]! * RAD2DEG)) % 360).padStart(3, '0')}`, color: GREEN });
    const alt = Math.round(hud[SnapshotHud.AP_ALT_M]!);
    if ((f & AutopilotFlag.VsMode) !== 0) {
      const vs = hud[SnapshotHud.AP_VS_MPS]!;
      parts.push({ text: `VS ${vs >= 0 ? '+' : ''}${Math.round(vs)}`, color: GREEN });
      // The altitude bug: armed (will be captured) or just preset.
      parts.push({ text: `ALT ${alt}`, color: (f & AutopilotFlag.AltArmed) !== 0 ? 'white' : DIM });
    } else {
      const changing = Math.abs(hud[SnapshotHud.ALT_MSL_M]! - alt) > 30;
      parts.push({ text: `ALT${changing ? '*' : ''} ${alt}`, color: GREEN });
    }
  } else if ((f & AutopilotFlag.ApOffFlash) !== 0) {
    if (blink) parts.push({ text: 'AP OFF', color: AMBER, box: true });
  }
  if (at) parts.push({ text: `A/T ${fmtSpeed(hud[SnapshotHud.AP_SPD_MPS]!, unit)}`, color: GREEN });
  else if ((f & AutopilotFlag.AtOffFlash) !== 0 && blink) parts.push({ text: 'A/T OFF', color: AMBER, box: true });
  if (parts.length === 0) return;

  ctx.save();
  ctx.font = '12px monospace';
  ctx.textBaseline = 'middle';
  const gap = 14;
  const widths = parts.map((p) => ctx.measureText(p.text).width);
  let x = centerX - (widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1)) / 2;
  parts.forEach((p, i) => {
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, x, y);
    if (p.box) {
      ctx.strokeStyle = p.color;
      ctx.strokeRect(x - 3, y - 9, widths[i]! + 6, 18);
    }
    x += widths[i]! + gap;
  });
  ctx.restore();
}

/** A caret pointing at the tape's value line. */
function caret(ctx: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + dx - dy, y + dy - dx);
  ctx.lineTo(x + dx + dy, y + dy + dx);
  ctx.closePath();
  ctx.stroke();
}

/**
 * Bug marks on the tapes (same geometry as tapes.ts): heading on the top tape, altitude on the
 * inner edge of the right tape, speed on the inner edge of the left tape. Pinned to the tape end
 * when off-scale.
 */
export function drawAutopilotBugs(
  ctx: CanvasRenderingContext2D,
  hud: Float64Array,
  headingCenterX: number,
  headingTopY: number,
  headingHalfWidthPx: number,
  speedX: number,
  altX: number,
  tapeCenterY: number,
  tapeHalfHeightPx: number
): void {
  const f = hud[SnapshotHud.AP_FLAGS]! | 0;
  ctx.save();
  ctx.lineWidth = 1.5;
  if ((f & AutopilotFlag.HdgBug) !== 0) {
    let d = wrapHeadingDeg(hud[SnapshotHud.AP_HDG_RAD]! * RAD2DEG - hud[SnapshotHud.HEADING_RAD]! * RAD2DEG);
    if (d > 180) d -= 360;
    const x = headingCenterX + Math.max(-headingHalfWidthPx, Math.min(headingHalfWidthPx, d * HEADING_TAPE_PX_PER_DEG));
    ctx.strokeStyle = (f & AutopilotFlag.Engaged) !== 0 ? GREEN : DIM;
    caret(ctx, x, headingTopY + 24, 0, 7);
  }
  if ((f & AutopilotFlag.AltBug) !== 0) {
    const dy = (hud[SnapshotHud.AP_ALT_M]! - hud[SnapshotHud.ALT_MSL_M]!) * ALT_TAPE_PX_PER_M;
    const y = tapeCenterY - Math.max(-tapeHalfHeightPx, Math.min(tapeHalfHeightPx, dy));
    ctx.strokeStyle = (f & AutopilotFlag.Engaged) !== 0 ? GREEN : DIM;
    caret(ctx, altX - 3, y, -8, 0);
  }
  if ((f & AutopilotFlag.SpdBug) !== 0) {
    const bug = hud[SnapshotHud.AP_SPD_MPS]!;
    const ias = hud[SnapshotHud.IAS_MPS]!;
    // The tape's px per displayed unit times units per m/s is SPEED_TAPE_PX_PER_MPS either way.
    const dy = (bug - ias) * SPEED_TAPE_PX_PER_MPS;
    const y = tapeCenterY - Math.max(-tapeHalfHeightPx, Math.min(tapeHalfHeightPx, dy));
    ctx.strokeStyle = (f & AutopilotFlag.Autothrottle) !== 0 ? GREEN : DIM;
    caret(ctx, speedX + 3, y, 8, 0);
  }
  ctx.restore();
}
