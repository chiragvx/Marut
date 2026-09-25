/**
 * src/terrain/chunkGeometryBuilder.ts — builds one chunk's positions/normals/indices
 * (module 04). Grid + skirt layout and triangle winding: docs/spec/04-terrain.md
 * section 4.7.
 */
import type { HeightSampler } from '../contracts/core';
import type { ChunkKey, ChunkGeometry, BuildChunkGeometry, ChunkBounds } from '../contracts/terrain';
import { chunkKeyToBounds, chunkSizeAtDepth, skirtDepthM } from './quadtree';

function idx(i: number, j: number, res: number): number {
  return j * (res + 1) + i;
}

/** World-scale radius of the valley-occlusion estimate. Fixed (not the grid step) so a vertex's shading does not change when its chunk changes LOD. */
export const OCCLUSION_RADIUS_M = 300;
/** Occlusion per unit of (mean ring height - height) / radius, and its floor. */
const OCCLUSION_GAIN = 1.6;
const OCCLUSION_MIN = 0.45;
/** Water depth encoded into the normal length saturates at this depth. */
export const WATER_DEPTH_ENCODE_MAX_M = 30;

/**
 * Samples `sampler.heightAt` over a (gridQuads+1)x(gridQuads+1) grid covering `key`'s world-space
 * AABB (plus a one-cell border for the edge normals), plus a skirt ring. Allocates its typed arrays
 * fresh each call (not a hot-path violation — see 04-terrain.md section 6: this runs only in
 * terrain.worker.ts on new-chunk events).
 *
 * NORMALS CARRY TWO EXTRA VALUES IN THEIR LENGTH (no extra vertex attribute, so no extra VRAM):
 * - Land vertices: length = sky occlusion in [OCCLUSION_MIN, 1]. It is estimated from how far the
 *   mean height on a ring of radius OCCLUSION_RADIUS_M rises above the vertex, so valley floors
 *   and gullies are darker than open slopes and ridges.
 * - Water vertices (at the sampler's water level): length = 1 + depth / WATER_DEPTH_ENCODE_MAX_M,
 *   the water depth to the seabed or riverbed, used for shallow-water colour and shore foam.
 * The shader normalises the direction and decodes the length (src/render/terrainMaterial.ts).
 *
 * Direction is the central difference of the grid heights themselves, so shading matches the
 * rendered surface at every LOD. Previously it was the analytic normal from 1 m samples, which
 * picked up noise far finer than the grid and shimmered between vertices.
 */
export const buildChunkGeometry: BuildChunkGeometry = (
  sampler: HeightSampler,
  key: ChunkKey,
  gridQuads: number
): ChunkGeometry => {
  const res = gridQuads;
  const bounds: ChunkBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, minY: 0, maxY: 0 };
  chunkKeyToBounds(key, bounds);
  const step = (bounds.maxX - bounds.minX) / res;

  const mainVertCount = (res + 1) * (res + 1);
  const skirtVertCount = 4 * (res + 1);
  const vertexCount = mainVertCount + skirtVertCount;
  const interiorIdxCount = res * res * 6;
  const skirtIdxCount = 24 * res;
  const indexCount = interiorIdxCount + skirtIdxCount;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);

  // Heights on the grid plus a one-cell border, row-major, (res+3) per row.
  const bw = res + 3;
  const heights = new Float64Array(bw * bw);
  for (let j = -1; j <= res + 1; j++) {
    for (let i = -1; i <= res + 1; i++) {
      heights[(j + 1) * bw + (i + 1)] = sampler.heightAt(bounds.minX + i * step, bounds.minZ + j * step);
    }
  }
  const waterLevelM = sampler.waterLevelM;
  const r = OCCLUSION_RADIUS_M;

  // --- main (interior) grid vertices, absolute world coordinates ---
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const x = bounds.minX + i * step;
      const z = bounds.minZ + j * step;
      const c = (j + 1) * bw + (i + 1);
      const y = heights[c]!;
      const dHdx = (heights[c + 1]! - heights[c - 1]!) / (2 * step);
      const dHdz = (heights[c + bw]! - heights[c - bw]!) / (2 * step);
      const inv = 1 / Math.sqrt(dHdx * dHdx + 1 + dHdz * dHdz);

      let len: number;
      if (waterLevelM !== undefined && y <= waterLevelM && sampler.groundHeightAt) {
        const depth = waterLevelM - sampler.groundHeightAt(x, z);
        len = 1 + Math.min(Math.max(depth, 0), WATER_DEPTH_ENCODE_MAX_M) / WATER_DEPTH_ENCODE_MAX_M;
      } else {
        const ring = (sampler.heightAt(x + r, z) + sampler.heightAt(x - r, z) + sampler.heightAt(x, z + r) + sampler.heightAt(x, z - r)) * 0.25;
        const occ = 1 - (OCCLUSION_GAIN * (ring - y)) / r;
        len = occ < OCCLUSION_MIN ? OCCLUSION_MIN : occ > 1 ? 1 : occ;
      }

      const v = idx(i, j, res) * 3;
      positions[v] = x;
      positions[v + 1] = y;
      positions[v + 2] = z;
      normals[v] = -dHdx * inv * len;
      normals[v + 1] = inv * len;
      normals[v + 2] = -dHdz * inv * len;
    }
  }

  // --- main grid triangles: T1=(A,C,B) T2=(B,C,D) per (i,j) quad, both up-facing ---
  let ii = 0;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = idx(i, j, res);
      const b = idx(i + 1, j, res);
      const c = idx(i, j + 1, res);
      const d = idx(i + 1, j + 1, res);
      indices[ii++] = a;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = d;
    }
  }

  // --- skirts: north(j=0), south(j=res), west(i=0), east(i=res), each res+1 vertices ---
  const depthM = skirtDepthM(chunkSizeAtDepth(key.depth));
  const SKIRT_BASE = mainVertCount;
  const edgeBase: readonly number[] = [SKIRT_BASE, SKIRT_BASE + (res + 1), SKIRT_BASE + 2 * (res + 1), SKIRT_BASE + 3 * (res + 1)];
  const edgeMainIndexFn: readonly ((k: number) => number)[] = [
    (k: number) => idx(k, 0, res),
    (k: number) => idx(k, res, res),
    (k: number) => idx(0, k, res),
    (k: number) => idx(res, k, res),
  ];

  for (let e = 0; e < 4; e++) {
    const base = edgeBase[e]!;
    const mainIdxFn = edgeMainIndexFn[e]!;
    for (let k = 0; k <= res; k++) {
      const mv = mainIdxFn(k) * 3;
      const sv = (base + k) * 3;
      positions[sv] = positions[mv]!;
      positions[sv + 1] = positions[mv + 1]! - depthM;
      positions[sv + 2] = positions[mv + 2]!;
      // Skirts reuse the mirrored main-edge vertex's normal (section 4.6) — no
      // separate outward-facing normal is computed for the curtain.
      normals[sv] = normals[mv]!;
      normals[sv + 1] = normals[mv + 1]!;
      normals[sv + 2] = normals[mv + 2]!;
    }
  }

  // --- skirt triangles: same up-facing-pattern as the main grid, applied to the
  //     2x(res+1) strip formed by each edge's main row and its skirt row ---
  for (let e = 0; e < 4; e++) {
    const base = edgeBase[e]!;
    const mainIdxFn = edgeMainIndexFn[e]!;
    for (let k = 0; k < res; k++) {
      const m0 = mainIdxFn(k);
      const m1 = mainIdxFn(k + 1);
      const s0 = base + k;
      const s1 = base + k + 1;
      indices[ii++] = m0;
      indices[ii++] = s0;
      indices[ii++] = m1;
      indices[ii++] = m1;
      indices[ii++] = s0;
      indices[ii++] = s1;
    }
  }

  return { positions, normals, indices, vertexCount, indexCount };
};
