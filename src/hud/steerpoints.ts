/**
 * src/hud/steerpoints.ts — the mission's target areas as steerpoints: each hostile ground group is
 * an amber triangle under the heading tape at its bearing with its distance (pinned to the tape's
 * edge with an arrow when outside its span), and a triangle over the area in the 3D view with its
 * name and distance. The Tejas radar sees only aircraft; this is how the pilot finds ground targets
 * (as a mission's pre-planned target points would be in the real navigation system).
 */
import type { CameraState, HudSteerpoint } from '../contracts/render';
import type { MissionGroundGroup } from '../contracts/ground';
import { SITE_TEMPLATES } from '../catalog/groundUnits';
import { HEADING_TAPE_PX_PER_DEG } from './tapes';
import { createScreenProjection, projectWorldToScreen } from './targetBox';

const AMBER = '#ffc040';
/** Closer than this (horizontally) the steerpoint leaves the tape: the targets are under the nose. */
const AT_TARGET_M = 800;

const scratch = createScreenProjection();

const wrapDeg = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180;
const km = (m: number): string => (m < 10000 ? (m / 1000).toFixed(1) : (m / 1000).toFixed(0));

/**
 * Steerpoints for a mission's hostile ground groups: each at the centre of its units (the site
 * template's offsets rotated by the group heading), on the ground.
 */
export function buildSteerpoints(groups: readonly MissionGroundGroup[], heightAt: (x: number, z: number) => number): HudSteerpoint[] {
  const out: HudSteerpoint[] = [];
  for (const g of groups) {
    if (g.team === 0) continue;
    const units = [...(g.template ? (SITE_TEMPLATES[g.template]?.units ?? []) : []), ...(g.units ?? [])];
    let dx = 0, dz = 0;
    for (const u of units) {
      dx += u.dx;
      dz += u.dz;
    }
    const n = Math.max(1, units.length);
    dx /= n;
    dz /= n;
    const fx = Math.sin(g.headingRad), fz = -Math.cos(g.headingRad);
    const rx = Math.cos(g.headingRad), rz = Math.sin(g.headingRad);
    const x = g.pos.x + dx * fx + dz * rx;
    const z = g.pos.z + dx * fz + dz * rz;
    out.push({ name: g.name ?? (g.template ? SITE_TEMPLATES[g.template]?.name : undefined) ?? g.id, x, y: heightAt(x, z), z });
  }
  return out;
}

function triangle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: boolean): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.9, y + r * 0.6);
  ctx.lineTo(x - r * 0.9, y + r * 0.6);
  ctx.closePath();
  if (fill) ctx.fill();
  else ctx.stroke();
}

/** Steerpoints under the heading tape (one row below the airbases). */
export function drawSteerpointTape(ctx: CanvasRenderingContext2D, points: readonly HudSteerpoint[], px: number, pz: number, headingRad: number, centerX: number, topY: number, halfWidthPx: number): void {
  if (points.length === 0) return;
  const headingDeg = (headingRad * 180) / Math.PI;
  const y0 = topY + 46;
  const pinned = [0, 0];
  ctx.save();
  ctx.font = '10px monospace';
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = AMBER;
  ctx.fillStyle = AMBER;
  for (const p of points) {
    const d = Math.hypot(p.x - px, p.z - pz);
    if (d < AT_TARGET_M) continue;
    const rel = wrapDeg((Math.atan2(p.x - px, -(p.z - pz)) * 180) / Math.PI - headingDeg);
    let x = centerX + rel * HEADING_TAPE_PX_PER_DEG;
    const off = Math.abs(x - centerX) > halfWidthPx - 6;
    let y = y0;
    if (off) {
      const k = rel > 0 ? 1 : 0;
      y = y0 + 13 * pinned[k]!;
      pinned[k]!++;
      const s = Math.sign(rel);
      x = centerX + s * (halfWidthPx - 6);
      ctx.beginPath();
      ctx.moveTo(x + s * 8, y);
      ctx.lineTo(x + s * 2, y - 4);
      ctx.lineTo(x + s * 2, y + 4);
      ctx.closePath();
      ctx.fill();
    }
    triangle(ctx, x, y, 5, true);
    const text = km(d);
    const tx = off && rel > 0 ? x - 10 - ctx.measureText(text).width : x + 8;
    ctx.fillText(text, tx, y + 4);
  }
  ctx.restore();
}

/** Steerpoints in the 3D view: a triangle over each target area with its name and distance. */
export function drawSteerpointMarkers(ctx: CanvasRenderingContext2D, points: readonly HudSteerpoint[], camera: CameraState, px: number, py: number, pz: number, widthPx: number, heightPx: number): void {
  if (points.length === 0) return;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = AMBER;
  ctx.fillStyle = AMBER;
  for (const p of points) {
    projectWorldToScreen(camera, p, widthPx, heightPx, scratch);
    if (!scratch.visible) continue;
    const d = Math.hypot(p.x - px, p.y - py, p.z - pz);
    const x = scratch.xPx;
    const y = scratch.yPx;
    triangle(ctx, x, y, 9, false);
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(p.name.toUpperCase(), x, y - 14);
    ctx.font = '10px monospace';
    ctx.fillText(`${km(d)} KM`, x, y + 20);
    ctx.textAlign = 'start';
  }
  ctx.restore();
}
