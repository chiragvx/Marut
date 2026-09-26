/**
 * src/terrain/urbanMath.ts — the urban layer's street network, lots and buildings, as maths shared
 * exactly by the terrain worker (TypeScript, for the 3D buildings and trees) and the ground shader
 * (URBAN_MATH_GLSL, for the ground at every distance).
 *
 * Everything is driven by the baked urban field (urbanField.ts; contracts UrbanLayer): urbanity U,
 * a street-grid direction and a signed distance to the main roads. On top of it:
 * - Districts: a jittered 600 m Voronoi tiling (in a gently warped space, so streets bend). Each
 *   district takes U and the grid direction at its own centre, so its streets are one coherent
 *   grid: fine blocks (~80 m) in a dense centre, large (~380 m) in the country. District borders
 *   are collector roads (kept more often the more urban the two sides are).
 * - Street grid: lines every Sx and Sz in the district's frame; each block-side segment is kept or
 *   dropped by a hash (almost all kept in town, few in the country: dead ends and lone lanes).
 * - Lots: along every kept street, a row of lots (the frontage band, D deep). The lot decides
 *   whether a building stands on it (more likely the higher U at the lot), its setback, depth,
 *   width, roof (red Mangalore tile or flat concrete) and storeys (urbanity of the field texel at
 *   the lot centre decides the building). Behind the frontage: yards.
 *
 * Hashes are integer (uint arithmetic in GLSL, Math.imul here), so both sides pick the same
 * streets and lots bit for bit; positions agree to float32 precision.
 */
import type { UrbanLayer } from '../contracts/terrain';

export const URBAN_DISTRICT_M = 600;
/** Districts less urban than this have no streets or lots. */
export const URBAN_MIN_U = 0.02;
/** The field's signed distance to the main roads is stored over +-this range (m). */
export const URBAN_SDF_RANGE_M = 150;
/** Half width of the main roads as the urban layer draws and clears them (m). */
export const URBAN_ARTERIAL_HW_M = 5.5;

const G = URBAN_DISTRICT_M;
/** Keeps every hashed integer positive. */
const OFF = 1024;

/** Integer hash of three non-negative ints and a seed to [0, 1) (24 bits). Mirrored in GLSL as uh(). */
export function uh(a: number, b: number, c: number, seed: number): number {
  let h = (Math.imul(a, 0x8da6b343) ^ Math.imul(b, 0xd8163841) ^ Math.imul(c, 0xcb1ab31f) ^ Math.imul(seed, 0x2c1b3c6d)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h >>> 8) / 16777216;
}

function sstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// --- warp: s = p + w(p), a sum of sines (smooth everywhere; slope < 0.37, so it inverts) ----------

export function warpX(x: number, z: number): number {
  return 14 * Math.sin(0.0071 * x + 0.0043 * z + 1.7) + 8 * Math.sin(-0.0029 * x + 0.0117 * z + 0.4) + 30 * Math.sin(0.0043 * x - 0.0021 * z + 0.9);
}

export function warpZ(x: number, z: number): number {
  return 14 * Math.sin(-0.0052 * x + 0.0066 * z + 4.1) + 8 * Math.sin(0.0123 * x + 0.0034 * z + 2.9) + 30 * Math.sin(0.0019 * x + 0.0046 * z + 5.2);
}

/** World position whose warped position is (sx, sz) (fixed-point iteration, ~1 cm). */
export function unwarp(sx: number, sz: number, out: { x: number; z: number }): void {
  let x = sx;
  let z = sz;
  for (let i = 0; i < 9; i++) {
    const nx = sx - warpX(x, z);
    const nz = sz - warpZ(x, z);
    x = nx;
    z = nz;
  }
  out.x = x;
  out.z = z;
}

// --- the baked field -----------------------------------------------------------------------------

/** Bilinear sample of the field at (x, z): out = [U, cos2a, sin2a, sdf (m), min |sdf| of the 4 texels]. */
export function sampleUrban(L: UrbanLayer, x: number, z: number, out: Float64Array): void {
  const gx = (x - L.originX) / L.resM - 0.5;
  const gz = (z - L.originZ) / L.resM - 0.5;
  const fx0 = Math.floor(gx);
  const fz0 = Math.floor(gz);
  const fx = gx - fx0;
  const fz = gz - fz0;
  const i0 = Math.max(0, Math.min(L.nx - 1, fx0));
  const i1 = Math.max(0, Math.min(L.nx - 1, fx0 + 1));
  const j0 = Math.max(0, Math.min(L.nz - 1, fz0));
  const j1 = Math.max(0, Math.min(L.nz - 1, fz0 + 1));
  const d = L.data;
  const o00 = (j0 * L.nx + i0) * 4;
  const o10 = (j0 * L.nx + i1) * 4;
  const o01 = (j1 * L.nx + i0) * 4;
  const o11 = (j1 * L.nx + i1) * 4;
  for (let c = 0; c < 4; c++) {
    const a = mix(d[o00 + c]! / 255, d[o10 + c]! / 255, fx);
    const b = mix(d[o01 + c]! / 255, d[o11 + c]! / 255, fx);
    out[c] = mix(a, b, fz);
  }
  out[1] = out[1]! * 2 - 1;
  out[2] = out[2]! * 2 - 1;
  const k = (URBAN_SDF_RANGE_M / 127) * 255;
  const dec = (v: number): number => (v / 255 - 128 / 255) * k;
  out[3] = dec(out[3]! * 255);
  out[4] = Math.min(Math.abs(dec(d[o00 + 3]!)), Math.abs(dec(d[o10 + 3]!)), Math.abs(dec(d[o01 + 3]!)), Math.abs(dec(d[o11 + 3]!)));
}

/** U of the texel containing (x, z) (0 outside the field). */
export function texelU(L: UrbanLayer, x: number, z: number): number {
  const i = Math.floor((x - L.originX) / L.resM);
  const j = Math.floor((z - L.originZ) / L.resM);
  if (i < 0 || j < 0 || i >= L.nx || j >= L.nz) return 0;
  return L.data[(j * L.nx + i) * 4]! / 255;
}

// --- districts -----------------------------------------------------------------------------------

// A district centre's jitter: one hash, 12 bits per axis.
export function featureX(cx: number, cz: number, seed: number): number {
  const h = Math.floor(uh(cx + OFF, cz + OFF, 1, seed) * 16777216);
  return (cx + 0.2 + 0.6 * (Math.floor(h / 4096) / 4096)) * G;
}

export function featureZ(cx: number, cz: number, seed: number): number {
  const h = Math.floor(uh(cx + OFF, cz + OFF, 1, seed) * 16777216);
  return (cz + 0.2 + 0.6 * ((h % 4096) / 4096)) * G;
}

export interface UrbanDistrict {
  /** Owner district (cell and centre). */
  cx: number;
  cz: number;
  fx: number;
  fz: number;
  /** The neighbour across the nearest border, and the distance to that border (m). */
  ncx: number;
  ncz: number;
  nfx: number;
  nfz: number;
  border: number;
}

export function newDistrict(): UrbanDistrict {
  return { cx: 0, cz: 0, fx: 0, fz: 0, ncx: 0, ncz: 0, nfx: 0, nfz: 0, border: 0 };
}

const fsx = new Float64Array(9);
const fsz = new Float64Array(9);

/** The district owning warped point (sx, sz). Mirrors GLSL uDistrictAt. */
export function districtAt(sx: number, sz: number, seed: number, d: UrbanDistrict): void {
  const c0x = Math.floor(sx / G);
  const c0z = Math.floor(sz / G);
  let best = Infinity;
  let bk = 0;
  for (let k = 0; k < 9; k++) {
    const cx = c0x + (k % 3) - 1;
    const cz = c0z + Math.floor(k / 3) - 1;
    const fx = featureX(cx, cz, seed);
    const fz = featureZ(cx, cz, seed);
    fsx[k] = fx;
    fsz[k] = fz;
    const dd = (fx - sx) * (fx - sx) + (fz - sz) * (fz - sz);
    if (dd < best) {
      best = dd;
      bk = k;
    }
  }
  d.cx = c0x + (bk % 3) - 1;
  d.cz = c0z + Math.floor(bk / 3) - 1;
  d.fx = fsx[bk]!;
  d.fz = fsz[bk]!;
  let border = Infinity;
  let nk = 0;
  for (let k = 0; k < 9; k++) {
    if (k === bk) continue;
    const nx = fsx[k]! - d.fx;
    const nz = fsz[k]! - d.fz;
    const len = Math.hypot(nx, nz);
    const e = ((0.5 * (fsx[k]! + d.fx) - sx) * nx + (0.5 * (fsz[k]! + d.fz) - sz) * nz) / len;
    if (e < border) {
      border = e;
      nk = k;
    }
  }
  d.ncx = c0x + (nk % 3) - 1;
  d.ncz = c0z + Math.floor(nk / 3) - 1;
  d.nfx = fsx[nk]!;
  d.nfz = fsz[nk]!;
  d.border = border;
}

export interface UrbanDistrictParams {
  U: number;
  /** 0..1: how much of a dense town centre this is (big lots, flat-roofed blocks). */
  core: number;
  /** Grid direction (rad) and its cos/sin: local x = (c, s) in world x/z. */
  theta: number;
  c: number;
  s: number;
  /** Block size, grid offset, street half width, lot width and frontage depth (m). */
  Sx: number;
  Sz: number;
  ox: number;
  oz: number;
  hw: number;
  Lw: number;
  D: number;
  /** Building density multiplier of this district (busy and quiet quarters). */
  dens: number;
}

export function newDistrictParams(): UrbanDistrictParams {
  return { U: 0, core: 0, theta: 0, c: 1, s: 0, Sx: 1, Sz: 1, ox: 0, oz: 0, hw: 0, Lw: 1, D: 1, dens: 1 };
}

/** Mirrors GLSL uDistrictParams. */
export function districtParams(L: UrbanLayer, cx: number, cz: number, fx: number, fz: number, p: UrbanDistrictParams): void {
  const i = Math.floor((fx - L.originX) / L.resM);
  const j = Math.floor((fz - L.originZ) / L.resM);
  let U = 0;
  let c2 = 1;
  let s2 = 0;
  if (i >= 0 && j >= 0 && i < L.nx && j < L.nz) {
    const o = (j * L.nx + i) * 4;
    U = L.data[o]! / 255;
    c2 = (L.data[o + 1]! / 255) * 2 - 1;
    s2 = (L.data[o + 2]! / 255) * 2 - 1;
  }
  const a = cx + OFF;
  const b = cz + OFF;
  const seed = L.seed;
  p.U = U;
  p.core = sstep(0.55, 0.8, U);
  p.theta = 0.5 * Math.atan2(s2, c2) + (uh(a, b, 3, seed) - 0.5) * 0.3;
  p.c = Math.cos(p.theta);
  p.s = Math.sin(p.theta);
  p.Sx = 80 + 300 * Math.pow(1 - U, 1.6);
  p.Sz = p.Sx * (0.6 + 0.25 * uh(a, b, 4, seed));
  p.ox = uh(a, b, 5, seed) * p.Sx;
  p.oz = uh(a, b, 6, seed) * p.Sz;
  p.hw = mix(2.6, 3.6, sstep(0.1, 0.6, U));
  p.Lw = mix(20, 15, sstep(0.1, 0.5, U)) + 12 * p.core;
  p.D = Math.min(p.hw + mix(22, 30, p.core), 0.48 * Math.min(p.Sx, p.Sz));
  p.dens = 0.85 + 0.3 * uh(a, b, 7, seed);
}

/** Street keep probabilities: x = whole grid line, y = one block's segment of it (fam 0 lines run along local z, fam 1 along local x). */
export function keepProb(fam: number, U: number): [number, number] {
  const t = sstep(0.12, 0.65, U);
  return fam === 0 ? [mix(0.6, 1.0, t), mix(0.8, 0.97, t)] : [mix(0.3, 1.0, t), mix(0.55, 0.93, t)];
}

/**
 * Is the street along block side (i, j) kept? fam 0: grid line i, segment j (along local z);
 * fam 1: grid line j, segment i. A line is kept or dropped whole first (so country lanes run on
 * as lanes instead of scattered dashes), then block by block. Mirrors GLSL uSegKeep.
 */
export function segKeep(cx: number, cz: number, i: number, j: number, fam: number, U: number, seed: number): boolean {
  const [pl, ps] = keepProb(fam, U);
  const line = fam === 0 ? i : j;
  if (uh((cx + OFF) * 128 + line + 64, (cz + OFF) * 4 + fam, 20, seed) >= pl) return false;
  return uh((cx + OFF) * 128 + i + 64, (cz + OFF) * 128 + j + 64, 16 + fam, seed) < ps;
}

/**
 * Distance from warped point (sx, sz) to the nearest kept grid street of district (cx, cz) with
 * centre (fx, fz) and params P (1e9 if none of its block's sides is kept). Mirrors GLSL uGridStreetDist.
 */
export function gridStreetDist(cx: number, cz: number, fx: number, fz: number, P: UrbanDistrictParams, sx: number, sz: number, seed: number): number {
  if (P.U < URBAN_MIN_U) return 1e9;
  const dx = sx - fx;
  const dz = sz - fz;
  const lx = P.c * dx + P.s * dz + P.ox;
  const lz = -P.s * dx + P.c * dz + P.oz;
  const i = Math.floor(lx / P.Sx);
  const j = Math.floor(lz / P.Sz);
  const a = lx - i * P.Sx;
  const b = lz - j * P.Sz;
  let d = 1e9;
  if (segKeep(cx, cz, i, j, 0, P.U, seed)) d = Math.min(d, a);
  if (segKeep(cx, cz, i + 1, j, 0, P.U, seed)) d = Math.min(d, P.Sx - a);
  if (segKeep(cx, cz, i, j, 1, P.U, seed)) d = Math.min(d, b);
  if (segKeep(cx, cz, i, j + 1, 1, P.U, seed)) d = Math.min(d, P.Sz - b);
  return d;
}

/** A collector lot has no building where a grid street runs on into it (centre this close to one). */
export function collectorLotClear(hw: number, Lw: number, lot: UrbanLot): number {
  return hw + 0.5 * Math.max(Lw - 2 * lot.g, lot.dp) + 1;
}

/** Half width of the collector road along the border of districts a and b (0 = none). */
export function borderRoadHw(ax: number, az: number, bx: number, bz: number, Ua: number, Ub: number, seed: number): number {
  const Um = Math.max(Ua, Ub);
  if (Um < URBAN_MIN_U) return 0;
  const aLo = ax < bx || (ax === bx && az < bz);
  const lx = aLo ? ax : bx;
  const lz = aLo ? az : bz;
  const hx = aLo ? bx : ax;
  const hz = aLo ? bz : az;
  const h = uh((lx + OFF) * 4 + (hx - lx + 1), (lz + OFF) * 4 + (hz - lz + 1), 24, seed);
  if (h >= mix(0.35, 0.75, sstep(0.03, 0.3, Um))) return 0;
  return mix(3.0, 4.6, sstep(0.1, 0.6, Um));
}

/** Probability that a lot of urbanity U has a building (times the district's density). */
export function occupancy(U: number): number {
  return Math.min(0.95, 0.25 + 1.3 * U) * sstep(0.03, 0.1, U);
}

// --- lots ----------------------------------------------------------------------------------------

/** Lot identity: three ints for uh(); per-lot quantities use salt 0..7 in the low bits of c. */
export interface UrbanLot {
  a: number;
  b: number;
  c: number;
  /** Setback of the building from the street centreline, its depth and the gap to the lot's sides (m). */
  sb: number;
  dp: number;
  g: number;
  Lw: number;
}

export function lotHash(lot: UrbanLot, salt: number, seed: number): number {
  return uh(lot.a, lot.b, lot.c * 8 + salt, seed);
}

/** Fills a lot's building shape (sb, dp, g) from its hashes. Mirrors GLSL uLotShape. */
export function lotShape(lot: UrbanLot, core: number, hw: number, D: number, seed: number): void {
  const h1 = lotHash(lot, 1, seed);
  const h2 = lotHash(lot, 2, seed);
  const h3 = lotHash(lot, 3, seed);
  lot.sb = hw + mix(2 + 4 * h1, 1 + 1.5 * h1, core);
  lot.dp = Math.max(6, Math.min(D - lot.sb - 1, mix(8 + 6 * h2, D - lot.sb - 1.5, core)));
  lot.g = mix(1.5 + 3 * h3, 0.8 + 1.0 * h3, core);
}

/** Border (collector) lots: frontage depth and lot width. */
export function borderDepth(hwb: number, core: number): number {
  return hwb + mix(22, 28, core);
}
export function borderLotW(core: number): number {
  return 18 + 8 * core;
}

// --- one ground point ----------------------------------------------------------------------------

export const UrbanRegion = { None: 0, Interior: 1, Grid: 2, Border: 3 } as const;

/** What the urban layer has at one ground point (the TS twin of GLSL uUrbanPixel, for trees and tests). */
export interface UrbanPixel {
  U: number;
  sdf: number;
  /** On a street (grid, collector or main road)? */
  street: boolean;
  /** On a building footprint (grown by the `margin` passed in)? */
  building: boolean;
  region: number;
  core: number;
  Ud: number;
  lot: UrbanLot;
}

export function newUrbanPixel(): UrbanPixel {
  return { U: 0, sdf: 1e9, street: false, building: false, region: 0, core: 0, Ud: 0, lot: { a: 0, b: 0, c: 0, sb: 0, dp: 0, g: 0, Lw: 1 } };
}

const smp = new Float64Array(5);
const dist = newDistrict();
const par = newDistrictParams();


/**
 * Classifies world point (x, z). `margin` grows building footprints (m), e.g. to keep tree trunks
 * clear of walls. Mirrors GLSL uUrbanPixel (which also returns what the colouring needs).
 */
export function urbanPixel(L: UrbanLayer, x: number, z: number, margin: number, out: UrbanPixel): void {
  const seed = L.seed;
  sampleUrban(L, x, z, smp);
  const U = smp[0]!;
  out.U = U;
  out.sdf = smp[4]! < 72 ? smp[3]! : 1e9;
  out.street = Math.abs(out.sdf) < URBAN_ARTERIAL_HW_M;
  out.building = false;
  out.region = UrbanRegion.None;
  out.core = 0;
  out.Ud = 0;
  if (U < 0.004) return;
  const gate = U >= 0.012;
  const sx = x + warpX(x, z);
  const sz = z + warpZ(x, z);
  districtAt(sx, sz, seed, dist);
  const P = par;
  districtParams(L, dist.cx, dist.cz, dist.fx, dist.fz, P);
  const Un = texelU(L, dist.nfx, dist.nfz);
  out.core = P.core;
  out.Ud = P.U;
  const hwb = borderRoadHw(dist.cx, dist.cz, dist.ncx, dist.ncz, P.U, Un, seed);
  if (hwb > 0 && dist.border < hwb && gate) out.street = true;
  if (P.U < URBAN_MIN_U && hwb <= 0) return;
  out.region = UrbanRegion.Interior;
  const dx = sx - dist.fx;
  const dz = sz - dist.fz;
  const lx = P.c * dx + P.s * dz + P.ox;
  const lz = -P.s * dx + P.c * dz + P.oz;
  const i = Math.floor(lx / P.Sx);
  const j = Math.floor(lz / P.Sz);
  const a = lx - i * P.Sx;
  const b = lz - j * P.Sz;
  const ok = P.U >= URBAN_MIN_U;
  const kL = ok && segKeep(dist.cx, dist.cz, i, j, 0, P.U, seed);
  const kR = ok && segKeep(dist.cx, dist.cz, i + 1, j, 0, P.U, seed);
  const kT = ok && segKeep(dist.cx, dist.cz, i, j, 1, P.U, seed);
  const kB = ok && segKeep(dist.cx, dist.cz, i, j + 1, 1, P.U, seed);
  const hw = P.hw;
  if (gate && ((kL && a < hw) || (kR && P.Sx - a < hw) || (kT && b < hw) || (kB && P.Sz - b < hw))) out.street = true;

  // Which lot row (if any) this point is in: collector frontage first, then the grid's.
  const lot = out.lot;
  let across = 0;
  let t = 0;
  let tEnd = 0;
  let ucx = 0;
  let ucz = 0;
  let D = P.D;
  let hwl = hw;
  const core = P.core;
  const Db = borderDepth(hwb, core);
  if (hwb > 0 && dist.border < Db) {
    out.region = UrbanRegion.Border;
    const aLo = dist.cx < dist.ncx || (dist.cx === dist.ncx && dist.cz < dist.ncz);
    const lox = aLo ? dist.fx : dist.nfx;
    const loz = aLo ? dist.fz : dist.nfz;
    const hix = aLo ? dist.nfx : dist.fx;
    const hiz = aLo ? dist.nfz : dist.fz;
    const nl = Math.hypot(hix - lox, hiz - loz);
    const nx = (hix - lox) / nl;
    const nz = (hiz - loz) / nl;
    const mx = 0.5 * (lox + hix);
    const mz = 0.5 * (loz + hiz);
    t = (sx - mx) * -nz + (sz - mz) * nx;
    across = dist.border;
    lot.Lw = borderLotW(core);
    const k = Math.floor(t / lot.Lw);
    const lcx = aLo ? dist.cx : dist.ncx;
    const lcz = aLo ? dist.cz : dist.ncz;
    const hcx = aLo ? dist.ncx : dist.cx;
    const hcz = aLo ? dist.ncz : dist.cz;
    lot.a = (lcx + OFF) * 4 + (hcx - lcx + 1);
    lot.b = (lcz + OFF) * 4 + (hcz - lcz + 1);
    lot.c = 2048 + (aLo ? 0 : 1) * 1024 + k + 512;
    t -= k * lot.Lw;
    tEnd = lot.Lw;
    D = Db;
    hwl = hwb;
    lotShape(lot, core, hwl, D, seed);
    // Lot centre (warped space): on the owner's side of the border.
    const side = aLo ? -1 : 1;
    const tc = (k + 0.5) * lot.Lw;
    const ac = side * (lot.sb + 0.5 * lot.dp);
    ucx = mx - nz * tc + nx * ac;
    ucz = mz + nx * tc + nz * ac;
    if (gridStreetDist(dist.cx, dist.cz, dist.fx, dist.fz, P, ucx, ucz, seed) < collectorLotClear(P.hw, lot.Lw, lot)) return;
  } else {
    if (!ok) return;
    let side = -1;
    let t0 = 0;
    let t1 = 0;
    if (kL && a < P.D && !(kR && P.Sx - a < a)) {
      side = 0;
      across = a;
    } else if (kR && P.Sx - a < P.D) {
      side = 1;
      across = P.Sx - a;
    } else if (kT && b < P.D && !(kB && P.Sz - b < b)) {
      side = 2;
      across = b;
    } else if (kB && P.Sz - b < P.D) {
      side = 3;
      across = P.Sz - b;
    }
    if (side < 0) return;
    out.region = UrbanRegion.Grid;
    if (side < 2) {
      t0 = kT ? hw : 0;
      t1 = P.Sz - (kB ? hw : 0);
      t = b - t0;
    } else {
      t0 = kL ? P.D : 0;
      t1 = P.Sx - (kR ? P.D : 0);
      t = a - t0;
    }
    lot.Lw = P.Lw;
    const k = Math.floor(t / lot.Lw);
    if (k < 0 || (k + 1) * lot.Lw > t1 - t0) {
      out.region = UrbanRegion.Interior;
      return;
    }
    lot.a = (dist.cx + OFF) * 128 + i + 64;
    lot.b = (dist.cz + OFF) * 128 + j + 64;
    lot.c = 64 + side * 128 + k + 16;
    t -= k * lot.Lw;
    tEnd = lot.Lw;
    lotShape(lot, core, hw, P.D, seed);
    // Lot centre in the local frame, then warped space.
    const ac = lot.sb + 0.5 * lot.dp;
    const tc = t0 + (k + 0.5) * lot.Lw;
    let clx: number;
    let clz: number;
    if (side === 0) {
      clx = i * P.Sx + ac;
      clz = j * P.Sz + tc;
    } else if (side === 1) {
      clx = (i + 1) * P.Sx - ac;
      clz = j * P.Sz + tc;
    } else if (side === 2) {
      clx = i * P.Sx + tc;
      clz = j * P.Sz + ac;
    } else {
      clx = i * P.Sx + tc;
      clz = (j + 1) * P.Sz - ac;
    }
    const qx = clx - P.ox;
    const qz = clz - P.oz;
    ucx = dist.fx + P.c * qx - P.s * qz;
    ucz = dist.fz + P.s * qx + P.c * qz;
  }
  const inside =
    across >= lot.sb - margin && across <= lot.sb + lot.dp + margin && t >= lot.g - margin && t <= tEnd - lot.g + margin;
  if (!inside || Math.abs(out.sdf) < URBAN_ARTERIAL_HW_M + 3) return;
  if (lotHash(lot, 0, seed) >= occupancy(texelU(L, ucx, ucz)) * P.dens) return;
  out.building = true;
}

/** Expected cover of an area of urbanity U (for the far view): x = roofs, y = streets, z = flat-roof share, w = frontage share. Mirrors GLSL uUrbanMean. */
export function urbanMean(U: number, out: Float64Array): void {
  const k0 = keepProb(0, U);
  const k1 = keepProb(1, U);
  const pk0 = k0[0] * k0[1];
  const pk1 = k1[0] * k1[1];
  const core = sstep(0.55, 0.8, U);
  const Sx = 80 + 300 * Math.pow(1 - U, 1.6);
  const Sz = Sx * 0.725;
  const hw = mix(2.6, 3.6, sstep(0.1, 0.6, U));
  const Lw = mix(20, 15, sstep(0.1, 0.5, U)) + 12 * core;
  const D = Math.min(hw + mix(22, 30, core), 0.48 * Sz);
  const gate = sstep(0.004, 0.02, U) * (U >= URBAN_MIN_U ? 1 : 0.3);
  const s0 = (pk0 * 2 * hw) / Sx;
  const s1 = (pk1 * 2 * hw) / Sz;
  const kb = mix(0.35, 0.75, sstep(0.03, 0.3, U));
  const hwb = mix(3.0, 4.6, sstep(0.1, 0.6, U));
  const streets = 0.85 * (s0 + s1 - s0 * s1 + (kb * 2 * hwb * 2) / G) * gate;
  const fLR = Math.min(1, (pk0 * 2 * D) / Sx);
  const fTB = Math.min(1, (pk1 * 2 * D) / Sz);
  const front = (fLR + (1 - fLR) * fTB) * gate;
  const sb = hw + mix(4, 1.75, core);
  const dp = mix(11, D - sb - 1.5, core);
  const g = mix(3, 1.3, core);
  const roofs = front * occupancy(U) * ((Lw - 2 * g) / Lw) * 0.75 * (dp / D);
  out[0] = roofs;
  out[1] = streets;
  out[2] = mix(0.12, 0.7, sstep(0.25, 0.75, U));
  out[3] = front;
}

// --- GLSL twin ------------------------------------------------------------------------------------

/**
 * Needs uniforms uUrbanTex (RGBA8 field), uUrbanInfo (originX, originZ, resM, enabled),
 * uUrbanSize (nx, nz) and uUrbanSeed; declared here.
 */
export const URBAN_MATH_GLSL = /* glsl */ `
  uniform highp sampler2D uUrbanTex;
  uniform vec4 uUrbanInfo;
  uniform ivec2 uUrbanSize;
  uniform int uUrbanSeed;

  float uh(int a, int b, int c) {
    uint h = uint(a) * 0x8da6b343u ^ uint(b) * 0xd8163841u ^ uint(c) * 0xcb1ab31fu ^ uint(uUrbanSeed) * 0x2c1b3c6du;
    h ^= h >> 16u;
    h *= 0x7feb352du;
    h ^= h >> 15u;
    h *= 0x846ca68bu;
    h ^= h >> 16u;
    return float(h >> 8u) * (1.0 / 16777216.0);
  }

  vec2 uWarp(vec2 p) {
    return vec2(
      14.0 * sin(0.0071 * p.x + 0.0043 * p.y + 1.7) + 8.0 * sin(-0.0029 * p.x + 0.0117 * p.y + 0.4) + 30.0 * sin(0.0043 * p.x - 0.0021 * p.y + 0.9),
      14.0 * sin(-0.0052 * p.x + 0.0066 * p.y + 4.1) + 8.0 * sin(0.0123 * p.x + 0.0034 * p.y + 2.9) + 30.0 * sin(0.0019 * p.x + 0.0046 * p.y + 5.2));
  }

  vec4 uTexel(ivec2 t) {
    return texelFetch(uUrbanTex, clamp(t, ivec2(0), uUrbanSize - 1), 0);
  }

  float uSdfDec(float v) { return (v - 128.0 / 255.0) * ${((URBAN_SDF_RANGE_M / 127) * 255).toFixed(6)}; }

  // Bilinear sample: U, cos2a, sin2a, sdf (m); minAbs = min |sdf| over the four texels.
  vec4 uSample(vec2 p, out float minAbs) {
    vec2 g = (p - uUrbanInfo.xy) / uUrbanInfo.z - 0.5;
    vec2 fl = floor(g);
    vec2 f = g - fl;
    ivec2 i = ivec2(fl);
    vec4 a = uTexel(i);
    vec4 b = uTexel(i + ivec2(1, 0));
    vec4 c = uTexel(i + ivec2(0, 1));
    vec4 d = uTexel(i + ivec2(1, 1));
    minAbs = min(min(abs(uSdfDec(a.w)), abs(uSdfDec(b.w))), min(abs(uSdfDec(c.w)), abs(uSdfDec(d.w))));
    vec4 r = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    return vec4(r.x, r.y * 2.0 - 1.0, r.z * 2.0 - 1.0, uSdfDec(r.w));
  }

  float uTexelU(vec2 p) {
    ivec2 t = ivec2(floor((p - uUrbanInfo.xy) / uUrbanInfo.z));
    if (t.x < 0 || t.y < 0 || t.x >= uUrbanSize.x || t.y >= uUrbanSize.y) return 0.0;
    return texelFetch(uUrbanTex, t, 0).x;
  }

  // A district centre's jitter: one hash, 12 bits per axis.
  vec2 uFeature(ivec2 c) {
    int h = int(uh(c.x + ${OFF}, c.y + ${OFF}, 1) * 16777216.0);
    return (vec2(c) + 0.2 + 0.6 * vec2(float(h >> 12), float(h & 4095)) * (1.0 / 4096.0)) * ${G.toFixed(1)};
  }

  // Owner district c1 (centre f1) of warped point s; neighbour c2 (f2) across the nearest border at distance border.
  void uDistrictAt(vec2 s, out ivec2 c1, out vec2 f1, out ivec2 c2, out vec2 f2, out float border) {
    ivec2 c0 = ivec2(floor(s / ${G.toFixed(1)}));
    vec2 fs[9];
    float best = 1e20;
    int bk = 0;
    // (Only constant array indices once the loops unroll: a dynamic index can push the array
    // out of registers on some GPUs.)
    for (int k = 0; k < 9; k++) {
      ivec2 c = c0 + ivec2(k % 3 - 1, k / 3 - 1);
      fs[k] = uFeature(c);
      vec2 d = fs[k] - s;
      float dd = dot(d, d);
      if (dd < best) { best = dd; bk = k; c1 = c; f1 = fs[k]; }
    }
    border = 1e20;
    for (int k = 0; k < 9; k++) {
      if (k == bk) continue;
      vec2 n = fs[k] - f1;
      float e = dot(0.5 * (fs[k] + f1) - s, n) * inversesqrt(dot(n, n));
      if (e < border) { border = e; c2 = c0 + ivec2(k % 3 - 1, k / 3 - 1); f2 = fs[k]; }
    }
  }

  struct UDist {
    float U; float core; float c; float s;
    float Sx; float Sz; float ox; float oz;
    float hw; float Lw; float D; float dens;
  };

  UDist uDistrictParams(ivec2 cc, vec2 f) {
    UDist P;
    ivec2 t = ivec2(floor((f - uUrbanInfo.xy) / uUrbanInfo.z));
    vec4 v = vec4(0.0, 1.0, 0.5, 0.0);
    if (t.x >= 0 && t.y >= 0 && t.x < uUrbanSize.x && t.y < uUrbanSize.y) v = texelFetch(uUrbanTex, t, 0);
    int a = cc.x + ${OFF};
    int b = cc.y + ${OFF};
    P.U = v.x;
    P.core = smoothstep(0.55, 0.8, P.U);
    float th = 0.5 * atan(v.z * 2.0 - 1.0, v.y * 2.0 - 1.0) + (uh(a, b, 3) - 0.5) * 0.3;
    P.c = cos(th);
    P.s = sin(th);
    P.Sx = 80.0 + 300.0 * pow(1.0 - P.U, 1.6);
    P.Sz = P.Sx * (0.6 + 0.25 * uh(a, b, 4));
    P.ox = uh(a, b, 5) * P.Sx;
    P.oz = uh(a, b, 6) * P.Sz;
    P.hw = mix(2.6, 3.6, smoothstep(0.1, 0.6, P.U));
    P.Lw = mix(20.0, 15.0, smoothstep(0.1, 0.5, P.U)) + 12.0 * P.core;
    P.D = min(P.hw + mix(22.0, 30.0, P.core), 0.48 * min(P.Sx, P.Sz));
    P.dens = 0.85 + 0.3 * uh(a, b, 7);
    return P;
  }

  vec2 uKeepProb(int fam, float U) {
    float t = smoothstep(0.12, 0.65, U);
    return fam == 0 ? vec2(mix(0.6, 1.0, t), mix(0.8, 0.97, t)) : vec2(mix(0.3, 1.0, t), mix(0.55, 0.93, t));
  }

  bool uSegKeep(ivec2 cc, int i, int j, int fam, float U) {
    vec2 p = uKeepProb(fam, U);
    int line = fam == 0 ? i : j;
    if (uh((cc.x + ${OFF}) * 128 + line + 64, (cc.y + ${OFF}) * 4 + fam, 20) >= p.x) return false;
    return uh((cc.x + ${OFF}) * 128 + i + 64, (cc.y + ${OFF}) * 128 + j + 64, 16 + fam) < p.y;
  }

  bool uLess(ivec2 a, ivec2 b) { return a.x < b.x || (a.x == b.x && a.y < b.y); }

  float uBorderRoadHw(ivec2 a, ivec2 b, float Ua, float Ub) {
    float Um = max(Ua, Ub);
    if (Um < ${URBAN_MIN_U.toFixed(3)}) return 0.0;
    bool aLo = uLess(a, b);
    ivec2 lo = aLo ? a : b;
    ivec2 hi = aLo ? b : a;
    float h = uh((lo.x + ${OFF}) * 4 + (hi.x - lo.x + 1), (lo.y + ${OFF}) * 4 + (hi.y - lo.y + 1), 24);
    if (h >= mix(0.35, 0.75, smoothstep(0.03, 0.3, Um))) return 0.0;
    return mix(3.0, 4.6, smoothstep(0.1, 0.6, Um));
  }

  float uGridStreetDist(ivec2 cc, UDist P, vec2 f, vec2 s) {
    if (P.U < ${URBAN_MIN_U.toFixed(3)}) return 1e9;
    vec2 d = s - f;
    vec2 l = vec2(P.c * d.x + P.s * d.y + P.ox, -P.s * d.x + P.c * d.y + P.oz);
    int i = int(floor(l.x / P.Sx));
    int j = int(floor(l.y / P.Sz));
    float a = l.x - float(i) * P.Sx;
    float b = l.y - float(j) * P.Sz;
    float r = 1e9;
    if (uSegKeep(cc, i, j, 0, P.U)) r = min(r, a);
    if (uSegKeep(cc, i + 1, j, 0, P.U)) r = min(r, P.Sx - a);
    if (uSegKeep(cc, i, j, 1, P.U)) r = min(r, b);
    if (uSegKeep(cc, i, j + 1, 1, P.U)) r = min(r, P.Sz - b);
    return r;
  }

  float uOccupancy(float U) { return min(0.95, 0.25 + 1.3 * U) * smoothstep(0.03, 0.1, U); }

  float uLotHash(ivec3 lot, int salt) { return uh(lot.x, lot.y, lot.z * 8 + salt); }

  // Building shape of a lot: x = setback from the street centreline, y = depth, z = side gap.
  vec3 uLotShape(ivec3 lot, float core, float hw, float D) {
    float h1 = uLotHash(lot, 1);
    float h2 = uLotHash(lot, 2);
    float h3 = uLotHash(lot, 3);
    float sb = hw + mix(2.0 + 4.0 * h1, 1.0 + 1.5 * h1, core);
    float dp = max(6.0, min(D - sb - 1.0, mix(8.0 + 6.0 * h2, D - sb - 1.5, core)));
    float g = mix(1.5 + 3.0 * h3, 0.8 + 1.0 * h3, core);
    return vec3(sb, dp, g);
  }

  // Everything the colouring needs at one ground point (see urbanMath.ts urbanPixel).
  struct UPx {
    float U; float sdf; float Ud; float core; float gate;
    // Grid: local position in the block (a, b), block size, street half width, kept sides L R T B.
    vec2 ab; vec2 S; float hw; vec4 keep; vec2 dirX;
    // Collector: distance to the border, its half width (0 = none) and its normal.
    float border; float hwb; vec2 nB;
    // Lot row: region (0 none, 1 interior, 2 grid, 3 collector), across/along the row, the lot's
    // width, shape (setback, depth, gap), id, and whether it has a building (U of the texel at its centre).
    int region; float across; float t; float Lw; vec3 shape; ivec3 lot; float built; float lotU;
    float dens; float D;
    // Which street the lot row fronts: 0-3 grid sides L R T B, 4 the collector.
    int side;
    // For street lights: the point in the district's grid frame, the district cell, the position
    // along the collector (m from the midpoint of the two centres) and its lower cell.
    vec2 l; ivec2 cell; float tB; ivec2 lo;
  };

  // smp, minAbs: uSample(p) (the caller has it already).
  UPx uUrbanPixel(vec2 p, vec4 smp, float minAbs, bool lotDetail) {
    UPx o;
    o.U = smp.x;
    o.side = -1;
    o.sdf = minAbs < 72.0 ? smp.w : 1e9;
    o.region = 0;
    o.hwb = 0.0;
    o.keep = vec4(0.0);
    o.built = 0.0;
    o.Ud = 0.0;
    o.core = 0.0;
    o.gate = smoothstep(0.004, 0.012, o.U);
    o.across = 1e9;
    o.t = 0.0;
    o.Lw = 1.0;
    o.shape = vec3(0.0);
    o.lot = ivec3(0);
    o.lotU = 0.0;
    o.dens = 1.0;
    o.border = 1e9;
    o.hw = 0.0;
    o.D = 1.0;
    o.S = vec2(1.0);
    o.ab = vec2(0.0);
    o.dirX = vec2(1.0, 0.0);
    o.nB = vec2(1.0, 0.0);
    o.l = vec2(0.0);
    o.cell = ivec2(0);
    o.tB = 0.0;
    o.lo = ivec2(0);
    if (o.U < 0.004) return o;
    vec2 s = p + uWarp(p);
    ivec2 c1; vec2 f1; ivec2 c2; vec2 f2; float border;
    uDistrictAt(s, c1, f1, c2, f2, border);
    UDist P = uDistrictParams(c1, f1);
    float Un = uTexelU(f2);
    o.Ud = P.U;
    o.core = P.core;
    o.dens = P.dens;
    o.border = border;
    o.hwb = uBorderRoadHw(c1, c2, P.U, Un);
    bool aLo = uLess(c1, c2);
    vec2 fl = aLo ? f1 : f2;
    vec2 fh = aLo ? f2 : f1;
    vec2 n = normalize(fh - fl);
    o.nB = n;
    o.cell = c1;
    o.lo = aLo ? c1 : c2;
    o.tB = dot(s - 0.5 * (fl + fh), vec2(-n.y, n.x));
    if (P.U < ${URBAN_MIN_U.toFixed(3)} && o.hwb <= 0.0) return o;
    o.region = 1;
    vec2 d = s - f1;
    vec2 l = vec2(P.c * d.x + P.s * d.y + P.ox, -P.s * d.x + P.c * d.y + P.oz);
    int i = int(floor(l.x / P.Sx));
    int j = int(floor(l.y / P.Sz));
    float a = l.x - float(i) * P.Sx;
    float b = l.y - float(j) * P.Sz;
    bool ok = P.U >= ${URBAN_MIN_U.toFixed(3)};
    bool kL = ok && uSegKeep(c1, i, j, 0, P.U);
    bool kR = ok && uSegKeep(c1, i + 1, j, 0, P.U);
    bool kT = ok && uSegKeep(c1, i, j, 1, P.U);
    bool kB = ok && uSegKeep(c1, i, j + 1, 1, P.U);
    o.ab = vec2(a, b);
    o.l = l;
    o.S = vec2(P.Sx, P.Sz);
    o.hw = P.hw;
    o.D = P.D;
    o.keep = vec4(kL, kR, kT, kB);
    o.dirX = vec2(P.c, P.s);
    float Db = o.hwb + mix(22.0, 28.0, P.core);
    if (o.hwb > 0.0 && border < Db) {
      o.region = 3;
      o.side = 4;
      vec2 m = 0.5 * (fl + fh);
      float t = dot(s - m, vec2(-n.y, n.x));
      o.Lw = 18.0 + 8.0 * P.core;
      int k = int(floor(t / o.Lw));
      ivec2 lo = aLo ? c1 : c2;
      ivec2 hi = aLo ? c2 : c1;
      o.lot = ivec3((lo.x + ${OFF}) * 4 + (hi.x - lo.x + 1), (lo.y + ${OFF}) * 4 + (hi.y - lo.y + 1), 2048 + (aLo ? 0 : 1) * 1024 + k + 512);
      o.across = border;
      o.t = t - float(k) * o.Lw;
      o.D = Db;
      o.shape = uLotShape(o.lot, P.core, o.hwb, Db);
      if (lotDetail) {
        float side = aLo ? -1.0 : 1.0;
        vec2 uc = m + vec2(-n.y, n.x) * ((float(k) + 0.5) * o.Lw) + n * (side * (o.shape.x + 0.5 * o.shape.y));
        o.lotU = uTexelU(uc);
        // No building where a grid street runs on into the lot (see urbanMath.ts collectorLotClear).
        if (uGridStreetDist(c1, P, f1, uc) < P.hw + 0.5 * max(o.Lw - 2.0 * o.shape.z, o.shape.y) + 1.0) o.lotU = 0.0;
      }
    } else {
      if (!ok) return o;
      int side = -1;
      if (kL && a < P.D && !(kR && P.Sx - a < a)) { side = 0; o.across = a; }
      else if (kR && P.Sx - a < P.D) { side = 1; o.across = P.Sx - a; }
      else if (kT && b < P.D && !(kB && P.Sz - b < b)) { side = 2; o.across = b; }
      else if (kB && P.Sz - b < P.D) { side = 3; o.across = P.Sz - b; }
      if (side < 0) return o;
      o.region = 2;
      o.side = side;
      float t0;
      float t1;
      float t;
      if (side < 2) { t0 = kT ? P.hw : 0.0; t1 = P.Sz - (kB ? P.hw : 0.0); t = b - t0; }
      else { t0 = kL ? P.D : 0.0; t1 = P.Sx - (kR ? P.D : 0.0); t = a - t0; }
      o.Lw = P.Lw;
      int k = int(floor(t / o.Lw));
      if (k < 0 || float(k + 1) * o.Lw > t1 - t0) { o.region = 1; o.across = 1e9; return o; }
      o.lot = ivec3((c1.x + ${OFF}) * 128 + i + 64, (c1.y + ${OFF}) * 128 + j + 64, 64 + side * 128 + k + 16);
      o.t = t - float(k) * o.Lw;
      o.shape = uLotShape(o.lot, P.core, P.hw, P.D);
      if (lotDetail) {
        float ac = o.shape.x + 0.5 * o.shape.y;
        float tc = t0 + (float(k) + 0.5) * o.Lw;
        vec2 cl;
        if (side == 0) cl = vec2(float(i) * P.Sx + ac, float(j) * P.Sz + tc);
        else if (side == 1) cl = vec2(float(i + 1) * P.Sx - ac, float(j) * P.Sz + tc);
        else if (side == 2) cl = vec2(float(i) * P.Sx + tc, float(j) * P.Sz + ac);
        else cl = vec2(float(i) * P.Sx + tc, float(j + 1) * P.Sz - ac);
        vec2 q = cl - vec2(P.ox, P.oz);
        vec2 uc = f1 + vec2(P.c * q.x - P.s * q.y, P.s * q.x + P.c * q.y);
        o.lotU = uTexelU(uc);
      }
    }
    if (lotDetail) o.built = step(uLotHash(o.lot, 0), uOccupancy(o.lotU) * P.dens) * step(${(URBAN_ARTERIAL_HW_M + 3).toFixed(1)}, abs(o.sdf));
    return o;
  }

  // Expected cover of an area of urbanity U: x roofs, y streets, z flat-roof share, w frontage share.
  vec4 uUrbanMean(float U) {
    vec2 k0 = uKeepProb(0, U);
    vec2 k1 = uKeepProb(1, U);
    float pk0 = k0.x * k0.y;
    float pk1 = k1.x * k1.y;
    float core = smoothstep(0.55, 0.8, U);
    float Sx = 80.0 + 300.0 * pow(1.0 - U, 1.6);
    float Sz = Sx * 0.725;
    float hw = mix(2.6, 3.6, smoothstep(0.1, 0.6, U));
    float Lw = mix(20.0, 15.0, smoothstep(0.1, 0.5, U)) + 12.0 * core;
    float D = min(hw + mix(22.0, 30.0, core), 0.48 * Sz);
    float gate = smoothstep(0.004, 0.02, U) * (U >= ${URBAN_MIN_U.toFixed(3)} ? 1.0 : 0.3);
    float s0 = pk0 * 2.0 * hw / Sx;
    float s1 = pk1 * 2.0 * hw / Sz;
    float kb = mix(0.35, 0.75, smoothstep(0.03, 0.3, U));
    float hwb = mix(3.0, 4.6, smoothstep(0.1, 0.6, U));
    float streets = 0.85 * (s0 + s1 - s0 * s1 + kb * 2.0 * hwb * 2.0 / ${G.toFixed(1)}) * gate;
    float fLR = min(1.0, pk0 * 2.0 * D / Sx);
    float fTB = min(1.0, pk1 * 2.0 * D / Sz);
    float front = (fLR + (1.0 - fLR) * fTB) * gate;
    float sb = hw + mix(4.0, 1.75, core);
    float dp = mix(11.0, D - sb - 1.5, core);
    float g = mix(3.0, 1.3, core);
    float roofs = front * uOccupancy(U) * ((Lw - 2.0 * g) / Lw) * 0.75 * (dp / D);
    return vec4(roofs, streets, mix(0.12, 0.7, smoothstep(0.25, 0.75, U)), front);
  }
`;
