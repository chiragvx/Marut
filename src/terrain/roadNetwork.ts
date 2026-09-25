/**
 * src/terrain/roadNetwork.ts — procedural settlements and road network for a theatre.
 *
 * Built once per terrain (in the terrain worker, and in tests) from TerrainParams.network:
 * - Named towns and cities at fixed positions, and named routes through them: highways, state
 *   and district roads, and canals. Each leg gets gentle bends; highways and canals get bridges
 *   where they cross a river.
 * - Villages on a jittered grid, kept off rivers, floodplains, towns and airbases.
 * - Village link roads between grid neighbours, bending a little, never crossing a river; villages
 *   near a town get a district road into it.
 * - A few narrow lanes through every settlement (towns are just larger village clusters).
 * A uniform-grid spatial index lets src/terrain/chunkFeatures.ts fetch what touches one chunk.
 *
 * Everything is a pure function of (params, sampler): the same network in every thread.
 */
import type { HeightSampler } from '../contracts/core';
import { DecalClass, TreeKind, type CoastProfile, type NetworkSpec, type TerrainParams } from '../contracts/terrain';
import { buildCoastProfile } from './terrainHeight';
import { ESTUARY_FLOATS, packEstuary } from './coastMath';

export interface RoadPolyline {
  cls: DecalClass;
  widthM: number;
  /** x, z pairs. */
  pts: Float64Array;
  /** Cumulative length at each point (m). */
  along: Float64Array;
  /** Tree kind lining the road (-1 = none), and the chance that a given 300 m stretch of one side has a row. */
  treeKind: number;
  treeProb: number;
  /** Highways, state roads and canals cross rivers on bridges; everything else avoids them. */
  bridges: boolean;
}

export interface Settlement {
  x: number;
  z: number;
  radiusM: number;
  kind: 'city' | 'town' | 'village';
  /** Street/lane grid orientation, rad. */
  rotRad: number;
  /** Per-settlement random seed. */
  seed: number;
}

export interface RoadNetwork {
  settlements: Settlement[];
  roads: RoadPolyline[];
  cellSizeM: number;
  /** Cell key -> indices into roads / settlements touching that cell. */
  roadCells: Map<number, number[]>;
  settlementCells: Map<number, number[]>;
  /** Water surface level (m) if the terrain has water. */
  waterLevelM: number | undefined;
  style: 'punjab' | 'goa';
  /** Coast theatres: the shoreline table and packed estuaries (coastMath.ts), for vegetation. */
  coast?: { table: CoastProfile; estuaries: Float32Array; count: number };
}

const CELL_M = 1000;

/** Deterministic hash of up to three integers and a seed to [0, 1). */
export function hash3(a: number, b: number, c: number, seed: number): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x2545f491) ^ Math.imul(seed | 0, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 1D value noise in [-1, 1]. */
function noise1(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return 2 * (hash3(i, 0, 0, seed) + (hash3(i + 1, 0, 0, seed) - hash3(i, 0, 0, seed)) * u) - 1;
}

export function cellKey(ix: number, iz: number): number {
  return (ix + 4096) * 8192 + (iz + 4096);
}

// Narrow roads, as in the reference imagery: even the national highways read as 2-lane roads from the air.
const WIDTH: Readonly<Record<RouteSpecCls, number>> = { highway: 11, state: 10, district: 8, canal: 26 };
type RouteSpecCls = NetworkSpec['routes'][number]['cls'];
const CLS: Readonly<Record<RouteSpecCls, DecalClass>> = { highway: DecalClass.State, state: DecalClass.District, district: DecalClass.District, canal: DecalClass.Canal };

function makePolyline(cls: DecalClass, widthM: number, xz: number[], treeKind: number, treeProb: number, bridges: boolean): RoadPolyline {
  const n = xz.length / 2;
  const pts = new Float64Array(xz);
  const along = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    along[i] = along[i - 1]! + Math.hypot(pts[2 * i]! - pts[2 * i - 2]!, pts[2 * i + 1]! - pts[2 * i - 1]!);
  }
  return { cls, widthM, pts, along, treeKind, treeProb, bridges };
}

/**
 * A bent path from a to b: `pieces` intermediate points offset sideways by up to `ampM` (zero at
 * the ends), then two rounds of Chaikin smoothing. Appends x,z pairs to `out` (a itself included
 * only if `includeStart`).
 */
function bentPath(ax: number, az: number, bx: number, bz: number, pieceM: number, ampM: number, seed: number, includeStart: boolean, out: number[]): void {
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.max(2, Math.ceil(len / pieceM));
  const nx = -(bz - az) / (len || 1);
  const nz = (bx - ax) / (len || 1);
  const raw: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const off = ampM * noise1(t * n * 0.7, seed) * Math.sin(Math.PI * t);
    raw.push(ax + (bx - ax) * t + nx * off, az + (bz - az) * t + nz * off);
  }
  let pts = raw;
  for (let it = 0; it < 2; it++) {
    const sm: number[] = [pts[0]!, pts[1]!];
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const x0 = pts[i]!, z0 = pts[i + 1]!, x1 = pts[i + 2]!, z1 = pts[i + 3]!;
      sm.push(0.75 * x0 + 0.25 * x1, 0.75 * z0 + 0.25 * z1, 0.25 * x0 + 0.75 * x1, 0.25 * z0 + 0.75 * z1);
    }
    sm.push(pts[pts.length - 2]!, pts[pts.length - 1]!);
    pts = sm;
  }
  for (let i = includeStart ? 0 : 2; i < pts.length; i++) out.push(pts[i]!);
}

export function buildRoadNetwork(params: TerrainParams, sampler: HeightSampler): RoadNetwork | undefined {
  const spec = params.network;
  if (!spec) return undefined;
  const seed = params.seed | 0;
  const wl = params.waterLevelM;
  /** Water or floodplain (a few metres above the water) at (x, z). */
  const wet = (x: number, z: number): boolean => wl !== undefined && sampler.heightAt(x, z) < wl + 4.5;

  const settlements: Settlement[] = [];
  const roads: RoadPolyline[] = [];
  const townByName = new Map<string, Settlement>();

  // --- towns and cities -------------------------------------------------------------------------
  spec.towns.forEach((t, i) => {
    const s: Settlement = { x: t.x, z: t.z, radiusM: t.radiusM, kind: t.kind, rotRad: hash3(i, 1, 0, seed) * Math.PI * 0.5, seed: (seed ^ Math.imul(i + 1, 0x51ed27)) | 0 };
    settlements.push(s);
    townByName.set(t.name, s);
  });
  const towns = settlements.slice();

  // --- named routes -----------------------------------------------------------------------------
  spec.routes.forEach((r, ri) => {
    const pts: number[] = [];
    let px: number | undefined;
    let pz: number | undefined;
    r.via.forEach((v, vi) => {
      let x: number;
      let z: number;
      if (typeof v === 'string') {
        const t = townByName.get(v);
        if (!t) return;
        x = t.x;
        z = t.z;
      } else {
        x = v[0];
        z = v[1];
      }
      if (px === undefined || pz === undefined) {
        pts.push(x, z);
      } else {
        const amp = r.cls === 'highway' ? 350 : r.cls === 'canal' ? 600 : 500;
        bentPath(px, pz, x, z, r.cls === 'highway' ? 2500 : 1600, amp, (seed + ri * 977 + vi * 131) | 0, false, pts);
      }
      px = x;
      pz = z;
    });
    if (pts.length < 4) return;
    const cls = CLS[r.cls];
    // Sparse roadside trees (shisham, kikar, some eucalyptus); canals keep fuller rows.
    const treeKind = r.cls === 'canal' ? TreeKind.Eucalyptus : TreeKind.Broadleaf;
    const treeProb = r.cls === 'canal' ? 0.6 : 0.3;
    roads.push(makePolyline(cls, WIDTH[r.cls], pts, treeKind, treeProb, r.cls !== 'district'));
  });

  // --- villages ---------------------------------------------------------------------------------
  const S = spec.villageSpacingM;
  const half = 98000;
  const nCells = Math.floor((2 * half) / S);
  const villageAt = new Map<number, number>();
  for (let j = 0; j < nCells; j++) {
    for (let i = 0; i < nCells; i++) {
      if (hash3(i, j, 1, seed) > spec.villageKeep) continue;
      const x = -half + (i + 0.5 + 0.7 * (hash3(i, j, 2, seed) - 0.5)) * S;
      const z = -half + (j + 0.5 + 0.7 * (hash3(i, j, 3, seed) - 0.5)) * S;
      const r = 110 + 170 * hash3(i, j, 4, seed);
      if (towns.some((t) => Math.hypot(x - t.x, z - t.z) < t.radiusM + 900)) continue;
      if (spec.exclusions.some((e) => Math.hypot(x - e.x, z - e.z) < e.radiusM + r)) continue;
      if (wet(x, z) || wet(x + r, z) || wet(x - r, z) || wet(x, z + r) || wet(x, z - r)) continue;
      if (spec.maxVillageElevM !== undefined && sampler.heightAt(x, z) > spec.maxVillageElevM) continue;
      villageAt.set(i * 100000 + j, settlements.length);
      settlements.push({ x, z, radiusM: r, kind: 'village', rotRad: (hash3(i, j, 5, seed) - 0.5) * 0.5, seed: (seed ^ Math.imul(i * 7919 + j + 1, 0x2f6b3)) | 0 });
    }
  }

  // --- village link roads (grid neighbours), never across water --------------------------------
  const crossesWater = (xz: number[]): boolean => {
    for (let k = 0; k + 3 < xz.length; k += 2) {
      const x0 = xz[k]!, z0 = xz[k + 1]!, x1 = xz[k + 2]!, z1 = xz[k + 3]!;
      const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 120);
      for (let s = 0; s <= steps; s++) if (wet(x0 + ((x1 - x0) * s) / steps, z0 + ((z1 - z0) * s) / steps)) return true;
    }
    return false;
  };
  const degree = new Map<Settlement, number>();
  const link = (a: Settlement, b: Settlement, lseed: number, cls: DecalClass, width: number): boolean => {
    const xz: number[] = [];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    bentPath(a.x, a.z, b.x, b.z, Math.max(400, len / 3), 0.09 * len, lseed, true, xz);
    if (crossesWater(xz)) return false;
    if (spec.exclusions.some((e) => segmentsNear(xz, e.x, e.z, e.radiusM))) return false;
    roads.push(makePolyline(cls, width, xz, TreeKind.Broadleaf, 0.2, false));
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
    return true;
  };
  for (const [k, vi] of villageAt) {
    const i = Math.floor(k / 100000);
    const j = k - i * 100000;
    const a = settlements[vi]!;
    const east = villageAt.get((i + 1) * 100000 + j);
    const south = villageAt.get(i * 100000 + j + 1);
    const diag = villageAt.get((i + 1) * 100000 + j + 1);
    // Decal widths include ~2 m of dusty verge each side of a 3.5-4.5 m road.
    if (east !== undefined && hash3(i, j, 11, seed) < 0.8) link(a, settlements[east]!, (seed + k * 3) | 0, DecalClass.Link, 7.5 + 1 * hash3(i, j, 14, seed));
    if (south !== undefined && hash3(i, j, 12, seed) < 0.75) link(a, settlements[south]!, (seed + k * 3 + 1) | 0, DecalClass.Link, 7.5 + 1 * hash3(i, j, 15, seed));
    if (diag !== undefined && hash3(i, j, 13, seed) < 0.2) link(a, settlements[diag]!, (seed + k * 3 + 2) | 0, DecalClass.Link, 7.5);
  }
  // Villages near a town get a district road into it (the nearest few).
  towns.forEach((t, ti) => {
    const near = settlements
      .filter((s) => s.kind === 'village' && Math.hypot(s.x - t.x, s.z - t.z) < t.radiusM + 3200)
      .sort((p, q) => Math.hypot(p.x - t.x, p.z - t.z) - Math.hypot(q.x - t.x, q.z - t.z))
      .slice(0, t.kind === 'city' ? 10 : 5);
    near.forEach((v, n) => {
      if (hash3(ti, n, 21, seed) < 0.75) link(v, t, (seed + ti * 1009 + n) | 0, DecalClass.District, 8);
    });
  });

  // Every village gets at least one road: link any still unconnected one to its nearest
  // reachable neighbour (the grid neighbours may have been skipped or cut off by a river).
  for (const [k, vi] of villageAt) {
    const a = settlements[vi]!;
    if ((degree.get(a) ?? 0) > 0) continue;
    const i = Math.floor(k / 100000);
    const j = k - i * 100000;
    const cands: Settlement[] = [];
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const o = villageAt.get((i + di) * 100000 + j + dj);
      if (o !== undefined && o !== vi) cands.push(settlements[o]!);
    }
    cands.sort((p, q) => Math.hypot(p.x - a.x, p.z - a.z) - Math.hypot(q.x - a.x, q.z - a.z));
    for (const b of cands) if (link(a, b, (seed + k * 7 + 5) | 0, DecalClass.Link, 7.5)) break;
  }

  // --- lanes: every settlement is a village-style cluster (towns just larger), with a few narrow lanes
  for (const s of settlements) {
    const lanes = s.kind === 'village' ? 2 : 4;
    for (let a = 0; a < lanes; a++) {
      const ang = s.rotRad + (a * Math.PI) / lanes + (a > 1 ? 0.3 * (hash3(a, 0, 41, s.seed) - 0.5) : 0);
      const dx = Math.cos(ang) * s.radiusM * 0.9;
      const dz = Math.sin(ang) * s.radiusM * 0.9;
      roads.push(makePolyline(DecalClass.Street, 6, [s.x - dx, s.z - dz, s.x + dx, s.z + dz], -1, 0, false));
    }
  }

  // --- spatial index ----------------------------------------------------------------------------
  const roadCells = new Map<number, number[]>();
  const settlementCells = new Map<number, number[]>();
  const add = (map: Map<number, number[]>, minX: number, minZ: number, maxX: number, maxZ: number, idx: number): void => {
    for (let iz = Math.floor(minZ / CELL_M); iz <= Math.floor(maxZ / CELL_M); iz++) {
      for (let ix = Math.floor(minX / CELL_M); ix <= Math.floor(maxX / CELL_M); ix++) {
        const key = cellKey(ix, iz);
        let list = map.get(key);
        if (!list) map.set(key, (list = []));
        if (list[list.length - 1] !== idx) list.push(idx);
      }
    }
  };
  roads.forEach((r, ri) => {
    const m = r.widthM * 0.5 + 25;
    for (let k = 0; k + 3 < r.pts.length; k += 2) {
      const x0 = r.pts[k]!, z0 = r.pts[k + 1]!, x1 = r.pts[k + 2]!, z1 = r.pts[k + 3]!;
      add(roadCells, Math.min(x0, x1) - m, Math.min(z0, z1) - m, Math.max(x0, x1) + m, Math.max(z0, z1) + m, ri);
    }
  });
  settlements.forEach((s, si) => {
    const m = s.radiusM * 1.4;
    add(settlementCells, s.x - m, s.z - m, s.x + m, s.z + m, si);
  });

  let coast: RoadNetwork['coast'];
  const table = buildCoastProfile(params);
  if (table && params.shape?.kind === 'coast') {
    const est = new Float32Array(params.shape.estuaries.length * ESTUARY_FLOATS);
    params.shape.estuaries.forEach((e, i) => packEstuary(e, i, params.seed, est, i * ESTUARY_FLOATS));
    coast = { table, estuaries: est, count: params.shape.estuaries.length };
  }
  return { settlements, roads, cellSizeM: CELL_M, roadCells, settlementCells, waterLevelM: wl, style: spec.style ?? 'punjab', ...(coast ? { coast } : {}) };
}

function segmentsNear(xz: number[], cx: number, cz: number, r: number): boolean {
  for (let k = 0; k + 3 < xz.length; k += 2) {
    const x0 = xz[k]!, z0 = xz[k + 1]!, x1 = xz[k + 2]!, z1 = xz[k + 3]!;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const t = Math.max(0, Math.min(1, ((cx - x0) * dx + (cz - z0) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(x0 + dx * t - cx, z0 + dz * t - cz) < r) return true;
  }
  return false;
}

/** Indices of roads and settlements whose index cells overlap the rectangle (deduplicated into the given sets). */
export function queryNetwork(net: RoadNetwork, minX: number, minZ: number, maxX: number, maxZ: number, roadsOut: Set<number>, settlementsOut: Set<number>): void {
  for (let iz = Math.floor(minZ / net.cellSizeM); iz <= Math.floor(maxZ / net.cellSizeM); iz++) {
    for (let ix = Math.floor(minX / net.cellSizeM); ix <= Math.floor(maxX / net.cellSizeM); ix++) {
      const key = cellKey(ix, iz);
      const r = net.roadCells.get(key);
      if (r) for (const i of r) roadsOut.add(i);
      const s = net.settlementCells.get(key);
      if (s) for (const i of s) settlementsOut.add(i);
    }
  }
}
