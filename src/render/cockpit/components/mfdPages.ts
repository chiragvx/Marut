/**
 * src/render/cockpit/components/mfdPages.ts — the multi-function display pages.
 *
 * Formats after the Tejas's BEL MFDs (photos of the LMFD/CMFD/RMFD): a deep navy background,
 * green, white and cyan symbology, the page menu along the top OSBs (WPN SNSR PFD HSI A/C), more
 * pages along the bottom (ENG FUEL FCS CAS), and page-specific functions on the side OSBs.
 * Every page draws a 512 x 512 picture from the cockpit context; nothing here is decorative-only:
 * each number is the aircraft's.
 */

import { LockStateCode, SnapshotTrackFlag, TrackIdentityCode, WarningBit, WeaponKindCode } from '../../../contracts/core';
import type { CockpitAction } from '../../../contracts/render';
import { M_TO_FT, MPS_TO_KT, apEngaged, atEngaged, fmtHdg, readTrack, storeInfoByCode, type TrackView } from '../avionics';
import { font } from '../screen';
import type { CockpitContext } from '../types';

export const MFD_BG = '#0b1238';
export const C = {
  green: '#46f070',
  white: '#e9f1f4',
  cyan: '#46d8f4',
  yellow: '#f4e04a',
  amber: '#ffa326',
  red: '#ff4636',
  magenta: '#ff5cf0',
  grey: '#7f8aa4',
  sky: '#2767c4',
  ground: '#7a4e22',
};

/** An aircraft's stores stations for the stores page: snapshot slot, station number, planform position (body m). */
export interface StationDef {
  slot: number;
  label: string;
  x: number;
  z: number;
}

export interface MfdConfig {
  /** Planform outline for the stores/fuel pages, body metres (x fwd, z right). */
  planform: readonly (readonly [number, number])[];
  stations: readonly StationDef[];
  /** Internal fuel capacity, kg; bingo, kg. */
  internalFuelKg: number;
  bingoKg: number;
  /** FCS limits for the FCS page. */
  gMax: number;
  gMin: number;
  aoaMaxDeg: number;
}

export interface MfdState {
  id: string;
  /** Radar B-sweep phase. */
  sweep: number;
}

/** A side OSB's function on a page: its legend and what pressing it does. */
export interface SideKey {
  legend: string;
  /** Returns an action for the aircraft, or null after changing cockpit state itself. */
  press: (ctx: CockpitContext) => CockpitAction | null;
  /** Shown boxed (a selected option). */
  on?: (ctx: CockpitContext) => boolean;
}

export interface MfdPage {
  name: string;
  draw(g: CanvasRenderingContext2D, W: number, H: number, ctx: CockpitContext, cfg: MfdConfig, st: MfdState): void;
  /** L1..L4 (top to bottom), R1..R4. */
  left?: (SideKey | null)[];
  right?: (SideKey | null)[];
}

export const TOP_MENU = ['WPN', 'SNSR', 'PFD', 'HSI', 'A/C'];
export const BOTTOM_MENU = ['ENG', 'FUEL', 'FCS', 'CAS', ''];
/** OSB positions as fractions of the picture: top/bottom x, side y. */
export const OSB_X = [0.14, 0.32, 0.5, 0.68, 0.86];
export const OSB_Y = [0.27, 0.42, 0.58, 0.73];

// -----------------------------------------------------------------------------
// Drawing helpers.
// -----------------------------------------------------------------------------

function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, px: number, color = C.white, align: CanvasTextAlign = 'center', bold = false): void {
  font(g, px, bold);
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}

function boxed(g: CanvasRenderingContext2D, s: string, x: number, y: number, px: number, color: string): void {
  font(g, px);
  const w = g.measureText(s).width + 8;
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.strokeRect(x - w / 2, y - px * 0.62, w, px * 1.24);
  text(g, s, x, y, px, color);
}

/** The page frame: menu legends at the OSBs, the current page boxed, side legends. */
export function drawFrame(g: CanvasRenderingContext2D, W: number, H: number, page: MfdPage, ctx: CockpitContext): void {
  const px = 17;
  TOP_MENU.forEach((m, i) => (m === page.name ? boxed(g, m, OSB_X[i]! * W, 16, px, C.white) : text(g, m, OSB_X[i]! * W, 16, px, C.white)));
  BOTTOM_MENU.forEach((m, i) => {
    if (!m) return;
    if (m === page.name) boxed(g, m, OSB_X[i]! * W, H - 16, px, C.white);
    else text(g, m, OSB_X[i]! * W, H - 16, px, C.white);
  });
  const side = (keys: (SideKey | null)[] | undefined, x: number, align: CanvasTextAlign): void => {
    keys?.forEach((k, i) => {
      if (!k) return;
      const y = OSB_Y[i]! * H;
      const lines = k.legend.split('\n');
      lines.forEach((l, j) => {
        const yy = y + (j - (lines.length - 1) / 2) * 17;
        if (k.on?.(ctx)) {
          font(g, 16);
          const w = g.measureText(l).width + 6;
          g.strokeStyle = C.white;
          g.lineWidth = 1.5;
          g.strokeRect(align === 'left' ? x - 3 : x - w + 3, yy - 10, w, 20);
        }
        text(g, l, x, yy, 16, C.white, align);
      });
    });
  };
  side(page.left, 8, 'left');
  side(page.right, W - 8, 'right');
}

function bar(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frac: number, color: string, marks: number[] = []): void {
  g.strokeStyle = C.white;
  g.lineWidth = 1.5;
  g.strokeRect(x, y, w, h);
  const f = Math.max(0, Math.min(1, frac));
  g.fillStyle = color;
  g.fillRect(x + 2, y + h - (h - 4) * f - 2, w - 4, (h - 4) * f);
  g.strokeStyle = C.yellow;
  for (const m of marks) {
    g.beginPath();
    g.moveTo(x - 4, y + h - h * m);
    g.lineTo(x + w + 4, y + h - h * m);
    g.stroke();
  }
}

const trk: TrackView = { id: 0, x: 0, y: 0, z: 0, vx: 0, vz: 0, identity: 0, flags: 0 };
const DEG = Math.PI / 180;

/** Heading-relative bearing (rad) and horizontal distance (m) from the aircraft to a world point. */
function relBearing(ctx: CockpitContext, x: number, z: number): [number, number] {
  const dx = x - ctx.f.pos.x;
  const dz = z - ctx.f.pos.z;
  const brg = Math.atan2(dx, -dz);
  return [brg - ctx.av.headingDeg * DEG, Math.hypot(dx, dz)];
}

// -----------------------------------------------------------------------------
// Pages.
// -----------------------------------------------------------------------------

const PFD: MfdPage = {
  name: 'PFD',
  draw(g, W, H, ctx) {
    const { av } = ctx;
    const cx = W / 2;
    const cy = H * 0.47;
    const ppd = 6;
    g.save();
    g.beginPath();
    g.rect(40, 34, W - 80, H - 90);
    g.clip();
    g.translate(cx, cy);
    g.rotate(-av.rollDeg * DEG);
    g.translate(0, av.pitchDeg * ppd);
    g.fillStyle = C.sky;
    g.fillRect(-600, -1400, 1200, 1400);
    g.fillStyle = C.ground;
    g.fillRect(-600, 0, 1200, 1400);
    g.strokeStyle = C.white;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-600, 0);
    g.lineTo(600, 0);
    g.stroke();
    for (let p = -80; p <= 80; p += 5) {
      if (p === 0) continue;
      const y = -p * ppd;
      const w = p % 10 === 0 ? 70 : 34;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(-w, y);
      g.lineTo(w, y);
      g.stroke();
      if (p % 10 === 0) {
        text(g, String(Math.abs(p)), -w - 16, y, 14);
        text(g, String(Math.abs(p)), w + 16, y, 14);
      }
    }
    g.restore();
    // Aircraft symbol.
    g.strokeStyle = C.yellow;
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(cx - 70, cy);
    g.lineTo(cx - 22, cy);
    g.lineTo(cx - 10, cy + 12);
    g.moveTo(cx + 70, cy);
    g.lineTo(cx + 22, cy);
    g.lineTo(cx + 10, cy + 12);
    g.stroke();
    g.fillStyle = C.yellow;
    g.fillRect(cx - 3, cy - 3, 6, 6);
    // Flight path marker.
    if (av.fpmValid) {
      const ax = Math.atan2(av.fpm.z, av.fpm.x) / DEG;
      const ay = Math.atan2(av.fpm.y, av.fpm.x) / DEG;
      const r = av.rollDeg * DEG;
      const fx = cx + (ax * Math.cos(r) + ay * Math.sin(r)) * ppd;
      const fy = cy - (ay * Math.cos(r) - ax * Math.sin(r)) * ppd;
      g.strokeStyle = C.green;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(fx, fy, 8, 0, Math.PI * 2);
      g.moveTo(fx - 8, fy);
      g.lineTo(fx - 20, fy);
      g.moveTo(fx + 8, fy);
      g.lineTo(fx + 20, fy);
      g.moveTo(fx, fy - 8);
      g.lineTo(fx, fy - 16);
      g.stroke();
    }
    // Bank scale.
    g.strokeStyle = C.white;
    g.lineWidth = 2;
    const R = 150;
    for (const b of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const a = -Math.PI / 2 + b * DEG;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.lineTo(cx + Math.cos(a) * (R + (b % 30 === 0 ? 14 : 8)), cy + Math.sin(a) * (R + (b % 30 === 0 ? 14 : 8)));
      g.stroke();
    }
    const ra = -Math.PI / 2 - av.rollDeg * DEG;
    g.fillStyle = C.white;
    g.beginPath();
    g.moveTo(cx + Math.cos(ra) * (R - 2), cy + Math.sin(ra) * (R - 2));
    g.lineTo(cx + Math.cos(ra + 0.06) * (R - 16), cy + Math.sin(ra + 0.06) * (R - 16));
    g.lineTo(cx + Math.cos(ra - 0.06) * (R - 16), cy + Math.sin(ra - 0.06) * (R - 16));
    g.fill();
    // Speed and altitude tapes.
    tape(g, 44, cy, av.iasKt, 10, 50, 'left');
    tape(g, W - 44, cy, av.altFt, 100, 500, 'right');
    text(g, `M ${av.mach.toFixed(2)}`, 76, cy + 132, 16, C.green);
    text(g, `G ${av.g.toFixed(1)}`, 76, cy + 152, 16, C.green);
    text(g, `α ${av.aoaDeg.toFixed(1)}`, 76, cy - 132, 16, C.green);
    text(g, `${av.vsFpm >= 0 ? '+' : ''}${Math.round(av.vsFpm / 10) * 10}`, W - 76, cy + 132, 16, C.green);
    if (av.aglFt < 5000) text(g, `R ${Math.round(av.aglFt)}`, W - 76, cy + 152, 16, C.green);
    // Heading.
    g.fillStyle = '#000';
    g.fillRect(cx - 34, H - 64, 68, 26);
    g.strokeStyle = C.white;
    g.strokeRect(cx - 34, H - 64, 68, 26);
    text(g, fmtHdg(av.headingDeg), cx, H - 51, 20, C.white, 'center', true);
  },
};

function tape(g: CanvasRenderingContext2D, x: number, cy: number, v: number, step: number, major: number, side: 'left' | 'right'): void {
  const w = 62;
  const x0 = side === 'left' ? x : x - w;
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(x0, cy - 110, w, 220);
  const ppu = 110 / (step * 5);
  g.save();
  g.beginPath();
  g.rect(x0, cy - 110, w, 220);
  g.clip();
  g.strokeStyle = C.white;
  g.lineWidth = 1.5;
  for (let t = Math.floor((v - step * 6) / step) * step; t <= v + step * 6; t += step) {
    const y = cy - (t - v) * ppu;
    const edge = side === 'left' ? x0 + w : x0;
    const dir = side === 'left' ? -1 : 1;
    g.beginPath();
    g.moveTo(edge, y);
    g.lineTo(edge + dir * (t % major === 0 ? 12 : 6), y);
    g.stroke();
    if (t % major === 0 && t >= 0) text(g, major >= 500 ? (t / 1000).toFixed(1) : String(t), edge + dir * 34, y, 14);
  }
  g.restore();
  g.fillStyle = '#000';
  g.fillRect(x0 - 4, cy - 15, w + 8, 30);
  g.strokeStyle = C.white;
  g.lineWidth = 2;
  g.strokeRect(x0 - 4, cy - 15, w + 8, 30);
  text(g, String(Math.round(side === 'right' ? v / 10 : v) * (side === 'right' ? 10 : 1)), x0 + w / 2, cy, 19, C.white, 'center', true);
}

const HSI: MfdPage = {
  name: 'HSI',
  left: [
    { legend: 'SCL\n▲', press: (c) => ((c.local.hsiRangeKm = Math.min(320, c.local.hsiRangeKm * 2)), null) },
    { legend: 'SCL\n▼', press: (c) => ((c.local.hsiRangeKm = Math.max(10, c.local.hsiRangeKm / 2)), null) },
    null,
    null,
  ],
  right: [{ legend: 'TAXI', press: () => ({ kind: 'taxiGuide' }) }, null, null, null],
  draw(g, W, H, ctx) {
    const { av, aux } = ctx;
    const cx = W / 2;
    const cy = H * 0.54;
    const R = 170;
    const hdg = av.headingDeg * DEG;
    const range = ctx.local.hsiRangeKm * 1000;
    // Range ring (half scale, dashed) and the rose.
    g.strokeStyle = C.grey;
    g.lineWidth = 1;
    g.setLineDash([4, 6]);
    g.beginPath();
    g.arc(cx, cy, R / 2, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = C.green;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    for (let d = 0; d < 360; d += 5) {
      const a = d * DEG - hdg;
      const len = d % 30 === 0 ? 16 : d % 10 === 0 ? 11 : 6;
      g.beginPath();
      g.moveTo(cx + Math.sin(a) * R, cy - Math.cos(a) * R);
      g.lineTo(cx + Math.sin(a) * (R - len), cy - Math.cos(a) * (R - len));
      g.stroke();
      if (d % 30 === 0) {
        const lbl = d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10);
        text(g, lbl, cx + Math.sin(a) * (R - 30), cy - Math.cos(a) * (R - 30), 16, C.green);
      }
    }
    // Lubber line and the aircraft.
    g.strokeStyle = C.white;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx, cy - R - 12);
    g.lineTo(cx, cy - R + 4);
    g.stroke();
    g.beginPath();
    g.moveTo(cx, cy - 16);
    g.lineTo(cx, cy + 16);
    g.moveTo(cx - 14, cy - 2);
    g.lineTo(cx + 14, cy - 2);
    g.moveTo(cx - 6, cy + 13);
    g.lineTo(cx + 6, cy + 13);
    g.stroke();
    // Ground track.
    const ta = av.trackDeg * DEG - hdg;
    g.strokeStyle = C.white;
    g.setLineDash([3, 5]);
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.sin(ta) * R, cy - Math.cos(ta) * R);
    g.stroke();
    g.setLineDash([]);
    // Autopilot heading bug.
    if (av.apFlags & 64) {
      const a = av.apHdgDeg * DEG - hdg;
      g.fillStyle = C.magenta;
      g.save();
      g.translate(cx + Math.sin(a) * R, cy - Math.cos(a) * R);
      g.rotate(a);
      g.fillRect(-9, -4, 6, 10);
      g.fillRect(3, -4, 6, 10);
      g.restore();
    }
    // Airbases.
    g.save();
    g.beginPath();
    g.arc(cx, cy, R - 2, 0, Math.PI * 2);
    g.clip();
    for (const b of aux.bases ?? []) {
      const [a, d] = relBearing(ctx, b.x, b.z);
      const r = (d / range) * R;
      const x = cx + Math.sin(a) * r;
      const y = cy - Math.cos(a) * r;
      if (b.hostile) {
        g.strokeStyle = C.red;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x, y - 9);
        g.lineTo(x + 9, y);
        g.lineTo(x, y + 9);
        g.lineTo(x - 9, y);
        g.closePath();
        g.stroke();
      } else {
        g.strokeStyle = C.cyan;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, 7, 0, Math.PI * 2);
        g.stroke();
      }
      text(g, b.name.split(/[ (]/)[0]!.toUpperCase().slice(0, 9), x, y + 18, 13, b.hostile ? C.red : C.cyan);
    }
    g.restore();
    // Home: bearing pointer on the rose and a data block.
    const home = aux.homeBase;
    if (home) {
      const [a, d] = relBearing(ctx, home.x, home.z);
      g.fillStyle = C.cyan;
      g.save();
      g.translate(cx + Math.sin(a) * (R + 12), cy - Math.cos(a) * (R + 12));
      g.rotate(a);
      g.beginPath();
      g.moveTo(0, -9);
      g.lineTo(7, 5);
      g.lineTo(-7, 5);
      g.closePath();
      g.fill();
      g.restore();
      const brg = ((((a + hdg) / DEG) % 360) + 360) % 360;
      const km = d / 1000;
      const gs = av.gsKt / MPS_TO_KT;
      const eta = gs > 20 ? d / gs : 0;
      text(g, 'HOME', W - 58, 58, 15, C.cyan, 'right');
      text(g, `${fmtHdg(brg)}° ${km.toFixed(km < 10 ? 1 : 0)} KM`, W - 58, 78, 15, C.cyan, 'right');
      if (eta > 0) text(g, `ETE ${Math.floor(eta / 60)}:${String(Math.floor(eta % 60)).padStart(2, '0')}`, W - 58, 98, 15, C.cyan, 'right');
    }
    text(g, `GS ${Math.round(av.gsKt)}`, 58, 58, 15, C.green, 'left');
    text(g, `TAS ${Math.round(av.tasKt)}`, 58, 78, 15, C.green, 'left');
    text(g, `TRK ${fmtHdg(av.trackDeg)}`, 58, 98, 15, C.green, 'left');
    text(g, `${ctx.local.hsiRangeKm} KM`, cx + R * 0.72, cy + R * 0.9, 14, C.grey);
    // Heading box.
    g.fillStyle = '#000';
    g.fillRect(cx - 30, cy - R - 44, 60, 24);
    g.strokeStyle = C.white;
    g.strokeRect(cx - 30, cy - R - 44, 60, 24);
    text(g, fmtHdg(av.headingDeg), cx, cy - R - 32, 18, C.white, 'center', true);
  },
};

const SNSR: MfdPage = {
  name: 'SNSR',
  left: [
    { legend: 'RNG\n▲', press: (c) => ((c.local.radarRangeKm = Math.min(160, c.local.radarRangeKm * 2)), { kind: 'radarRange', dir: 1 }) },
    { legend: 'RNG\n▼', press: (c) => ((c.local.radarRangeKm = Math.max(10, c.local.radarRangeKm / 2)), { kind: 'radarRange', dir: -1 }) },
    { legend: 'ACM', press: () => ({ kind: 'radarMode' }), on: (c) => c.av.radarMode === 1 },
    null,
  ],
  right: [{ legend: 'TGT', press: () => ({ kind: 'cycleTarget' }) }, null, null, null],
  draw(g, W, H, ctx, _cfg, st) {
    const { av } = ctx;
    const x0 = 58;
    const x1 = W - 58;
    const y0 = 44;
    const y1 = H - 50;
    const azMax = 60 * DEG;
    const rangeM = ctx.local.radarRangeKm * 1000;
    const X = (az: number): number => x0 + ((az + azMax) / (2 * azMax)) * (x1 - x0);
    const Y = (r: number): number => y1 - (r / rangeM) * (y1 - y0);
    // Grid.
    g.strokeStyle = 'rgba(120,150,190,0.45)';
    g.lineWidth = 1;
    g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    for (let k = 1; k < 4; k++) {
      g.beginPath();
      g.moveTo(x0, y0 + ((y1 - y0) * k) / 4);
      g.lineTo(x1, y0 + ((y1 - y0) * k) / 4);
      g.stroke();
      g.beginPath();
      g.moveTo(x0 + ((x1 - x0) * k) / 4, y0);
      g.lineTo(x0 + ((x1 - x0) * k) / 4, y1);
      g.stroke();
      text(g, String(Math.round((ctx.local.radarRangeKm * (4 - k)) / 4)), x0 - 6, y0 + ((y1 - y0) * k) / 4, 13, C.grey, 'right');
    }
    text(g, String(ctx.local.radarRangeKm), x0 - 6, y0 + 8, 14, C.white, 'right');
    // Scan limits and the B-sweep.
    const scan = Math.min(azMax, av.radarScanAzRad || azMax);
    g.strokeStyle = C.cyan;
    g.lineWidth = 1.5;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(X(s * scan), y1);
      g.lineTo(X(s * scan), y1 - 16);
      g.stroke();
    }
    const ph = (ctx.timeSec / 1.6) % 2;
    const sweepAz = (ph < 1 ? -1 + 2 * ph : 3 - 2 * ph) * scan;
    g.strokeStyle = 'rgba(70,240,112,0.55)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(X(sweepAz), y1);
    g.lineTo(X(sweepAz), y0);
    g.stroke();
    // Tracks.
    let designated: TrackView | null = null;
    for (let i = 0; i < av.trackCount; i++) {
      readTrack(ctx.f.hud, i, trk);
      const [az0, d] = relBearing(ctx, trk.x, trk.z);
      const az = Math.atan2(Math.sin(az0), Math.cos(az0));
      if (Math.abs(az) > azMax || d > rangeM) continue;
      const x = X(az);
      const y = Y(d);
      const memory = (trk.flags & SnapshotTrackFlag.Memory) !== 0;
      const color = trk.identity === TrackIdentityCode.hostile ? C.red : trk.identity === TrackIdentityCode.friend ? C.green : C.yellow;
      g.globalAlpha = memory ? 0.45 : 1;
      g.strokeStyle = color;
      g.fillStyle = color;
      g.lineWidth = 2;
      // Velocity line, heading-relative.
      const vh = Math.atan2(trk.vx, -trk.vz) - av.headingDeg * DEG;
      const spd = Math.hypot(trk.vx, trk.vz);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.sin(vh) * Math.min(30, spd / 12), y - Math.cos(vh) * Math.min(30, spd / 12));
      g.stroke();
      if (trk.identity === TrackIdentityCode.hostile) {
        g.beginPath();
        g.moveTo(x, y - 8);
        g.lineTo(x + 8, y + 6);
        g.lineTo(x - 8, y + 6);
        g.closePath();
        if (trk.flags & SnapshotTrackFlag.Locked) g.fill();
        else g.stroke();
      } else if (trk.identity === TrackIdentityCode.friend) {
        g.beginPath();
        g.arc(x, y, 7, 0, Math.PI * 2);
        g.stroke();
      } else {
        g.strokeRect(x - 6, y - 6, 12, 12);
      }
      text(g, String(Math.round((trk.y * M_TO_FT) / 1000)), x, y + 16, 12, color);
      if (trk.flags & (SnapshotTrackFlag.Designated | SnapshotTrackFlag.Locked)) {
        designated = { ...trk };
        g.strokeStyle = C.white;
        g.lineWidth = 1.5;
        g.strokeRect(x - 13, y - 13, 26, 26);
      }
      g.globalAlpha = 1;
    }
    // Header and the designated target's data.
    text(g, av.radarMode === 1 ? 'ACM' : 'RWS', x0 + 24, y0 + 14, 15, C.green);
    text(g, `${av.trackCount} TRK`, x1 - 30, y0 + 14, 15, C.green);
    if (designated && av.targetRangeM > 0) {
      const locked = av.lockState === LockStateCode.locked;
      text(g, `${locked ? 'LOCK' : 'TGT'}  R ${(av.targetRangeM / 1852).toFixed(1)} NM  VC ${Math.round(av.closureMps * MPS_TO_KT)}  ${Math.round(designated.y * M_TO_FT)} FT`, W / 2, y1 - 14, 14, locked ? C.red : C.white);
    }
  },
};

const WPN: MfdPage = {
  name: 'WPN',
  left: [{ legend: 'SEL', press: () => ({ kind: 'cycleWeapon' }) }, null, null, null],
  right: [
    { legend: 'ARM', press: () => ({ kind: 'masterArm' }), on: (c) => c.aux.masterArm },
    null,
    null,
    { legend: 'JETT\nTANKS', press: () => ({ kind: 'jettison' }) },
  ],
  draw(g, W, H, ctx, cfg) {
    const { av, inv } = ctx;
    const cx = W / 2;
    const top = 48;
    const scale = 26;
    const P = (x: number, z: number): [number, number] => [cx + z * scale, top + (7.2 - x) * scale * 0.68];
    // Planform, nose up.
    g.strokeStyle = C.green;
    g.lineWidth = 2;
    g.beginPath();
    cfg.planform.forEach(([x, z], i) => {
      const [px, py] = P(x, z);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    });
    g.closePath();
    g.stroke();
    // Stations: a row of boxes (left to right as on the aircraft), with a leader to each pylon.
    const sel = av.weaponIdx;
    const order = [...cfg.stations].sort((a, b) => a.z - b.z);
    const bw = 46;
    const gap = (W - 60 - order.length * bw) / Math.max(1, order.length - 1);
    order.forEach((s, i) => {
      const slot = inv.slots[s.slot];
      const bx = 30 + i * (bw + gap);
      const by = 318;
      const [px, py] = P(s.x, s.z);
      const code = slot?.code ?? 0;
      const count = slot?.count ?? 0;
      const info = storeInfoByCode(code);
      const kind = info && info.kind !== 'fuel_tank' ? WeaponKindCode[info.kind] : -1;
      const name = info?.short ?? '';
      const active = kind === sel && count > 0;
      g.strokeStyle = code ? C.grey : 'rgba(127,138,164,0.4)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(bx + bw / 2, by);
      g.stroke();
      g.fillStyle = code ? C.white : C.grey;
      g.beginPath();
      g.arc(px, py, 3, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = active ? C.green : 'rgba(0,0,0,0.6)';
      g.fillRect(bx, by, bw, 44);
      g.strokeStyle = count > 0 ? C.white : C.grey;
      g.lineWidth = 1.5;
      g.strokeRect(bx, by, bw, 44);
      text(g, s.label, bx + bw / 2, by + 58, 13, C.grey);
      text(g, code ? name : '---', bx + bw / 2, by + 14, 14, active ? '#001a08' : count > 0 ? C.white : C.grey, 'center', true);
      if (code) text(g, String(count), bx + bw / 2, by + 32, 14, active ? '#001a08' : C.white);
    });
    // Selected weapon and status.
    const selName = sel === WeaponKindCode.gun ? 'GUN' : sel === WeaponKindCode.ir_missile ? inv.irName || 'SRM' : inv.radarName || 'MRM';
    const selCount = sel === WeaponKindCode.gun ? `${ctx.gunRounds} RDS` : String(sel === WeaponKindCode.ir_missile ? inv.ir : inv.radar);
    boxed(g, `${selName}  ${selCount}`, cx, H - 92, 20, C.green);
    text(g, `GUN ${ctx.gunRounds}`, 60, H - 60, 15, C.white, 'left');
    text(g, `SRM ${inv.ir}   MRM ${inv.radar}`, cx, H - 60, 15, C.white);
    text(g, ctx.aux.masterArm ? 'ARM' : 'SAFE', W - 60, H - 60, 17, ctx.aux.masterArm ? C.red : C.green, 'right', true);
  },
};

const AC: MfdPage = {
  name: 'A/C',
  draw(g, W, H, ctx, cfg) {
    const { av } = ctx;
    const row = (y: number, label: string, value: string, color = C.green): void => {
      text(g, label, 70, y, 16, C.white, 'left');
      text(g, value, W - 70, y, 16, color, 'right');
    };
    text(g, 'AIRCRAFT STATUS', W / 2, 52, 17, C.cyan);
    let y = 86;
    const gear = av.gearPos > 0.98 ? 'DOWN' : av.gearPos < 0.02 ? 'UP' : 'TRANSIT';
    row(y, 'LANDING GEAR', gear, gear === 'TRANSIT' ? C.amber : C.green);
    row((y += 24), 'AIRBRAKE', av.airbrake ? 'OUT' : 'IN', av.airbrake ? C.amber : C.green);
    row((y += 24), 'WEIGHT ON WHEELS', av.onGround ? 'YES' : 'NO');
    row((y += 34), 'ENGINE  NH / FTIT', `${av.nhPct.toFixed(0)} %  ${Math.round(av.ftitC)} °C`);
    row((y += 24), 'REHEAT', av.ab > 0.5 ? 'LIT' : 'OFF', av.ab > 0.5 ? C.amber : C.green);
    row((y += 34), 'FUEL INT / EXT', `${Math.round(av.fuelKg)} / ${av.tankKg >= 0 ? Math.round(av.tankKg) : '---'} KG`);
    row((y += 24), 'BINGO', `${cfg.bingoKg} KG`, av.totalFuelKg < cfg.bingoKg ? C.amber : C.green);
    row((y += 24), 'ENDURANCE', av.enduranceMin > 0 ? `${Math.floor(av.enduranceMin)} MIN` : '---');
    row((y += 34), 'HYD 1 / 2', '3000 / 3000 PSI');
    row((y += 24), 'ELEC  GEN / BATT', 'ON / 28 V');
    row((y += 24), 'FCS', 'NORM  QUAD');
    row((y += 24), 'OXY', '9.5 L');
  },
};

const ENG: MfdPage = {
  name: 'ENG',
  draw(g, W, H, ctx) {
    const { av } = ctx;
    text(g, 'F404-GE-IN20', W / 2, 50, 16, C.cyan);
    const bars: [string, number, number, string, number[]][] = [
      ['NH', av.nhPct / 110, av.nhPct, '%', [100 / 110]],
      ['NL', av.nlPct / 110, av.nlPct, '%', [100 / 110]],
      ['FTIT', (av.ftitC - 200) / 900, av.ftitC, '°C', [(930 - 200) / 900]],
      ['NOZ', av.nozzlePct / 100, av.nozzlePct, '%', []],
      ['OIL', av.oilPsi / 60, av.oilPsi, 'PSI', []],
    ];
    const bw = 44;
    const gap = (W - 110) / bars.length;
    bars.forEach(([name, frac, v, unit, marks], i) => {
      const x = 62 + i * gap + (gap - bw) / 2;
      const color = name === 'FTIT' && v > 900 ? C.amber : C.green;
      bar(g, x, 90, bw, 250, frac, color, marks);
      text(g, name, x + bw / 2, 76, 15, C.white);
      text(g, `${Math.round(v)}`, x + bw / 2, 360, 17, C.white, 'center', true);
      text(g, unit, x + bw / 2, 380, 12, C.grey);
    });
    text(g, `FF ${Math.round(av.ffKgH)} KG/H`, 70, 420, 17, C.green, 'left');
    text(g, av.ab > 0.5 ? 'A/B' : av.nhPct > 97 ? 'MIL' : av.nhPct < 72 ? 'IDLE' : '', W - 70, 420, 19, av.ab > 0.5 ? C.amber : C.green, 'right', true);
    text(g, `THR ${Math.round(ctx.controls.throttle * 100)} %`, 70, 446, 15, C.white, 'left');
  },
};

const FUEL: MfdPage = {
  name: 'FUEL',
  right: [null, null, null, { legend: 'JETT\nTANKS', press: () => ({ kind: 'jettison' }) }],
  draw(g, W, H, ctx, cfg) {
    const { av } = ctx;
    const cx = W / 2;
    const frac = av.fuelKg / cfg.internalFuelKg;
    const tank = (x: number, y: number, w: number, h: number, f: number, label: string): void => {
      g.strokeStyle = C.white;
      g.lineWidth = 1.5;
      g.strokeRect(x, y, w, h);
      g.fillStyle = f < 0.15 ? C.amber : C.green;
      g.fillRect(x + 2, y + h - (h - 4) * Math.max(0, Math.min(1, f)) - 2, w - 4, (h - 4) * Math.max(0, Math.min(1, f)));
      text(g, label, x + w / 2, y - 12, 13, C.white);
    };
    // Fuselage tanks (fed last from the wings), wing tanks and drop tanks if carried.
    const wingF = Math.max(0, Math.min(1, (frac - 0.45) / 0.55));
    const fusF = Math.max(0, Math.min(1, frac / 0.45));
    tank(cx - 30, 90, 60, 150, fusF, 'FUS');
    tank(cx - 170, 150, 110, 70, wingF, 'L WING');
    tank(cx + 60, 150, 110, 70, wingF, 'R WING');
    if (av.tankKg >= 0) {
      const tf = Math.min(1, av.tankKg / Math.max(1, ctx.inv.tanks * 950));
      tank(cx - 150, 270, 60, 60, tf, 'DROP L');
      tank(cx + 90, 270, 60, 60, tf, 'DROP R');
    }
    text(g, `INT ${Math.round(av.fuelKg)} KG`, 70, 370, 17, C.green, 'left');
    text(g, av.tankKg >= 0 ? `EXT ${Math.round(av.tankKg)} KG` : 'EXT ---', W - 70, 370, 17, C.green, 'right');
    text(g, `TOTAL ${Math.round(av.totalFuelKg)} KG`, cx, 400, 19, C.white, 'center', true);
    text(g, `BINGO ${cfg.bingoKg}`, 70, 432, 15, av.totalFuelKg < cfg.bingoKg ? C.amber : C.cyan, 'left');
    text(g, `FF ${Math.round(av.ffKgH)} KG/H`, W - 70, 432, 15, C.green, 'right');
    const rangeKm = av.ffKgH > 1 ? (av.totalFuelKg / av.ffKgH) * av.gsKt * 1.852 : 0;
    text(g, av.enduranceMin > 0 ? `${Math.floor(av.enduranceMin)} MIN  ${Math.round(rangeKm)} KM` : '', cx, 458, 15, C.cyan);
  },
};

const FCS: MfdPage = {
  name: 'FCS',
  draw(g, W, H, ctx, cfg) {
    const { f, av, controls } = ctx;
    text(g, 'FCS  NORM  QUADRUPLEX', W / 2, 50, 16, C.green);
    // Elevons and rudder.
    const surf = (x: number, label: string, rad: number, max: number): void => {
      const h = 160;
      const y0 = 110;
      g.strokeStyle = C.white;
      g.lineWidth = 1.5;
      g.strokeRect(x - 12, y0, 24, h);
      g.beginPath();
      g.moveTo(x - 18, y0 + h / 2);
      g.lineTo(x + 18, y0 + h / 2);
      g.stroke();
      const k = Math.max(-1, Math.min(1, rad / max));
      g.fillStyle = C.green;
      g.fillRect(x - 10, y0 + h / 2 + (k > 0 ? 0 : k * h * 0.5), 20, Math.abs(k) * h * 0.5);
      text(g, label, x, y0 - 14, 14, C.white);
      text(g, `${(rad / DEG).toFixed(0)}°`, x, y0 + h + 16, 14, C.green);
    };
    surf(110, 'ELV L', f.elevonL, 25 * DEG);
    surf(W - 110, 'ELV R', f.elevonR, 25 * DEG);
    surf(W / 2, 'RUD', f.rudder, 20 * DEG);
    // Stick position.
    const sx = W / 2;
    const sy = 380;
    g.strokeStyle = C.grey;
    g.strokeRect(sx - 50, sy - 50, 100, 100);
    g.beginPath();
    g.moveTo(sx - 50, sy);
    g.lineTo(sx + 50, sy);
    g.moveTo(sx, sy - 50);
    g.lineTo(sx, sy + 50);
    g.stroke();
    g.fillStyle = C.cyan;
    g.beginPath();
    g.arc(sx + controls.roll * 46, sy + controls.pitch * 46, 6, 0, Math.PI * 2);
    g.fill();
    text(g, 'STICK', sx, sy - 64, 13, C.white);
    text(g, `G ${av.g.toFixed(1)}  LIM ${cfg.gMax.toFixed(1)}/${cfg.gMin.toFixed(1)}`, 60, 330, 14, C.green, 'left');
    text(g, `α ${av.aoaDeg.toFixed(1)}  LIM ${cfg.aoaMaxDeg}`, 60, 352, 14, C.green, 'left');
    text(g, `PED ${Math.round(controls.yaw * 100)}`, W - 60, 330, 14, C.green, 'right');
  },
};

const CAS: MfdPage = {
  name: 'CAS',
  draw(g, W, H, ctx) {
    const { av } = ctx;
    const w = av.warnings;
    const items: [string, string][] = [];
    const add = (cond: boolean, s: string, c: string): void => void (cond && items.push([s, c]));
    add((w & WarningBit.EngineFire) !== 0, 'ENGINE FIRE', C.red);
    add((w & WarningBit.TerrainPullUp) !== 0, 'GPWS PULL UP', C.red);
    add((w & WarningBit.MissileLaunch) !== 0, 'MISSILE LAUNCH', C.red);
    add((w & WarningBit.OverG) !== 0, 'OVER G', C.amber);
    add((w & WarningBit.Stall) !== 0, 'AOA LIMIT', C.amber);
    add((w & WarningBit.MissileLock) !== 0, 'RWR LOCK', C.amber);
    add((w & WarningBit.Overspeed) !== 0, 'OVERSPEED', C.amber);
    add((w & WarningBit.GearUnsafe) !== 0, 'GEAR UNSAFE', C.amber);
    add((w & WarningBit.ConfigWarning) !== 0, 'CONFIG', C.amber);
    add((w & WarningBit.LowFuel) !== 0, 'FUEL LOW', C.amber);
    add(av.gearDownCmd, 'GEAR DOWN', C.cyan);
    add(av.airbrake, 'SPEED BRAKE', C.cyan);
    add(apEngaged(av), 'AUTOPILOT', C.cyan);
    add(atEngaged(av), 'AUTOTHROTTLE', C.cyan);
    add(av.ab > 0.5, 'REHEAT', C.cyan);
    add(!ctx.aux.masterArm, 'MASTER SAFE', C.cyan);
    add(av.tankKg >= 0, 'DROP TANKS', C.cyan);
    text(g, 'CAUTIONS AND ADVISORIES', W / 2, 52, 16, C.white);
    items.slice(0, 15).forEach(([s, c], i) => text(g, s, 70, 88 + i * 25, 18, c, 'left', c !== C.cyan));
    if (!items.length) text(g, 'NO MESSAGES', W / 2, H / 2, 18, C.grey);
  },
};

export const MFD_PAGES: Readonly<Record<string, MfdPage>> = { PFD, HSI, SNSR, WPN, 'A/C': AC, ENG, FUEL, FCS, CAS };
