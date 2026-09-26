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
import { buildChunkGeometryAndSurface } from './chunkGeometryBuilder';
import { airportClearZones, buildChunkFeatures, type ClearZone } from './chunkFeatures';
import { buildRoadNetwork, packSettlementLayer, type RoadNetwork } from './roadNetwork';

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
let maxLodDepth: number = TERRAIN_QUALITY_PROFILES.low.maxLodDepth;
let network: RoadNetwork | undefined;
/** No trees on or around any airport. */
let clearZones: ClearZone[] = [];

self.onmessage = (ev: MessageEvent<MainToTerrainMessage | MainToTerrainMessageExt>): void => {
  const msg = ev.data;

  if (msg.type === 'terrainInit') {
    sampler = createHeightSampler(msg.params, msg.flattenZones);
    clearZones = airportClearZones(msg.flattenZones);
    activeGridQuads = msg.chunkGridQuads;
    maxLodDepth = msg.maxLodDepth ?? maxLodDepth;
    network = buildRoadNetwork(msg.params, sampler);
    const settlements = network && msg.params.network ? packSettlementLayer(network, msg.params.network) : undefined;
    const ready: TerrainReadyMessage = settlements ? { type: 'terrainReady', settlements } : { type: 'terrainReady' };
    const transfer: ArrayBuffer[] = settlements ? [settlements.grid.buffer as ArrayBuffer] : [];
    if (settlements?.urban) transfer.push(settlements.urban.data.buffer as ArrayBuffer);
    self.postMessage(ready, transfer);
    return;
  }

  if (msg.type === 'requestChunk') {
    if (!sampler) return; // protocol violation by the caller (requestChunk before terrainInit): ignore defensively, no crash, no chunk
    const built = buildChunkGeometryAndSurface(sampler, { depth: msg.lod, cx: msg.chunkX, cz: msg.chunkZ }, activeGridQuads);
    const geo = built.geometry;
    // Scenery on the finest chunks this tier reaches: roads from depth 4 (or the tier's finest),
    // trees and buildings from depth 5 (or the tier's finest, thinned).
    // Scenery only on the tier's finest chunks (and never below depth 4): coarse far chunks now
    // reach 50+ km, and their roads would be sub-pixel anyway.
    const roadDepth = Math.max(4, maxLodDepth);
    const objectDepth = Math.max(4, maxLodDepth);
    const features =
      network && msg.lod >= roadDepth
        ? buildChunkFeatures(network, built.bounds, built.surface, { objects: msg.lod >= objectDepth, treeDensity: msg.lod >= 5 ? 1 : 0.5, clearZones })
        : undefined;
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
    const transfer: ArrayBuffer[] = [out.positions, out.normals, out.indices];
    if (features) {
      const buf = (a: Float32Array | Uint32Array): ArrayBuffer => a.buffer as ArrayBuffer;
      out.features = {
        decalPositions: buf(features.decalPositions),
        decalAttribs: buf(features.decalAttribs),
        decalIndices: buf(features.decalIndices),
        treeMatrices: features.treeMatrices.map(buf),
        treeColors: features.treeColors.map(buf),
        buildingMatrices: buf(features.buildingMatrices),
        buildingColors: buf(features.buildingColors),
        domeMatrices: buf(features.domeMatrices),
        houseMatrices: buf(features.houseMatrices),
        houseColors: buf(features.houseColors),
      };
      const f = out.features;
      transfer.push(f.decalPositions, f.decalAttribs, f.decalIndices, ...f.treeMatrices, ...f.treeColors, f.buildingMatrices, f.buildingColors, f.domeMatrices, f.houseMatrices, f.houseColors);
    }
    self.postMessage(out, transfer);
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
