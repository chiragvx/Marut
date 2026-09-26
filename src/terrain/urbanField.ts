/**
 * src/terrain/urbanField.ts — bakes a theatre's urban field (contracts UrbanLayer) once, in the
 * terrain worker, from NetworkSpec.urban and the named roads:
 * - urbanity U: town cores (elliptical kernels), ribbon development along the named roads, and
 *   scattered hamlets over the lowland (patchy noise) plus a thin base, joined as a probabilistic
 *   union; then cut back behind the beaches and estuary banks, off steep or high ground, on the
 *   low tidal (khazan) paddies by the estuaries, and on the cleared airfields;
 * - the street-grid direction, a weighted double-angle average of the core axes, the nearest
 *   road's direction and the shoreline's (so towns face their roads and beaches);
 * - the signed distance to the nearest named road (the shader draws them far away with it).
 * 100 m texels; heights come from a 200 m grid of the height sampler (about 0.3 s once).
 */
import type { HeightSampler } from '../contracts/core';
import { DecalClass, type TerrainParams, type UrbanLayer, type UrbanSpec } from '../contracts/terrain';
import { ESTUARY_FLOATS, estuaryField, packEstuary, shoreAt } from './coastMath';
import { buildCoastProfile } from './terrainHeight';
import { URBAN_SDF_RANGE_M } from './urbanMath';

export const URBAN_RES_M = 100;

interface RoadLine {
  cls: number;
  pts: Float64Array;
}

function sstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function hashf(a: number, b: number, seed: number): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hashf(ix, iz, seed);
  const b = hashf(ix + 1, iz, seed);
  const c = hashf(ix, iz + 1, seed);
  const d = hashf(ix + 1, iz + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, z: number, seed: number): number {
  return 0.55 * vnoise(x, z, seed) + 0.3 * vnoise(x * 2.1 + 5.3, z * 2.1 - 1.7, seed + 1) + 0.15 * vnoise(x * 4.3 - 2.9, z * 4.3 + 7.1, seed + 2);
}

export function buildUrbanField(params: TerrainParams, sampler: HeightSampler, spec: UrbanSpec, roads: readonly RoadLine[], seed: number): UrbanLayer {
  const R = URBAN_RES_M;
  const [x0, z0, x1, z1] = spec.extent;
  const nx = Math.ceil((x1 - x0) / R);
  const nz = Math.ceil((z1 - z0) / R);
  const n = nx * nz;
  const data = new Uint8Array(n * 4);

  // Coast: shoreline x per texel row (and its direction), estuaries.
  const table = buildCoastProfile(params);
  const shoreX = new Float64Array(nz).fill(-1e9);
  const shoreAng = new Float64Array(nz).fill(Math.PI / 2);
  if (table) {
    const s = { x: 0, headland: 0 };
    for (let j = 0; j < nz; j++) {
      const z = z0 + (j + 0.5) * R;
      shoreAt(table, z, s);
      shoreX[j] = s.x;
      shoreAt(table, z - 60, s);
      const xa = s.x;
      shoreAt(table, z + 60, s);
      shoreAng[j] = Math.atan2(120, s.x - xa);
    }
  }
  const est = params.shape?.kind === 'coast' ? params.shape.estuaries : [];
  const estPk = new Float32Array(est.length * ESTUARY_FLOATS);
  est.forEach((e, i) => packEstuary(e, i, params.seed, estPk, i * ESTUARY_FLOATS));

  // Heights and slopes on a 200 m grid (land only).
  const HR = 2 * R;
  const hx = Math.ceil((x1 - x0) / HR) + 2;
  const hz = Math.ceil((z1 - z0) / HR) + 2;
  const H = new Float32Array(hx * hz);
  const shoreAtZ = (z: number): number => shoreX[Math.max(0, Math.min(nz - 1, Math.floor((z - z0) / R)))]!;
  for (let j = 0; j < hz; j++) {
    const z = z0 + (j - 0.5) * HR;
    const sx = shoreAtZ(z);
    for (let i = 0; i < hx; i++) {
      const x = x0 + (i - 0.5) * HR;
      H[j * hx + i] = x < sx - 400 ? -20 : sampler.heightAt(x, z);
    }
  }
  // Slope (m/m) per node, from its neighbours 400 m apart.
  const SL = new Float32Array(hx * hz);
  for (let j = 1; j < hz - 1; j++) {
    for (let i = 1; i < hx - 1; i++) {
      const gx = (H[j * hx + i + 1]! - H[j * hx + i - 1]!) / (2 * HR);
      const gz = (H[(j + 1) * hx + i]! - H[(j - 1) * hx + i]!) / (2 * HR);
      SL[j * hx + i] = Math.hypot(gx, gz);
    }
  }
  /** Bilinear lookup of a node grid (heights or slopes) at (x, z). */
  const grid = (A: Float32Array, x: number, z: number): number => {
    const gx = (x - x0) / HR + 0.5;
    const gz = (z - z0) / HR + 0.5;
    const i = Math.max(0, Math.min(hx - 2, Math.floor(gx)));
    const j = Math.max(0, Math.min(hz - 2, Math.floor(gz)));
    const fx = Math.max(0, Math.min(1, gx - i));
    const fz = Math.max(0, Math.min(1, gz - j));
    const a = A[j * hx + i]! + (A[j * hx + i + 1]! - A[j * hx + i]!) * fx;
    const b = A[(j + 1) * hx + i]! + (A[(j + 1) * hx + i + 1]! - A[(j + 1) * hx + i]!) * fx;
    return a + (b - a) * fz;
  };

  // Nearest named road: signed distance and direction (within 1.5 km).
  const REACH = 1500;
  const roadD = new Float32Array(n).fill(1e9);
  const roadS = new Int8Array(n);
  const roadA = new Float32Array(n);
  for (const r of roads) {
    if (r.cls === DecalClass.Canal) continue;
    const p = r.pts;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const ax = p[k]!;
      const az = p[k + 1]!;
      const bx = p[k + 2]!;
      const bz = p[k + 3]!;
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-6) continue;
      const ang = Math.atan2(dz, dx);
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - REACH - x0) / R));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + REACH - x0) / R));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - REACH - z0) / R));
      const j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz) + REACH - z0) / R));
      const len = Math.sqrt(l2);
      for (let j = j0; j <= j1; j++) {
        const z = z0 + (j + 0.5) * R;
        for (let i = i0; i <= i1; i++) {
          const x = x0 + (i + 0.5) * R;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
          const o = j * nx + i;
          if (d < roadD[o]!) {
            roadD[o] = d;
            roadS[o] = (dx * (z - az) - dz * (x - ax)) / len >= 0 ? 1 : -1;
            roadA[o] = ang;
          }
        }
      }
    }
  }

  const cores = spec.cores.map((c) => {
    const st = c.stretch ?? 1;
    const ax = c.axisRad ?? 0;
    return { x: c.x, z: c.z, ra: c.radiusM * st, rc: c.radiusM / st, ca: Math.cos(ax), sa: Math.sin(ax), c2: Math.cos(2 * ax), s2: Math.sin(2 * ax), peak: c.peak, reach: 2.6 * c.radiusM * st };
  });
  const clears = spec.clear.map((c) => ({ ...c, ca: Math.cos(c.axisRad), sa: Math.sin(c.axisRad) }));

  for (let j = 0; j < nz; j++) {
    const z = z0 + (j + 0.5) * R;
    const sx = shoreX[j]!;
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * R;
      const o = j * nx + i;
      const dShore = x - sx;
      // Border texels stay empty, so clamped sampling outside the field reads U = 0.
      const edge = i === 0 || j === 0 || i === nx - 1 || j === nz - 1;
      let U = 0;
      let vc = 0.25 * Math.cos(2 * Math.PI * vnoise(x / 6000, z / 6000, seed + 11));
      let vs = 0.25 * Math.sin(2 * Math.PI * vnoise(x / 6000, z / 6000, seed + 11));
      if (!edge && dShore > 20) {
        let e = -1e9;
        for (let k = 0; k < est.length; k++) e = Math.max(e, estuaryField(estPk, k * ESTUARY_FLOATS, x, z));
        // Cores.
        let notK = 1;
        for (const c of cores) {
          const dx = x - c.x;
          const dz = z - c.z;
          if (Math.abs(dx) > c.reach || Math.abs(dz) > c.reach) continue;
          const u = (dx * c.ca + dz * c.sa) / c.ra;
          const v = (-dx * c.sa + dz * c.ca) / c.rc;
          const k = c.peak * Math.exp(-1.1 * (u * u + v * v));
          notK *= 1 - k;
          vc += 3 * k * c.c2;
          vs += 3 * k * c.s2;
        }
        // Ribbons along the roads, stronger in some stretches than others.
        const rd = roadD[o]!;
        const rib = rd < 1e8 ? spec.ribbonU * Math.exp(-((rd / spec.ribbonM) ** 2)) * (0.35 + 0.65 * vnoise(x / 5000, z / 5000, seed + 3)) : 0;
        if (rd < REACH) {
          const w = 1.5 * Math.exp(-((rd / 600) ** 2));
          vc += w * Math.cos(2 * roadA[o]!);
          vs += w * Math.sin(2 * roadA[o]!);
        }
        // Along the coast, streets follow the shore.
        const wc = 1.2 * Math.exp(-((dShore / 1500) ** 2));
        vc += wc * Math.cos(2 * shoreAng[j]!);
        vs += wc * Math.sin(2 * shoreAng[j]!);
        // Hamlets: patchy, over the lowland.
        // (Denser in the coastal lowland, thinning towards the Ghats.)
        const lowland = 0.45 + 0.55 * (1 - sstep(8000, 22000, dShore));
        const ham = spec.hamletU * lowland * sstep(0.48, 0.76, fbm(x / spec.hamletScaleM, z / spec.hamletScaleM, seed + 5)) + spec.baseU;
        U = 1 - notK * (1 - rib) * (1 - ham);
        // Cut back: beaches and estuary banks, high or steep ground, tidal paddies, airfields.
        U *= sstep(70, 260, dShore) * sstep(15, 120, -e);
        const h = grid(H, x, z);
        const slope = grid(SL, x, z);
        U *= 1 - sstep(spec.maxElevM - 60, spec.maxElevM, h);
        U *= 1 - sstep(spec.maxSlope * 0.55, spec.maxSlope, slope);
        if (e > -3000) U *= 0.25 + 0.75 * sstep(2, 6, h);
        for (const c of clears) {
          const dx = x - c.x;
          const dz = z - c.z;
          const out = Math.max(Math.abs(dx * c.ca + dz * c.sa) - c.halfLenM, Math.abs(-dx * c.sa + dz * c.ca) - c.halfWidM);
          U *= sstep(0, 250, out);
        }
      }
      const sd = roadD[o]! < 1e8 ? roadS[o]! * roadD[o]! : URBAN_SDF_RANGE_M;
      const vl = Math.hypot(vc, vs) || 1;
      data[o * 4] = Math.round(Math.max(0, Math.min(1, U)) * 255);
      data[o * 4 + 1] = Math.round((0.5 + (0.5 * vc) / vl) * 255);
      data[o * 4 + 2] = Math.round((0.5 + (0.5 * vs) / vl) * 255);
      data[o * 4 + 3] = edge ? 255 : Math.round(Math.max(0, Math.min(255, 128 + (sd * 127) / URBAN_SDF_RANGE_M)));
    }
  }
  return { originX: x0, originZ: z0, resM: R, nx, nz, seed: (seed >>> 0) & 0x7fffffff, data };
}
