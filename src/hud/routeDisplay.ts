/**
 * src/hud/routeDisplay.ts — the mission's planned route (World keeps the active steerpoint,
 * SnapshotHudExt): a caret over the heading tape at the steerpoint's bearing (pinned to the tape's
 * end when outside it), a circle over the steerpoint in the 3D view with its name and distance, and a
 * data block: steerpoint, distance, time to go, and the time over target (planned time, early/late
 * at the present groundspeed, and the groundspeed that would make it).
 */
import type { CameraState, HudRoutePoint } from '../contracts/render';
import { HUD_EXT_BASE, SnapshotHudExt, SpeedUnit } from '../contracts/core';
import { HEADING_TAPE_PX_PER_DEG, mpsToKnots } from './tapes';
import { createScreenProjection, projectWorldToScreen } from './targetBox';

const GREEN = '#40ff60';
const scratch = createScreenProjection();

const wrapDeg = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180;
const km = (m: number): string => (m < 10000 ? (m / 1000).toFixed(1) : (m / 1000).toFixed(0));
/** m:ss (or h:mm:ss), with a sign when asked. */
export function clockText(sec: number, signed = false): string {
  const s = Math.round(Math.abs(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const body = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  return signed ? `${sec < 0 ? '-' : '+'}${body}` : body;
}

const ext = (hud: Float64Array, f: number): number => hud[HUD_EXT_BASE + f] ?? 0;

/** The active steerpoint index, or -1. */
export function activeRouteIndex(hud: Float64Array, route: readonly HudRoutePoint[]): number {
  const i = ext(hud, SnapshotHudExt.ROUTE_INDEX);
  return i >= 0 && i < route.length ? i : -1;
}

/** The caret over the heading tape (topY = the tape's top). */
export function drawRouteCaret(ctx: CanvasRenderingContext2D, hud: Float64Array, route: readonly HudRoutePoint[], px: number, pz: number, headingRad: number, centerX: number, topY: number, halfWidthPx: number): void {
  if (activeRouteIndex(hud, route) < 0) return;
  const x0 = ext(hud, SnapshotHudExt.ROUTE_X), z0 = ext(hud, SnapshotHudExt.ROUTE_Z);
  const rel = wrapDeg((Math.atan2(x0 - px, -(z0 - pz)) * 180) / Math.PI - (headingRad * 180) / Math.PI);
  let x = centerX + rel * HEADING_TAPE_PX_PER_DEG;
  const off = Math.abs(x - centerX) > halfWidthPx;
  if (off) x = centerX + Math.sign(rel) * halfWidthPx;
  ctx.save();
  ctx.fillStyle = GREEN;
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (off) {
    // Pinned: an arrow pointing the way to turn.
    const s = Math.sign(rel);
    ctx.moveTo(x + s * 9, topY - 6);
    ctx.lineTo(x, topY - 11);
    ctx.lineTo(x, topY - 1);
  } else {
    ctx.moveTo(x, topY - 1);
    ctx.lineTo(x - 5, topY - 9);
    ctx.lineTo(x + 5, topY - 9);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The steerpoint in the 3D view: a circle on the ground with its name and distance. */
export function drawRouteMarker(ctx: CanvasRenderingContext2D, hud: Float64Array, route: readonly HudRoutePoint[], camera: CameraState, px: number, py: number, pz: number, widthPx: number, heightPx: number): void {
  const i = activeRouteIndex(hud, route);
  if (i < 0) return;
  const p = { x: ext(hud, SnapshotHudExt.ROUTE_X), y: ext(hud, SnapshotHudExt.ROUTE_Y), z: ext(hud, SnapshotHudExt.ROUTE_Z) };
  projectWorldToScreen(camera, p, widthPx, heightPx, scratch);
  if (!scratch.visible) return;
  const d = Math.hypot(p.x - px, p.y - py, p.z - pz);
  ctx.save();
  ctx.strokeStyle = GREEN;
  ctx.fillStyle = GREEN;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(scratch.xPx, scratch.yPx, 7, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${i + 1} ${route[i]!.name.toUpperCase()}`, scratch.xPx, scratch.yPx - 13);
  ctx.font = '10px monospace';
  ctx.fillText(`${km(d)} KM`, scratch.xPx, scratch.yPx + 21);
  ctx.restore();
}

/**
 * The route data block at (x, y), top-left aligned:
 *   STPT 3 IP
 *   12.4 KM  0:52
 *   TOT 12:40  +0:12 LATE
 *   GS 245 KT
 */
export function drawRouteData(ctx: CanvasRenderingContext2D, hud: Float64Array, route: readonly HudRoutePoint[], simTimeSec: number, px: number, pz: number, gsMps: number, unit: SpeedUnit, x: number, y: number): void {
  const i = activeRouteIndex(hud, route);
  if (i < 0) return;
  const d = Math.hypot(ext(hud, SnapshotHudExt.ROUTE_X) - px, ext(hud, SnapshotHudExt.ROUTE_Z) - pz);
  ctx.save();
  ctx.fillStyle = GREEN;
  ctx.font = '12px monospace';
  ctx.fillText(`STPT ${i + 1} ${route[i]!.name.toUpperCase()}`, x, y);
  ctx.fillText(`${km(d)} KM  ${gsMps > 30 ? clockText(d / gsMps) : '--:--'}`, x, y + 15);
  const k = ext(hud, SnapshotHudExt.TOT_INDEX);
  const tot = k >= 0 ? route[k]?.tot : undefined;
  if (tot !== undefined) {
    const delta = ext(hud, SnapshotHudExt.TOT_DELTA_SEC);
    const late = Math.abs(delta) < 5 ? 'ON TIME' : delta > 0 ? 'LATE' : 'EARLY';
    const at = k === i ? '' : ` @${k + 1}`;
    ctx.fillText(`TOT ${clockText(tot)}${at}  ${Math.abs(delta) < 5 ? '' : clockText(delta, true) + ' '}${late}`, x, y + 30);
    const req = ext(hud, SnapshotHudExt.TOT_GS_MPS);
    if (req > 0 && tot > simTimeSec) {
      const v = unit === SpeedUnit.Knots ? `${Math.round(mpsToKnots(req))} KT` : `${Math.round(req)} M/S`;
      ctx.fillText(`GS ${v}`, x, y + 45);
    }
  }
  ctx.restore();
}
