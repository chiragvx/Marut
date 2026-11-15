/**
 * src/briefing/mapData.ts — the war-room table map's data, without three.js: where the table map
 * sits in the room, the named places, the rivers, the height grid sampled from the game's own
 * Himalaya terrain (src/terrain/himalaya, the same mountains the player flies) and its colours.
 *
 * The map is relief, rivers, place names and the story's own marks (attack pins, advance arrows,
 * a front line, the C-17's route, the drop zone) — and nothing else. It draws NO international
 * boundary and NO colouring by country, on purpose: the area is disputed (Kalapani / Lipulekh,
 * Aksai Chin) and India restricts maps that show it wrongly. MAP_LINE_KINDS is the whole list of
 * line kinds the table may draw (tests/briefing/briefing.test.ts holds the map to it).
 *
 * Room frame: metres, y up, the map north-up with world x east -> room x, world z south -> room z.
 */
import { AIRFIELDS, LAKES, PEAKS, VALLEYS, geo } from '../terrain/himalaya/layout';

/** The world the map shows: the whole 200 km Himalaya theatre, +-100 km about its centre. */
export const MAP_WORLD_HALF_M = 100_000;
/** The map's side on the table, room metres. */
export const TABLE_MAP_SIZE_M = 2.6;
/** Room metres per world metre, across. */
export const MAP_SCALE = TABLE_MAP_SIZE_M / (2 * MAP_WORLD_HALF_M);
/** Heights are drawn this much taller than true scale (a relief model's usual exaggeration). */
export const MAP_RELIEF = 1.8;
/** The table top (the map's sea of glass), room metres up. */
export const TABLE_TOP_Y = 0.86;
/** Ground this low sits on the table top. */
const MAP_FLOOR_H = 300;

export const roomY = (h: number): number => TABLE_TOP_Y + 0.004 + Math.max(0, h - MAP_FLOOR_H) * MAP_SCALE * MAP_RELIEF;

/** The kinds of line the table map draws: and only these (no boundaries, no country fills). */
export const MAP_LINE_KINDS = ['river', 'grid', 'arrow', 'route', 'front', 'ring'] as const;
export type MapLineKind = (typeof MAP_LINE_KINDS)[number];

/** A point on the map: a place id, a latitude/longitude, or a world position (m, x east, z south). */
export type MapPoint = string | { lat: number; lon: number } | { x: number; z: number };

export type PlaceKind = 'town' | 'post' | 'airfield' | 'pass' | 'peak' | 'lake' | 'river' | 'region';
export interface Place {
  name: string;
  lat: number;
  lon: number;
  kind: PlaceKind;
}

const airfield = (id: string): { lat: number; lon: number } => {
  const a = AIRFIELDS.find((f) => f.id === id)!;
  return { lat: a.lat, lon: a.lon };
};
const peak = (id: string): { lat: number; lon: number } => {
  const p = PEAKS.find((f) => f.id === id)!;
  return { lat: p.lat, lon: p.lon };
};
const lake = (id: string): { lat: number; lon: number } => {
  const l = LAKES.find((f) => f.id === id)!;
  return { lat: l.lat, lon: l.lon };
};

/**
 * The places the briefings can name or point at. Airfields, peaks and lakes are the terrain's own
 * (layout.ts); the villages and posts are placed on the game's (compressed) map along the Humla
 * Karnali, not surveyed. Regions are districts and valleys, never countries.
 */
export const PLACES: Readonly<Record<string, Place>> = {
  simikot: { name: 'Simikot', kind: 'airfield', ...airfield('simikot') },
  hilsa: { name: 'Hilsa', kind: 'post', lat: 30.152, lon: 81.336 },
  yari: { name: 'Yari', kind: 'post', lat: 30.112, lon: 81.432 },
  limi: { name: 'Limi', kind: 'post', lat: 30.258, lon: 81.545 },
  kermi: { name: 'Kermi', kind: 'town', lat: 30.012, lon: 81.676 },
  purang: { name: 'Purang', kind: 'airfield', ...airfield('burang') },
  lipulekh: { name: 'Lipulekh', kind: 'pass', lat: 30.234, lon: 81.029 },
  gunji: { name: 'Gunji', kind: 'airfield', ...airfield('gunji') },
  naini: { name: 'Naini Saini', kind: 'airfield', ...airfield('naini') },
  ngari: { name: 'Ngari Gunsa', kind: 'airfield', ...airfield('ngari') },
  dharchula: { name: 'Dharchula', kind: 'town', lat: 29.85, lon: 80.54 },
  kailash: { name: 'Kailash', kind: 'peak', ...peak('kailash') },
  gurla: { name: 'Gurla Mandhata', kind: 'peak', ...peak('gurla') },
  api: { name: 'Api', kind: 'peak', ...peak('api') },
  saipal: { name: 'Saipal', kind: 'peak', ...peak('saipal') },
  mansarovar: { name: 'Mansarovar', kind: 'lake', ...lake('mansarovar') },
  karnali: { name: 'Karnali', kind: 'river', lat: 30.085, lon: 81.5 },
  kali: { name: 'Kali', kind: 'river', lat: 29.95, lon: 80.69 },
  humla: { name: 'Humla', kind: 'region', lat: 30.08, lon: 81.98 },
};

/** World position of a map point (throws on an unknown place id: the script tests catch it). */
export function worldOf(p: MapPoint): { x: number; z: number } {
  if (typeof p === 'string') {
    const pl = PLACES[p];
    if (!pl) throw new Error(`unknown place '${p}'`);
    const [x, z] = geo(pl.lat, pl.lon);
    return { x, z };
  }
  if ('lat' in p) {
    const [x, z] = geo(p.lat, p.lon);
    return { x, z };
  }
  return { x: p.x, z: p.z };
}

/** Room x / z of a world position. */
export const roomX = (worldX: number): number => worldX * MAP_SCALE;
export const roomZ = (worldZ: number): number => worldZ * MAP_SCALE;

// --- The height grid ---------------------------------------------------------------------------

/** Samples along each axis. */
export const GRID_N = 224;
/** Extra sample density round the drop zone (the last shots push in on Simikot), as 1 + A * gaussian. */
const WARP_GAIN = 3.2;
const WARP_SIGMA_M = 14_000;

/**
 * One axis's sample positions (world m), denser near `centre`: the inverse of the cumulative
 * density 1 + WARP_GAIN * exp(-((s - centre) / sigma)^2). One mesh, no seams, ~300 m cells over
 * the Karnali gorge and ~1.2 km on the far plateau.
 */
export function warpAxis(n: number, centre: number): Float64Array {
  const steps = 4096;
  const h = (2 * MAP_WORLD_HALF_M) / steps;
  const cum = new Float64Array(steps + 1);
  for (let i = 1; i <= steps; i++) {
    const s = -MAP_WORLD_HALF_M + (i - 0.5) * h;
    cum[i] = cum[i - 1]! + h * (1 + WARP_GAIN * Math.exp(-(((s - centre) / WARP_SIGMA_M) ** 2)));
  }
  const total = cum[steps]!;
  const out = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    while (j < steps - 1 && cum[j + 1]! < target) j++;
    const f = (target - cum[j]!) / Math.max(1e-9, cum[j + 1]! - cum[j]!);
    out[i] = -MAP_WORLD_HALF_M + (j + Math.min(1, Math.max(0, f))) * h;
  }
  out[0] = -MAP_WORLD_HALF_M;
  out[n - 1] = MAP_WORLD_HALF_M;
  return out;
}

export interface MapGrid {
  n: number;
  xs: Float64Array;
  zs: Float64Array;
  /** Height (m), row-major: h[j * n + i] at (xs[i], zs[j]). */
  h: Float32Array;
  /** Vertex colours, RGB 0..255. */
  rgb: Uint8Array;
}

export function gridAxes(n = GRID_N): { xs: Float64Array; zs: Float64Array } {
  const dz = worldOf('simikot');
  return { xs: warpAxis(n, dz.x - 6000), zs: warpAxis(n, dz.z - 3000) };
}

/** Hypsometric tints (m -> linear-ish RGB 0..1): a printed relief map, never coloured by country. */
const TINTS: readonly [number, number, number, number][] = [
  [300, 0.2, 0.3, 0.2],
  [1200, 0.3, 0.38, 0.24],
  [2200, 0.47, 0.47, 0.3],
  [3200, 0.6, 0.53, 0.37],
  [4300, 0.66, 0.58, 0.44],
  [5200, 0.6, 0.56, 0.52],
  [5900, 0.78, 0.78, 0.78],
  [6600, 0.94, 0.95, 0.96],
];

function tint(h: number, out: [number, number, number]): void {
  if (h <= TINTS[0]![0]) {
    out[0] = TINTS[0]![1];
    out[1] = TINTS[0]![2];
    out[2] = TINTS[0]![3];
    return;
  }
  for (let k = 1; k < TINTS.length; k++) {
    const b = TINTS[k]!;
    if (h <= b[0]) {
      const a = TINTS[k - 1]!;
      const f = (h - a[0]) / (b[0] - a[0]);
      out[0] = a[1] + (b[1] - a[1]) * f;
      out[1] = a[2] + (b[2] - a[2]) * f;
      out[2] = a[3] + (b[3] - a[3]) * f;
      return;
    }
  }
  const l = TINTS[TINTS.length - 1]!;
  out[0] = l[1];
  out[1] = l[2];
  out[2] = l[3];
}

/**
 * Samples the terrain on the grid and colours it: tints by height, lakes blue, hill shading from
 * the north-west (as printed maps are lit), darker towards the map's edge.
 */
export function buildMapGrid(heightAt: (x: number, z: number) => number, waterLevelAt: (x: number, z: number) => number, n = GRID_N): MapGrid {
  const { xs, zs } = gridAxes(n);
  const h = new Float32Array(n * n);
  const wet = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = xs[i]!, z = zs[j]!;
      const g = heightAt(x, z);
      const w = waterLevelAt(x, z);
      const k = j * n + i;
      if (w > g) {
        h[k] = w;
        wet[k] = 1;
      } else h[k] = g;
    }
  }
  const rgb = new Uint8Array(n * n * 3);
  const c: [number, number, number] = [0, 0, 0];
  // Light from the north-west, 40 degrees up; slopes exaggerated so the relief reads from far off.
  const lx = -0.62, ly = 0.64, lz = -0.45;
  const EX = 2.6;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      const j0 = Math.max(0, j - 1), j1 = Math.min(n - 1, j + 1);
      const dhdx = ((h[j * n + i1]! - h[j * n + i0]!) / (xs[i1]! - xs[i0]!)) * EX;
      const dhdz = ((h[j1 * n + i]! - h[j0 * n + i]!) / (zs[j1]! - zs[j0]!)) * EX;
      const len = Math.hypot(dhdx, 1, dhdz);
      const shade = Math.max(0, (-dhdx * lx + ly - dhdz * lz) / len);
      if (wet[k]) {
        c[0] = 0.18;
        c[1] = 0.36;
        c[2] = 0.5;
      } else tint(h[k]!, c);
      const lit = 0.32 + 0.95 * shade;
      const ex = Math.abs(xs[i]!) / MAP_WORLD_HALF_M, ez = Math.abs(zs[j]!) / MAP_WORLD_HALF_M;
      const edge = 1 - 0.55 * Math.max(0, Math.max(ex, ez) - 0.82) / 0.18;
      const m = lit * edge;
      rgb[k * 3] = Math.min(255, Math.round(c[0] * m * 255));
      rgb[k * 3 + 1] = Math.min(255, Math.round(c[1] * m * 255));
      rgb[k * 3 + 2] = Math.min(255, Math.round(c[2] * m * 255));
    }
  }
  return { n, xs, zs, h, rgb };
}

/** Index of the cell holding `v` on an ascending axis (clamped). */
function cellOf(axis: Float64Array, v: number): number {
  let lo = 0, hi = axis.length - 2;
  if (v <= axis[0]!) return 0;
  if (v >= axis[hi + 1]!) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (axis[mid]! <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The grid's height at a world point, as the mesh draws it (bilinear in its cell). */
export function gridHeightAt(g: MapGrid, x: number, z: number): number {
  const i = cellOf(g.xs, x), j = cellOf(g.zs, z);
  const fx = Math.min(1, Math.max(0, (x - g.xs[i]!) / (g.xs[i + 1]! - g.xs[i]!)));
  const fz = Math.min(1, Math.max(0, (z - g.zs[j]!) / (g.zs[j + 1]! - g.zs[j]!)));
  const n = g.n;
  const a = g.h[j * n + i]!, b = g.h[j * n + i + 1]!, c = g.h[(j + 1) * n + i]!, d = g.h[(j + 1) * n + i + 1]!;
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

// --- Lines -------------------------------------------------------------------------------------

/** A smooth path through points (Catmull-Rom), about every `stepM` world metres. */
export function smoothPath(pts: readonly { x: number; z: number }[], stepM = 400): { x: number; z: number }[] {
  if (pts.length < 2) return pts.map((p) => ({ ...p }));
  const out: { x: number; z: number }[] = [];
  for (let s = 0; s < pts.length - 1; s++) {
    const p0 = pts[Math.max(0, s - 1)]!, p1 = pts[s]!, p2 = pts[s + 1]!, p3 = pts[Math.min(pts.length - 1, s + 2)]!;
    const len = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const k = Math.max(1, Math.ceil(len / stepM));
    for (let q = 0; q < k; q++) {
      const t = q / k, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  out.push({ ...pts[pts.length - 1]! });
  return out;
}

export interface MapRiver {
  id: string;
  name: string;
  /** World points along the river's bed. */
  pts: { x: number; z: number }[];
  /** Ribbon width, room metres. */
  widthM: number;
}

/** The rivers: the terrain's own river valleys (layout.ts VALLEYS with river: true). */
export function mapRivers(): MapRiver[] {
  return VALLEYS.filter((v) => v.river).map((v) => ({
    id: v.id,
    name: v.name,
    pts: smoothPath(v.nodes.map((n) => {
      const [x, z] = geo(n.lat, n.lon);
      return { x, z };
    })),
    widthM: v.id === 'karnali' || v.id === 'sutlej' || v.id === 'indus' || v.id === 'kali' ? 0.0042 : 0.0026,
  }));
}
