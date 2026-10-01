/**
 * src/hud/rwrDisplay.ts — the radar-warning receiver scope (the DARE EW suite's threat display): a
 * small circle with your aircraft at the centre, nose up; each hostile radar heard is its symbol at
 * its bearing — on the outer ring while it only searches, the middle ring (amber, boxed) while it
 * tracks you, the inner ring (red, circled, flashing) while it guides a missile at you. Symbols:
 * S search, EW early warning, L8 LY-80, 9 HQ-9, FM FM-90, A AAA fire control, J JF-17, F F-16.
 * MANPADS are passive: they never show (the missile-launch warning still does).
 */
import { RWR_BASE, RWR_SYMBOLS, SNAPSHOT_RWR_STRIDE, SnapshotHud, SnapshotRwr } from '../contracts/core';

const RING = [0.88, 0.6, 0.32];
const COLOR = ['#40ff60', '#ffc040', '#ff4a3a'];

export function drawRwrScope(ctx: CanvasRenderingContext2D, hud: Float64Array, cx: number, cy: number, r: number, nowMs: number): void {
  const n = Math.round(hud[SnapshotHud.RWR_COUNT] ?? 0);
  const heading = hud[SnapshotHud.HEADING_RAD] ?? 0;
  ctx.save();
  ctx.strokeStyle = 'rgba(64,255,96,0.55)';
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.46, 0, Math.PI * 2);
  ctx.stroke();
  // Own aircraft, and the cardinal ticks.
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx, cy + 5);
  ctx.moveTo(cx - 5, cy + 1);
  ctx.lineTo(cx + 5, cy + 1);
  ctx.stroke();
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.sin(a) * r, cy - Math.cos(a) * r);
    ctx.lineTo(cx + Math.sin(a) * (r - 5), cy - Math.cos(a) * (r - 5));
    ctx.stroke();
  }
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const flash = Math.floor(nowMs / 200) % 2 === 0;
  for (let k = 0; k < n; k++) {
    const o = RWR_BASE + k * SNAPSHOT_RWR_STRIDE;
    const symbol = RWR_SYMBOLS[hud[o + SnapshotRwr.SYMBOL] ?? 0] ?? '?';
    const state = Math.max(0, Math.min(2, Math.round(hud[o + SnapshotRwr.STATE] ?? 0)));
    const rel = (hud[o + SnapshotRwr.BEARING_RAD] ?? 0) - heading;
    const d = r * RING[state]!;
    const x = cx + Math.sin(rel) * d;
    const y = cy - Math.cos(rel) * d;
    if (state === 2 && !flash) continue;
    ctx.fillStyle = COLOR[state]!;
    ctx.strokeStyle = COLOR[state]!;
    ctx.fillText(symbol || '?', x, y);
    if (state === 1) ctx.strokeRect(x - 9, y - 7, 18, 14);
    if (state === 2) {
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.font = '9px monospace';
  ctx.fillStyle = 'rgba(64,255,96,0.8)';
  ctx.fillText('RWR', cx, cy + r + 9);
  ctx.restore();
}
