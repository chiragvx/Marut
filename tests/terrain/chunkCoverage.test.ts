/**
 * tests/terrain/chunkCoverage.test.ts — the displayed terrain never opens a hole.
 *
 * Regression for "terrain vanishes in small segments for a split second, then reappears" (Himalaya):
 * the chunk manager used to evict a chunk the moment it left the desired set — a parent the frame
 * its children were first requested, children the frame their parent was — so the ground there was
 * missing until the worker built the replacement. Here a simulated worker answers a few requests
 * per frame (as the real one does) while the camera flies, and at every update the set of chunks
 * the renderer has been handed (onChunkReady minus onChunkEvicted) must
 *  - never overlap itself (no two displayed chunks cover the same ground), and
 *  - never uncover ground inside the streamed area that was displayed the frame before.
 */
import { describe, it, expect } from 'vitest';
import { createChunkManager, terrainProfileFor } from '../../src/terrain';
import { chunkKeyToBounds, distanceToChunk } from '../../src/terrain/quadtree';
import { DEFAULT_TERRAIN_PARAMS, MAX_QUADTREE_DEPTH, REFERENCE_CHUNK_SIZE_M, THEATRE_TERRAIN_PARAMS } from '../../src/contracts/terrain';
import type { ChunkBounds, ChunkKey, TerrainParams } from '../../src/contracts/terrain';
import type { QualityTier, TerrainRequestChunkMessage } from '../../src/contracts/core';

const hash = (k: ChunkKey): number => k.depth * 1_000_000 + k.cx * 1000 + k.cz;
const bounds: ChunkBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, minY: 0, maxY: 0 };

function coveredBy(set: Set<number>, key: ChunkKey): boolean {
  for (let d = key.depth; d >= 0; d--) {
    const s = key.depth - d;
    if (set.has(hash({ depth: d, cx: key.cx >> s, cz: key.cz >> s }))) return true;
  }
  return false;
}

/** Ground (m^2) inside `radiusM` of the camera shown by `prev` but by nothing in `cur`. */
function lostArea(prev: Set<number>, cur: Set<number>, cam: { x: number; y: number; z: number }, radiusM: number, key: ChunkKey = { depth: 0, cx: 0, cz: 0 }): number {
  chunkKeyToBounds(key, bounds);
  const size = bounds.maxX - bounds.minX;
  const flat = { x: cam.x, y: 0, z: cam.z };
  bounds.minY = 0;
  bounds.maxY = 0;
  if (distanceToChunk(flat, bounds) > radiusM) return 0;
  if (coveredBy(cur, key)) return 0;
  if (key.depth >= MAX_QUADTREE_DEPTH) {
    // Finest cell: counts when it was shown before and its centre lies inside the radius.
    const cx = (bounds.minX + bounds.maxX) / 2 - cam.x;
    const cz = (bounds.minZ + bounds.maxZ) / 2 - cam.z;
    return coveredBy(prev, key) && Math.hypot(cx, cz) < radiusM ? size * size : 0;
  }
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    sum += lostArea(prev, cur, cam, radiusM, { depth: key.depth + 1, cx: key.cx * 2 + (i & 1), cz: key.cz * 2 + (i >> 1) });
  }
  return sum;
}

/** Each displayed chunk's ancestors must not be displayed too. */
function overlaps(cur: Set<number>, keys: Map<number, ChunkKey>): number {
  let n = 0;
  for (const k of keys.values()) {
    for (let d = k.depth - 1; d >= 0; d--) {
      const s = k.depth - d;
      if (cur.has(hash({ depth: d, cx: k.cx >> s, cz: k.cz >> s }))) n++;
    }
  }
  return n;
}

interface Flight {
  params: TerrainParams;
  tier: QualityTier;
  /** Chunks the simulated worker finishes per frame. */
  buildsPerFrame: number;
  speedMps: number;
  y: number;
  frames: number;
}

function fly(f: Flight): { gapFrames: number; lostM2: number; overlapFrames: number; displayed: number } {
  const queue: TerrainRequestChunkMessage[] = [];
  const manager = createChunkManager({ qualityTier: f.tier, terrainParams: f.params, flattenZones: [] }, (msg) => {
    if (msg.type === 'requestChunk') queue.push(msg);
  });
  const shown = new Set<number>();
  const shownKeys = new Map<number, ChunkKey>();
  manager.onChunkReady((c) => {
    const h = hash(c.key);
    expect(shown.has(h)).toBe(false);
    shown.add(h);
    shownKeys.set(h, c.key);
  });
  manager.onChunkEvicted((k) => {
    const h = hash(k);
    expect(shown.has(h)).toBe(true);
    shown.delete(h);
    shownKeys.delete(h);
  });
  manager.handleTerrainWorkerMessage({ type: 'terrainReady' });
  const buildOne = (): void => {
    const req = queue.shift()!;
    const empty = { positions: new Float32Array(3).buffer, normals: new Float32Array(3).buffer, indices: new Uint32Array(3).buffer };
    manager.handleTerrainWorkerMessage({ type: 'chunkReady', requestId: req.requestId, chunkX: req.chunkX, chunkZ: req.chunkZ, lod: req.lod, ...empty });
  };

  const cam = { x: 34_600, y: f.y, z: 34_000 };
  // Load fully first (the loading screen).
  for (let i = 0; i < 2000; i++) {
    manager.update(cam, f.tier);
    while (queue.length) buildOne();
    const p = manager.loadProgress();
    if (p.resident === p.desired) break;
  }
  const radiusM = terrainProfileFor(f.tier, f.params).streamRadiusChunks * REFERENCE_CHUNK_SIZE_M - 2000;
  let prev = new Set(shown);
  let gapFrames = 0;
  let lostM2 = 0;
  let overlapFrames = 0;
  const dt = 1 / 60;
  for (let frame = 0; frame < f.frames; frame++) {
    // A gentle turn so the camera crosses chunk edges both ways.
    const hdg = frame * dt * 0.05;
    cam.x += Math.sin(hdg) * f.speedMps * dt;
    cam.z -= Math.cos(hdg) * f.speedMps * dt;
    manager.update(cam, f.tier);
    for (let b = 0; b < f.buildsPerFrame && queue.length; b++) buildOne();
    const lost = lostArea(prev, shown, cam, radiusM);
    if (lost > 0) gapFrames++;
    lostM2 += lost;
    if (overlaps(shown, shownKeys) > 0) overlapFrames++;
    prev = new Set(shown);
  }
  // Stop and let the worker catch up: the chunks kept on screen during swaps must all go, leaving
  // exactly the desired set displayed.
  for (let i = 0; i < 4000; i++) {
    manager.update(cam, f.tier);
    if (!queue.length) break;
    while (queue.length) buildOne();
  }
  manager.update(cam, f.tier);
  expect(shown.size).toBe(manager.loadProgress().desired);
  expect(manager.loadProgress().resident).toBe(manager.loadProgress().desired);
  expect(overlaps(shown, shownKeys)).toBe(0);
  return { gapFrames, lostM2, overlapFrames, displayed: shown.size };
}

describe('ChunkManager — displayed chunks tile the streamed area with no gaps', () => {
  it('Himalaya ultra, low and fast, slow worker: no frame uncovers ground or double-draws it', () => {
    const r = fly({ params: THEATRE_TERRAIN_PARAMS.himalaya, tier: 'ultra', buildsPerFrame: 2, speedMps: 300, y: 4500, frames: 900 });
    expect(r.gapFrames).toBe(0);
    expect(r.overlapFrames).toBe(0);
    expect(r.displayed).toBeGreaterThan(0);
  });

  it('Himalaya high, worker one chunk per frame', () => {
    const r = fly({ params: THEATRE_TERRAIN_PARAMS.himalaya, tier: 'high', buildsPerFrame: 1, speedMps: 250, y: 6000, frames: 900 });
    expect(r.gapFrames).toBe(0);
    expect(r.overlapFrames).toBe(0);
  });

  it('Default terrain, medium', () => {
    const r = fly({ params: DEFAULT_TERRAIN_PARAMS, tier: 'medium', buildsPerFrame: 3, speedMps: 250, y: 1500, frames: 600 });
    expect(r.gapFrames).toBe(0);
    expect(r.overlapFrames).toBe(0);
  });
});
