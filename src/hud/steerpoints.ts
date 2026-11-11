/**
 * src/hud/steerpoints.ts — the mission's target areas as steerpoints: each hostile ground group is
 * an amber triangle under the heading tape at its bearing with its distance (pinned to the tape's
 * edge with an arrow when outside its span), and a triangle over the area in the 3D view with its
 * name and distance. The Tejas radar sees only aircraft; this is how the pilot finds ground targets
 * (as a mission's pre-planned target points would be in the real navigation system).
 */
import type { CameraState, HudSteerpoint } from '../contracts/render';
import type { MissionGroundGroup } from '../contracts/ground';
import type { MissionObjective } from '../contracts/core';
import type { AirportLayout } from '../contracts/airport';
import { SITE_TEMPLATES } from '../catalog/groundUnits';
import { HEADING_TAPE_PX_PER_DEG } from './tapes';
import { createScreenProjection, projectWorldToScreen } from './targetBox';

const AMBER = '#ffc040';
/** Scripted objectives (src/script): apart from the amber steerpoints and red threats. */
const OBJECTIVE = '#6fe3ff';
/** Objective markers out of view are held this far inside the screen's edge, px. */
const EDGE_PX = 48;
const THREAT = '#ff5a4a';
/** Threat markers are named only within this distance. */
const THREAT_LABEL_M = 25000;
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
    const threat = !!(g.template && SITE_TEMPLATES[g.template]?.airDefence);
    out.push({ name: g.name ?? (g.template ? SITE_TEMPLATES[g.template]?.name : undefined) ?? g.id, x, y: heightAt(x, z), z, ...(threat ? { threat } : {}) });
  }
  return out;
}

/**
 * Steerpoints for a mission's structure objectives (destroy_structures): the centre of the matching
 * airbase structures (that airport, that layout group), named after the group.
 */
export function buildStructureSteerpoints(objectives: readonly MissionObjective[], layouts: readonly AirportLayout[]): HudSteerpoint[] {
  const out: HudSteerpoint[] = [];
  for (const o of objectives) {
    if (o.kind !== 'destroy_structures') continue;
    const a = layouts.find((l) => l.id === o.params.airportId);
    if (!a) continue;
    const group = o.params.group;
    const ss = (a.structures ?? []).filter((s) => group === undefined || s.group === group);
    if (ss.length === 0) continue;
    const x = ss.reduce((n, s) => n + s.worldX, 0) / ss.length;
    const z = ss.reduce((n, s) => n + s.worldZ, 0) / ss.length;
    const base = a.name.replace(/_/g, ' ');
    const name = typeof group === 'string' ? `${base} ${group.replace(/-/g, ' ')}` : base;
    out.push({ name, x, y: a.elevationM, z });
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
  let lastX = -1e9;
  for (const p of points) {
    if (p.threat) continue;
    ctx.fillStyle = ctx.strokeStyle = p.objective ? OBJECTIVE : AMBER;
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
    // Only one distance where several steerpoints sit together on the tape.
    if (Math.abs(x - lastX) < 34 && !off) continue;
    lastX = x;
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
  // Labels drawn so far (screen boxes): one that would overlap is left out.
  const drawn: number[] = [];
  const free = (x: number, y: number): boolean => {
    for (let i = 0; i < drawn.length; i += 2) if (Math.abs(drawn[i]! - x) < 110 && Math.abs(drawn[i + 1]! - y) < 34) return false;
    drawn.push(x, y);
    return true;
  };
  for (const p of points) {
    if (p.objective) {
      drawObjectiveMarker(ctx, p, camera, Math.hypot(p.x - px, p.y - py, p.z - pz), widthPx, heightPx, free);
      continue;
    }
    projectWorldToScreen(camera, p, widthPx, heightPx, scratch);
    if (!scratch.visible) continue;
    const d = Math.hypot(p.x - px, p.y - py, p.z - pz);
    const x = scratch.xPx;
    const y = scratch.yPx;
    if (p.threat) {
      // A known air-defence site: a small red diamond, named when close.
      ctx.strokeStyle = THREAT;
      ctx.fillStyle = THREAT;
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 6, y);
      ctx.closePath();
      ctx.stroke();
      if (d < THREAT_LABEL_M && free(x, y)) {
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(p.name.toUpperCase(), x, y - 10);
        ctx.textAlign = 'start';
      }
      continue;
    }
    ctx.strokeStyle = AMBER;
    ctx.fillStyle = AMBER;
    triangle(ctx, x, y, 9, false);
    if (!free(x, y)) continue;
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

/**
 * A scripted objective: a diamond over it with its name and distance; out of view (or behind), a
 * diamond and an arrow at the screen's edge, on the side to turn to.
 */
function drawObjectiveMarker(ctx: CanvasRenderingContext2D, p: HudSteerpoint, camera: CameraState, distM: number, widthPx: number, heightPx: number, free: (x: number, y: number) => boolean): void {
  const m = camera.viewProjectionMatrix;
  const lx = p.x - camera.originWorld.x;
  const ly = p.y - camera.originWorld.y;
  const lz = p.z - camera.originWorld.z;
  const cx = m[0]! * lx + m[4]! * ly + m[8]! * lz + m[12]!;
  const cy = m[1]! * lx + m[5]! * ly + m[9]! * lz + m[13]!;
  const cw = m[3]! * lx + m[7]! * ly + m[11]! * lz + m[15]!;
  const behind = cw <= 1e-6;
  // Behind the camera the projection mirrors: flip it so the arrow points the way to turn.
  let nx = behind ? -cx : cx / cw;
  let ny = behind ? -cy : cy / cw;
  const onScreen = !behind && Math.abs(nx) <= 1 && Math.abs(ny) <= 1;
  const hw = widthPx / 2;
  const hh = heightPx / 2;
  let x: number;
  let y: number;
  let ax = 0;
  let ay = 0;
  if (onScreen) {
    x = (nx * 0.5 + 0.5) * widthPx;
    y = (1 - (ny * 0.5 + 0.5)) * heightPx;
  } else {
    if (behind && Math.abs(nx) < 1e-6 && Math.abs(ny) < 1e-6) nx = 1;
    // Scale the direction from the centre out to the inset edge rectangle.
    const ex = (hw - EDGE_PX) / hw;
    const ey = (hh - EDGE_PX) / hh;
    const k = Math.min(ex / Math.max(1e-6, Math.abs(nx)), ey / Math.max(1e-6, Math.abs(ny)));
    nx *= k;
    ny *= k;
    x = hw + nx * hw;
    y = hh - ny * hh;
    const len = Math.hypot(x - hw, y - hh) || 1;
    ax = (x - hw) / len;
    ay = (y - hh) / len;
  }
  ctx.save();
  ctx.strokeStyle = OBJECTIVE;
  ctx.fillStyle = OBJECTIVE;
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 3;
  const r = onScreen ? 9 : 7;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 2, 0, Math.PI * 2);
  ctx.fill();
  if (!onScreen) {
    // The arrow, outside the diamond, pointing off-screen.
    const tx = x + ax * (r + 12);
    const ty = y + ay * (r + 12);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - ax * 9 - ay * 6, ty - ay * 9 + ax * 6);
    ctx.lineTo(tx - ax * 9 + ay * 6, ty - ay * 9 - ax * 6);
    ctx.closePath();
    ctx.fill();
  }
  // Labels only where they do not overlap another's (the first listed, the current step, wins).
  if (!free(x, y)) {
    ctx.restore();
    return;
  }
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  const below = y < 40;
  ctx.fillText(p.name.toUpperCase(), x, below ? y + r + 14 : y - r - 6);
  ctx.font = '10px monospace';
  ctx.fillText(`${km(distM)} KM`, x, below ? y + r + 26 : y + r + 14);
  ctx.restore();
}
