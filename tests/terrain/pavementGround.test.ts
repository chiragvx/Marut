/**
 * tests/terrain/pavementGround.test.ts — the ground never rises through an airfield's pavement.
 *
 * Pavement is drawn 4 cm above its layout elevation with no depth write (src/airport/
 * pavementGeometry.ts, src/render/airfieldPavement.ts): wherever the terrain mesh under it is any
 * higher, the ground hides it, and at grazing angles it flickers in and out. The height sampler is
 * exact on a pad, but a coarse LOD triangle spanning the pad's edge used to be interpolated metres
 * above it (Ngari and Simikot), so the chunk builder holds vertices near flatten zones down
 * (HeightSampler.airfieldFloorNear). Checked under every point of every runway, taxiway (with its
 * round joins) and apron of the Himalaya fields and of Bhisiana, at every LOD depth and tier grid.
 */
import { describe, expect, test } from 'vitest';
import type { AirportLayout } from '../../src/contracts/airport';
import { type TerrainParams, TERRAIN_QUALITY_PROFILES, TERRAIN_WORLD_HALF_EXTENT_M, TERRAIN_WORLD_EXTENT_M } from '../../src/contracts/terrain';
import { createHeightSampler, buildChunkGeometryAndSurface } from '../../src/terrain';
import { resolveBuiltinMission } from '../../src/core';

/** Points ~4 m apart over a layout's runways, taxiways (segments and their round joins) and aprons. */
function pavementPoints(L: AirportLayout): [number, number][] {
  const out: [number, number][] = [];
  const strip = (ax: number, az: number, bx: number, bz: number, hw: number): void => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / 4));
    const m = Math.max(1, Math.ceil((2 * hw) / 4));
    const lx = len > 0 ? -(bz - az) / len : 1;
    const lz = len > 0 ? (bx - ax) / len : 0;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= m; j++) {
        const c = -hw + (2 * hw * j) / m;
        out.push([ax + ((bx - ax) * i) / n + lx * c, az + ((bz - az) * i) / n + lz * c]);
      }
    }
  };
  for (const r of L.runways) {
    strip(r.thresholdWorldX, r.thresholdWorldZ, r.thresholdWorldX + Math.sin(r.headingRad) * r.lengthM, r.thresholdWorldZ - Math.cos(r.headingRad) * r.lengthM, r.widthM / 2);
  }
  for (const t of L.taxiways) {
    const hw = t.widthM / 2;
    for (let i = 0; i + 1 < t.points.length; i++) strip(t.points[i]!.worldX, t.points[i]!.worldZ, t.points[i + 1]!.worldX, t.points[i + 1]!.worldZ, hw);
    for (const p of t.points) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        out.push([p.worldX + Math.cos(a) * hw, p.worldZ + Math.sin(a) * hw]);
      }
    }
  }
  for (const a of L.aprons) {
    const P = a.points;
    const xs = P.map((p) => p.worldX);
    const zs = P.map((p) => p.worldZ);
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 4) {
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += 4) {
        let inside = false;
        for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
          const pi = P[i]!;
          const pj = P[j]!;
          if (pi.worldZ > z !== pj.worldZ > z && x < ((pj.worldX - pi.worldX) * (z - pi.worldZ)) / (pj.worldZ - pi.worldZ) + pi.worldX) inside = !inside;
        }
        if (inside) out.push([x, z]);
      }
    }
    for (const p of P) out.push([p.worldX, p.worldZ]);
  }
  return out;
}

const CASES: readonly [string, readonly string[]][] = [
  ['himalaya-free', ['fukche-alg', 'ngari-gunsa', 'simikot']],
  ['border-defence', ['bhisiana-afs']],
];
const GRIDS = [...new Set(Object.values(TERRAIN_QUALITY_PROFILES).map((p) => p.chunkGridQuads))];
const DEPTHS = [2, 3, 4, 5, 6, 7, 8];
/** Rounding allowance, m (the pavement itself is 4 cm up). */
const EPS = 0.005;

describe('ground under pavement', () => {
  for (const [missionId, ids] of CASES) {
    const m = resolveBuiltinMission(missionId as never);
    const layouts = m.world.airports as AirportLayout[];
    const sampler = createHeightSampler(m.world.terrain as TerrainParams, layouts.flatMap((l) => l.flattenZones));
    for (const id of ids) {
      test(`${id}: sampler and every LOD's mesh stay at or below the pavement`, () => {
        const L = layouts.find((l) => l.id === id);
        expect(L, id).toBeDefined();
        const pts = pavementPoints(L!);
        let worst = -Infinity;
        for (const [x, z] of pts) worst = Math.max(worst, sampler.heightAt(x, z) - L!.elevationM);
        expect(worst, `${id} sampler`).toBeLessThanOrEqual(EPS);
        for (const grid of GRIDS) {
          for (const depth of DEPTHS) {
            const size = TERRAIN_WORLD_EXTENT_M / 2 ** depth;
            const chunks = new Map<string, (x: number, z: number) => number>();
            let w = -Infinity;
            for (const [x, z] of pts) {
              const cx = Math.floor((x + TERRAIN_WORLD_HALF_EXTENT_M) / size);
              const cz = Math.floor((z + TERRAIN_WORLD_HALF_EXTENT_M) / size);
              const k = `${cx},${cz}`;
              let f = chunks.get(k);
              if (!f) {
                f = buildChunkGeometryAndSurface(sampler, { depth, cx, cz }, grid).surface;
                chunks.set(k, f);
              }
              w = Math.max(w, f(x, z) - L!.elevationM);
            }
            expect(w, `${id} depth ${depth} grid ${grid}`).toBeLessThanOrEqual(EPS);
          }
        }
      }, 60_000);
    }
  }
});
