/**
 * src/script/geo.ts — the numbers a controller reads out: world metres to latitude/longitude,
 * bearings, BRAA (bearing, range, altitude, aspect), compass points. Pure.
 *
 * World axes: +x east, -z north, +y up (bearing = atan2(dx, -dz)). Each theatre is anchored on one
 * real airfield at its true position; the rest of the map is laid out true to scale from there (the
 * game's theatres compress the real distances between bases, so the coordinates are the game's own
 * geography, not a real survey). True bearings: the magnetic variation over the Punjab is ~1 deg.
 */

export interface GeoAnchor {
  x: number;
  z: number;
  latDeg: number;
  lonDeg: number;
}

/** Border theatre: Bhisiana AFS (Bathinda) at its real reference point, 30°16'13"N 74°45'20"E. */
export const BORDER_GEO: GeoAnchor = { x: 30500, z: -11000, latDeg: 30.2703, lonDeg: 74.7556 };

const M_PER_DEG_LAT = 111_320;
export const M_PER_NM = 1852;
export const FT_PER_M = 3.28084;

export function toLatLon(x: number, z: number, g: GeoAnchor): { latDeg: number; lonDeg: number } {
  const latDeg = g.latDeg + -(z - g.z) / M_PER_DEG_LAT;
  const lonDeg = g.lonDeg + (x - g.x) / (M_PER_DEG_LAT * Math.cos((g.latDeg * Math.PI) / 180));
  return { latDeg, lonDeg };
}

/** Degrees and decimal minutes, as a navigation display shows them: N30°04.5' E074°07.8'. */
export function formatLatLon(latDeg: number, lonDeg: number): string {
  const part = (v: number, pos: string, neg: string, degDigits: number): string => {
    const a = Math.abs(v);
    let d = Math.floor(a);
    let m = Math.round((a - d) * 600) / 10;
    if (m >= 60) {
      d += 1;
      m = 0;
    }
    return `${v >= 0 ? pos : neg}${String(d).padStart(degDigits, '0')}°${m.toFixed(1).padStart(4, '0')}'`;
  };
  return `${part(latDeg, 'N', 'S', 2)} ${part(lonDeg, 'E', 'W', 3)}`;
}

/** True bearing from (fx, fz) to (tx, tz), 0..360. */
export const bearingDeg = (fx: number, fz: number, tx: number, tz: number): number => ((Math.atan2(tx - fx, -(tz - fz)) * 180) / Math.PI + 360) % 360;

/** a - b wrapped to -180..180. */
export const wrapDeg = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180;

/** A bearing as the three digits a controller says (360 for north, not 000). */
export const threeDigits = (deg: number): string => {
  const r = Math.round(((deg % 360) + 360) % 360);
  return String(r === 0 ? 360 : r).padStart(3, '0');
};

export type Aspect = 'hot' | 'flanking' | 'beaming' | 'cold';

/**
 * The target's aspect towards the viewer: the angle between its track and the line from it to the
 * viewer. Hot 0-30 deg (coming at you), flanking to 70, beaming to 110, cold beyond.
 */
export function aspectOf(tx: number, tz: number, tvx: number, tvz: number, vx: number, vz: number): Aspect {
  if (Math.hypot(tvx, tvz) < 1) return 'hot';
  const track = (Math.atan2(tvx, -tvz) * 180) / Math.PI;
  const toViewer = bearingDeg(tx, tz, vx, vz);
  const off = Math.abs(wrapDeg(track - toViewer));
  return off <= 30 ? 'hot' : off <= 70 ? 'flanking' : off <= 110 ? 'beaming' : 'cold';
}

export interface Braa {
  bearing: number;
  rangeNm: number;
  /** Thousands of feet (angels), or hundreds of feet below 1000 ft (cherubs). */
  angels: number;
  cherubs: boolean;
  aspect: Aspect;
}

/** BRAA of a target from a viewer (positions in world metres, the target's velocity). */
export function braa(vx: number, vz: number, t: { x: number; y: number; z: number; vx: number; vz: number }): Braa {
  const ft = t.y * FT_PER_M;
  const cherubs = ft < 1000;
  return {
    bearing: bearingDeg(vx, vz, t.x, t.z),
    rangeNm: Math.max(1, Math.round(Math.hypot(t.x - vx, t.z - vz) / M_PER_NM)),
    angels: cherubs ? Math.max(1, Math.round(ft / 100)) : Math.round(ft / 1000),
    cherubs,
    aspect: aspectOf(t.x, t.z, t.vx, t.vz, vx, vz),
  };
}

export type Compass8 = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
const C8: readonly Compass8[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
export const compass8 = (deg: number): Compass8 => C8[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
export const COMPASS_WORDS: Readonly<Record<Compass8, string>> = { n: 'north', ne: 'north-east', e: 'east', se: 'south-east', s: 'south', sw: 'south-west', w: 'west', nw: 'north-west' };
