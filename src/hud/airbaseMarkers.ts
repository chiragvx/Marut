/**
 * src/hud/airbaseMarkers.ts — navigation markers for the mission's airbases.
 *
 * - Heading tape: every airbase at its bearing, just under the tape (friendly: a green circle,
 *   hostile: a red diamond) with its distance in km; one outside the tape's span sits at the edge
 *   with an arrow, so the player knows which way to turn.
 * - Friendly airbases: a diamond over the field in the 3D view, with the name, distance and runways.
 * - Low over a friendly field: its runway ends labelled in 3D; on the ground there, its nearest
 *   facilities too (stands with the refuel/rearm hint on the nearest, hangars, tower, fuel depot,
 *   munitions, radar). Labels that would overlap one already drawn are skipped.
 */
import type { AirportLayout } from '../contracts/airport';
import type { CameraState, HudAirbase, HudFacility } from '../contracts/render';
import { HEADING_TAPE_PX_PER_DEG } from './tapes';
import { createScreenProjection, projectWorldToScreen } from './targetBox';

const FRIENDLY = '#40ff60';
const HOSTILE = '#ff5a4a';
const FACILITY = '#9fe8ff';
/** Facility labels show within this distance of a friendly base's reference point... */
const NEAR_BASE_M = 4000;
/** ...when on the ground or at most this high above the field. */
const LOW_OVER_FIELD_M = 300;
const FACILITY_RANGE_M = 2500;
const MAX_FACILITIES = 12;
/** A base closer than this is where the player is: it leaves the heading tape. */
const AT_BASE_M = 1500;

const scratch = createScreenProjection();

function wrapDeg(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** Bearing from (px, pz) to (x, z), degrees, world heading convention (0 = north = -Z, 90 = east). */
function bearingDeg(px: number, pz: number, x: number, z: number): number {
  return (Math.atan2(x - px, -(z - pz)) * 180) / Math.PI;
}

function km(m: number): string {
  const k = m / 1000;
  return k < 10 ? k.toFixed(1) : k.toFixed(0);
}

/** Symbols under the heading tape (same geometry as drawHeadingTape). */
export function drawAirbaseTape(
  ctx: CanvasRenderingContext2D,
  bases: readonly HudAirbase[],
  px: number,
  pz: number,
  headingRad: number,
  centerX: number,
  topY: number,
  halfWidthPx: number
): void {
  if (bases.length === 0) return;
  const headingDeg = (headingRad * 180) / Math.PI;
  const y0 = topY + 31;
  // Bases pinned to the tape's edges stack downwards instead of overlapping.
  const pinned = [0, 0];
  ctx.save();
  ctx.font = '10px monospace';
  ctx.lineWidth = 1.5;
  for (const b of bases) {
    const d = Math.hypot(b.x - px, b.z - pz);
    if (d < AT_BASE_M) continue;
    const col = b.side === 'hostile' ? HOSTILE : FRIENDLY;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    const rel = wrapDeg(bearingDeg(px, pz, b.x, b.z) - headingDeg);
    let x = centerX + rel * HEADING_TAPE_PX_PER_DEG;
    const off = Math.abs(x - centerX) > halfWidthPx - 6;
    let y = y0;
    if (off) {
      const k = rel > 0 ? 1 : 0;
      y = y0 + 13 * pinned[k]!;
      pinned[k]!++;
      // Pinned to the tape's edge with an arrow pointing the way to turn.
      const s = Math.sign(rel);
      x = centerX + s * (halfWidthPx - 6);
      ctx.beginPath();
      ctx.moveTo(x + s * 8, y);
      ctx.lineTo(x + s * 2, y - 4);
      ctx.lineTo(x + s * 2, y + 4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    if (b.side === 'hostile') {
      ctx.moveTo(x, y - 5);
      ctx.lineTo(x + 5, y);
      ctx.lineTo(x, y + 5);
      ctx.lineTo(x - 5, y);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    const text = km(d);
    const tx = off && rel > 0 ? x - 10 - ctx.measureText(text).width : x + 8;
    ctx.fillText(text, tx, y + 4);
  }
  ctx.restore();
}

/** The friendly airbase markers in 3D, and the facility labels when on or low over one. */
export function drawAirbaseMarkers(
  ctx: CanvasRenderingContext2D,
  bases: readonly HudAirbase[],
  camera: CameraState,
  px: number,
  py: number,
  pz: number,
  onGround: boolean,
  widthPx: number,
  heightPx: number
): void {
  if (bases.length === 0) return;
  // The friendly base whose facilities are labelled (if any): the nearest one we are on or low over.
  let near: HudAirbase | undefined;
  let nearD = NEAR_BASE_M;
  for (const b of bases) {
    if (b.side === 'hostile') continue;
    const d = Math.hypot(b.x - px, b.z - pz);
    if (d < nearD && (onGround || py - b.y < LOW_OVER_FIELD_M)) {
      nearD = d;
      near = b;
    }
  }
  ctx.save();
  ctx.lineWidth = 1.5;
  for (const b of bases) {
    if (b.side === 'hostile' || b === near) continue;
    const d = Math.hypot(b.x - px, b.z - pz, b.y - py);
    projectWorldToScreen(camera, { x: b.x, y: b.y + 40, z: b.z }, widthPx, heightPx, scratch);
    if (!scratch.visible) continue;
    const x = scratch.xPx;
    const y = scratch.yPx;
    ctx.strokeStyle = FRIENDLY;
    ctx.fillStyle = FRIENDLY;
    ctx.beginPath();
    ctx.moveTo(x, y - 8);
    ctx.lineTo(x + 8, y);
    ctx.lineTo(x, y + 8);
    ctx.lineTo(x - 8, y);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(b.name.toUpperCase(), x, y - 13);
    ctx.font = '10px monospace';
    ctx.fillText(`${km(d)} KM  RWY ${b.runways}`, x, y + 20);
    ctx.textAlign = 'start';
  }
  if (near) drawFacilities(ctx, near, camera, px, pz, onGround, widthPx, heightPx);
  ctx.restore();
}

function drawFacilities(ctx: CanvasRenderingContext2D, base: HudAirbase, camera: CameraState, px: number, pz: number, onGround: boolean, widthPx: number, heightPx: number): void {
  const list: { f: HudFacility; d: number }[] = [];
  for (const f of base.facilities) {
    // Airborne (on approach) only the runway ends; the rest once on the ground.
    if (!onGround && f.kind !== 'runway') continue;
    const d = Math.hypot(f.x - px, f.z - pz);
    // Runway ends are useful from further out (lining up); the rest only nearby.
    if (d < (f.kind === 'runway' ? NEAR_BASE_M : FACILITY_RANGE_M)) list.push({ f, d });
  }
  list.sort((a, b) => a.d - b.d);
  let nearestStand = true;
  let shown = 0;
  const drawn: [number, number][] = [];
  ctx.font = '10px monospace';
  for (const { f, d } of list) {
    if (shown >= MAX_FACILITIES) break;
    projectWorldToScreen(camera, { x: f.x, y: f.y + (f.kind === 'runway' ? 2 : 6), z: f.z }, widthPx, heightPx, scratch);
    if (!scratch.visible) continue;
    // Skip a label that would overlap one already drawn (nearer ones come first).
    const lx = scratch.xPx;
    const ly = scratch.yPx;
    if (drawn.some(([ax, ay]) => Math.abs(ax - lx) < 70 && Math.abs(ay - ly) < 24)) continue;
    drawn.push([lx, ly]);
    shown++;
    const fade = f.kind === 'runway' ? 1 : 1 - Math.max(0, Math.min(1, (d - 1500) / (FACILITY_RANGE_M - 1500)));
    ctx.globalAlpha = 0.35 + 0.65 * fade;
    const col = f.kind === 'runway' ? FRIENDLY : FACILITY;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    const x = scratch.xPx;
    const y = scratch.yPx;
    // A pin: a short stem up from the spot, a small box, and the label.
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - 10);
    ctx.stroke();
    ctx.strokeRect(x - 3, y - 16, 6, 6);
    let label = f.label;
    if (f.kind === 'stand' && nearestStand) {
      nearestStand = false;
      // Servicing works on friendly stands and aprons (R): say so at the nearest one on the ground.
      if (onGround) label += '  R: REFUEL/REARM';
    }
    const dist = d < 1000 ? `${Math.round(d / 10) * 10} M` : `${km(d)} KM`;
    ctx.fillText(label, x + 6, y - 11);
    ctx.fillText(dist, x + 6, y - 1);
  }
  ctx.globalAlpha = 1;
}

/**
 * The HUD's view of the mission's airbases (non-hostile ones count as friendly: the player's
 * own). Facilities: runway ends, stands, and one label per hangar, tower, fuel depot (the tanks'
 * centre), munitions area (the magazines' centre) and radar.
 */
export function buildHudAirbases(layouts: readonly AirportLayout[]): HudAirbase[] {
  return layouts.map((a) => {
    const y = a.elevationM;
    const facilities: HudFacility[] = [];
    for (const r of a.runways) facilities.push({ kind: 'runway', label: `RWY ${r.id}`, x: r.thresholdWorldX, y, z: r.thresholdWorldZ });
    for (const p of a.parkingSpots) facilities.push({ kind: 'stand', label: p.id, x: p.worldX, y, z: p.worldZ });
    const centroid = (kinds: readonly string[], kind: HudFacility['kind'], label: string): void => {
      const s = (a.structures ?? []).filter((st) => kinds.includes(st.kind));
      if (s.length === 0) return;
      facilities.push({ kind, label, x: s.reduce((t, st) => t + st.worldX, 0) / s.length, y, z: s.reduce((t, st) => t + st.worldZ, 0) / s.length });
    };
    for (const st of a.structures ?? []) {
      if (st.kind === 'hangar') facilities.push({ kind: 'hangar', label: 'HANGAR', x: st.worldX, y, z: st.worldZ });
      else if (st.kind === 'control_tower') facilities.push({ kind: 'tower', label: 'TOWER', x: st.worldX, y, z: st.worldZ });
      else if (st.kind === 'radar') facilities.push({ kind: 'radar', label: 'RADAR', x: st.worldX, y, z: st.worldZ });
    }
    centroid(['fuel_tank', 'fuel_bund'], 'fuel', 'FUEL');
    centroid(['magazine'], 'arms', 'MUNITIONS');
    // Runway designators, a pair per strip ("08/26"), from the runway list (reciprocals follow each other).
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const r of a.runways) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (r.reciprocalId) seen.add(r.reciprocalId);
      ids.push(r.reciprocalId ? `${r.id}/${r.reciprocalId}` : r.id);
    }
    return { id: a.id, name: a.name, side: a.side === 'hostile' ? 'hostile' : 'friendly', x: a.referenceWorldX, y, z: a.referenceWorldZ, runways: ids.join(' '), facilities };
  });
}
