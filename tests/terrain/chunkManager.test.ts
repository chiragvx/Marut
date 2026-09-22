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
