import { describe, it, expect } from 'vitest';
import { createChunkManager } from '../../src/terrain';
import { DEFAULT_TERRAIN_PARAMS } from '../../src/contracts/terrain';
import type { MainToTerrainMessage, TerrainRequestChunkMessage } from '../../src/contracts/core';
import type { MainToTerrainMessageExt, ResidentChunkInfo, ChunkKey } from '../../src/contracts/terrain';

function isRequestChunk(msg: MainToTerrainMessage | MainToTerrainMessageExt): msg is TerrainRequestChunkMessage {
  return msg.type === 'requestChunk';
}

describe('ChunkManager — buffers requests until terrainReady', () => {
  it('sends terrainInit at construction, zero requestChunk before terrainReady, then flushes exactly the desired set', () => {
    const sent: (MainToTerrainMessage | MainToTerrainMessageExt)[] = [];
    const manager = createChunkManager(
      { qualityTier: 'low', terrainParams: DEFAULT_TERRAIN_PARAMS, flattenZones: [] },
      (msg) => sent.push(msg)
    );

    expect(sent.length).toBe(1);
    expect(sent[0]!.type).toBe('terrainInit');

    manager.update({ x: 0, y: 2000, z: 0 }, 'low');
    expect(sent.filter(isRequestChunk).length).toBe(0);

    manager.handleTerrainWorkerMessage({ type: 'terrainReady' });
    // Low @ (0,2000,0) cold start = 4 desired chunks (see quadtree.test.ts), all
    // within MAX_REQUESTS_PER_UPDATE (4), so all 4 flush in this one call.
    expect(sent.filter(isRequestChunk).length).toBe(4);
  });
});

describe('ChunkManager — onChunkReady / onChunkEvicted', () => {
  it('fires onChunkReady exactly once for a matching chunkReady, evicts on the next update, and drops a stale chunkReady afterward', () => {
    const sent: (MainToTerrainMessage | MainToTerrainMessageExt)[] = [];
    const manager = createChunkManager(
      { qualityTier: 'low', terrainParams: DEFAULT_TERRAIN_PARAMS, flattenZones: [] },
      (msg) => sent.push(msg)
    );
    manager.update({ x: 0, y: 2000, z: 0 }, 'low');
    manager.handleTerrainWorkerMessage({ type: 'terrainReady' });

    const requests = sent.filter(isRequestChunk);
    expect(requests.length).toBeGreaterThan(0);
    const first = requests[0]!;

    let readyCount = 0;
    let readyKey: ChunkKey | undefined;
    manager.onChunkReady((chunk: ResidentChunkInfo) => {
      readyCount++;
      readyKey = chunk.key;
    });

    manager.handleTerrainWorkerMessage({
      type: 'chunkReady',
      requestId: first.requestId,
      chunkX: first.chunkX,
      chunkZ: first.chunkZ,
      lod: first.lod,
      positions: new Float32Array(3).buffer,
      normals: new Float32Array(3).buffer,
      indices: new Uint32Array(3).buffer,
    });
    expect(readyCount).toBe(1);
    expect(readyKey).toEqual({ depth: first.lod, cx: first.chunkX, cz: first.chunkZ });

    let evictedCount = 0;
    let evictedKey: ChunkKey | undefined;
    manager.onChunkEvicted((key: ChunkKey) => {
      evictedCount++;
      evictedKey = key;
    });

    // Camera moves far outside the resident chunk's draw distance.
    manager.update({ x: 500000, y: 500000, z: 500000 }, 'low');
    expect(evictedCount).toBe(1);
    expect(evictedKey).toEqual(readyKey);

    manager.handleTerrainWorkerMessage({
      type: 'chunkReady',
      requestId: first.requestId,
      chunkX: first.chunkX,
      chunkZ: first.chunkZ,
      lod: first.lod,
      positions: new Float32Array(3).buffer,
      normals: new Float32Array(3).buffer,
      indices: new Uint32Array(3).buffer,
    });
    expect(readyCount).toBe(1); // unchanged: stale requestId silently dropped
  });
});

describe('ChunkManager — repeated update() calls while streaming (regression)', () => {
  it('stays correct across many consecutive frames of a moving camera: every request eventually resolves to exactly one onChunkReady, a steady (unmoving) camera fires no further eviction/ready churn, and resident chunks form a partition matching the desired set', () => {
    const sent: (MainToTerrainMessage | MainToTerrainMessageExt)[] = [];
    const manager = createChunkManager(
      { qualityTier: 'ultra', terrainParams: DEFAULT_TERRAIN_PARAMS, flattenZones: [] },
      (msg) => sent.push(msg)
    );
    manager.handleTerrainWorkerMessage({ type: 'terrainReady' });

    let readyCount = 0;
    let evictedCount = 0;
    const readyKeys = new Set<string>();
    manager.onChunkReady((chunk: ResidentChunkInfo) => {
      readyCount++;
      const ks = `${chunk.key.depth}/${chunk.key.cx}/${chunk.key.cz}`;
      // A chunk must never become resident twice without an eviction in between.
      expect(readyKeys.has(ks)).toBe(false);
      readyKeys.add(ks);
    });
    manager.onChunkEvicted((key: ChunkKey) => {
      evictedCount++;
      const ks = `${key.depth}/${key.cx}/${key.cz}`;
      expect(readyKeys.has(ks)).toBe(true);
      readyKeys.delete(ks);
    });

    // Simulate ~80 rendered frames of low-level terrain-hugging flight: the
    // camera sweeps across world X (a few chunk-widths per frame at ultra's
    // finest LOD) while altitude stays low, continuously changing the desired
    // set and keeping trySendRequests()/the split-ancestor walk busy — the
    // exact "active terrain streaming" scenario the finding described.
    let cursor = 0;
    for (let frame = 0; frame < 80; frame++) {
      const cameraPos = { x: cursor, y: 1500, z: 0 };
      manager.update(cameraPos, 'ultra');

      // Resolve every outstanding request immediately (as if the terrain
      // worker responded within the same frame) so the manager keeps making
      // forward progress and MAX_REQUESTS_PER_UPDATE doesn't stall the test.
      const pending = sent.splice(0, sent.length).filter(isRequestChunk);
      for (const req of pending) {
        manager.handleTerrainWorkerMessage({
          type: 'chunkReady',
          requestId: req.requestId,
          chunkX: req.chunkX,
          chunkZ: req.chunkZ,
          lod: req.lod,
          positions: new Float32Array(3).buffer,
          normals: new Float32Array(3).buffer,
          indices: new Uint32Array(3).buffer,
        });
      }
      cursor += 900;
    }

    expect(readyCount).toBeGreaterThan(0);
    expect(readyCount).toBe(readyKeys.size + evictedCount);

    // Resident set must exactly match what's currently marked ready-and-not-evicted.
    let resident = manager.getResidentChunks();
    let residentKeys = new Set(resident.map((r) => `${r.key.depth}/${r.key.cx}/${r.key.cz}`));
    expect(residentKeys).toEqual(readyKeys);

    // Hold the camera still and keep resolving requests until a full frame
    // produces zero new requestChunk messages (MAX_REQUESTS_PER_UPDATE caps
    // how many of ultra's ~124 chunks can be requested per call, so the
    // moving-camera phase above deliberately outruns that budget and leaves
    // a backlog — this "settle" phase is what a real session does once the
    // camera stops, before we can assert the steady-state invariant below).
    const stillCameraPos = { x: cursor - 900, y: 1500, z: 0 };
    let settleFrames = 0;
    for (; settleFrames < 100; settleFrames++) {
      manager.update(stillCameraPos, 'ultra');
      const pending = sent.splice(0, sent.length).filter(isRequestChunk);
      if (pending.length === 0) break;
      for (const req of pending) {
        manager.handleTerrainWorkerMessage({
          type: 'chunkReady',
          requestId: req.requestId,
          chunkX: req.chunkX,
          chunkZ: req.chunkZ,
          lod: req.lod,
          positions: new Float32Array(3).buffer,
          normals: new Float32Array(3).buffer,
          indices: new Uint32Array(3).buffer,
        });
      }
    }
    expect(settleFrames).toBeLessThan(100); // sanity: must actually have settled, not hit the iteration cap

    resident = manager.getResidentChunks();
    residentKeys = new Set(resident.map((r) => `${r.key.depth}/${r.key.cx}/${r.key.cz}`));
    expect(residentKeys).toEqual(readyKeys);

    // Now that the manager is fully settled: a steady (unmoving) camera must
    // not evict or re-ready anything on further frames — this is the exact
    // invariant contracts/terrain.ts's `ChunkManager.update()` doc promises
    // ("No allocation once the resident set has stabilised in steady state"),
    // and it depends on desired-set membership (now hash-based, not
    // string-based per this fix) staying exactly correct frame to frame.
    const readyBefore = readyCount;
    const evictedBefore = evictedCount;
    for (let frame = 0; frame < 10; frame++) {
      manager.update(stillCameraPos, 'ultra');
    }
    expect(readyCount).toBe(readyBefore);
    expect(evictedCount).toBe(evictedBefore);
    expect(sent.filter(isRequestChunk).length).toBe(0);
  });
});
