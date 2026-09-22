/**
 * src/terrain/terrain.worker.ts — terrain worker bootstrap (module 04).
 * Handles TerrainInitMessage / TerrainRequestChunkMessage / TerrainCancelMessage;
 * posts TerrainReadyMessage / TerrainChunkReadyMessage. See docs/spec/04-terrain.md
 * section 4.10. Compiled under tsconfig.worker.json (lib: WebWorker), per
 * 00-architecture.md section 13 — this is the one file in src/terrain allowed to
 * reference `self`/`postMessage`.
 */
import type { MainToTerrainMessage, TerrainChunkReadyMessage, HeightSampler } from '../contracts/core';
import type { MainToTerrainMessageExt, TerrainReadyMessage } from '../contracts/terrain';
import { TERRAIN_QUALITY_PROFILES } from '../contracts/terrain';
import { createHeightSampler } from './heightSampler';
import { buildChunkGeometry } from './chunkGeometryBuilder';

let sampler: HeightSampler | undefined;

// KNOWN CONTRACT GAP (see docs/spec/04-terrain.md section 4.10/9, and this
// module's return-value contractConcerns): TerrainRequestChunkMessage carries
// `lod` (quadtree depth) but neither it nor TerrainInitMessage carries the
// active quality tier's `chunkGridQuads`, so this worker cannot actually learn
// which tier is active from any message the fixed protocol defines. Per the
// spec's own documented fallback, default to the Low tier's chunkGridQuads and
// never change it (there is no legal message that could tell us to).
let activeGridQuads: number = TERRAIN_QUALITY_PROFILES.low.chunkGridQuads;

self.onmessage = (ev: MessageEvent<MainToTerrainMessage | MainToTerrainMessageExt>): void => {
  const msg = ev.data;

  if (msg.type === 'terrainInit') {
    sampler = createHeightSampler(msg.params, msg.flattenZones);
    const ready: TerrainReadyMessage = { type: 'terrainReady' };
    self.postMessage(ready);
    return;
  }

  if (msg.type === 'requestChunk') {
    if (!sampler) return; // protocol violation by the caller (requestChunk before terrainInit): ignore defensively, no crash, no chunk
    const geo = buildChunkGeometry(sampler, { depth: msg.lod, cx: msg.chunkX, cz: msg.chunkZ }, activeGridQuads);
    const out: TerrainChunkReadyMessage = {
      type: 'chunkReady',
      requestId: msg.requestId,
      chunkX: msg.chunkX,
      chunkZ: msg.chunkZ,
      lod: msg.lod,
      // .buffer is typed ArrayBufferLike (to also cover SharedArrayBuffer) even
      // though buildChunkGeometry always backs these with a plain ArrayBuffer
      // (freshly `new Float32Array(...)`/`new Uint32Array(...)` per call).
      positions: geo.positions.buffer as ArrayBuffer,
      normals: geo.normals.buffer as ArrayBuffer,
      indices: geo.indices.buffer as ArrayBuffer,
    };
    self.postMessage(out, [out.positions, out.normals, out.indices]);
    return;
  }

  if (msg.type === 'cancel') {
    // Best-effort only: this worker processes each requestChunk synchronously to
    // completion (no yielding), so a cancel can only prevent a future,
    // not-yet-started request. There is no queued/pending state to search here
    // since onmessage handles one message at a time to completion; a cancel for
    // an already-finished (or not-yet-arrived) requestChunk is simply a no-op.
    return;
  }
};
