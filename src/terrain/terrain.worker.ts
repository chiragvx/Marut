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

// FIXED CONTRACT GAP (see docs/spec/04-terrain.md section 4.10/9, and this
// module's return-value contractConcerns): TerrainInitMessage now carries the
// active quality tier's `chunkGridQuads` directly (contracts/terrain.ts), so
// this no longer needs to guess. Default to Low only until the first
// `terrainInit` message arrives (mirrors the pre-fix fallback so a
// protocol-violating `requestChunk` sent before `terrainInit` — already
// defensively ignored below — still has a sane value to fall back to).
// Runtime quality-tier CHANGES still are not propagated (no message exists
// for that yet); this only fixes the resolution matching the tier active at
// boot, which is what was producing visible ground-clipping (the render mesh
// sitting meters away from the physics-exact HeightSampler height it should
// track) regardless of the selected tier.
let activeGridQuads: number = TERRAIN_QUALITY_PROFILES.low.chunkGridQuads;

self.onmessage = (ev: MessageEvent<MainToTerrainMessage | MainToTerrainMessageExt>): void => {
  const msg = ev.data;

  if (msg.type === 'terrainInit') {
    sampler = createHeightSampler(msg.params, msg.flattenZones);
    activeGridQuads = msg.chunkGridQuads;
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
