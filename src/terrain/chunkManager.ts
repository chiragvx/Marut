/**
 * src/terrain/chunkManager.ts — stateful, main-thread chunk residency tracker
 * (module 04). Design: docs/spec/04-terrain.md section 4.9. DOM-free/Node-testable:
 * only talks to the terrain worker through the injected `sendToTerrainWorker`
 * function and manually-fed `handleTerrainWorkerMessage` calls.
 */
import type { Vec3Like, QualityTier, TerrainToMainMessage } from '../contracts/core';
import type {
  ChunkKey,
  ChunkGeometry,
  ChunkManager,
  ChunkManagerConfig,
  CreateChunkManager,
  ResidentChunkInfo,
  SendToTerrainWorker,
  TerrainInitMessage,
  TerrainToMainMessageExt,
} from '../contracts/terrain';
import { TERRAIN_QUALITY_PROFILES, MAX_RESIDENT_CHUNKS, MAX_REQUESTS_PER_UPDATE, MAX_QUADTREE_DEPTH, REFERENCE_CHUNK_SIZE_M } from '../contracts/terrain';
import type { QualityTerrainProfile } from '../contracts/terrain';
import { chunkParent, chunkKeyToBounds, computeDesiredChunks, distanceToChunk } from './quadtree';
import type { ChunkBounds, TerrainParams } from '../contracts/terrain';

interface Entry {
  key: ChunkKey;
  resident: boolean;
  /** Handed to the renderer (onChunkReady fired, onChunkEvicted not yet). */
  displayed: boolean;
  requestId?: number;
  geometry?: ChunkGeometry;
}

/** A displayed chunk that left the desired set, kept on screen until its ground is covered again. */
interface Retained {
  key: ChunkKey;
  geometry: ChunkGeometry;
}

/**
 * Packs a ChunkKey into a single small safe integer for allocation-free Map/
 * Set keys. `contracts/terrain.ts`'s `ChunkKeyToString` doc note says its
 * string form is "fine, only called on state-change edges, never per-frame
 * per resident chunk" — this module's `update()` runs once per rendered
 * frame (see 00-architecture.md section 14 / src/main.ts's frame loop) and,
 * while terrain is actively streaming, was re-deriving that string for every
 * desired chunk and every one of its ancestors on EVERY call, not just on
 * state-change edges. A numeric hash serves the same identity-lookup role
 * (Map/Set membership) as a `chunkKeyToString` key but costs nothing to
 * produce (plain arithmetic on small integers, never heap-allocated),
 * so it is safe to recompute unconditionally every frame. Injective for any
 * valid ChunkKey: `cx`/`cz` are always `< 2^depth <= 2^MAX_QUADTREE_DEPTH`
 * (256) per 04-terrain.md section 4.1, comfortably under the 1000 multiplier
 * below and far under Number.MAX_SAFE_INTEGER.
 */
function chunkKeyHash(key: ChunkKey): number {
  return key.depth * 1_000_000 + key.cx * 1000 + key.cz;
}

/** chunkKeyHash of `key`'s ancestor at `depth` (<= key.depth), without allocating the key. */
function ancestorHash(key: ChunkKey, depth: number): number {
  const s = key.depth - depth;
  return depth * 1_000_000 + (key.cx >> s) * 1000 + (key.cz >> s);
}

/**
 * The tier's terrain profile adjusted for the terrain: `lodDepthBonus` extra quadtree depth (capped
 * at MAX_QUADTREE_DEPTH) and a stream radius of at least `minDrawDistanceM` (TerrainParams).
 */
export function terrainProfileFor(tier: QualityTier, params: TerrainParams): QualityTerrainProfile {
  const base = TERRAIN_QUALITY_PROFILES[tier];
  const bonus = params.lodDepthBonus ?? 0;
  const minChunks = params.minDrawDistanceM !== undefined ? Math.ceil(params.minDrawDistanceM / REFERENCE_CHUNK_SIZE_M) : 0;
  if (bonus <= 0 && minChunks <= base.streamRadiusChunks) return base;
  return {
    ...base,
    maxLodDepth: Math.min(MAX_QUADTREE_DEPTH, base.maxLodDepth + Math.max(0, bonus)),
    streamRadiusChunks: Math.max(base.streamRadiusChunks, minChunks),
  };
}

class ChunkManagerImpl implements ChunkManager {
  private readonly sendToTerrainWorker: SendToTerrainWorker;
  private readonly entries = new Map<number, Entry>();
  /**
   * Displayed chunks no longer desired, still drawn until the ground they cover is shown by the
   * desired chunks that replace them (all resident) — so an LOD split or merge swaps the meshes in
   * one step instead of leaving a hole while the worker builds the replacement. Never overlaps
   * itself or a displayed entry: desired chunks under a retained one stay hidden until it goes.
   */
  private readonly retained = new Map<number, Retained>();
  /** Scratch: hashes of every not-yet-resident desired chunk and all its ancestors. */
  private readonly pendingScratch = new Set<number>();
  private ready = false;
  private disposed = false;
  private nextRequestId = 1;

  private lastCameraX = 0;
  private lastCameraY = 0;
  private lastCameraZ = 0;

  private splitAncestorsCur = new Set<number>();
  private splitAncestorsNext = new Set<number>();
  private readonly desiredSet = new Set<number>();
  private readonly scratchDesired: ChunkKey[] = [];
  private readonly scratchBounds: ChunkBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, minY: 0, maxY: 0 };
  // Reused across trySendRequests() calls (`.length = 0` reset) instead of a
  // fresh `[]` per call — see the perf note on trySendRequests() below.
  private readonly candidatesScratch: Entry[] = [];
  /** The active terrain's vertical bounds for LOD distances (TerrainParams.heightBoundsM). */
  private readonly heightBoundsM: TerrainParams['heightBoundsM'];
  private readonly terrainParams: TerrainParams;
  private readonly profiles = new Map<QualityTier, QualityTerrainProfile>();

  private onChunkReadyCallback: ((chunk: ResidentChunkInfo) => void) | undefined;
  private onChunkEvictedCallback: ((key: ChunkKey) => void) | undefined;

  // Created once (not inside update()/trySendRequests()) so those methods
  // never allocate a closure on the main thread's per-frame path.
  private readonly wasSplitLastFrameFn = (key: ChunkKey): boolean => this.splitAncestorsCur.has(chunkKeyHash(key));
  private readonly compareCandidatesByDistance = (a: Entry, b: Entry): number => this.distanceOfKey(a.key) - this.distanceOfKey(b.key);

  constructor(config: ChunkManagerConfig, sendToTerrainWorker: SendToTerrainWorker) {
    this.sendToTerrainWorker = sendToTerrainWorker;
    this.heightBoundsM = config.terrainParams.heightBoundsM;
    this.terrainParams = config.terrainParams;
    const init: TerrainInitMessage = {
      type: 'terrainInit',
      params: config.terrainParams,
      flattenZones: config.flattenZones,
      chunkGridQuads: TERRAIN_QUALITY_PROFILES[config.qualityTier].chunkGridQuads,
      maxLodDepth: this.profileFor(config.qualityTier).maxLodDepth,
    };
    this.sendToTerrainWorker(init);
  }

  private profileFor(tier: QualityTier): QualityTerrainProfile {
    let p = this.profiles.get(tier);
    if (!p) {
      p = terrainProfileFor(tier, this.terrainParams);
      this.profiles.set(tier, p);
    }
    return p;
  }

  update(cameraWorldPos: Vec3Like, qualityTier: QualityTier): void {
    if (this.disposed) return;
    this.lastCameraX = cameraWorldPos.x;
    this.lastCameraY = cameraWorldPos.y;
    this.lastCameraZ = cameraWorldPos.z;

    const profile = this.profileFor(qualityTier);
    computeDesiredChunks(cameraWorldPos, profile, this.wasSplitLastFrameFn, this.scratchDesired, this.heightBoundsM);

    // Single pass over this frame's desired keys: populate desiredSet AND
    // register any newly-desired entry, computing each key's hash exactly
    // once (previously two separate loops each re-stringified every desired
    // chunk with chunkKeyToString, allocating a fresh string per chunk per
    // frame even for chunks that were also desired last frame).
    this.desiredSet.clear();
    for (const key of this.scratchDesired) {
      const kh = chunkKeyHash(key);
      this.desiredSet.add(kh);
      if (this.entries.has(kh)) continue;
      const back = this.retained.get(kh);
      if (back) {
        // Wanted again while still on screen (the camera turned back): it simply stays.
        this.retained.delete(kh);
        this.entries.set(kh, { key: back.key, resident: true, displayed: true, geometry: back.geometry });
      } else {
        this.entries.set(kh, { key, resident: false, displayed: false });
      }
    }

    // Cancel entries that fell out of the desired set; displayed ones stay drawn (retained) until
    // their replacement is resident, see reconcileDisplay().
    for (const [kh, entry] of this.entries) {
      if (this.desiredSet.has(kh)) continue;
      if (entry.requestId !== undefined && !entry.resident) {
        this.sendToTerrainWorker({ type: 'cancel', requestId: entry.requestId });
      }
      if (entry.displayed && entry.geometry) this.retained.set(kh, { key: entry.key, geometry: entry.geometry });
      this.entries.delete(kh);
    }

    this.enforceResidentCap();

    // Recompute the "split ancestor" set (nodes the recursion descended past this
    // frame) from this frame's desired leaves, for next call's wasSplitLastFrame —
    // see 04-terrain.md section 4.9 point 5 ("re-deriving it... from which parents
    // of scratchOut entries are NOT themselves in scratchOut").
    this.splitAncestorsNext.clear();
    for (const key of this.scratchDesired) {
      let p = chunkParent(key);
      while (p !== undefined) {
        this.splitAncestorsNext.add(chunkKeyHash(p));
        p = chunkParent(p);
      }
    }
    const tmp = this.splitAncestorsCur;
    this.splitAncestorsCur = this.splitAncestorsNext;
    this.splitAncestorsNext = tmp;

    this.trySendRequests();
    this.reconcileDisplay();
  }

  handleTerrainWorkerMessage(msg: TerrainToMainMessage | TerrainToMainMessageExt): void {
    if (this.disposed) return;
    if (msg.type === 'terrainReady') {
      this.ready = true;
      this.trySendRequests();
      return;
    }
    if (msg.type === 'chunkReady') {
      const kh = chunkKeyHash({ depth: msg.lod, cx: msg.chunkX, cz: msg.chunkZ });
      const entry = this.entries.get(kh);
      if (!entry || entry.requestId !== msg.requestId) return; // stale/cancelled/superseded: drop silently
      const positions = new Float32Array(msg.positions);
      const normals = new Float32Array(msg.normals);
      const indices = new Uint32Array(msg.indices);
      const geometry: ChunkGeometry = { positions, normals, indices, vertexCount: positions.length / 3, indexCount: indices.length };
      const f = msg.features;
      if (f) {
        geometry.features = {
          decalPositions: new Float32Array(f.decalPositions),
          decalAttribs: new Float32Array(f.decalAttribs),
          decalIndices: new Uint32Array(f.decalIndices),
          treeMatrices: f.treeMatrices.map((bf) => new Float32Array(bf)),
          treeColors: f.treeColors.map((bf) => new Float32Array(bf)),
          buildingMatrices: new Float32Array(f.buildingMatrices),
          buildingColors: new Float32Array(f.buildingColors),
          domeMatrices: new Float32Array(f.domeMatrices),
          houseMatrices: new Float32Array(f.houseMatrices),
          houseColors: new Float32Array(f.houseColors),
        };
      }
      entry.geometry = geometry;
      entry.resident = true;
      this.reconcileDisplay();
      return;
    }
  }

  onChunkReady(callback: (chunk: ResidentChunkInfo) => void): void {
    this.onChunkReadyCallback = callback;
  }

  onChunkEvicted(callback: (key: ChunkKey) => void): void {
    this.onChunkEvictedCallback = callback;
  }

  loadProgress(): { resident: number; desired: number } {
    let resident = 0;
    for (const e of this.entries.values()) if (e.resident) resident++;
    return { resident, desired: this.entries.size };
  }

  getResidentChunks(): readonly ResidentChunkInfo[] {
    const result: ResidentChunkInfo[] = [];
    for (const entry of this.entries.values()) {
      if (entry.displayed && entry.geometry) result.push({ key: entry.key, geometry: entry.geometry });
    }
    for (const r of this.retained.values()) result.push({ key: r.key, geometry: r.geometry });
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.retained.clear();
    this.onChunkReadyCallback = undefined;
    this.onChunkEvictedCallback = undefined;
  }

  private fireEvicted(key: ChunkKey): void {
    this.onChunkEvictedCallback?.(key);
  }

  /**
   * Brings what the renderer draws in line with residency without ever uncovering ground:
   * 1. a retained chunk goes once its ground is covered — by a resident desired ancestor, or by
   *    all of its desired descendants being resident (none left pending); one with no desired
   *    chunk over or under it lies outside the streamed area and goes at once;
   * 2. then every resident desired chunk not under a retained one is shown.
   * Both steps of a swap happen in the same call, so an LOD change never leaves a hole or draws
   * the same ground twice.
   */
  private reconcileDisplay(): void {
    if (this.retained.size > 0) {
      const pending = this.pendingScratch;
      pending.clear();
      for (const entry of this.entries.values()) {
        if (entry.resident) continue;
        for (let d = entry.key.depth; d >= 0; d--) {
          const h = ancestorHash(entry.key, d);
          if (pending.has(h)) break; // the rest of the chain is already in
          pending.add(h);
        }
      }
      for (const [kh, r] of this.retained) {
        let release: boolean | undefined;
        for (let d = r.key.depth - 1; d >= 0; d--) {
          const anc = this.entries.get(ancestorHash(r.key, d));
          if (anc) {
            release = anc.resident;
            break;
          }
        }
        if (release === undefined) release = !pending.has(kh);
        if (release) {
          this.retained.delete(kh);
          this.fireEvicted(r.key);
        }
      }
    }
    for (const entry of this.entries.values()) {
      if (!entry.resident || entry.displayed || !entry.geometry) continue;
      if (this.retained.size > 0 && this.underRetained(entry.key)) continue;
      entry.displayed = true;
      this.onChunkReadyCallback?.({ key: entry.key, geometry: entry.geometry });
    }
  }

  private underRetained(key: ChunkKey): boolean {
    for (let d = key.depth - 1; d >= 0; d--) if (this.retained.has(ancestorHash(key, d))) return true;
    return false;
  }

  private distanceOfKey(key: ChunkKey): number {
    chunkKeyToBounds(key, this.scratchBounds, this.heightBoundsM);
    return distanceToChunk({ x: this.lastCameraX, y: this.lastCameraY, z: this.lastCameraZ }, this.scratchBounds);
  }

  /**
   * Sends at most MAX_REQUESTS_PER_UPDATE new requestChunk messages,
   * nearest-to-camera first, for entries needing one. No-op until `ready`.
   * Reuses `candidatesScratch` (reset via `.length = 0`, never reallocated)
   * and the pre-bound `compareCandidatesByDistance` comparator instead of a
   * fresh `[]` and a fresh comparator closure per call — this runs every
   * `update()` while any chunk is still awaiting a request, i.e. continuously
   * while terrain is streaming.
   */
  private trySendRequests(): void {
    if (!this.ready) return;
    const candidates = this.candidatesScratch;
    candidates.length = 0;
    for (const entry of this.entries.values()) {
      if (!entry.resident && entry.requestId === undefined) candidates.push(entry);
    }
    if (candidates.length === 0) return;
    candidates.sort(this.compareCandidatesByDistance);
    const n = Math.min(candidates.length, MAX_REQUESTS_PER_UPDATE);
    for (let i = 0; i < n; i++) {
      const entry = candidates[i]!;
      const requestId = this.nextRequestId++;
      entry.requestId = requestId;
      this.sendToTerrainWorker({ type: 'requestChunk', chunkX: entry.key.cx, chunkZ: entry.key.cz, lod: entry.key.depth, requestId });
    }
    candidates.length = 0; // drop references promptly; array itself is kept/reused
  }

  /** Safety cap: evict the farthest-from-camera resident entries first if the map would exceed MAX_RESIDENT_CHUNKS. */
  private enforceResidentCap(): void {
    if (this.entries.size <= MAX_RESIDENT_CHUNKS) return;
    const resident: Entry[] = [];
    for (const entry of this.entries.values()) if (entry.resident) resident.push(entry);
    resident.sort((a, b) => this.distanceOfKey(b.key) - this.distanceOfKey(a.key)); // farthest first
    let overflow = this.entries.size - MAX_RESIDENT_CHUNKS;
    for (const entry of resident) {
      if (overflow <= 0) break;
      const kh = chunkKeyHash(entry.key);
      if (entry.displayed) this.fireEvicted(entry.key);
      this.entries.delete(kh);
      this.desiredSet.delete(kh);
      overflow--;
    }
  }
}

export const createChunkManager: CreateChunkManager = (config: ChunkManagerConfig, sendToTerrainWorker: SendToTerrainWorker): ChunkManager =>
  new ChunkManagerImpl(config, sendToTerrainWorker);
