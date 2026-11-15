/**
 * src/terrain/himalaya/humla.ts - the Humla Karnali valley system round Simikot, shaped by code.
 *
 * Along each river (layout.ts HUMLA_RIVER and HUMLA_TRIBUTARIES) the ground follows a valley
 * cross-profile: a gravel floor a few hundred metres wide, a short steep inner bank, then terraced
 * middle slopes (benches that follow the contours, where the villages and fields are) rising to
 * rounded ridges 1,500-2,100 m above the river. Spurs push out from the walls between the side
 * ravines, so the walls are neither straight nor uniform. The generic mountains (height.ts) stand
 * above the profile; the lower of the two wins, with a smooth blend.
 *
 * Simikot's terrace (SIMIKOT_SHELF) is laid over that: a broad shelf sloping gently to the south
 * and east, ending in a rounded edge above the river.
 *
 * Pure functions of the map-frame position: the same in every worker and on the main thread.
 */
import { Noise2, gullies } from './noise';
import { HUMLA_RIVER, HUMLA_TRIBUTARIES, MAP_SHIFT_X, MAP_SHIFT_Z, SIMIKOT_SHELF, geoMap, type HumlaRiver } from './layout';

const N = new Noise2(2971);

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** One river as a dense polyline (map frame), with the valley's shape at each point. */
interface Line {
  id: number;
  n: number;
  x: Float64Array; z: Float64Array; along: Float64Array;
  bed: Float64Array; floor: Float64Array; wall: Float64Array; relief: Float64Array; tilt: Float64Array;
  /** Segment groups for culling: first segment, bounding box. */
  groups: { s0: number; s1: number; minX: number; maxX: number; minZ: number; maxZ: number }[];
  minX: number; maxX: number; minZ: number; maxZ: number;
}

const STEP_M = 350;
/** Distance scale of the along-river averaging, m. */
const BLEND_M = 250;
const GROUP = 8;

function buildLine(r: HumlaRiver, id: number): Line {
  const P = r.nodes.map((nd) => { const [x, z] = geoMap(nd.lat, nd.lon); return { x, z, nd }; });
  const xs: number[] = [], zs: number[] = [], bed: number[] = [], fl: number[] = [], wl: number[] = [], rl: number[] = [], tl: number[] = [];
  for (let i = 0; i + 1 < P.length; i++) {
    const p0 = P[Math.max(0, i - 1)]!, p1 = P[i]!, p2 = P[i + 1]!, p3 = P[Math.min(P.length - 1, i + 2)]!;
    const k = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / STEP_M));
    for (let q = 0; q < k; q++) {
      const t = q / k, t2 = t * t, t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      const lin = (a: number, b: number): number => a + (b - a) * t;
      xs.push(cr(p0.x, p1.x, p2.x, p3.x)); zs.push(cr(p0.z, p1.z, p2.z, p3.z));
      bed.push(lin(p1.nd.bed, p2.nd.bed)); fl.push(lin(p1.nd.floor, p2.nd.floor)); wl.push(lin(p1.nd.wall, p2.nd.wall));
      rl.push(lin(p1.nd.relief, p2.nd.relief)); tl.push(lin(p1.nd.tilt ?? 0, p2.nd.tilt ?? 0));
    }
  }
  const last = P[P.length - 1]!;
  xs.push(last.x); zs.push(last.z); bed.push(last.nd.bed); fl.push(last.nd.floor); wl.push(last.nd.wall); rl.push(last.nd.relief); tl.push(last.nd.tilt ?? 0);
  const n = xs.length;
  const along = new Float64Array(n);
  for (let i = 1; i < n; i++) along[i] = along[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, zs[i]! - zs[i - 1]!);
  let reach = 0;
  for (let i = 0; i < n; i++) reach = Math.max(reach, fl[i]! + wl[i]! * 1.8);
  const groups: Line['groups'] = [];
  for (let s0 = 0; s0 < n - 1; s0 += GROUP) {
    const s1 = Math.min(n - 1, s0 + GROUP);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = s0; i <= s1; i++) { minX = Math.min(minX, xs[i]!); maxX = Math.max(maxX, xs[i]!); minZ = Math.min(minZ, zs[i]!); maxZ = Math.max(maxZ, zs[i]!); }
    groups.push({ s0, s1, minX, maxX, minZ, maxZ });
  }
  const g = groups;
  return {
    id, n, x: Float64Array.from(xs), z: Float64Array.from(zs), along,
    bed: Float64Array.from(bed), floor: Float64Array.from(fl), wall: Float64Array.from(wl), relief: Float64Array.from(rl), tilt: Float64Array.from(tl),
    groups,
    minX: Math.min(...g.map((q) => q.minX)) - reach, maxX: Math.max(...g.map((q) => q.maxX)) + reach,
    minZ: Math.min(...g.map((q) => q.minZ)) - reach, maxZ: Math.max(...g.map((q) => q.maxZ)) + reach,
  };
}

const MAIN = buildLine(HUMLA_RIVER, 0);
const TRIBS = HUMLA_TRIBUTARIES.map((r, i) => buildLine(r, i + 1));
const LINES = [MAIN, ...TRIBS];

/** Where a point stands relative to one river (shared scratch). */
interface Near { d: number; along: number; side: number; ux: number; uz: number; bed: number; floor: number; wall: number; relief: number; tilt: number }
const near: Near = { d: 0, along: 0, side: 0, ux: 0, uz: 0, bed: 0, floor: 0, wall: 0, relief: 0, tilt: 0 };

function nearest(L: Line, x: number, z: number, out: Near): boolean {
  if (x < L.minX || x > L.maxX || z < L.minZ || z > L.maxZ) return false;
  let best = Infinity, bi = -1, bu = 0;
  for (const g of L.groups) {
    const gx = Math.max(g.minX - x, 0, x - g.maxX), gz = Math.max(g.minZ - z, 0, z - g.maxZ);
    if (gx * gx + gz * gz >= best) continue;
    for (let i = g.s0; i < g.s1; i++) {
      const ax = L.x[i]!, az = L.z[i]!, ex = L.x[i + 1]! - ax, ez = L.z[i + 1]! - az;
      const l2 = ex * ex + ez * ez;
      const u = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
      const px = ax + ex * u - x, pz = az + ez * u - z;
      const d2 = px * px + pz * pz;
      if (d2 < best) { best = d2; bi = i; bu = u; }
    }
  }
  if (bi < 0) return false;
  const i = bi, u = bu;
  const ax = L.x[i]!, az = L.z[i]!, ex = L.x[i + 1]! - ax, ez = L.z[i + 1]! - az;
  const fx = ax + ex * u, fz = az + ez * u;
  const d = Math.sqrt(best);
  out.d = d;
  const vx = x - fx, vz = z - fz;
  // Left of the downstream direction (x east, z south): the cross product is negative.
  // (continuous: +-1 beside the line, 0 straight on past its ends).
  const el = Math.hypot(ex, ez);
  out.side = d > 1e-6 && el > 0 ? -(ex * vz - ez * vx) / (el * d) : 0;
  const inv = d > 1e-6 ? 1 / d : 0;
  out.ux = vx * inv; out.uz = vz * inv;
  // The distance along the river and the valley's shape, averaged over the segments nearly as
  // near as the nearest (a nearest-segment pick jumps on the inside of a bend).
  const lim = d + BLEND_M * 7;
  let ws = 0, al = 0, bd = 0, fo = 0, wa = 0, re = 0, ti = 0;
  for (const g of L.groups) {
    const gx = Math.max(g.minX - x, 0, x - g.maxX), gz = Math.max(g.minZ - z, 0, z - g.maxZ);
    if (gx * gx + gz * gz >= lim * lim) continue;
    for (let k = g.s0; k < g.s1; k++) {
      const kx = L.x[k]!, kz = L.z[k]!, qx = L.x[k + 1]! - kx, qz = L.z[k + 1]! - kz;
      const l2 = qx * qx + qz * qz;
      const uu = l2 > 0 ? Math.min(1, Math.max(0, ((x - kx) * qx + (z - kz) * qz) / l2)) : 0;
      const dk = Math.hypot(kx + qx * uu - x, kz + qz * uu - z);
      if (dk >= lim) continue;
      const w = Math.exp(-(dk - d) / BLEND_M);
      const lp = (a: Float64Array): number => a[k]! + (a[k + 1]! - a[k]!) * uu;
      ws += w; al += w * (L.along[k]! + (L.along[k + 1]! - L.along[k]!) * uu);
      bd += w * lp(L.bed); fo += w * lp(L.floor); wa += w * lp(L.wall); re += w * lp(L.relief); ti += w * lp(L.tilt);
    }
  }
  out.along = al / ws; out.bed = bd / ws; out.floor = fo / ws; out.wall = wa / ws; out.relief = re / ws; out.tilt = ti / ws;
  return true;
}

/** Terrace step on the valley walls, metres of height. */
const BENCH_M = 140;

/** The rivers wind: each is found from a point warped by this much (m), side valleys more. */
const warpAmp = (id: number): number => (id === 0 ? 320 : 500);
const warpX = (x: number, z: number): number => N.fbm(x / 3500 + 1.3, z / 3500 + 8.8, 3);
const warpZ = (x: number, z: number): number => N.fbm(x / 3500 - 5.2, z / 3500 + 2.4, 3);
/** The valley floor's half-width at a point, from the river's. */
const floorAt = (base: number, id: number, x: number, z: number): number => base * (1 + 0.35 * N.noise(x / 1900 + id * 7.1, z / 1900 - 3.3));
/** Where the channel runs across the floor (signed: + to the left of the line), m. */
const channelOffset = (floor: number, along: number, id: number): number => Math.min(0.45 * floor, 160) * N.noise(along / 1500, id * 13.37);
/** Half-width of the carved channel, m (its water is about 60% of that). */
const channelHalfWidth = (id: number): number => (id === 0 ? 22 : 9);

/** How much of a valley's profile applies at its point (1 near the river, 0 past its reach). */
let reachW = 0;
/** How much the profile is the ground outright, before the generic mountains (1 low on the walls). */
let ownW = 0;

/** The valley's ground at a point, from where it stands relative to the river; `ch` gets the channel weight. */
function valleyHeight(q: Near, id: number, x: number, z: number, ch: { river: number; flat: number }): number {
  // Everything that varies along the valley is a noise of the position, not of the distance along
  // the river (that jumps on the inside of bends); `side` is continuous (0 straight past an end).
  const floor = floorAt(q.floor, id, x, z);
  // The walls' foot wanders in and out by a few hundred metres.
  const d = Math.max(0, q.d + 500 * N.fbm(x / 4500 + 9.1, z / 4500 + id, 2) * smoothstep(floor, floor + 800, q.d));
  const s = Math.max(0, d - floor);
  const W = q.wall;
  // Spurs: high ground reaching towards the river between the side ravines, growing away from
  // the floor; and the ridge heights vary along the valley.
  // Spur lines run up the walls (a noise of the distance along the river, slowly bending with
  // height), with a little blotchy variation on top.
  const sp = 1.6 * N.ridged(x / 2600 + id * 3.1, z / 2600 - 6.6, 3) - 0.9;
  const se = s * (1 + 0.7 * sp * smoothstep(150, 1500, s));
  const Hr = q.relief * (1 + q.tilt * q.side) * (1 + 0.15 * N.noise(x / 7000 + id, z / 7000 + 5.1));
  const t = se / W;
  const inner = 1 - Math.exp(-se / (0.09 * W));
  const main = t < 1 ? Math.pow(t, 1.3) : 1 + (t - 1) * 0.7;
  // Side valleys are V-shaped (no inner gorge); the main river has its short steep bank.
  const ki = id === 0 ? 0.24 : 0.08;
  let R = Hr * (ki * inner + (1 - ki) * main);
  // Benches along the contours on the middle slopes (fields and villages), not on the inner bank
  // or near the crest; how strong varies along the valley.
  const off = 70 * N.fbm(x / 2500 - 4.1, z / 2500 + 7.3, 2);
  const qv = (R + off) / BENCH_M;
  const fl = Math.floor(qv);
  const tr = BENCH_M * (fl + smoothstep(0.4, 1, qv - fl)) - off;
  const amt = 0.4 * smoothstep(120, 320, R) * (1 - smoothstep(0.6 * Hr, 0.85 * Hr, R)) * (0.55 + 0.45 * N.noise(x / 3200 + 2.2, z / 3200 - 1.4));
  R += (tr - R) * amt;
  let h = q.bed + R + 0.02 * Math.min(q.d, floor) + 2.5 * N.fbm(x / 400, z / 400, 2);
  // Side ravines down the walls.
  const gA = Math.min(150, 0.14 * R) * smoothstep(40, 350, s);
  if (gA > 1) h += gA * (gullies(x, z, q.ux, q.uz, 1300, 3, 1.6, 1.2) - 0.1);
  // The channel: a few metres down, wandering on the floor.
  const ds = Math.abs(q.d * Math.sign(q.side) - channelOffset(floor, q.along, id));
  const cw = channelHalfWidth(id);
  if (ds < cw) {
    const kk = 1 - (ds / cw) * (ds / cw);
    h -= (id === 0 ? 3.5 : 2) * kk;
    ch.river = Math.max(ch.river, kk);
  }
  ch.flat = Math.max(ch.flat, 1 - smoothstep(floor * 0.8, floor + 150, q.d));
  reachW = 1 - smoothstep(q.floor + 1.0 * W, q.floor + 1.7 * W, q.d);
  ownW = 1 - smoothstep(0.35 * W, 1.0 * W, s);
  return h;
}

const shelf = (() => {
  const [x, z] = geoMap(SIMIKOT_SHELF.lat, SIMIKOT_SHELF.lon);
  const th = (SIMIKOT_SHELF.headingDeg * Math.PI) / 180;
  return { ...SIMIKOT_SHELF, x, z, ax: Math.sin(th), az: -Math.cos(th), rx: Math.cos(th), rz: Math.sin(th) };
})();
const SHELF_REACH = Math.max(shelf.alongM, shelf.northM, shelf.southM) * 1.6;

/** Surface hints out of humlaHeight (shared scratch). */
export const humlaInfo = { river: 0, flat: 0 };

/** Map-frame bounds of everything here (a quick reject). */
const B = { minX: Math.min(...LINES.map((l) => l.minX)), maxX: Math.max(...LINES.map((l) => l.maxX)), minZ: Math.min(...LINES.map((l) => l.minZ)), maxZ: Math.max(...LINES.map((l) => l.maxZ)) };

/**
 * The Humla landform over the generic mountains `h` at map-frame (x, z): the valleys cut into it,
 * and the terrace. Writes humlaInfo.
 */
export function humlaHeight(x: number, z: number, h: number): number {
  humlaInfo.river = 0;
  humlaInfo.flat = 0;
  if (x < B.minX || x > B.maxX || z < B.minZ || z > B.maxZ) return h;
  // The rivers wind: they are found from a warped point (side valleys more than the main one).
  const wx = warpX(x, z), wz = warpZ(x, z);
  for (const L of LINES) {
    const wa = warpAmp(L.id);
    if (!nearest(L, x + wx * wa, z + wz * wa, near)) continue;
    const v = valleyHeight(near, L.id, x, z, humlaInfo);
    // Where a side valley's wall meets the main valley's the blend is wide (a rounded spur, not a crease).
    // Low on the walls the valley's own profile is the ground (the generic mountains' hollows do not
    // show through); higher up it gives way to them, and the lower of the two wins.
    if (reachW > 0) {
      // (Narrow near the floors, so a confluence is not dug out below either river.)
      const m = smin(h, v, L.id === 0 ? 250 : Math.min(500, Math.max(40, (Math.min(h, v) - near.bed) * 0.8)));
      h += (m + (v - m) * (L.id === 0 ? ownW : 0) - h) * reachW;
    }
  }

  // Simikot's terrace.
  const dx = x - shelf.x, dz = z - shelf.z;
  if (Math.abs(dx) < SHELF_REACH && Math.abs(dz) < SHELF_REACH) {
    const a = dx * shelf.ax + dz * shelf.az, c = dx * shelf.rx + dz * shelf.rz;
    const ca = c >= 0 ? shelf.southM : shelf.northM;
    let e = Math.cbrt(Math.abs(a / shelf.alongM) ** 3 + Math.abs(c / ca) ** 3);
    e += 0.07 * N.noise(x / 900 + 4.4, z / 900 - 2.1) + 0.04 * N.noise(x / 300, z / 300);
    if (e < 1.4) {
      // A gentle plane with low field banks on it.
      let T = shelf.elev - shelf.slopeAlong * a - shelf.slopeCross * c;
      const qv = (T - 2800) / 6;
      const fl = Math.floor(qv);
      T = 2800 + 6 * (fl + smoothstep(0.55, 1, qv - fl)) * 0.6 + (T - 2800) * 0.4 + 1.5 * N.fbm(x / 250, z / 250, 2);
      const w = 1 - smoothstep(0.92, 1.38, e);
      h += (T - h) * w;
      humlaInfo.flat = Math.max(humlaInfo.flat, w * 0.75);
    }
  }
  return h;
}

/** The rivers' water for the renderer: a grid round the Humla rivers, world frame. */
export interface RiverGrid {
  /** World position of texel (0, 0), and the texel spacing, m. */
  originX: number; originZ: number; stepM: number;
  nx: number; nz: number;
  /** Per texel: R = signed distance to the channel's middle (128 + m / 2, so +-254 m; 255 = far),
   *  G = the water's half-width (m x 16). Signed, so bilinear filtering keeps the line sharp. */
  data: Uint8Array;
}

/**
 * Bakes where the Humla rivers' water is (the channels heightAt carves, found the same way) on a
 * grid `stepM` apart (40 m: 4.4 MB), for the alpine ground shader's water and gravel bars. Only the bands along
 * the rivers are computed; everything else stays "far".
 */
export function bakeRiverGrid(stepM = 40): RiverGrid {
  const PAD = 700;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const L of LINES) for (let i = 0; i < L.n; i++) { minX = Math.min(minX, L.x[i]!); maxX = Math.max(maxX, L.x[i]!); minZ = Math.min(minZ, L.z[i]!); maxZ = Math.max(maxZ, L.z[i]!); }
  minX -= PAD; minZ -= PAD; maxX += PAD; maxZ += PAD;
  const nx = Math.ceil((maxX - minX) / stepM) + 1, nz = Math.ceil((maxZ - minZ) / stepM) + 1;
  const dist = new Float32Array(nx * nz).fill(255);
  const sdist = new Float32Array(nx * nz).fill(254);
  const hw = new Uint8Array(nx * nz);
  // The warp per texel, computed once where needed (NaN: not yet).
  const qx = new Float32Array(nx * nz).fill(NaN), qz = new Float32Array(nx * nz);
  const R = 250;
  for (const L of LINES) {
    const wa = warpAmp(L.id);
    const reach = R + wa * 1.1;
    const half = channelHalfWidth(L.id) * 0.6;
    for (let k = 0; k + 1 < L.n; k++) {
      const ax = L.x[k]!, az = L.z[k]!, ex = L.x[k + 1]! - ax, ez = L.z[k + 1]! - az;
      const l2 = ex * ex + ez * ez;
      if (l2 <= 0) continue;
      const i0 = Math.max(0, Math.floor((Math.min(ax, ax + ex) - reach - minX) / stepM)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, ax + ex) + reach - minX) / stepM));
      const j0 = Math.max(0, Math.floor((Math.min(az, az + ez) - reach - minZ) / stepM)), j1 = Math.min(nz - 1, Math.ceil((Math.max(az, az + ez) + reach - minZ) / stepM));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const t = j * nx + i;
          const x = minX + i * stepM, z = minZ + j * stepM;
          if (Number.isNaN(qx[t]!)) { qx[t] = warpX(x, z); qz[t] = warpZ(x, z); }
          const px = x + qx[t]! * wa, pz = z + qz[t]! * wa;
          const u = Math.min(1, Math.max(0, ((px - ax) * ex + (pz - az) * ez) / l2));
          const vx = px - (ax + ex * u), vz = pz - (az + ez * u);
          const d = Math.hypot(vx, vz);
          if (d > R + 200) continue;
          const side = ex * vz - ez * vx < 0 ? 1 : -1;
          const along = L.along[k]! + (L.along[k + 1]! - L.along[k]!) * u;
          const floor = floorAt(L.floor[k]! + (L.floor[k + 1]! - L.floor[k]!) * u, L.id, x, z);
          const sd = d * side - channelOffset(floor, along, L.id);
          const ds = Math.abs(sd);
          if (ds < dist[t]!) { dist[t] = ds; sdist[t] = sd; hw[t] = Math.round(half * 16); }
        }
      }
    }
  }
  const data = new Uint8Array(nx * nz * 2);
  for (let t = 0; t < nx * nz; t++) {
    data[t * 2] = Math.min(254, Math.max(0, Math.round(128 + sdist[t]! / 2)));
    // No half-width where the distance is clamped: the sign may flip between two clamped texels
    // (band edges, midway between rivers), and a zero crossing there must not read as water.
    data[t * 2 + 1] = Math.abs(sdist[t]!) < 240 ? hw[t]! : 0;
  }
  // The border stays "far" (the texture clamps to it outside the grid).
  for (let i = 0; i < nx; i++) { data[i * 2 + 1] = 0; data[((nz - 1) * nx + i) * 2 + 1] = 0; }
  for (let j = 0; j < nz; j++) { data[j * nx * 2 + 1] = 0; data[(j * nx + nx - 1) * 2 + 1] = 0; }
  return { originX: minX - MAP_SHIFT_X, originZ: minZ - MAP_SHIFT_Z, stepM, nx, nz, data };
}
