/**
 * src/terrain/chunkGeometryBuilder.ts — builds one chunk's positions/normals/indices
 * (module 04). Grid + skirt layout and triangle winding: docs/spec/04-terrain.md
 * section 4.7.
 */
import type { Vec3Like, HeightSampler } from '../contracts/core';
import type { ChunkKey, ChunkGeometry, BuildChunkGeometry, ChunkBounds } from '../contracts/terrain';
import { chunkKeyToBounds, chunkSizeAtDepth, skirtDepthM } from './quadtree';

function idx(i: number, j: number, res: number): number {
  return j * (res + 1) + i;
}

/**
 * Samples `sampler.heightAt`/`normalAt` over a (gridQuads+1)x(gridQuads+1) grid
 * covering `key`'s world-space AABB, plus a skirt ring. Allocates its 3 typed
 * arrays fresh each call (not a hot-path violation — see 04-terrain.md section 6:
 * this runs only in terrain.worker.ts on new-chunk events).
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

  const normalScratch: Vec3Like = { x: 0, y: 0, z: 0 };

  // --- main (interior) grid vertices, absolute world coordinates ---
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const x = bounds.minX + i * step;
      const z = bounds.minZ + j * step;
      const y = sampler.heightAt(x, z);
      sampler.normalAt(x, z, normalScratch);
      const v = idx(i, j, res) * 3;
      positions[v] = x;
      positions[v + 1] = y;
      positions[v + 2] = z;
      normals[v] = normalScratch.x;
      normals[v + 1] = normalScratch.y;
      normals[v + 2] = normalScratch.z;
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
