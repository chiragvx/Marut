/**
 * src/terrain/quadtree.ts — chunk quadtree addressing and LOD selection (module 04).
 * Algorithms: docs/spec/04-terrain.md sections 4.1, 4.6, 4.8.
 */
import type { Vec3Like } from '../contracts/core';
import type {
  ChunkKey,
  ChunkBounds,
  ChunkSizeAtDepth,
  ChunkKeyToBounds,
  ChunkChildren,
  ChunkParent,
  ChunkKeyToString,
  ComputeDesiredChunks,
  WasChunkSplitLastFrame,
  QualityTerrainProfile,
  SkirtDepthM,
  TerrainParams,
} from '../contracts/terrain';
import {
  TERRAIN_WORLD_EXTENT_M,
  TERRAIN_WORLD_HALF_EXTENT_M,
  TERRAIN_MIN_HEIGHT_M,
  TERRAIN_MAX_HEIGHT_M,
  REFERENCE_CHUNK_SIZE_M,
  LOD_SPLIT_DISTANCE_FACTOR,
  LOD_MERGE_DISTANCE_FACTOR,
  MAX_QUADTREE_DEPTH,
  SKIRT_DEPTH_FRACTION,
  SKIRT_DEPTH_MIN_M,
  SKIRT_DEPTH_MAX_M,
} from '../contracts/terrain';

export const chunkSizeAtDepth: ChunkSizeAtDepth = (depth: number): number => TERRAIN_WORLD_EXTENT_M / Math.pow(2, depth);

export const chunkKeyToBounds: ChunkKeyToBounds = (key: ChunkKey, out: ChunkBounds, heightBoundsM?: TerrainParams['heightBoundsM']): ChunkBounds => {
  const size = chunkSizeAtDepth(key.depth);
  out.minX = -TERRAIN_WORLD_HALF_EXTENT_M + key.cx * size;
  out.maxX = out.minX + size;
  out.minZ = -TERRAIN_WORLD_HALF_EXTENT_M + key.cz * size;
  out.maxZ = out.minZ + size;
  out.minY = heightBoundsM ? heightBoundsM.minM : TERRAIN_MIN_HEIGHT_M;
  out.maxY = heightBoundsM ? heightBoundsM.maxM : TERRAIN_MAX_HEIGHT_M;
  return out;
};

/** Child order: [0]=(2cx,2cz) [1]=(2cx+1,2cz) [2]=(2cx,2cz+1) [3]=(2cx+1,2cz+1). */
export const chunkChildren: ChunkChildren = (key: ChunkKey, out: [ChunkKey, ChunkKey, ChunkKey, ChunkKey]): void => {
  const d = key.depth + 1;
  const cx = key.cx * 2;
  const cz = key.cz * 2;
  out[0] = { depth: d, cx, cz };
  out[1] = { depth: d, cx: cx + 1, cz };
  out[2] = { depth: d, cx, cz: cz + 1 };
  out[3] = { depth: d, cx: cx + 1, cz: cz + 1 };
};

export const chunkParent: ChunkParent = (key: ChunkKey): ChunkKey | undefined => {
  if (key.depth === 0) return undefined;
  return { depth: key.depth - 1, cx: Math.floor(key.cx / 2), cz: Math.floor(key.cz / 2) };
};

export const chunkKeyToString: ChunkKeyToString = (key: ChunkKey): string => `${key.depth}/${key.cx}/${key.cz}`;

export const skirtDepthM: SkirtDepthM = (chunkSizeM: number): number => {
  const d = chunkSizeM * SKIRT_DEPTH_FRACTION;
  return d < SKIRT_DEPTH_MIN_M ? SKIRT_DEPTH_MIN_M : d > SKIRT_DEPTH_MAX_M ? SKIRT_DEPTH_MAX_M : d;
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Full 3D distance from `cam` to the nearest point on `b`'s AABB. Exported for reuse by chunkManager.ts (nearest-to-camera request ordering / eviction). */
export function distanceToChunk(cam: Vec3Like, b: ChunkBounds): number {
  const cx = clamp(cam.x, b.minX, b.maxX);
  const cy = clamp(cam.y, b.minY, b.maxY);
  const cz = clamp(cam.z, b.minZ, b.maxZ);
  const dx = cam.x - cx;
  const dy = cam.y - cy;
  const dz = cam.z - cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Allocation-free steady state: one scratch ChunkBounds reused across the whole
// recursion (only needed transiently to compute `dist`, never held across a
// recursive call), and one 4-tuple children scratch PER DEPTH LEVEL (0..MAX_QUADTREE_DEPTH),
// since sibling recursive calls at the same depth run sequentially (depth-first)
// but nested calls at depth+1 must not alias the parent depth's in-use tuple.
const scratchBounds: ChunkBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, minY: 0, maxY: 0 };
const childrenScratchByDepth: [ChunkKey, ChunkKey, ChunkKey, ChunkKey][] = [];
for (let d = 0; d <= MAX_QUADTREE_DEPTH; d++) {
  childrenScratchByDepth.push([
    { depth: 0, cx: 0, cz: 0 },
    { depth: 0, cx: 0, cz: 0 },
    { depth: 0, cx: 0, cz: 0 },
    { depth: 0, cx: 0, cz: 0 },
  ]);
}

/** Pure (given `wasSplitLastFrame`), allocation-free-in-steady-state recursive quadtree LOD selection. See docs/spec/04-terrain.md section 4.8. */
export const computeDesiredChunks: ComputeDesiredChunks = (
  cameraWorldPos: Vec3Like,
  profile: QualityTerrainProfile,
  wasSplitLastFrame: WasChunkSplitLastFrame,
  out: ChunkKey[],
  heightBoundsM?: TerrainParams['heightBoundsM']
): void => {
  out.length = 0;
  const streamRadiusM = profile.streamRadiusChunks * REFERENCE_CHUNK_SIZE_M;

  function recurse(key: ChunkKey): void {
    const size = chunkSizeAtDepth(key.depth);
    const bounds = chunkKeyToBounds(key, scratchBounds, heightBoundsM);
    const dist = distanceToChunk(cameraWorldPos, bounds);
    if (dist > streamRadiusM + size * 0.75) return; // prune: entirely (with margin) outside draw distance
    const factor = wasSplitLastFrame(key) ? LOD_MERGE_DISTANCE_FACTOR : LOD_SPLIT_DISTANCE_FACTOR;
    if (key.depth < profile.maxLodDepth && dist < factor * size) {
      const children = childrenScratchByDepth[key.depth]!;
      chunkChildren(key, children);
      for (const child of children) recurse(child);
    } else {
      out.push(key);
    }
  }

  recurse({ depth: 0, cx: 0, cz: 0 });
};
