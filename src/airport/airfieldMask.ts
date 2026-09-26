/**
 * src/airport/airfieldMask.ts — a small texture per airbase telling the ground shader where the
 * airfield is: mown grass within ~230-340 m of any pavement or structure (instead of crops or
 * forest), and bare, scuffed earth right along the pavement edges.
 *
 * Built once per mission on the CPU: paved surfaces, runway strips and structures are rasterised
 * into a grid, a two-pass chamfer distance transform gives each texel its distance (m) to the
 * nearest of them, and that becomes two channels:
 *   R = airfield weight (1 inside, fading to 0 from 230 to 340 m out),
 *   G = distance to the pavement edge / 64 m (for the scuffed earth along it).
 */
import type { AirportLayout } from '../contracts/airport';

export const AIRFIELD_MASK_SIZE = 512;
const INNER_M = 230;
const OUTER_M = 340;
const EDGE_SCALE_M = 64;

export interface AirfieldMask {
  /** World x, z of texel (0, 0)'s corner, and the side of the square, m. */
  minX: number;
  minZ: number;
  sizeM: number;
  /** AIRFIELD_MASK_SIZE^2 x 2 bytes (R, G). */
  data: Uint8Array;
}

export function buildAirfieldMask(L: AirportLayout): AirfieldMask {
  const N = AIRFIELD_MASK_SIZE;
  const z0 = L.flattenZones[0];
  const cx = z0 ? z0.centerWorldX : L.referenceWorldX;
  const cz = z0 ? z0.centerWorldZ : L.referenceWorldZ;
  const half = (z0 ? z0.flatRadiusM : 2500) + OUTER_M + 50;
  const minX = cx - half;
  const minZ = cz - half;
  const cell = (2 * half) / N;
  const paved = new Uint8Array(N * N); // 1 = pavement / structure
  const strip = new Uint8Array(N * N); // 1 = runway strip (counts as airfield, not pavement edge)

  const toI = (x: number): number => (x - minX) / cell;
  const toJ = (z: number): number => (z - minZ) / cell;

  function fillPoly(pts: readonly [number, number][], out: Uint8Array): void {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [x, z] of pts) {
      x0 = Math.min(x0, toI(x));
      x1 = Math.max(x1, toI(x));
      y0 = Math.min(y0, toJ(z));
      y1 = Math.max(y1, toJ(z));
    }
    for (let j = Math.max(0, Math.floor(y0)); j <= Math.min(N - 1, Math.ceil(y1)); j++) {
      const wz = minZ + (j + 0.5) * cell;
      for (let i = Math.max(0, Math.floor(x0)); i <= Math.min(N - 1, Math.ceil(x1)); i++) {
        const wx = minX + (i + 0.5) * cell;
        let inside = false;
        for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
          const [ax, az] = pts[a]!;
          const [bx, bz] = pts[b]!;
          if (az > wz !== bz > wz && wx < ((bx - ax) * (wz - az)) / (bz - az) + ax) inside = !inside;
        }
        if (inside) out[j * N + i] = 1;
      }
    }
  }
  const rect = (x: number, z: number, fx: number, fz: number, halfL: number, halfW: number): [number, number][] => {
    const rx = -fz;
    const rz = fx;
    return [
      [x + fx * halfL + rx * halfW, z + fz * halfL + rz * halfW],
      [x + fx * halfL - rx * halfW, z + fz * halfL - rz * halfW],
      [x - fx * halfL - rx * halfW, z - fz * halfL - rz * halfW],
      [x - fx * halfL + rx * halfW, z - fz * halfL + rz * halfW],
    ];
  };

  for (const a of L.aprons) fillPoly(a.points.map((p) => [p.worldX, p.worldZ] as [number, number]), paved);
  for (const t of L.taxiways) {
    for (let k = 0; k + 1 < t.points.length; k++) {
      const a = t.points[k]!;
      const b = t.points[k + 1]!;
      const len = Math.hypot(b.worldX - a.worldX, b.worldZ - a.worldZ);
      if (len < 0.01) continue;
      const fx = (b.worldX - a.worldX) / len;
      const fz = (b.worldZ - a.worldZ) / len;
      fillPoly(rect((a.worldX + b.worldX) / 2, (a.worldZ + b.worldZ) / 2, fx, fz, len / 2 + t.widthM / 2, t.widthM / 2), paved);
    }
  }
  for (const r of L.runways) {
    const fx = Math.sin(r.headingRad);
    const fz = -Math.cos(r.headingRad);
    const mx = r.thresholdWorldX + (fx * r.lengthM) / 2;
    const mz = r.thresholdWorldZ + (fz * r.lengthM) / 2;
    fillPoly(rect(mx, mz, fx, fz, r.lengthM / 2, r.widthM / 2), paved);
    fillPoly(rect(mx, mz, fx, fz, r.lengthM / 2 + 120, r.widthM / 2 + 75), strip);
  }
  for (const s of L.structures ?? []) {
    fillPoly(rect(s.worldX, s.worldZ, Math.sin(s.headingRad), -Math.cos(s.headingRad), s.lengthM / 2, s.widthM / 2), paved);
  }

  // Chamfer distance transform (3-4 weights) from the pavement, in texels.
  const INF = 1e9;
  const d = new Float32Array(N * N);
  const dAll = new Float32Array(N * N);
  for (let k = 0; k < N * N; k++) {
    d[k] = paved[k] ? 0 : INF;
    dAll[k] = paved[k] || strip[k] ? 0 : INF;
  }
  const pass = (dist: Float32Array): void => {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        let v = dist[k]!;
        if (i > 0) v = Math.min(v, dist[k - 1]! + 1);
        if (j > 0) {
          v = Math.min(v, dist[k - N]! + 1);
          if (i > 0) v = Math.min(v, dist[k - N - 1]! + 1.4142);
          if (i < N - 1) v = Math.min(v, dist[k - N + 1]! + 1.4142);
        }
        dist[k] = v;
      }
    }
    for (let j = N - 1; j >= 0; j--) {
      for (let i = N - 1; i >= 0; i--) {
        const k = j * N + i;
        let v = dist[k]!;
        if (i < N - 1) v = Math.min(v, dist[k + 1]! + 1);
        if (j < N - 1) {
          v = Math.min(v, dist[k + N]! + 1);
          if (i < N - 1) v = Math.min(v, dist[k + N + 1]! + 1.4142);
          if (i > 0) v = Math.min(v, dist[k + N - 1]! + 1.4142);
        }
        dist[k] = v;
      }
    }
  };
  pass(d);
  pass(dAll);

  const data = new Uint8Array(N * N * 2);
  for (let k = 0; k < N * N; k++) {
    const m = dAll[k]! * cell;
    const t = Math.max(0, Math.min(1, (m - INNER_M) / (OUTER_M - INNER_M)));
    data[k * 2] = Math.round((1 - t * t * (3 - 2 * t)) * 255);
    data[k * 2 + 1] = Math.round(Math.min(1, (d[k]! * cell) / EDGE_SCALE_M) * 255);
  }
  return { minX, minZ, sizeM: 2 * half, data };
}
