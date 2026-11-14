/**
 * src/terrain/himalaya/height.ts - the procedural Himalaya height function: regional fields from the
 * layout's control points, eroded/ridged noise mountains, named summits, carved valleys with noisy
 * flat floors and river channels, flat basins, lakes, and level airfield pads.
 *
 * One pure function of (x, z): the same in every worker and on the main thread, no data files and
 * no seed (the map is fixed). The game's 'himalaya' terrain shape (src/terrain/theatreShapes.ts)
 * and the terrain lab (terrain-lab/) both call it.
 */

import { Noise2, gullies } from './noise';
import { AIRFIELDS, BASINS, CONTROL, LAKES, PEAKS, VALLEYS, geo } from './layout';

const N = new Noise2(1729);
const N2 = new Noise2(4242);

// --- Regional fields on a coarse grid (Gaussian-weighted control points). ---
const FIELD_HALF = 150_000;
const FIELD_STEP = 1000;
const FN = Math.round((2 * FIELD_HALF) / FIELD_STEP) + 1;
const SIGMA = 16_000;
// Built on first use (about 3 M exp() calls), so importing this module costs the other theatres
// nothing.
let fBase = new Float32Array(0);
let fRelief = fBase;
let fDissect = fBase;
let fDry = fBase;
function buildFields(): void {
  const nb = new Float32Array(FN * FN), nr = new Float32Array(FN * FN), nd = new Float32Array(FN * FN), ny = new Float32Array(FN * FN);
  const pts = CONTROL.map((c) => ({ ...c, w: geo(c.lat, c.lon) }));
  const inv2s2 = 1 / (2 * SIGMA * SIGMA);
  for (let j = 0; j < FN; j++) {
    const z = -FIELD_HALF + j * FIELD_STEP;
    for (let i = 0; i < FN; i++) {
      const x = -FIELD_HALF + i * FIELD_STEP;
      let ws = 0, b = 0, r = 0, d = 0, y = 0;
      for (const p of pts) {
        const dx = x - p.w[0], dz = z - p.w[1];
        const d2 = dx * dx + dz * dz;
        const w = Math.exp(-d2 * inv2s2) + 1e-9 / (1 + d2 / (SIGMA * SIGMA));
        ws += w; b += w * p.base; r += w * p.relief; d += w * p.dissect; y += w * p.dry;
      }
      const k = j * FN + i;
      nb[k] = b / ws; nr[k] = r / ws; nd[k] = d / ws; ny[k] = y / ws;
    }
  }
  fRelief = nr; fDissect = nd; fDry = ny;
  fBase = nb; // last: its length is the "built" flag
}

function field(f: Float32Array, x: number, z: number): number {
  const gx = Math.min(FN - 1.001, Math.max(0, (x + FIELD_HALF) / FIELD_STEP));
  const gz = Math.min(FN - 1.001, Math.max(0, (z + FIELD_HALF) / FIELD_STEP));
  const i = Math.floor(gx), j = Math.floor(gz);
  const fx = gx - i, fz = gz - j;
  const k = j * FN + i;
  const a = f[k]! + (f[k + 1]! - f[k]!) * fx;
  const b = f[k + FN]! + (f[k + FN + 1]! - f[k + FN]!) * fx;
  return a + (b - a) * fz;
}

// --- Features in world coordinates. ---
const peaks = PEAKS.map((p) => { const [x, z] = geo(p.lat, p.lon); return { ...p, x, z }; });

interface Seg { ax: number; az: number; bx: number; bz: number; len: number; t0: number; f0: number; f1: number; w0: number; w1: number; k0: number; k1: number }
const valleys = VALLEYS.map((v, vi) => {
  const pts = v.nodes.map((n) => { const [x, z] = geo(n.lat, n.lon); return { x, z, n }; });
  const segs: Seg[] = [];
  let t = 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    segs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, len, t0: t, f0: a.n.floor, f1: b.n.floor, w0: a.n.halfWidth, w1: b.n.halfWidth, k0: a.n.wall ?? 1, k1: b.n.wall ?? 1 });
    t += len;
  }
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  const M = 14_000;
  return { river: v.river, vi, segs, minX: minX - M, maxX: maxX + M, minZ: minZ - M, maxZ: maxZ + M };
});

const basins = BASINS.map((b) => { const [x, z] = geo(b.lat, b.lon); const r = (b.rot * Math.PI) / 180; return { ...b, x, z, c: Math.cos(r), s: Math.sin(r) }; });
const lakes = LAKES.map((l) => { const [x, z] = geo(l.lat, l.lon); const r = (l.rot * Math.PI) / 180; return { ...l, x, z, c: Math.cos(r), s: Math.sin(r) }; });

export interface Strip { id: string; layoutId?: string; cx: number; cz: number; dx: number; dz: number; halfL: number; halfW: number; taxi: boolean }

const fields = AIRFIELDS.map((a) => {
  const [x, z] = geo(a.lat, a.lon);
  const th = (a.headingDeg * Math.PI) / 180;
  const dx = Math.sin(th), dz = -Math.cos(th); // along the runway
  const rx = Math.cos(th), rz = Math.sin(th); // to its right
  const off = a.taxiway?.offsetM ?? 0, tw = a.taxiway?.widthM ?? 0;
  const cMin = Math.min(-a.widthM / 2 - 40, a.taxiway ? off - tw / 2 - 30 : 0);
  const cMax = Math.max(a.widthM / 2 + 40, a.taxiway ? off + tw / 2 + 30 : 0);
  const halfL = a.lengthM / 2 + (a.stripEndM ?? 150);
  return {
    ...a, x, z, dx, dz, rx, rz, halfL, cMin, cMax,
    padL: halfL + (a.padAlongM ?? 450), c0: cMin - (a.padLeftM ?? 300), c1: cMax + (a.padRightM ?? 300), blend: a.blendM ?? 700,
  };
});

/** Runway and taxiway rectangles, for drawing. */
export function strips(): Strip[] {
  const out: Strip[] = [];
  for (const f of fields) {
    const tag = { id: f.id, ...(f.layoutId ? { layoutId: f.layoutId } : {}) };
    out.push({ ...tag, cx: f.x, cz: f.z, dx: f.dx, dz: f.dz, halfL: f.lengthM / 2, halfW: f.widthM / 2, taxi: false });
    if (f.taxiway) {
      out.push({ ...tag, cx: f.x + f.rx * f.taxiway.offsetM, cz: f.z + f.rz * f.taxiway.offsetM, dx: f.dx, dz: f.dz, halfL: f.lengthM / 2 - 100, halfW: f.taxiway.widthM / 2, taxi: true });
    }
  }
  return out;
}

/** An airfield's exactly level pad: centre, axes (along, right), along half-length, across extent (right +), blend, level. */
export interface PadBox { id: string; layoutId?: string; x: number; z: number; dx: number; dz: number; rx: number; rz: number; halfAlong: number; c0: number; c1: number; blend: number; elev: number }

export function padBoxes(): PadBox[] {
  return fields.map((f) => ({
    id: f.id, ...(f.layoutId ? { layoutId: f.layoutId } : {}), x: f.x, z: f.z, dx: f.dx, dz: f.dz, rx: f.rx, rz: f.rz,
    halfAlong: f.padL, c0: f.c0, c1: f.c1, blend: f.blend, elev: f.elev,
  }));
}

// --- Helpers. ---
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
/** Ground that reads as flat from the air but is not a plane: metres of gentle undulation. */
function noisyFlat(x: number, z: number, amp: number): number {
  return amp * (0.65 * N2.fbm(x / 900, z / 900, 3) + 0.35 * N.fbm(x / 140, z / 140, 2));
}

const SD = new Float64Array(64), SU = new Float64Array(64), SS = new Float64Array(64);

/** The mountains before valleys are cut: regional ranges, hills, named summits. */
function mountains(x: number, z: number, base: number, relief: number, dissect: number, coarse = false): number {
  // Regional mountains: a ridged multifractal stretched along the Himalayan trend (NW-SE) for the
  // big ranges, eroded fbm for gullies and spurs; the power keeps valleys open and crests sharp.
  const wx = x + 3500 * N2.fbm(x / 22000, z / 22000, 3);
  const wz = z + 3500 * N2.fbm(x / 22000 + 50.3, z / 22000 - 30.1, 3);
  const tu = (wx * 0.866 + wz * 0.5) / 1.6, tv = -wx * 0.5 + wz * 0.866;
  const r = N.ridged(tu / 18000 + 11.1, tv / 18000 - 7.7, coarse ? 4 : 8);
  let m = Math.pow(Math.max(0, (r - 0.3) / 0.9), 1.7);
  if (dissect > 0.01) {
    const rf = N2.ridged(wx / 6000 + 3.3, wz / 6000 + 9.9, coarse ? 3 : 7);
    m = m * (1 - 0.6 * dissect) + 0.6 * dissect * Math.pow(Math.max(0, (rf - 0.3) / 0.9), 1.4);
  }
  // Rolling hills where the ranges die out (the plateau is never a plane).
  if (coarse) return peaksOver(x, z, base, base + relief * m, true);
  const hills = 0.5 + 0.5 * N2.erodedFbm(wx / 6000 - 2.2, wz / 6000 + 5.1, 6);
  m += 0.2 * hills * hills * (1 - Math.min(1, m * 3));
  const e = N.erodedFbm(wx / 3500, wz / 3500, 7);
  if (!(DBG.skip & 64)) m += 0.12 * e * (0.25 + m);
  return peaksOver(x, z, base, base + relief * m, false);
}

/** The named summits raised over the regional mountains `h`. */
function peaksOver(x: number, z: number, base: number, h: number, coarse: boolean): number {
  if (DBG.skip & 1) return h;
  for (const p of peaks) {
    const dx = x - p.x, dz = z - p.z;
    const lim = p.radius * 1.5;
    if (Math.abs(dx) > lim || Math.abs(dz) > lim) continue;
    let dist = p.pyramid ? Math.max(Math.abs(dx), Math.abs(dz)) * 1.08 : Math.hypot(dx, dz);
    // Spurs: the massif's footprint is lobed, not round.
    const inv = 1 / Math.max(1, Math.hypot(dx, dz));
    dist *= 1 + (p.pyramid ? 0.12 : 0.35) * N.noise(dx * inv * 1.7 + p.h * 0.01, dz * inv * 1.7 + dist / 7000) + 0.12 * N.noise(x / 2600 + 5.5, z / 2600 - 2.2);
    const t = dist / p.radius;
    if (t >= 1.5) continue;
    const tt = Math.min(1, t);
    let pk = base + (p.h - base) * Math.pow(1 - tt, p.pyramid ? 1.25 : 1.15) - 1600 * Math.max(0, t - 1);
    if (!coarse) pk -= 500 * Math.max(0, 1.1 - N.ridged(x / 1500 + 1.9, z / 1500 + 4.4, 5)) * tt * (1 - tt) * 2;
    h = smax(h, pk, 300);
  }
  return h;
}

/** Debug: bit mask of feature passes to skip (1 peaks, 2 basins, 4 valleys, 8 lakes, 16 airfields, 32 slope gullies, 64 eroded fbm). */
export const DBG = { skip: 0 };

export interface SurfaceInfo { flat: number; river: number; dry: number }

/** Terrain height (m above sea level) at world (x, z); surface hints into `info` if given. */
export function heightAt(x: number, z: number, info?: SurfaceInfo): number {
  if (fBase.length === 0) buildFields();
  const base = field(fBase, x, z);
  const relief = field(fRelief, x, z);
  const dissect = field(fDissect, x, z);
  let flat = 0, river = 0;

  // Mountains, then analytic erosion: gullies down their slopes (the slope from two extra samples).
  // The gully direction follows the big slopes, not every bump: a wide central difference.
  const E = 350;
  const h0 = mountains(x, z, base, relief, dissect);
  const gx = (mountains(x + E, z, base, relief, dissect, true) - mountains(x - E, z, base, relief, dissect, true)) / (2 * E);
  const gz = (mountains(x, z + E, base, relief, dissect, true) - mountains(x, z - E, base, relief, dissect, true)) / (2 * E);
  const slope = Math.hypot(gx, gz);
  let h = h0;
  const gAmp = relief * 0.13 * smoothstep(0.06, 0.45, slope);
  if (gAmp > 2 && !(DBG.skip & 32)) {
    const inv = 1 / Math.max(slope, 0.05);
    h += gAmp * (gullies(x, z, gx * inv, gz * inv, 3200, 4, 1.6, 1.2) - 0.15);
  }

  // Flat basins (lake plateau, Purang, the Koyul fan).
  if (!(DBG.skip & 2)) {
    for (const b of basins) {
      const dx = x - b.x, dz = z - b.z;
      const u = dx * b.c + dz * b.s, v = -dx * b.s + dz * b.c;
      let el = Math.hypot(u / b.rx, v / b.rz);
      if (el > 3) continue;
      el += 0.12 * N.noise(x / 4500 + 7.7, z / 4500 - 1.3);
      const s = (el - 1) * Math.min(b.rx, b.rz);
      const fl = b.level + noisyFlat(x, z, 14);
      const k = smoothstep(0, 4000, s);
      h = fl + (h - fl) * Math.pow(k, 1.3);
      flat = Math.max(flat, 1 - smoothstep(0, 2000, s));
    }
  }

  // Valleys: the query point is warped so corridors wind; the mountains are blended down to a
  // noisy flat floor with an irregular edge, so side spurs reach into the valley.
  const vx = x + 700 * N2.fbm(x / 8000 + 3.1, z / 8000 - 8.2, 3);
  const vz = z + 700 * N2.fbm(x / 8000 - 6.4, z / 8000 + 2.7, 3);
  for (const v of (DBG.skip & 4) ? [] : valleys) {
    if (vx < v.minX || vx > v.maxX || vz < v.minZ || vz > v.maxZ) continue;
    // Nearest distance, and the floor/width/wall/along blended over the segments near it (a hard
    // nearest-segment pick would jump on the bisector inside a bend).
    let best = Infinity, bpx = 0, bpz = 0;
    const nseg = v.segs.length;
    for (let i = 0; i < nseg; i++) {
      const s = v.segs[i]!;
      const ex = s.bx - s.ax, ez = s.bz - s.az;
      const u = Math.min(1, Math.max(0, ((vx - s.ax) * ex + (vz - s.az) * ez) / (s.len * s.len)));
      const px = s.ax + ex * u, pz = s.az + ez * u;
      const d = Math.hypot(vx - px, vz - pz);
      SD[i] = d; SU[i] = u; SS[i] = ((vx - s.ax) * ez - (vz - s.az) * ex) / s.len;
      if (d < best) { best = d; bpx = px; bpz = pz; }
    }
    let ws = 0, floor = 0, hw = 0, wall = 0, along = 0, bsd = 0;
    for (let i = 0; i < nseg; i++) {
      const s = v.segs[i]!;
      const w = Math.exp(-(SD[i]! - best) / 400);
      if (w < 1e-4) continue;
      const u = SU[i]!;
      ws += w;
      floor += w * (s.f0 + (s.f1 - s.f0) * u);
      hw += w * (s.w0 + (s.w1 - s.w0) * u);
      wall += w * (s.k0 + (s.k1 - s.k0) * u);
      along += w * (s.t0 + u * s.len);
      bsd += w * SS[i]!;
    }
    floor /= ws; hw /= ws; wall /= ws; along /= ws; bsd /= ws;
    // Floor edge wanders; the walls rise as a V/U whose steepness is broken by spurs and gullies,
    // and the valley is the lower of that and the mountains (continuous: a smooth min).
    const edge = hw * (1 + 0.4 * N.noise(x / 2200 + 1.7, z / 2200 - 3.3));
    const s = Math.max(0, best - edge);
    const spur = N.ridged(x / 1900 + 6.6, z / 1900 - 1.1, 4);
    const fl = floor + noisyFlat(x, z, 7) + 0.03 * Math.min(best, hw);
    const rise = wall * wall * (0.25 * s + (s * s) / 12000);
    let prof = fl + rise * (0.55 + 0.55 * spur + 0.2 * N.fbm(x / 650 - 3.7, z / 650 + 8.1, 3));
    if (prof > h + 400 + 0.4 * rise) continue;
    // Side ravines draining to the river.
    if (rise > 20) {
      const ib = 1 / Math.max(best, 1);
      prof += rise * 0.4 * smoothstep(0, 400, s) * gullies(x, z, (vx - bpx) * ib, (vz - bpz) * ib, 1400, 3, 1.6, 1.2);
    }
    h = smin(h, prof, 120);
    flat = Math.max(flat, 1 - smoothstep(edge * 0.8, edge + 200, best));
    if (v.river && best < hw + 200) {
      const meander = Math.min(0.4 * hw, 350) * N.noise(along / 2200, v.vi * 13.37);
      const ds = Math.abs(bsd - meander);
      const cw = 9 + Math.min(22, hw * 0.015);
      if (ds < cw) {
        const kk = 1 - (ds / cw) * (ds / cw);
        h -= 3.5 * kk;
        river = Math.max(river, kk);
      }
    }
  }

  // Lakes: carved below their own water level, with a gentle shore.
  if (!(DBG.skip & 8)) {
    for (const l of lakes) {
      const dx = x - l.x, dz = z - l.z;
      const u = dx * l.c + dz * l.s, v = -dx * l.s + dz * l.c;
      let el = Math.hypot(u / l.rx, v / l.rz);
      if (el > 2.5) continue;
      el += 0.13 * N.fbm(x / 3200 - 4.4, z / 3200 + 8.8, 3);
      // Lake bed below the water level; the shore blends back to the surrounding ground.
      const bed = l.level - 2 - 60 * Math.max(0, 1 - el * el);
      const k = smoothstep(0.98, 1.5, el);
      h = bed + (h - bed) * k;
    }
    // Round the lake whose water this is (lakeAt), the ground past its shore stays above that
    // water, so the only water in the region is the lake itself (no stray pools on the plain).
    const l = lakeAt(x, z);
    // (The floor is that lake's bed, rising past its rim to 1.5 m above the water: no step.)
    if (l) {
      const e = l.el + 0.13 * N.fbm(x / 3200 - 4.4, z / 3200 + 8.8, 3);
      h = Math.max(h, l.level - 2 - 60 * Math.max(0, 1 - e * e) + 3.5 * smoothstep(0.97, 1.12, e));
    }
  }

  // Airfields: a level pad, exactly flat (the airport layout's pavement and buildings sit on it),
  // blending back to the ground round it.
  if (!(DBG.skip & 16)) {
    for (const f of fields) {
      const dx = x - f.x, dz = z - f.z;
      const a = dx * f.dx + dz * f.dz, c = dx * f.rx + dz * f.rz;
      const da = Math.max(0, Math.abs(a) - f.padL);
      const dc = c < f.c0 ? f.c0 - c : c > f.c1 ? c - f.c1 : 0;
      if (da >= f.blend || dc >= f.blend) continue;
      if (da === 0 && dc === 0) { h = f.elev; flat = Math.max(flat, 0.8); continue; }
      const dd = Math.hypot(da, dc);
      if (dd >= f.blend) continue;
      const target = f.elev + noisyFlat(x, z, 1.2) * smoothstep(0, 120, dd);
      const k = 1 - smoothstep(0, f.blend, dd);
      h = h + (target - h) * k;
      flat = Math.max(flat, k * 0.8);
    }
  }

  if (info) { info.flat = flat; info.river = river; info.dry = field(fDry, x, z); }
  return h;
}

/** Lakes own the ground within this many (pure, un-noised) ellipse radii of their centre. */
export const LAKE_REGION_EL = 2.3;
const lakeHit = { level: 0, el: 0 };
/** The lake whose region holds (x, z) (the nearest, by ellipse distance), or undefined. Shared scratch result. */
function lakeAt(x: number, z: number): { level: number; el: number } | undefined {
  let best = LAKE_REGION_EL;
  let found = false;
  for (const l of lakes) {
    const dx = x - l.x, dz = z - l.z;
    const u = dx * l.c + dz * l.s, v = -dx * l.s + dz * l.c;
    const el = Math.hypot(u / l.rx, v / l.rz);
    if (el < best) { best = el; lakeHit.level = l.level; lakeHit.el = el; found = true; }
  }
  return found ? lakeHit : undefined;
}

/**
 * The water surface at (x, z): the level of the lake whose region holds it (there is water
 * wherever heightAt is below it), or -Infinity where there is no lake.
 */
export function waterLevelAt(x: number, z: number): number {
  const l = lakeAt(x, z);
  return l ? l.level : -Infinity;
}

/** The lakes for the renderer: centre, radii, rotation (rad, from east toward south) and level. */
export function lakeShapes(): { x: number; z: number; rx: number; rz: number; rotRad: number; level: number }[] {
  return lakes.map((l) => ({ x: l.x, z: l.z, rx: l.rx, rz: l.rz, rotRad: (l.rot * Math.PI) / 180, level: l.level }));
}

/** The regional dryness field (0 monsoon-wet south .. 1 rain-shadow plateau) at (x, z). */
export function dryAt(x: number, z: number): number {
  if (fBase.length === 0) buildFields();
  return field(fDry, x, z);
}
