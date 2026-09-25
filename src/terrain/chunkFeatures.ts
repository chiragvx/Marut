/**
 * src/terrain/chunkFeatures.ts — per-chunk scenery built from the road network (terrain worker).
 *
 * For one terrain chunk it produces (contracts/terrain.ts ChunkFeatures):
 * - ground decals: road ribbons, canals, village/town ground and village ponds, draped on the
 *   chunk's own terrain triangles (`surface`) so they sit exactly on the rendered mesh;
 * - tree instances: sparse trees along roads, fuller rows along canals, a few poplar rows on field
 *   boundaries, groves, trees in and around villages, scattered field trees;
 * - building instances: houses clustered on a lot grid with lanes (plus a gurdwara in about half of
 *   the settlements); towns are simply larger clusters.
 * Every item is generated from global, deterministic hashes and kept only if it falls in this
 * chunk, so neighbouring chunks (and the same area at another LOD) agree with each other.
 */
import { DecalClass, TREE_KIND_COUNT, TreeKind, type ChunkBounds, type ChunkFeatures } from '../contracts/terrain';
import { hash3, queryNetwork, type RoadNetwork, type Settlement } from './roadNetwork';

export type SurfaceFn = (x: number, z: number) => number;

export interface FeatureOptions {
  /** 0..1 multiplier on tree density. */
  treeDensity: number;
  /** Build trees and buildings (roads and ground are always built). */
  objects: boolean;
}

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
  decalPos: number[] = [];
  decalAttr: number[] = [];
  decalIdx: number[] = [];
  treeM: number[][] = Array.from({ length: TREE_KIND_COUNT }, () => []);
  treeC: number[][] = Array.from({ length: TREE_KIND_COUNT }, () => []);
  bldM: number[] = [];
  bldC: number[] = [];
  domeM: number[] = [];
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
  const wet = (x: number, z: number): boolean => wl !== undefined && surface(x, z) < wl + 4.5;

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

      // Tree rows along both sides, in 300 m stretches with gaps; none in towns or on bridges.
      if (!opts.objects || r.treeKind < 0) continue;
      const kind = r.treeKind;
      const spacing = kind === TreeKind.Poplar ? 6 : 11;
      const A0 = a0 + len * t0;
      const A1 = a0 + len * t1;
      for (let m = Math.ceil(A0 / spacing); m * spacing < A1; m++) {
        const sAlong = m * spacing;
        const t = (sAlong - a0) / len;
        const cx = x0 + dx * t;
        const cz = z0 + dz * t;
        for (let side = -1; side <= 1; side += 2) {
          if (hash3(ri, Math.floor(sAlong / 300), side, 77) > r.treeProb * opts.treeDensity) continue;
          if (hash3(ri, m, side, 78) > 0.88) continue;
          const off = hw + 3 + 2 * hash3(ri, m, side, 79);
          const tx = cx + nx * off * side;
          const tz = cz + nz * off * side;
          if (inSettlement(tx, tz, 0.9) || wet(tx, tz)) continue;
          const mixKind = hash3(ri, m, side, 80) < 0.15 ? TreeKind.Broadleaf : kind;
          pushTree(o, mixKind, tx, surface(tx, tz), tz, hash3(ri, m, side, 81), hash3(ri, m, side, 82));
        }
      }
    }
  }

  // --- settlements: ground, ponds, buildings, village trees ---------------------------------
  for (const s of nearSettlements) {
    const centreHere = inRect(b, s.x, s.z);
    if (centreHere) {
      pushFan(o, s.x, s.z, s.radiusM * 1.05, s.seed, DecalClass.VillageGround, surface, 1);
    }
    // Every settlement is a village-style cluster (towns are just larger and a little denser).
    const pond = villagePond(s);
    if (centreHere) pushFan(o, pond.x, pond.z, pond.r, s.seed + 1, DecalClass.Canal, surface, 0.44);
    if (opts.objects) buildVillage(o, s, pond, b, surface, opts);
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
    // --- poplar rows along field boundaries (rows only; the fields are not drawn) -------------
    const C = 500;
    for (let iz = Math.floor((b.minZ - margin) / C); iz <= Math.floor((b.maxZ + margin) / C); iz++) {
      for (let ix = Math.floor((b.minX - margin) / C); ix <= Math.floor((b.maxX + margin) / C); ix++) {
        if (hash3(ix, iz, 1, 91) > 0.05 * opts.treeDensity) continue;
        const sx = (ix + hash3(ix, iz, 2, 91)) * C;
        const sz = (iz + hash3(ix, iz, 3, 91)) * C;
        const ang = 0.12 + (hash3(ix, iz, 4, 91) < 0.5 ? 0 : Math.PI / 2);
        const len = 120 + 230 * hash3(ix, iz, 5, 91);
        const ux = Math.cos(ang);
        const uz = Math.sin(ang);
        for (let d = 0, n = 0; d < len; d += 3.5, n++) {
          const tx = sx + ux * d;
          const tz = sz + uz * d;
          if (!inRect(b, tx, tz) || hash3(ix * 131 + n, iz, 6, 91) > 0.9) continue;
          if (inSettlement(tx, tz, 1.1) || wet(tx, tz)) continue;
          pushTree(o, TreeKind.Poplar, tx, surface(tx, tz), tz, hash3(ix, iz * 97 + n, 7, 91), hash3(ix, iz * 97 + n, 8, 91));
        }
      }
    }
    // --- scattered field trees (kikar, shisham) ----------------------------------------------
    const C2 = 250;
    for (let iz = Math.floor(b.minZ / C2); iz * C2 < b.maxZ; iz++) {
      for (let ix = Math.floor(b.minX / C2); ix * C2 < b.maxX; ix++) {
        if (hash3(ix, iz, 1, 93) > 0.1 * opts.treeDensity) continue;
        const tx = (ix + hash3(ix, iz, 2, 93)) * C2;
        const tz = (iz + hash3(ix, iz, 3, 93)) * C2;
        if (!inRect(b, tx, tz) || inSettlement(tx, tz, 1.1) || wet(tx, tz)) continue;
        pushTree(o, TreeKind.Broadleaf, tx, surface(tx, tz), tz, hash3(ix, iz, 4, 93), hash3(ix, iz, 5, 93));
      }
    }
  }

  return {
    decalPositions: Float32Array.from(o.decalPos),
    decalAttribs: Float32Array.from(o.decalAttr),
    decalIndices: Uint32Array.from(o.decalIdx),
    treeMatrices: o.treeM.map((a) => Float32Array.from(a)),
    treeColors: o.treeC.map((a) => Float32Array.from(a)),
    buildingMatrices: Float32Array.from(o.bldM),
    buildingColors: Float32Array.from(o.bldC),
    domeMatrices: Float32Array.from(o.domeM),
  };
}

/** One tree: size and colour vary per kind; h1/h2 are per-tree random numbers. */
function pushTree(o: Out, kind: number, x: number, y: number, z: number, h1: number, h2: number): void {
  // Unit models are 1 m tall/wide; scale to real sizes.
  let sy: number;
  let sxz: number;
  if (kind === TreeKind.Poplar) {
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
