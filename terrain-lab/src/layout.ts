/**
 * terrain-lab/src/layout.ts - the Himalaya theatre as a hand-written outline (no elevation data):
 * regional control points, named peaks, valley corridors, basins, lakes and airfield pads, placed
 * from real latitude/longitude (docs/spec/himalaya-theatre.md) on a map compressed to MAP_SCALE.
 *
 * Heights are real (density altitude is the point of the theatre); horizontal distances between
 * places are compressed so the 320 km box fits the game's 200 km world. Valley widths, runway
 * sizes and peak radii are given in world metres, not compressed.
 */

export const ORIGIN_LAT = 30.85;
export const ORIGIN_LON = 80.745;
/** Horizontal compression of the real map. */
export const MAP_SCALE = 0.6;
const M_PER_DEG_LAT = 111_200;
const M_PER_DEG_LON = 95_600; // at 30.85 N

/** World (x east, z south, metres) of a latitude/longitude. */
export function geo(lat: number, lon: number): [number, number] {
  return [(lon - ORIGIN_LON) * M_PER_DEG_LON * MAP_SCALE, -(lat - ORIGIN_LAT) * M_PER_DEG_LAT * MAP_SCALE];
}

export function toGeo(x: number, z: number): [number, number] {
  return [ORIGIN_LAT - z / (M_PER_DEG_LAT * MAP_SCALE), ORIGIN_LON + x / (M_PER_DEG_LON * MAP_SCALE)];
}

/** Half-size of the playable map, metres. */
export const MAP_HALF_M = 100_000;

/**
 * Regional fields, interpolated between control points (Gaussian-weighted):
 * base = the lowland/valley level of the region, relief = how far the mountains rise above it,
 * dissect = weight of the fine, densely cut ridge layer (Lesser Himalaya), dry = 0 monsoon-wet
 * south (forest, meadow) .. 1 rain-shadow plateau (steppe, scree).
 */
export interface ControlPoint { lat: number; lon: number; base: number; relief: number; dissect: number; dry: number }

const cp = (lat: number, lon: number, base: number, relief: number, dissect: number, dry: number): ControlPoint =>
  ({ lat, lon, base, relief, dissect, dry });

export const CONTROL: ControlPoint[] = [
  // Tibetan plateau: Ngari / Indus, Kailash (Gangdise) range, lakes plateau, Purang basin, Zanda.
  cp(32.30, 79.60, 4500, 1500, 0.15, 1),
  cp(32.10, 80.05, 4300, 1500, 0.15, 1),
  cp(32.25, 80.70, 4600, 1400, 0.15, 1),
  cp(31.85, 81.20, 4700, 1300, 0.15, 1),
  cp(32.00, 82.30, 4700, 1300, 0.15, 1),
  cp(31.50, 79.80, 3800, 900, 0.10, 1),
  cp(31.55, 80.55, 4400, 1200, 0.15, 1),
  cp(31.20, 81.30, 4700, 900, 0.15, 1),
  cp(31.25, 82.00, 4800, 1200, 0.15, 1),
  cp(30.67, 81.35, 4600, 350, 0.00, 1),
  cp(30.90, 81.85, 4700, 700, 0.10, 1),
  cp(30.38, 81.15, 4150, 900, 0.10, 0.9),
  cp(30.75, 80.85, 4700, 1200, 0.15, 1),
  cp(31.10, 80.20, 4400, 1200, 0.15, 1),
  cp(31.40, 79.20, 4500, 1300, 0.15, 0.9),
  // Great Himalaya crest: Kamet, Niti, Nanda Devi, Panchachuli, Lipulekh, Api, Saipal.
  cp(30.92, 79.59, 4300, 3000, 0.25, 0.6),
  cp(30.97, 79.88, 4300, 2600, 0.25, 0.7),
  cp(30.38, 79.97, 4000, 3200, 0.25, 0.5),
  cp(30.20, 80.43, 3800, 2900, 0.25, 0.45),
  cp(30.25, 81.03, 4200, 2200, 0.25, 0.7),
  cp(30.01, 80.93, 3800, 3000, 0.25, 0.45),
  cp(29.89, 81.50, 3600, 3100, 0.25, 0.45),
  cp(30.30, 82.10, 4100, 2600, 0.25, 0.7),
  cp(30.60, 79.40, 3200, 2800, 0.35, 0.35),
  // Lesser Himalaya and the south: dense ridges, monsoon forest.
  cp(30.07, 80.24, 1800, 2600, 0.6, 0.2),
  cp(29.85, 80.54, 900, 1900, 0.75, 0.1),
  cp(29.59, 80.24, 1400, 700, 0.8, 0.05),
  cp(29.45, 80.70, 1000, 1200, 0.8, 0.05),
  cp(29.53, 81.18, 1200, 1500, 0.8, 0.1),
  cp(29.50, 81.70, 1400, 1700, 0.8, 0.1),
  cp(29.97, 81.82, 2300, 2400, 0.6, 0.3),
  cp(29.60, 82.30, 1900, 1900, 0.7, 0.2),
  cp(30.30, 79.16, 800, 1600, 0.8, 0.1),
  cp(29.50, 79.30, 700, 1300, 0.8, 0.05),
  cp(30.55, 79.56, 1900, 2700, 0.55, 0.2),
  cp(29.90, 79.70, 1100, 1600, 0.8, 0.1),
  cp(29.30, 80.10, 600, 1000, 0.8, 0.05),
];

/** Named summits, added on top of the regional mountains (`radius` in world metres). */
export interface Peak { id: string; name: string; lat: number; lon: number; h: number; radius: number; pyramid?: boolean }

export const PEAKS: Peak[] = [
  { id: 'kailash', name: 'Kailash', lat: 31.068, lon: 81.312, h: 6638, radius: 3800, pyramid: true },
  { id: 'gurla', name: 'Gurla Mandhata', lat: 30.438, lon: 81.297, h: 7694, radius: 9000 },
  { id: 'api', name: 'Api', lat: 30.007, lon: 80.933, h: 7132, radius: 6500 },
  { id: 'saipal', name: 'Saipal', lat: 29.893, lon: 81.502, h: 7031, radius: 6500 },
  { id: 'nandadevi', name: 'Nanda Devi', lat: 30.376, lon: 79.971, h: 7816, radius: 7500 },
  { id: 'kamet', name: 'Kamet', lat: 30.920, lon: 79.592, h: 7756, radius: 7000 },
  { id: 'panchachuli', name: 'Panchachuli', lat: 30.215, lon: 80.428, h: 6904, radius: 5500 },
];

/**
 * Valley corridors: polylines carved into the terrain. Each node: floor height (m), floor
 * half-width (m, world) and wall steepness (1 = normal, >1 = gorge).
 */
export interface ValleyNode { lat: number; lon: number; floor: number; halfWidth: number; wall?: number }
export interface Valley { id: string; name: string; river: boolean; nodes: ValleyNode[] }

const vn = (lat: number, lon: number, floor: number, halfWidth: number, wall = 1): ValleyNode => ({ lat, lon, floor, halfWidth, wall });

export const VALLEYS: Valley[] = [
  {
    id: 'indus', name: 'Gar / Indus valley (Ngari)', river: true, nodes: [
      vn(32.42, 79.72, 4210, 3500), vn(32.25, 79.92, 4245, 4500), vn(32.10, 80.06, 4268, 4500),
      vn(31.92, 80.28, 4310, 4000), vn(31.75, 80.50, 4400, 2500), vn(31.62, 80.70, 4550, 1200),
    ],
  },
  {
    id: 'sutlej', name: 'Sutlej (Zanda canyon)', river: true, nodes: [
      vn(30.72, 81.13, 4560, 900), vn(30.95, 80.75, 4300, 900), vn(31.20, 80.30, 4000, 1100),
      vn(31.48, 79.80, 3700, 1500), vn(31.68, 79.40, 3450, 1000, 1.3), vn(31.85, 79.00, 3200, 600, 1.5),
    ],
  },
  {
    id: 'karnali', name: 'Karnali (Purang, Humla)', river: true, nodes: [
      vn(30.60, 81.28, 4500, 1500), vn(30.45, 81.20, 4150, 2200), vn(30.30, 81.18, 3900, 1500),
      vn(30.15, 81.34, 3650, 300, 1.5), vn(30.05, 81.58, 3100, 150, 1.8), vn(29.955, 81.83, 2300, 120, 1.8),
      vn(29.78, 82.05, 1900, 120, 1.8), vn(29.55, 82.35, 1450, 150, 1.6),
    ],
  },
  {
    id: 'kali', name: 'Kali / Mahakali (Gunji, Dharchula)', river: true, nodes: [
      vn(30.21, 80.99, 3600, 400, 1.2), vn(30.18, 80.86, 3180, 1500), vn(30.10, 80.80, 2900, 300, 1.5),
      vn(29.98, 80.72, 2100, 120, 1.9), vn(29.85, 80.54, 900, 150, 1.8), vn(29.72, 80.40, 600, 150, 1.6),
      vn(29.57, 80.40, 560, 150, 1.5), vn(29.25, 80.20, 380, 300, 1.2),
    ],
  },
  {
    id: 'lipulekh', name: 'Lipulekh pass route', river: false, nodes: [
      vn(30.21, 80.99, 3600, 150, 1.2), vn(30.234, 81.029, 5050, 120, 1.2), vn(30.27, 81.10, 4300, 250), vn(30.30, 81.18, 3900, 600),
    ],
  },
  {
    id: 'gori', name: 'Gori Ganga (Munsiyari)', river: true, nodes: [
      vn(30.42, 80.18, 3800, 200, 1.4), vn(30.07, 80.24, 2200, 150, 1.6), vn(29.85, 80.38, 800, 120, 1.7), vn(29.75, 80.39, 620, 150, 1.6),
    ],
  },
  {
    id: 'dhauli', name: 'Dhauliganga (Niti valley)', river: true, nodes: [
      vn(30.95, 79.86, 3550, 250, 1.3), vn(30.72, 79.76, 2600, 150, 1.6), vn(30.55, 79.56, 1800, 150, 1.7), vn(30.30, 79.20, 800, 200, 1.5),
    ],
  },
  {
    id: 'saur', name: 'Saur valley (Pithoragarh)', river: false, nodes: [
      vn(29.62, 80.20, 1500, 900), vn(29.58, 80.26, 1490, 1100), vn(29.55, 80.31, 1460, 700),
    ],
  },
];

/** Broad flat basins (ellipses in world metres, `rot` in degrees from east toward south). */
export interface Basin { id: string; lat: number; lon: number; rx: number; rz: number; rot: number; level: number }

export const BASINS: Basin[] = [
  { id: 'lakes', lat: 30.67, lon: 81.36, rx: 19000, rz: 11000, rot: 0, level: 4600 },
  { id: 'purang', lat: 30.40, lon: 81.15, rx: 4500, rz: 6500, rot: -30, level: 4230 },
];

/** Lakes: noisy ellipses carved below their own water level. */
export interface Lake { id: string; name: string; lat: number; lon: number; rx: number; rz: number; rot: number; level: number }

export const LAKES: Lake[] = [
  { id: 'mansarovar', name: 'Mansarovar', lat: 30.65, lon: 81.46, rx: 6500, rz: 5800, rot: 0, level: 4590 },
  { id: 'rakshastal', name: 'Rakshastal', lat: 30.69, lon: 81.24, rx: 4200, rz: 6500, rot: 25, level: 4575 },
];

/** Airfields: a level pad with a perfectly flat strip (runway and parallel taxiway). */
export interface Airfield {
  id: string; name: string; lat: number; lon: number;
  /** True heading of the runway (the direction of the higher-numbered end's reciprocal: x/z along). */
  headingDeg: number; lengthM: number; widthM: number; elev: number;
  /** Parallel taxiway: offset to the right of `headingDeg` (m, negative = left) and width. */
  taxiway?: { offsetM: number; widthM: number };
}

export const AIRFIELDS: Airfield[] = [
  { id: 'ngari', name: 'Ngari Gunsa', lat: 32.1086, lon: 80.0528, headingDeg: 332, lengthM: 4486, widthM: 45, elev: 4274, taxiway: { offsetM: 168, widthM: 23 } },
  { id: 'burang', name: 'Burang (Purang)', lat: 30.3975, lon: 81.1386, headingDeg: 329, lengthM: 4500, widthM: 50, elev: 4250, taxiway: { offsetM: 180, widthM: 23 } },
  { id: 'naini', name: 'Naini Saini (Pithoragarh)', lat: 29.5914, lon: 80.2400, headingDeg: 140, lengthM: 2400, widthM: 45, elev: 1500 },
  { id: 'gunji', name: 'Gunji ALG', lat: 30.178, lon: 80.868, headingDeg: 68, lengthM: 1450, widthM: 30, elev: 3250 },
  { id: 'simikot', name: 'Simikot', lat: 29.9711, lon: 81.8189, headingDeg: 100, lengthM: 549, widthM: 20, elev: 2950 },
];

/** Named places for the viewer (markers and the jump list). */
export interface Place { id: string; name: string; lat: number; lon: number }

export const PLACES: Place[] = [
  ...AIRFIELDS.map((a) => ({ id: a.id, name: a.name, lat: a.lat, lon: a.lon })),
  ...PEAKS.map((p) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon })),
  ...LAKES.map((l) => ({ id: l.id, name: l.name, lat: l.lat, lon: l.lon })),
  { id: 'lipulekh', name: 'Lipulekh pass', lat: 30.234, lon: 81.029 },
  { id: 'zanda', name: 'Tholing (Zanda)', lat: 31.48, lon: 79.80 },
  { id: 'hilsa', name: 'Hilsa', lat: 30.15, lon: 81.34 },
  { id: 'dharchula', name: 'Dharchula', lat: 29.85, lon: 80.54 },
];

/** Viewer camera presets: look at a place from a bearing/distance (world metres) and altitude. */
export interface ViewPreset { label: string; place: string; targetAlt: number; bearingDeg: number; distM: number; alt: number }

export const VIEWS: ViewPreset[] = [
  { label: 'Theatre overview', place: 'gurla', targetAlt: 3000, bearingDeg: 200, distM: 120_000, alt: 38_000 },
  { label: 'Ngari Gunsa: runway 33 approach', place: 'ngari', targetAlt: 4274, bearingDeg: 152, distM: 9000, alt: 4800 },
  { label: 'Ngari valley from the NE', place: 'ngari', targetAlt: 4274, bearingDeg: 60, distM: 22_000, alt: 8000 },
  { label: 'Kailash south face', place: 'kailash', targetAlt: 6000, bearingDeg: 180, distM: 12_000, alt: 6100 },
  { label: 'Lakes and Gurla Mandhata', place: 'rakshastal', targetAlt: 4800, bearingDeg: 330, distM: 26_000, alt: 7200 },
  { label: 'Gurla Mandhata', place: 'gurla', targetAlt: 6500, bearingDeg: 300, distM: 16_000, alt: 7200 },
  { label: 'Burang: runway 33 approach', place: 'burang', targetAlt: 4250, bearingDeg: 149, distM: 8000, alt: 4750 },
  { label: 'Lipulekh pass from the Kali side', place: 'lipulekh', targetAlt: 5000, bearingDeg: 230, distM: 7000, alt: 5400 },
  { label: 'Kali valley at Gunji', place: 'gunji', targetAlt: 3300, bearingDeg: 215, distM: 5000, alt: 3750 },
  { label: 'Api and Saipal from the south', place: 'api', targetAlt: 6000, bearingDeg: 200, distM: 32_000, alt: 5200 },
  { label: 'Nanda Devi', place: 'nandadevi', targetAlt: 7000, bearingDeg: 210, distM: 22_000, alt: 6500 },
  { label: 'Kamet and Niti', place: 'kamet', targetAlt: 6500, bearingDeg: 160, distM: 22_000, alt: 7000 },
  { label: 'Zanda canyon', place: 'zanda', targetAlt: 3800, bearingDeg: 120, distM: 9000, alt: 4600 },
  { label: 'Simikot gorge', place: 'simikot', targetAlt: 2700, bearingDeg: 255, distM: 7000, alt: 4900 },
  { label: 'Naini Saini (Pithoragarh)', place: 'naini', targetAlt: 1500, bearingDeg: 320, distM: 7000, alt: 2100 },
];
