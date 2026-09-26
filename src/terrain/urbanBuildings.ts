/**
 * src/terrain/urbanBuildings.ts — the 3D buildings of the urban layer for one terrain chunk
 * (terrain worker). It walks the lots of every district that reaches the chunk (urbanMath.ts: the
 * grid streets' lot rows, then the collectors'), keeps those the ground shader shows a building on
 * (same hashes, same urbanity at the lot centre), and reports each building's footprint, height
 * and roof. Lots are generated in warped space and mapped back to the world (unwarp), and each
 * building is turned to follow its street there.
 */
import type { UrbanLayer } from '../contracts/terrain';
import {
  URBAN_ARTERIAL_HW_M,
  URBAN_DISTRICT_M,
  URBAN_MIN_U,
  borderDepth,
  borderLotW,
  borderRoadHw,
  collectorLotClear,
  districtAt,
  districtParams,
  featureX,
  featureZ,
  gridStreetDist,
  lotHash,
  lotShape,
  newDistrict,
  newDistrictParams,
  occupancy,
  sampleUrban,
  segKeep,
  texelU,
  unwarp,
  type UrbanLot,
} from './urbanMath';

export interface UrbanBuilding {
  /** Footprint centre (world), and the rotation for a unit model whose local x is the footprint's `sx` side. */
  x: number;
  z: number;
  rotRad: number;
  sx: number;
  sz: number;
  /** Wall height (m). */
  heightM: number;
  /** Flat concrete roof (else a red-tiled gable, ridge along local z). */
  flat: boolean;
  /** 0..1: picks the wall colour (and, for flat roofs, the roof tint). */
  colourHash: number;
}

const G = URBAN_DISTRICT_M;
/** The warp moves points by at most ~52 m. */
const WARP_MARGIN_M = 60;
const OFF = 1024;

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function sstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Calls `cb` for every building whose centre lies in [minX, maxX) x [minZ, maxZ). `blocked` lets
 * the caller veto a spot (water).
 */
export function forEachUrbanBuilding(
  L: UrbanLayer,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  blocked: (x: number, z: number) => boolean,
  cb: (b: UrbanBuilding) => void
): void {
  const seed = L.seed;
  const P = newDistrictParams();
  const Pn = newDistrictParams();
  const d = newDistrict();
  const smp = new Float64Array(5);
  const w = { x: 0, z: 0 };
  const w2 = { x: 0, z: 0 };
  const lot: UrbanLot = { a: 0, b: 0, c: 0, sb: 0, dp: 0, g: 0, Lw: 1 };
  const out: UrbanBuilding = { x: 0, z: 0, rotRad: 0, sx: 0, sz: 0, heightM: 0, flat: false, colourHash: 0 };
  const sMinX = minX - WARP_MARGIN_M;
  const sMaxX = maxX + WARP_MARGIN_M;
  const sMinZ = minZ - WARP_MARGIN_M;
  const sMaxZ = maxZ + WARP_MARGIN_M;

  /** Final checks at a lot centre (warped space) and the building's emission. dirX/dirZ: its local x axis in warped space. */
  const emit = (scx: number, scz: number, dirX: number, dirZ: number, sx: number, sz: number, core: number, Ud: number): void => {
    unwarp(scx, scz, w);
    if (w.x < minX || w.x >= maxX || w.z < minZ || w.z >= maxZ) return;
    sampleUrban(L, w.x, w.z, smp);
    if (smp[4]! < 72 && Math.abs(smp[3]!) < URBAN_ARTERIAL_HW_M + 3 + 0.5 * Math.hypot(sx, sz)) return;
    if (blocked(w.x, w.z)) return;
    unwarp(scx + dirX * 4, scz + dirZ * 4, w2);
    const flat = lotHash(lot, 4, seed) < mix(0.12, 0.7, sstep(0.25, 0.75, Ud));
    const h5 = lotHash(lot, 5, seed);
    const storeys = flat ? 1 + Math.floor(h5 * mix(2.2, 5.0, core)) : h5 < 0.3 ? 2 : 1;
    out.x = w.x;
    out.z = w.z;
    out.rotRad = -Math.atan2(w2.z - w.z, w2.x - w.x);
    out.sx = sx;
    out.sz = sz;
    out.heightM = 3.2 * storeys;
    out.flat = flat;
    out.colourHash = lotHash(lot, 6, seed);
    cb(out);
  };

  const c0x = Math.floor(sMinX / G) - 1;
  const c1x = Math.floor(sMaxX / G) + 1;
  const c0z = Math.floor(sMinZ / G) - 1;
  const c1z = Math.floor(sMaxZ / G) + 1;
  for (let cz = c0z; cz <= c1z; cz++) {
    for (let cx = c0x; cx <= c1x; cx++) {
      const fx = featureX(cx, cz, seed);
      const fz = featureZ(cx, cz, seed);
      districtParams(L, cx, cz, fx, fz, P);

      // --- grid lots --------------------------------------------------------------------------
      // The district only owns points within its 3x3 cells; clip that square to the chunk.
      const bx0 = Math.max((cx - 1) * G, sMinX);
      const bx1 = Math.min((cx + 2) * G, sMaxX);
      const bz0 = Math.max((cz - 1) * G, sMinZ);
      const bz1 = Math.min((cz + 2) * G, sMaxZ);
      if (P.U >= URBAN_MIN_U && bx0 < bx1 && bz0 < bz1) {
        let lx0 = Infinity;
        let lx1 = -Infinity;
        let lz0 = Infinity;
        let lz1 = -Infinity;
        for (const [qx, qz] of [
          [bx0, bz0],
          [bx1, bz0],
          [bx0, bz1],
          [bx1, bz1],
        ] as const) {
          const dx = qx - fx;
          const dz = qz - fz;
          const lx = P.c * dx + P.s * dz + P.ox;
          const lz = -P.s * dx + P.c * dz + P.oz;
          lx0 = Math.min(lx0, lx);
          lx1 = Math.max(lx1, lx);
          lz0 = Math.min(lz0, lz);
          lz1 = Math.max(lz1, lz);
        }
        const halfDiag = 0.5 * Math.hypot(P.Sx, P.Sz);
        const Db = (hwb: number): number => borderDepth(hwb, P.core);
        for (let j = Math.floor(lz0 / P.Sz); j <= Math.floor(lz1 / P.Sz); j++) {
          for (let i = Math.floor(lx0 / P.Sx); i <= Math.floor(lx1 / P.Sx); i++) {
            // Block centre in warped space: skip blocks outside the clip or wholly in another district.
            const qx = (i + 0.5) * P.Sx - P.ox;
            const qz = (j + 0.5) * P.Sz - P.oz;
            const bcx = fx + P.c * qx - P.s * qz;
            const bcz = fz + P.s * qx + P.c * qz;
            if (bcx < bx0 - halfDiag || bcx > bx1 + halfDiag || bcz < bz0 - halfDiag || bcz > bz1 + halfDiag) continue;
            districtAt(bcx, bcz, seed, d);
            if ((d.cx !== cx || d.cz !== cz) && d.border > halfDiag) continue;
            const kL = segKeep(cx, cz, i, j, 0, P.U, seed);
            const kR = segKeep(cx, cz, i + 1, j, 0, P.U, seed);
            const kT = segKeep(cx, cz, i, j, 1, P.U, seed);
            const kB = segKeep(cx, cz, i, j + 1, 1, P.U, seed);
            const kept = [kL, kR, kT, kB];
            for (let side = 0; side < 4; side++) {
              if (!kept[side]) continue;
              let t0: number;
              let t1: number;
              if (side < 2) {
                t0 = kT ? P.hw : 0;
                t1 = P.Sz - (kB ? P.hw : 0);
              } else {
                t0 = kL ? P.D : 0;
                t1 = P.Sx - (kR ? P.D : 0);
              }
              const nLots = Math.floor((t1 - t0) / P.Lw);
              for (let k = 0; k < nLots; k++) {
                lot.a = (cx + OFF) * 128 + i + 64;
                lot.b = (cz + OFF) * 128 + j + 64;
                lot.c = 64 + side * 128 + k + 16;
                lot.Lw = P.Lw;
                lotShape(lot, P.core, P.hw, P.D, seed);
                const ac = lot.sb + 0.5 * lot.dp;
                const tc = t0 + (k + 0.5) * P.Lw;
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
                const lqx = clx - P.ox;
                const lqz = clz - P.oz;
                const scx = fx + P.c * lqx - P.s * lqz;
                const scz = fz + P.s * lqx + P.c * lqz;
                if (scx < sMinX || scx >= sMaxX || scz < sMinZ || scz >= sMaxZ) continue;
                if (lotHash(lot, 0, seed) >= occupancy(texelU(L, scx, scz)) * P.dens) continue;
                // Owned by this district, and not in a collector's frontage (which wins there).
                districtAt(scx, scz, seed, d);
                if (d.cx !== cx || d.cz !== cz) continue;
                const bw = P.Lw - 2 * lot.g;
                const hwb = borderRoadHw(cx, cz, d.ncx, d.ncz, P.U, texelU(L, d.nfx, d.nfz), seed);
                if (hwb > 0 && d.border < Db(hwb) + 0.5 * Math.max(bw, lot.dp)) continue;
                // Local x: across the street for rows along grid lines i (sides 0, 1), along it for sides 2, 3.
                if (side < 2) emit(scx, scz, P.c, P.s, lot.dp, bw, P.core, P.U);
                else emit(scx, scz, P.c, P.s, bw, lot.dp, P.core, P.U);
              }
            }
          }
        }
      }

      // --- collector lots: each district pair once, from its lower cell -------------------------
      for (let k9 = 0; k9 < 9; k9++) {
        const ncx = cx + (k9 % 3) - 1;
        const ncz = cz + Math.floor(k9 / 3) - 1;
        if (!(cx < ncx || (cx === ncx && cz < ncz))) continue;
        const nfx = featureX(ncx, ncz, seed);
        const nfz = featureZ(ncx, ncz, seed);
        // Skip pairs whose border is nowhere near the chunk.
        const mx = 0.5 * (fx + nfx);
        const mz = 0.5 * (fz + nfz);
        if (mx < sMinX - G || mx > sMaxX + G || mz < sMinZ - G || mz > sMaxZ + G) continue;
        districtParams(L, ncx, ncz, nfx, nfz, Pn);
        const hwb = borderRoadHw(cx, cz, ncx, ncz, P.U, Pn.U, seed);
        if (hwb <= 0) continue;
        const nl = Math.hypot(nfx - fx, nfz - fz);
        const nx = (nfx - fx) / nl;
        const nz = (nfz - fz) / nl;
        for (let side = 0; side < 2; side++) {
          const O = side === 0 ? P : Pn;
          const ocx = side === 0 ? cx : ncx;
          const ocz = side === 0 ? cz : ncz;
          const sgn = side === 0 ? -1 : 1;
          const Lw = borderLotW(O.core);
          const D = borderDepth(hwb, O.core);
          const kMax = Math.ceil((1.3 * G) / Lw);
          for (let k = -kMax; k < kMax; k++) {
            lot.a = (cx + OFF) * 4 + (ncx - cx + 1);
            lot.b = (cz + OFF) * 4 + (ncz - cz + 1);
            lot.c = 2048 + side * 1024 + k + 512;
            lot.Lw = Lw;
            lotShape(lot, O.core, hwb, D, seed);
            const tc = (k + 0.5) * Lw;
            const acr = sgn * (lot.sb + 0.5 * lot.dp);
            const scx = mx - nz * tc + nx * acr;
            const scz = mz + nx * tc + nz * acr;
            if (scx < sMinX || scx >= sMaxX || scz < sMinZ || scz >= sMaxZ) continue;
            if (lotHash(lot, 0, seed) >= occupancy(texelU(L, scx, scz)) * O.dens) continue;
            districtAt(scx, scz, seed, d);
            if (d.cx !== ocx || d.cz !== ocz) continue;
            if (d.ncx !== (side === 0 ? ncx : cx) || d.ncz !== (side === 0 ? ncz : cz) || d.border >= D) continue;
            const ofx = side === 0 ? fx : nfx;
            const ofz = side === 0 ? fz : nfz;
            if (gridStreetDist(ocx, ocz, ofx, ofz, O, scx, scz, seed) < collectorLotClear(O.hw, Lw, lot)) continue;
            emit(scx, scz, sgn * nx, sgn * nz, lot.dp, Lw - 2 * lot.g, O.core, O.U);
          }
        }
      }
    }
  }
}
