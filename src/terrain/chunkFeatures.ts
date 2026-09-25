/**
 * src/terrain/chunkFeatures.ts — per-chunk scenery built from the road network (terrain worker).
 *
 * For one terrain chunk it produces (contracts/terrain.ts ChunkFeatures):
 * - ground decals: road ribbons, canals, village/town ground and village ponds, draped on the
 *   chunk's own terrain triangles (`surface`) so they sit exactly on the rendered mesh;
 * - tree instances, placed with clumping noise so they gather in natural groups: irregular roadside
 *   groups, broken rows along canals, trees along the field-block edges the ground shader draws,
 *   groves, trees in and around villages, and clumped single trees across the fields;
 * - building instances: houses clustered on a lot grid with lanes (plus a gurdwara in about half of
 *   the settlements); towns are simply larger clusters.
 * Every item is generated from global, deterministic hashes and kept only if it falls in this
 * chunk, so neighbouring chunks (and the same area at another LOD) agree with each other.
 */
import { DecalClass, TREE_KIND_COUNT, TreeKind, type ChunkBounds, type ChunkFeatures } from '../contracts/terrain';
import { hash3, queryNetwork, type RoadNetwork, type Settlement } from './roadNetwork';
import { ESTUARY_FLOATS, estuaryField, shoreAt } from './coastMath';

export type SurfaceFn = (x: number, z: number) => number;

export interface FeatureOptions {
  /** 0..1 multiplier on tree density. */
  treeDensity: number;
  /** Build trees and buildings (roads and ground are always built). */
  objects: boolean;
  /** Tree-free discs (airports: their flattened area plus a margin). See airportClearZones. */
  clearZones?: readonly ClearZone[];
}

export interface ClearZone {
  x: number;
  z: number;
  radiusM: number;
}

/** Extra clearance around an airport's flattened area, m (approach/departure ends, perimeter). */
export const AIRPORT_TREE_MARGIN_M = 250;

/** No-tree discs for every airport: each flatten zone (flat + blend radius) plus a margin. */
export function airportClearZones(flattenZones: readonly { centerWorldX: number; centerWorldZ: number; flatRadiusM: number; blendRadiusM: number }[]): ClearZone[] {
  return flattenZones.map((z) => ({ x: z.centerWorldX, z: z.centerWorldZ, radiusM: z.flatRadiusM + z.blendRadiusM + AIRPORT_TREE_MARGIN_M }));
}

/** Smooth 2D value noise in [0, 1] (for clumping tree density). */
function vnoise2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash3(ix, iz, 0, seed);
  const b = hash3(ix + 1, iz, 0, seed);
  const c = hash3(ix, iz + 1, 0, seed);
  const d = hash3(ix + 1, iz + 1, 0, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/**
 * Tree clumping: 0..1, high in patches a few hundred metres across and near zero between them, so
 * trees gather in natural groups instead of spreading evenly.
 */
function clump(x: number, z: number, seed: number): number {
  const n = 0.65 * vnoise2(x / 420, z / 420, seed) + 0.35 * vnoise2(x / 130, z / 130, seed + 7);
  const t = Math.max(0, Math.min(1, (n - 0.38) / 0.4));
  return t * t;
}

/** Field-block grid of the Punjab ground shader (terrainMaterial.ts plainsColor): q = R p, 760 m blocks. */
const FIELD_BLOCK_M = 760;
const FR_A = 0.993;
const FR_B = 0.12;
const FR_DET = FR_A * FR_A + FR_B * FR_B;

/** Height of the decals above the terrain surface (plus a polygon offset in the renderer). */
const DECAL_LIFT_M = 0.08;
/** Bridge deck clearance above the water for roads that bridge rivers. */
const BRIDGE_CLEARANCE_M = 6;

// Mostly pale grey and white from the air (flat concrete roofs, whitewash), some brick and cream.
const BUILDING_COLORS: readonly (readonly [number, number, number])[] = [
  [0.72, 0.71, 0.68], // pale concrete
  [0.8, 0.79, 0.76], // whitewash
  [0.64, 0.63, 0.6], // grey concrete
  [0.84, 0.83, 0.8], // white
  [0.76, 0.72, 0.64], // cream plaster
  [0.58, 0.42, 0.34], // brick
  [0.7, 0.69, 0.66], // pale concrete
  [0.78, 0.7, 0.62], // pinkish plaster
];

class Out {
  /** Tree-free discs (airports); pushTree drops any tree inside one. */
  clear: readonly ClearZone[] = [];
  decalPos: number[] = [];
  decalAttr: number[] = [];
  decalIdx: number[] = [];
  treeM: number[][] = Array.from({ length: TREE_KIND_COUNT }, () => []);
  treeC: number[][] = Array.from({ length: TREE_KIND_COUNT }, () => []);
  bldM: number[] = [];
  bldC: number[] = [];
  domeM: number[] = [];
  houseM: number[] = [];
  houseC: number[] = [];
}

/** Column-major matrix: rotate about Y, scale (sx, sy, sz), translate. */
function pushMatrix(out: number[], x: number, y: number, z: number, rot: number, sx: number, sy: number, sz: number): void {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  out.push(c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1);
}

function inRect(b: ChunkBounds, x: number, z: number): boolean {
  return x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ;
}

export function buildChunkFeatures(net: RoadNetwork, b: ChunkBounds, surface: SurfaceFn, opts: FeatureOptions): ChunkFeatures {
  const o = new Out();
  o.clear = opts.clearZones ?? [];
  const wl = net.waterLevelM;
  const roadSet = new Set<number>();
  const setSet = new Set<number>();
  // Wide enough to catch rows and villages that start outside but reach in.
  const margin = 450;
  queryNetwork(net, b.minX - margin, b.minZ - margin, b.maxX + margin, b.maxZ + margin, roadSet, setSet);
  const nearSettlements: Settlement[] = [];
  for (const i of setSet) nearSettlements.push(net.settlements[i]!);
  const inSettlement = (x: number, z: number, scale: number): boolean => {
    for (const s of nearSettlements) {
      const dx = x - s.x;
      const dz = z - s.z;
      const r = s.radiusM * scale;
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  };
  const goa = net.style === 'goa';
  const shoreScratch = { x: 0, headland: 0 };
  /** Goa: distance inland from the shoreline (m, < 0 at sea) and into the nearest estuary (m, > 0 in water). */
  const coastDist = (x: number, z: number): number => {
    if (!net.coast) return 1e9;
    shoreAt(net.coast.table, z, shoreScratch);
    return x - shoreScratch.x;
  };
  const estDist = (x: number, z: number): number => {
    if (!net.coast) return -1e9;
    let e = -1e9;
    for (let i = 0; i < net.coast.count; i++) e = Math.max(e, estuaryField(net.coast.estuaries, i * ESTUARY_FLOATS, x, z));
    return e;
  };
  const wet = goa
    ? (x: number, z: number): boolean => coastDist(x, z) < 55 || estDist(x, z) > -12
    : (x: number, z: number): boolean => wl !== undefined && surface(x, z) < wl + 4.5;

  // --- roads and canals ---------------------------------------------------------------------
  for (const ri of roadSet) {
    const r = net.roads[ri]!;
    const hw = r.widthM * 0.5;
    const pts = r.pts;
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const x0 = pts[k]!, z0 = pts[k + 1]!, x1 = pts[k + 2]!, z1 = pts[k + 3]!;
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      // Liang-Barsky clip of the centreline to the chunk.
      let t0 = 0;
      let t1 = 1;
      const clip = (p: number, q: number): boolean => {
        if (p === 0) return q >= 0;
        const t = q / p;
        if (p < 0) {
          if (t > t1) return false;
          if (t > t0) t0 = t;
        } else {
          if (t < t0) return false;
          if (t < t1) t1 = t;
        }
        return true;
      };
      if (!(clip(-dx, x0 - b.minX) && clip(dx, b.maxX - x0) && clip(-dz, z0 - b.minZ) && clip(dz, b.maxZ - z0))) continue;
      if (t1 <= t0) continue;
      const nx = -dz / len;
      const nz = dx / len;
      const a0 = r.along[k / 2]!;
      // Ribbon, subdivided so it follows the terrain triangles.
      const steps = Math.max(1, Math.ceil(((t1 - t0) * len) / 30));
      const base = o.decalPos.length / 3;
      for (let si = 0; si <= steps; si++) {
        const t = t0 + ((t1 - t0) * si) / steps;
        const cx = x0 + dx * t;
        const cz = z0 + dz * t;
        for (let side = -1; side <= 1; side += 2) {
          const px = cx + nx * hw * side;
          const pz = cz + nz * hw * side;
          let y = surface(px, pz) + DECAL_LIFT_M;
          if (r.bridges && wl !== undefined && r.cls !== DecalClass.Canal) y = Math.max(y, wl + BRIDGE_CLEARANCE_M);
          o.decalPos.push(px, y, pz);
          o.decalAttr.push(side, a0 + len * t, r.cls, hw);
        }
      }
      for (let si = 0; si < steps; si++) {
        const v = base + si * 2;
        o.decalIdx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      }

      // Roadside trees: irregular groups with gaps, set back 2-14 m, mostly one side at a time;
      // none in settlements or on bridges. Canals keep fuller (but still broken) rows.
      if (!opts.objects || r.treeKind < 0) continue;
      const kind = r.treeKind;
      const spacing = kind === TreeKind.Poplar ? 5 : 8;
      const A0 = a0 + len * t0;
      const A1 = a0 + len * t1;
      const canal = r.cls === DecalClass.Canal;
      for (let m = Math.ceil(A0 / spacing); m * spacing < A1; m++) {
        const jitterA = (hash3(ri, m, 3, 83) - 0.5) * spacing * 0.8;
        const sAlong = m * spacing + jitterA;
        const t = (sAlong - a0) / len;
        if (t < 0 || t > 1) continue;
        const cx = x0 + dx * t;
        const cz = z0 + dz * t;
        for (let side = -1; side <= 1; side += 2) {
          // Groups: a 1D noise along the road (per side) decides where trees stand.
          const g = vnoise2(sAlong / (canal ? 90 : 60), side * 17.3 + ri * 0.37, 84);
          const keep = (canal ? 0.25 + 0.75 * g : g * g * 1.6) * r.treeProb * opts.treeDensity;
          if (hash3(ri, m, side, 78) > keep) continue;
          const off = hw + 2 + (canal ? 3 : 12) * Math.pow(hash3(ri, m, side, 79), 1.5);
          const tx = cx + nx * off * side;
          const tz = cz + nz * off * side;
          if (inSettlement(tx, tz, 0.9) || wet(tx, tz)) continue;
          const hk = hash3(ri, m, side, 80);
          const mixKind = goa ? (hk < 0.55 ? TreeKind.Palm : TreeKind.Broadleaf) : hk < (canal ? 0.2 : 0.35) ? TreeKind.Broadleaf : kind;
          pushTree(o, mixKind, tx, surface(tx, tz), tz, hash3(ri, m, side, 81), hash3(ri, m, side, 82));
        }
      }
    }
  }

  // --- settlements: ground, ponds, buildings, village trees ---------------------------------
  for (const s of nearSettlements) {
    const centreHere = inRect(b, s.x, s.z);
    if (goa) {
      // Goan village: no bare ground or pond, just houses scattered among palms, and a church.
      if (opts.objects) buildGoanVillage(o, s, b, surface, opts, wet);
      continue;
    }
    if (centreHere) {
      pushFan(o, s.x, s.z, s.radiusM * 1.05, s.seed, DecalClass.VillageGround, surface, 1);
    }
    // Every settlement is a village-style cluster (towns are just larger and a little denser).
    const pond = villagePond(s);
    if (centreHere) pushFan(o, pond.x, pond.z, pond.r, s.seed + 1, DecalClass.Canal, surface, 0.44);
    if (opts.objects) buildVillage(o, s, pond, b, surface, opts);
  }

  if (goa) {
    if (opts.objects) goaVegetation(o, b, surface, opts, coastDist, estDist, inSettlement);
    return finish(o);
  }

  // --- groves: small dense clumps of trees (the dark patches in aerial views) ------------------
  const CG = 1000;
  for (let iz = Math.floor((b.minZ - 150) / CG); iz <= Math.floor((b.maxZ + 150) / CG); iz++) {
    for (let ix = Math.floor((b.minX - 150) / CG); ix <= Math.floor((b.maxX + 150) / CG); ix++) {
      if (hash3(ix, iz, 1, 95) > 0.1) continue;
      const gx = (ix + hash3(ix, iz, 2, 95)) * CG;
      const gz = (iz + hash3(ix, iz, 3, 95)) * CG;
      const gr = 40 + 80 * hash3(ix, iz, 4, 95);
      if (inRect(b, gx, gz) && !inSettlement(gx, gz, 1.2) && !wet(gx, gz)) pushFan(o, gx, gz, gr * 1.15, ix * 7919 + iz, DecalClass.Grove, surface, 1);
      if (!opts.objects) continue;
      const count = Math.round(gr * gr / 90);
      for (let t = 0; t < count; t++) {
        const a = hash3(ix * 97 + t, iz, 5, 95) * Math.PI * 2;
        const d = gr * Math.sqrt(hash3(ix * 97 + t, iz, 6, 95));
        const tx = gx + Math.cos(a) * d;
        const tz = gz + Math.sin(a) * d;
        if (!inRect(b, tx, tz) || inSettlement(tx, tz, 1.05) || wet(tx, tz)) continue;
        pushTree(o, hash3(ix * 97 + t, iz, 7, 95) < 0.8 ? TreeKind.Broadleaf : TreeKind.Eucalyptus, tx, surface(tx, tz), tz, hash3(ix * 97 + t, iz, 8, 95), hash3(ix * 97 + t, iz, 9, 95));
      }
    }
  }

  if (opts.objects) {
    // --- trees along field-block boundaries ----------------------------------------------------
    // The ground shader draws fields on a rotated 760 m block grid; every block edge is a field
    // edge (a bund or cart track), which is where most farm trees stand. Walk the block edges that
    // cross this chunk and scatter clumped trees along them, jittered off the line.
    const cornersQx = [b.minX, b.maxX].flatMap((x) => [b.minZ, b.maxZ].map((z) => FR_A * x - FR_B * z));
    const cornersQz = [b.minX, b.maxX].flatMap((x) => [b.minZ, b.maxZ].map((z) => FR_B * x + FR_A * z));
    const qx0 = Math.min(...cornersQx);
    const qx1 = Math.max(...cornersQx);
    const qz0 = Math.min(...cornersQz);
    const qz1 = Math.max(...cornersQz);
    const toWorld = (qx: number, qz: number): [number, number] => [(FR_A * qx + FR_B * qz) / FR_DET, (-FR_B * qx + FR_A * qz) / FR_DET];
    const EDGE_STEP = 7;
    for (let axis = 0; axis < 2; axis++) {
      const lo = axis === 0 ? qx0 : qz0;
      const hi = axis === 0 ? qx1 : qz1;
      const alo = axis === 0 ? qz0 : qx0;
      const ahi = axis === 0 ? qz1 : qx1;
      for (let k = Math.ceil(lo / FIELD_BLOCK_M); k * FIELD_BLOCK_M <= hi; k++) {
        const line = k * FIELD_BLOCK_M;
        for (let m = Math.ceil(alo / EDGE_STEP); m * EDGE_STEP <= ahi; m++) {
          const along = m * EDGE_STEP + (hash3(k, m, axis, 95) - 0.5) * EDGE_STEP;
          // Stretches with trees and long gaps without, per edge.
          const g = vnoise2(along / 110, k * 3.7 + axis * 101.3, 96);
          const keep = Math.max(0, g - 0.45) * 2.2 * 0.55 * opts.treeDensity;
          if (hash3(k, m, axis, 97) > keep) continue;
          const across = line + (hash3(k, m, axis, 98) - 0.5) * 9;
          const [tx, tz] = axis === 0 ? toWorld(across, along) : toWorld(along, across);
          if (!inRect(b, tx, tz) || inSettlement(tx, tz, 1.05) || wet(tx, tz)) continue;
          const h = hash3(k, m, axis, 99);
          const kind = h < 0.6 ? TreeKind.Broadleaf : h < 0.85 ? TreeKind.Eucalyptus : TreeKind.Poplar;
          pushTree(o, kind, tx, surface(tx, tz), tz, hash3(k, m, axis, 100), hash3(k, m, axis, 101));
        }
      }
    }
    // --- scattered field trees (kikar, shisham): clumped, never evenly spread -----------------
    const C2 = 90;
    for (let iz = Math.floor(b.minZ / C2); iz * C2 < b.maxZ; iz++) {
      for (let ix = Math.floor(b.minX / C2); ix * C2 < b.maxX; ix++) {
        const tx = (ix + hash3(ix, iz, 2, 93)) * C2;
        const tz = (iz + hash3(ix, iz, 3, 93)) * C2;
        const keep = (0.012 + 0.22 * clump(tx, tz, 94)) * opts.treeDensity;
        if (hash3(ix, iz, 1, 93) > keep) continue;
        if (!inRect(b, tx, tz) || inSettlement(tx, tz, 1.1) || wet(tx, tz)) continue;
        const kind = hash3(ix, iz, 6, 93) < 0.85 ? TreeKind.Broadleaf : TreeKind.Eucalyptus;
        pushTree(o, kind, tx, surface(tx, tz), tz, hash3(ix, iz, 4, 93), hash3(ix, iz, 5, 93));
      }
    }
  }

  return finish(o);
}

function finish(o: Out): ChunkFeatures {
  return {
    decalPositions: Float32Array.from(o.decalPos),
    decalAttribs: Float32Array.from(o.decalAttr),
    decalIndices: Uint32Array.from(o.decalIdx),
    treeMatrices: o.treeM.map((a) => Float32Array.from(a)),
    treeColors: o.treeC.map((a) => Float32Array.from(a)),
    buildingMatrices: Float32Array.from(o.bldM),
    buildingColors: Float32Array.from(o.bldC),
    domeMatrices: Float32Array.from(o.domeM),
    houseMatrices: Float32Array.from(o.houseM),
    houseColors: Float32Array.from(o.houseC),
  };
}

/** Goan house wall colours: whitewash, cream, yellow, sky blue, salmon pink, mint green, ochre. */
const GOA_WALLS: readonly (readonly [number, number, number])[] = [
  [0.9, 0.89, 0.85], [0.9, 0.89, 0.85], [0.9, 0.89, 0.85], [0.88, 0.84, 0.72], [0.88, 0.84, 0.72],
  [0.88, 0.8, 0.56], [0.72, 0.78, 0.82], [0.86, 0.72, 0.66], [0.74, 0.82, 0.72], [0.82, 0.68, 0.48],
];

/**
 * A Goan village or town: gabled, red-tiled houses scattered (not on a grid) among coconut palms,
 * denser towards the centre, and a whitewashed church with a bell tower (always in towns, in about
 * half the villages).
 */
function buildGoanVillage(o: Out, s: Settlement, b: ChunkBounds, surface: SurfaceFn, opts: FeatureOptions, wet: (x: number, z: number) => boolean): void {
  const R = s.radiusM;
  const town = s.kind !== 'village';
  const C = town ? 16 : 22;
  const n = Math.ceil((R * 1.2) / C);
  for (let iz = -n; iz <= n; iz++) {
    for (let ix = -n; ix <= n; ix++) {
      const lx = (ix + hash3(ix, iz, 1, s.seed) - 0.5) * C;
      const lz = (iz + hash3(ix, iz, 2, s.seed) - 0.5) * C;
      const d = Math.hypot(lx, lz) / R;
      if (d > 1.15) continue;
      const keep = (town ? 0.65 : 0.5) * (1 - 0.75 * d * d);
      if (hash3(ix, iz, 3, s.seed) > keep) continue;
      const x = s.x + lx;
      const z = s.z + lz;
      if (!inRect(b, x, z) || wet(x, z)) continue;
      const h = hash3(ix, iz, 4, s.seed);
      const storeys = town && h < 0.35 ? 2 : h < 0.12 ? 2 : 1;
      const w = 7 + 4 * hash3(ix, iz, 5, s.seed);
      const len = 8 + 5 * hash3(ix, iz, 6, s.seed);
      const rot = s.rotRad + (hash3(ix, iz, 7, s.seed) - 0.5) * 0.9;
      pushMatrix(o.houseM, x, surface(x, z), z, rot, w, 3.2 * storeys, len);
      const c = GOA_WALLS[Math.floor(hash3(ix, iz, 8, s.seed) * GOA_WALLS.length)]!;
      o.houseC.push(c[0], c[1], c[2]);
    }
  }
  // Church: a white nave with a tiled roof, and a bell tower at its front.
  if (town || hash3(s.seed, 9, 0, 5) < 0.55) {
    const a = hash3(s.seed, 10, 0, 5) * Math.PI * 2;
    const cx = s.x + Math.cos(a) * R * 0.25;
    const cz = s.z + Math.sin(a) * R * 0.25;
    if (inRect(b, cx, cz) && !wet(cx, cz)) {
      const y = surface(cx, cz);
      const rot = s.rotRad;
      const L = town ? 34 : 26;
      pushMatrix(o.houseM, cx, y, cz, rot, 11, 9, L);
      o.houseC.push(0.95, 0.94, 0.9);
      const fx = Math.sin(rot);
      const fz = Math.cos(rot);
      const tx = cx + fx * (L / 2 + 2.5);
      const tz = cz + fz * (L / 2 + 2.5);
      pushMatrix(o.bldM, tx, surface(tx, tz), tz, rot, 5.5, town ? 20 : 16, 5.5);
      o.bldC.push(0.95, 0.94, 0.9);
    }
  }
  // Palms (and a few mango/jackfruit trees) among the houses and around the village.
  const nt = Math.round(((R * R) / 650) * opts.treeDensity);
  for (let i = 0; i < nt; i++) {
    const a = hash3(i, 1, 0, s.seed + 17) * Math.PI * 2;
    const d = R * 1.4 * Math.sqrt(hash3(i, 2, 0, s.seed + 17));
    const tx = s.x + Math.cos(a) * d;
    const tz = s.z + Math.sin(a) * d;
    if (!inRect(b, tx, tz) || wet(tx, tz)) continue;
    pushTree(o, hash3(i, 3, 0, s.seed + 17) < 0.75 ? TreeKind.Palm : TreeKind.Broadleaf, tx, surface(tx, tz), tz, hash3(i, 4, 0, s.seed + 17), hash3(i, 5, 0, s.seed + 17));
  }
}

/**
 * Goa vegetation on a jittered 26 m grid, clumped into groves: coconut palms in a belt behind the
 * beaches and along the estuary banks (and scattered on low land), mango/cashew/jackfruit on the
 * plain, dense forest on the Ghats escarpment, sparse trees on the Deccan top.
 */
function goaVegetation(
  o: Out,
  b: ChunkBounds,
  surface: SurfaceFn,
  opts: FeatureOptions,
  coastDist: (x: number, z: number) => number,
  estDist: (x: number, z: number) => number,
  inSettlement: (x: number, z: number, scale: number) => boolean
): void {
  const C = 26;
  const ss = (e0: number, e1: number, x: number): number => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  for (let iz = Math.floor(b.minZ / C); iz * C < b.maxZ; iz++) {
    for (let ix = Math.floor(b.minX / C); ix * C < b.maxX; ix++) {
      const x = (ix + hash3(ix, iz, 2, 131)) * C;
      const z = (iz + hash3(ix, iz, 3, 131)) * C;
      if (!inRect(b, x, z)) continue;
      const cd = coastDist(x, z);
      if (cd < 55) continue;
      const ed = estDist(x, z);
      if (ed > -12) continue;
      const h = surface(x, z);
      const palm =
        0.25 * ss(55, 120, cd) * (1 - ss(1800, 4200, cd)) +
        (cd > 300 ? 0.24 * (1 - ss(40, 380, -ed)) : 0) +
        (h < 60 ? 0.06 : 0);
      const ghats = ss(220, 420, h) * (1 - ss(760, 840, h));
      const broad = 0.05 + 0.2 * ghats + (h > 800 ? 0.02 : 0);
      const cl = 0.25 + 1.5 * clump(x, z, 133);
      const r = hash3(ix, iz, 1, 131);
      const pPalm = palm * cl * opts.treeDensity;
      const pBroad = broad * cl * opts.treeDensity;
      if (r > pPalm + pBroad) continue;
      if (inSettlement(x, z, 1.05)) continue;
      pushTree(o, r < pPalm ? TreeKind.Palm : TreeKind.Broadleaf, x, h, z, hash3(ix, iz, 4, 131), hash3(ix, iz, 5, 131));
    }
  }
}

/** One tree: size and colour vary per kind; h1/h2 are per-tree random numbers. */
function pushTree(o: Out, kind: number, x: number, y: number, z: number, h1: number, h2: number): void {
  for (const c of o.clear) {
    const dx = x - c.x;
    const dz = z - c.z;
    if (dx * dx + dz * dz < c.radiusM * c.radiusM) return;
  }
  // Unit models are 1 m tall/wide; scale to real sizes.
  let sy: number;
  let sxz: number;
  if (kind === TreeKind.Palm) {
    // Coconut palms: 10-20 m tall, crowns ~8-11 m across.
    sy = 10 + 10 * h1;
    sxz = 8 + 3 * h2;
  } else if (kind === TreeKind.Poplar) {
    sy = 13 + 7 * h1;
    sxz = sy * (0.2 + 0.05 * h2);
  } else if (kind === TreeKind.Eucalyptus) {
    sy = 15 + 9 * h1;
    sxz = sy * (0.35 + 0.1 * h2);
  } else {
    sy = 7 + 7 * h1;
    sxz = sy * (0.85 + 0.35 * h2);
  }
  pushMatrix(o.treeM[kind]!, x, y, z, h2 * 6.283, sxz, sy, sxz);
  // Foliage tint variation.
  const v = 0.85 + 0.3 * h1;
  const warm = h2 - 0.5;
  o.treeC[kind]!.push(v * (1 + 0.12 * warm), v, v * (1 - 0.1 * warm));
}

/** A ground fan (disc with a ragged edge). across: 0 at the centre to `rimAcross` at the rim. */
function pushFan(o: Out, cx: number, cz: number, r: number, seed: number, cls: number, surface: SurfaceFn, rimAcross: number): void {
  const n = 40;
  const base = o.decalPos.length / 3;
  o.decalPos.push(cx, surface(cx, cz) + DECAL_LIFT_M * 0.5, cz);
  o.decalAttr.push(0, 0, cls, r);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (0.85 + 0.3 * hash3(i, 0, 0, seed));
    const x = cx + Math.cos(a) * rr;
    const z = cz + Math.sin(a) * rr;
    o.decalPos.push(x, surface(x, z) + DECAL_LIFT_M * 0.5, z);
    o.decalAttr.push(rimAcross, a * rr, cls, r);
  }
  for (let i = 0; i < n; i++) o.decalIdx.push(base, base + 1 + ((i + 1) % n), base + 1 + i);
}

function villagePond(s: Settlement): { x: number; z: number; r: number } {
  const a = hash3(s.seed, 1, 0, 5) * Math.PI * 2;
  const d = s.radiusM * (0.45 + 0.3 * hash3(s.seed, 2, 0, 5));
  return { x: s.x + Math.cos(a) * d, z: s.z + Math.sin(a) * d, r: 18 + 20 * hash3(s.seed, 3, 0, 5) };
}

function buildVillage(o: Out, s: Settlement, pond: { x: number; z: number; r: number }, b: ChunkBounds, surface: SurfaceFn, opts: FeatureOptions): void {
  const c = Math.cos(s.rotRad);
  const sn = Math.sin(s.rotRad);
  const LX = 14;
  const LZ = 13;
  const R = s.radiusM;
  const n = Math.ceil((R * 1.15) / LX);
  for (let iz = -n; iz <= n; iz++) {
    for (let ix = -n; ix <= n; ix++) {
      if (((ix % 5) + 5) % 5 === 2 || ((iz % 4) + 4) % 4 === 1) continue; // lanes
      const lx = ix * LX;
      const lz = iz * LZ;
      if (Math.abs(lx) < 6 || Math.abs(lz) < 6) continue; // the two main lanes
      const d = Math.hypot(lx, lz);
      const edge = R * (0.8 + 0.3 * hash3(Math.round(Math.atan2(lz, lx) * 6), 0, 0, s.seed));
      if (d > edge) continue;
      const h = hash3(ix, iz, 1, s.seed);
      if (h > 0.88 - 0.4 * (d / edge)) continue;
      const x = s.x + c * lx - sn * lz;
      const z = s.z + sn * lx + c * lz;
      if (!inRect(b, x, z) || Math.hypot(x - pond.x, z - pond.z) < pond.r + 8) continue;
      const w = 9 + 4 * hash3(ix, iz, 2, s.seed);
      const dd = 9 + 3 * hash3(ix, iz, 3, s.seed);
      const hh = hash3(ix, iz, 4, s.seed);
      const height = hh < 0.6 ? 3.4 : hh < 0.95 ? 6.6 : 9.8;
      pushMatrix(o.bldM, x, surface(x, z), z, s.rotRad, w, height, dd);
      const col = BUILDING_COLORS[Math.floor(hash3(ix, iz, 5, s.seed) * BUILDING_COLORS.length)]!;
      o.bldC.push(col[0], col[1], col[2]);
    }
  }
  // A white gurdwara with a dome in about half the villages.
  if (hash3(s.seed, 9, 0, 5) < 0.5) {
    const gx = s.x + c * R * 0.3;
    const gz = s.z + sn * R * 0.3;
    if (inRect(b, gx, gz)) {
      const gy = surface(gx, gz);
      pushMatrix(o.bldM, gx, gy, gz, s.rotRad, 16, 7, 16);
      o.bldC.push(0.93, 0.92, 0.88);
      pushMatrix(o.domeM, gx, gy + 7, gz, 0, 4.5, 5.5, 4.5);
    }
  }
  // Village trees: dense, broad (peepal, neem, banyan), inside and around the village.
  const nt = Math.round(((R * R) / 900) * opts.treeDensity);
  for (let i = 0; i < nt; i++) {
    const a = hash3(i, 1, 0, s.seed + 17) * Math.PI * 2;
    const d = R * 1.3 * Math.sqrt(hash3(i, 2, 0, s.seed + 17));
    const tx = s.x + Math.cos(a) * d;
    const tz = s.z + Math.sin(a) * d;
    if (!inRect(b, tx, tz) || Math.hypot(tx - pond.x, tz - pond.z) < pond.r) continue;
    pushTree(o, hash3(i, 3, 0, s.seed + 17) < 0.8 ? TreeKind.Broadleaf : TreeKind.Eucalyptus, tx, surface(tx, tz), tz, hash3(i, 4, 0, s.seed + 17), hash3(i, 5, 0, s.seed + 17));
  }
}
