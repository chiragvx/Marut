/**
 * =============================================================================
 * TEJAS SIM — TERRAIN CONTRACT (docs/spec/contracts/terrain.ts)
 * =============================================================================
 * Owner: module 04 (docs/spec/04-terrain.md). Implemented by src/terrain/*.
 *
 * Imports ONLY from './core'. This module deliberately does NOT import from
 * './math' even though 00-architecture.md's dependency rules would allow
 * src/terrain to import src/math/* at the implementation level: at drafting
 * time contracts/math.ts does not exist yet, and per 00-architecture.md
 * section 12 the future implementer of this module will read ONLY
 * 00-architecture.md + core.ts + 04-terrain.md + this file — never
 * contracts/math.ts. Every formula this module needs (noise, fBm, domain
 * warp, ridge multifractal, 2D vectors, hashing) is therefore self-contained
 * using plain `number`s and core.ts's `Vec3Like`. See 04-terrain.md section 9
 * for the full rationale.
 *
 * This file contains ONLY interfaces, type aliases, `as const` objects +
 * derived unions, exported DATA constants (plain object/number literals, not
 * function bodies), and bare function-signature type aliases
 * (`export type Foo = (...) => Bar`). No class bodies, no function bodies.
 * Must compile standalone with `tsc --noEmit --strict`.
 * =============================================================================
 */

import type { Vec3Like, HeightSampler, QualityTier, MainToTerrainMessage, TerrainToMainMessage } from './core';

// -----------------------------------------------------------------------------
// 1. World bounds. See 04-terrain.md section 4.1.
// -----------------------------------------------------------------------------

/** Total world width/depth, metres. World spans x,z in [-TERRAIN_WORLD_HALF_EXTENT_M, +TERRAIN_WORLD_HALF_EXTENT_M]. */
export const TERRAIN_WORLD_EXTENT_M = 200_000;
/** = TERRAIN_WORLD_EXTENT_M / 2. */
export const TERRAIN_WORLD_HALF_EXTENT_M = TERRAIN_WORLD_EXTENT_M / 2;
/** Hard cap on quadtree recursion depth (independent of any quality tier's own `maxLodDepth`, which is always <= this). Fixes the finest possible chunk size (`REFERENCE_CHUNK_SIZE_M`) used to convert a tier's `streamRadiusChunks` (a chunk COUNT) into a metres radius. */
export const MAX_QUADTREE_DEPTH = 8;
/** = TERRAIN_WORLD_EXTENT_M / 2^MAX_QUADTREE_DEPTH = 781.25 m. The fixed reference chunk size `streamRadiusChunks` is measured in, chosen independently of any tier's own leaf chunk size so tier draw distances compare like-for-like (see 04-terrain.md section 4.4). */
export const REFERENCE_CHUNK_SIZE_M = TERRAIN_WORLD_EXTENT_M / Math.pow(2, MAX_QUADTREE_DEPTH);

/**
 * Conservative (worst-case, analytically derived from DEFAULT_TERRAIN_PARAMS
 * and never exceeded by it — verified empirically over a 400x400 world-grid
 * sample in 04-terrain.md section 4.2, observed range approx [-131, 1591])
 * global vertical bounds of the raw (pre-flattening) heightfield, metres MSL.
 * Used for every quadtree node's AABB vertical extent (04-terrain.md section
 * 4.4 deliberately uses this GLOBAL bound rather than a per-node computed
 * bound, trading a slightly less tight LOD distance test for zero extra
 * heightAt() calls during LOD selection). AirportFlattenZone.elevationM
 * values (module 05) should stay within this range; flattening blends
 * TOWARD raw height, it does not clamp independently.
 */
export const TERRAIN_MAX_HEIGHT_M = 2100;
export const TERRAIN_MIN_HEIGHT_M = -200;

// -----------------------------------------------------------------------------
// 2. Local 2D helper type. core.ts has no 2D vector; terrain math is
//    frequently horizontal-plane-only (x,z). Field names `x`,`z` (not
//    `x`,`y`) to avoid ever being confused with a vertical-plane vector.
// -----------------------------------------------------------------------------

export interface Vec2Like {
  x: number;
  z: number;
}

// -----------------------------------------------------------------------------
// 3. Noise building blocks. All pure, deterministic, allocation-free once
//    constructed (the returned closures may capture a fixed-size permutation
//    table built once at construction time; that is NOT a hot-path
//    allocation — see 04-terrain.md section 6). Exact algorithms, constants
//    and worked/verified fixtures are in 04-terrain.md section 4.3.
// -----------------------------------------------------------------------------

/** Deterministic 2D noise, output clamped to [-1,1]. Same (instance, x, z) always yields the same value, in any thread/process. */
export type Noise2D = (x: number, z: number) => number;

/** Builds a Noise2D from an integer seed (see TerrainNoiseSeedTag / DeriveTerrainSubSeed for how this module derives the 5 sub-seeds it needs from one TerrainParams.seed). */
export type CreateNoise2D = (seed: number) => Noise2D;

export interface FbmParams {
  /** >= 1, integer. */
  octaves: number;
  /** Spatial frequency of octave 0, 1/m. */
  baseFrequency: number;
  /** Amplitude of octave 0, m. */
  baseAmplitudeM: number;
  /** Frequency multiplier applied per octave (>1, typically 2.0). */
  lacunarity: number;
  /** Amplitude multiplier applied per octave (0..1, typically 0.5). */
  persistence: number;
}

/** Sum of `params.baseAmplitudeM * params.persistence^i` for i in 0..octaves-1: the theoretical max |output| of a Noise2D built with these params (since each octave's Noise2D is itself bounded to [-1,1]). A pure formula, not a factory — 04-terrain.md documents it inline; no contract type needed since callers just need the fixed result, tabulated in 04-terrain.md section 5 for DEFAULT_TERRAIN_PARAMS. */

/** Combines a base Noise2D across `params.octaves` octaves (fractal Brownian motion). Output range approximately [-fbmMaxAmplitude, +fbmMaxAmplitude] (see above), NOT clamped. */
export type CreateFbmNoise2D = (baseNoise: Noise2D, params: FbmParams) => Noise2D;

export interface RidgeParams {
  octaves: number;
  baseFrequency: number;
  baseAmplitudeM: number;
  lacunarity: number;
  persistence: number;
  /** 0..1. Weights each octave's ridge signal by the previous octave's (clamped-to-[0,1]) signal — the standard ridged-multifractal "gain" term that makes higher octaves only contribute near existing ridges. */
  gain: number;
  /** >= 1. Exponent applied to `(1 - |noise|)` per octave; higher = sharper peaks/valleys. */
  sharpness: number;
}

/** Ridged-multifractal noise built from a base Noise2D. Output range [0, ridgeConservativeMaxAmplitude] where the upper bound = sum of `params.baseAmplitudeM * params.persistence^i` (same formula as fbm's bound; conservative because it ignores the `gain` damping, which can only reduce the true value). Mountains "poke up" — output is always >= 0. */
export type CreateRidgeNoise2D = (baseNoise: Noise2D, params: RidgeParams) => Noise2D;

export interface DomainWarpParams {
  enabled: boolean;
  /** 1/m. */
  warpFrequency: number;
  /** Maximum horizontal displacement magnitude per warp octave sum reaches at most `octaves` combined fbm amplitude — see 04-terrain.md section 4.3 for the exact per-octave breakdown; effectively the displacement is bounded by the same fbm-amplitude formula with this as baseAmplitudeM. m. */
  warpAmplitudeM: number;
  octaves: number;
}

/** Writes the warped (x,z) into `out` (no allocation) given two independently-seeded warp Noise2D instances (one drives the x displacement, one the z displacement — see TerrainNoiseSeedTag.WarpX/WarpZ). If `params.enabled` is false, writes `out.x = x; out.z = z` unchanged. */
export type WarpFn = (x: number, z: number, out: Vec2Like) => void;

export type CreateDomainWarp2D = (warpNoiseX: Noise2D, warpNoiseZ: Noise2D, params: DomainWarpParams) => WarpFn;

/** Very-low-frequency fbm used only to pick a BiomeBand; same shape as FbmParams minus baseAmplitudeM (this module always builds it with baseAmplitudeM = 1 internally and normalises the result — see 04-terrain.md 4.3.4 — so the output is a dimensionless "continentalness" value in [-1,1], not metres). */
export interface ContinentalParams {
  octaves: number;
  baseFrequency: number;
  lacunarity: number;
  persistence: number;
}

export interface BiomeBand {
  /** Inclusive lower bound of the normalised continental value [-1,1] this band applies from. Bands are sorted ascending by this field; the LAST band whose `fromContinental <= continental` applies (so the first band's `fromContinental` should be -1 to cover the whole range). */
  fromContinental: number;
  /** Unitless multiplier applied to the blended (fbm,ridge) signal within this band. */
  heightScale: number;
  /** 0..1. Fraction of ridged-multifractal contribution blended in within this band (0 = pure rolling fbm terrain, 1 = pure ridged mountains). `lerp(fbmH, ridgeH, ridgeBlend)`. */
  ridgeBlend: number;
  /** Elevation offset added within this band, m MSL. */
  baseElevationM: number;
}

export interface TerrainParams {
  /** Root seed for this terrain's noise fields. src/core sets this = WorldConfig.seed (or Mission.world.seed) when constructing a Mission's terrain params; a caller that wants a terrain independent of the mission's gameplay seed may supply a different value. */
  seed: number;
  fbm: FbmParams;
  domainWarp: DomainWarpParams;
  ridge: RidgeParams;
  continental: ContinentalParams;
  /** Sorted ascending by `fromContinental`; must contain at least one band whose `fromContinental <= -1`. */
  bands: readonly BiomeBand[];
  /** Reference elevation, m MSL, for src/render's fog/water-plane placement (module 08's concern; this module's HeightSampler does not clip or special-case heights below this value). */
  seaLevelM: number;
}

/** Numeric tags identifying which of this module's 5 independent noise fields a sub-seed is for. Passed to DeriveTerrainSubSeed. */
export const TerrainNoiseSeedTag = {
  Fbm: 1,
  Continental: 2,
  Ridge: 3,
  WarpX: 4,
  WarpZ: 5,
} as const;
export type TerrainNoiseSeedTag = (typeof TerrainNoiseSeedTag)[keyof typeof TerrainNoiseSeedTag];

/** Deterministic integer hash deriving an independent sub-seed for noise field `tag` from `TerrainParams.seed`, so the 5 fields never share a permutation table. Exact formula (verified fixtures) in 04-terrain.md section 4.3.1 — this module does NOT use src/math's mulberry32 for this (see file header). */
export type DeriveTerrainSubSeed = (rootSeed: number, tag: TerrainNoiseSeedTag) => number;

/**
 * The canonical default terrain configuration: used by the two built-in
 * missions (module 10), by this module's own reference implementation, and
 * by every numeric test fixture in 04-terrain.md section 7. `seed` here is
 * illustrative only — src/core normally overwrites it with the active
 * Mission's world seed; every OTHER field is the actual tuned default and
 * should not be changed without updating 04-terrain.md's verified fixtures.
 */
export const DEFAULT_TERRAIN_PARAMS: TerrainParams = {
  seed: 1,
  fbm: { octaves: 6, baseFrequency: 1 / 3000, baseAmplitudeM: 220, lacunarity: 2.0, persistence: 0.5 },
  domainWarp: { enabled: true, warpFrequency: 1 / 4000, warpAmplitudeM: 600, octaves: 3 },
  ridge: { octaves: 6, baseFrequency: 1 / 2500, baseAmplitudeM: 500, lacunarity: 2.0, persistence: 0.5, gain: 0.55, sharpness: 2 },
  continental: { octaves: 3, baseFrequency: 1 / 60000, lacunarity: 2.0, persistence: 0.5 },
  bands: [
    { fromContinental: -1.0, heightScale: 0.5, ridgeBlend: 0.05, baseElevationM: 20 },
    { fromContinental: -0.35, heightScale: 0.85, ridgeBlend: 0.25, baseElevationM: 80 },
    { fromContinental: 0.15, heightScale: 1.15, ridgeBlend: 0.55, baseElevationM: 250 },
    { fromContinental: 0.55, heightScale: 1.6, ridgeBlend: 0.9, baseElevationM: 600 },
  ],
  seaLevelM: 0,
};

/** Combined (pre-flattening) terrain height, world Y metres, at world (x,z). */
export type RawTerrainHeightFn = (x: number, z: number) => number;
/** Builds the full noise stack (continental band select -> domain warp -> fbm/ridge blend) from `params`, deriving all 5 sub-seeds via DeriveTerrainSubSeed. */
export type CreateRawTerrainHeight = (params: TerrainParams) => RawTerrainHeightFn;

// -----------------------------------------------------------------------------
// 4. Airport flattening (00-architecture.md section 9.2 — fixed shape, must
//    match contracts/airport.ts's AirportLayout.flattenZones element type
//    byte-for-byte).
// -----------------------------------------------------------------------------

export interface AirportFlattenZone {
  centerWorldX: number;
  centerWorldZ: number;
  /** Flattened surface elevation, m MSL. */
  elevationM: number;
  /** Radius, m, within which terrain height is forced to exactly `elevationM`. */
  flatRadiusM: number;
  /** Additional radius, m, beyond `flatRadiusM`, over which height smoothstep-blends back to raw noise height. */
  blendRadiusM: number;
}

/**
 * Builds the module's HeightSampler (core.ts's interface): `heightAt`
 * blends `CreateRawTerrainHeight(params)` with `flattenZones` per
 * 04-terrain.md section 4.5 (nearest-zone-wins smoothstep blend);
 * `normalAt` is the central-difference gradient of `heightAt` itself (so
 * flattening is automatically reflected in normals with no extra code —
 * see 04-terrain.md section 4.6). `sampler.seed === params.seed`.
 */
export type CreateHeightSampler = (params: TerrainParams, flattenZones: readonly AirportFlattenZone[]) => HeightSampler;

// -----------------------------------------------------------------------------
// 5. Quadtree chunk addressing and LOD selection.
// -----------------------------------------------------------------------------

/** Identifies one quadtree node. `depth` 0 = the single world-root chunk (covers the whole [-TERRAIN_WORLD_HALF_EXTENT_M, +TERRAIN_WORLD_HALF_EXTENT_M]^2 square). At `depth`, `cx`/`cz` range 0..2^depth - 1. */
export interface ChunkKey {
  readonly depth: number;
  readonly cx: number;
  readonly cz: number;
}

export interface ChunkBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Always TERRAIN_MIN_HEIGHT_M (global conservative bound; see section 1). */
  minY: number;
  /** Always TERRAIN_MAX_HEIGHT_M. */
  maxY: number;
}

/** World-space edge length of any chunk at `depth` = TERRAIN_WORLD_EXTENT_M / 2^depth. Pure formula (no allocation); 0 <= depth <= MAX_QUADTREE_DEPTH. */
export type ChunkSizeAtDepth = (depth: number) => number;

/** Writes `key`'s world-space AABB into `out` (no allocation) and returns `out`. */
export type ChunkKeyToBounds = (key: ChunkKey, out: ChunkBounds) => ChunkBounds;

/** Writes `key`'s 4 children (`depth+1`) into the 4 slots of `out` (no allocation; caller owns and reuses `out`). Child order: [0]=(2cx,2cz) [1]=(2cx+1,2cz) [2]=(2cx,2cz+1) [3]=(2cx+1,2cz+1). */
export type ChunkChildren = (key: ChunkKey, out: [ChunkKey, ChunkKey, ChunkKey, ChunkKey]) => void;

/** `key`'s parent (`depth-1`, `floor(cx/2)`, `floor(cz/2)`), or `undefined` if `key.depth === 0`. */
export type ChunkParent = (key: ChunkKey) => ChunkKey | undefined;

/** Canonical string form `${depth}/${cx}/${cz}`, used as a Map key by ChunkManager's implementation (allocates a string — fine, only called on state-change edges, never per-frame per resident chunk; see 04-terrain.md section 6). */
export type ChunkKeyToString = (key: ChunkKey) => string;

/** Per-tier terrain streaming/LOD configuration. `maxLodDepth` and `streamRadiusChunks` reproduce 00-architecture.md section 14's "terrain max LOD depth" / "terrain draw distance (chunks)" numbers EXACTLY for this tier — do not redefine them elsewhere. `chunkGridQuads` (this module's own design) is the number of grid quads per chunk edge at ANY depth for this tier (vertex count is therefore LOD-independent; only the world-space area a chunk covers changes with depth — see 04-terrain.md section 5.2). */
export interface QualityTerrainProfile {
  readonly qualityTier: QualityTier;
  readonly maxLodDepth: number;
  readonly streamRadiusChunks: number;
  readonly chunkGridQuads: number;
}

/** `streamRadiusChunks * REFERENCE_CHUNK_SIZE_M` for `profile` — the metres radius (horizontal+vertical 3D distance, see 04-terrain.md 4.4) beyond which no chunk is resident, regardless of LOD depth. Pure formula; no contract type needed beyond this comment — 04-terrain.md section 5.2 tabulates the resulting value per tier. */

export const TERRAIN_QUALITY_PROFILES: Readonly<Record<QualityTier, QualityTerrainProfile>> = {
  low: { qualityTier: 'low', maxLodDepth: 3, streamRadiusChunks: 6, chunkGridQuads: 12 },
  medium: { qualityTier: 'medium', maxLodDepth: 4, streamRadiusChunks: 10, chunkGridQuads: 16 },
  high: { qualityTier: 'high', maxLodDepth: 5, streamRadiusChunks: 16, chunkGridQuads: 24 },
  ultra: { qualityTier: 'ultra', maxLodDepth: 6, streamRadiusChunks: 24, chunkGridQuads: 32 },
} as const;

/** Split threshold: a node recurses into its 4 children when the 3D camera-to-chunk-AABB distance is less than this factor times the node's world-space size, AND it was NOT already split last frame. */
export const LOD_SPLIT_DISTANCE_FACTOR = 2.0;
/** Merge threshold: a node that WAS split last frame only merges its children back (stops recursing) once distance exceeds this factor times its size. Must be > LOD_SPLIT_DISTANCE_FACTOR; the gap between the two is the hysteresis band that prevents split/merge flicker. */
export const LOD_MERGE_DISTANCE_FACTOR = 2.6;

/** Safety cap on simultaneously resident chunks (any depth), independent of the geometric estimate in 04-terrain.md section 6. ChunkManager must never exceed this — if a desired set computation would, it keeps the `MAX_RESIDENT_CHUNKS` nearest-to-camera chunks and drops the rest (evicting/not-requesting the farthest first). */
export const MAX_RESIDENT_CHUNKS = 512;

/**
 * Hard cap on NEW `TerrainRequestChunkMessage`s a single `ChunkManager.update()`
 * call may send. A chunk build costs ~3.5 ms on desktop, up to ~10 ms on
 * mobile (04-terrain.md section 6); `terrain.worker.ts` processes requests
 * synchronously to completion with no yielding, so an unbounded burst of new
 * requests in one frame (a fast camera dive, or a floating-origin rebase,
 * suddenly changing `ComputeDesiredChunks`'s result by many chunks at once)
 * would serialise into a multi-frame worker backlog and a visible terrain
 * pop/stall. `ChunkManager.update()` sends at most this many NEW requests
 * per call, nearest-to-camera first (the same distance ordering
 * `ComputeDesiredChunks` already computes), deferring the rest to
 * subsequent `update()` calls, so the worst case degrades to "briefly
 * coarser LOD for a few extra frames," never an unbounded worker queue.
 */
export const MAX_REQUESTS_PER_UPDATE = 4;

/** Sticky hysteresis query: true if `key` was resident as a SPLIT (non-leaf) node as of the previous `update()`/evaluation. ChunkManager implements this from its own state; a test may stub it directly. */
export type WasChunkSplitLastFrame = (key: ChunkKey) => boolean;

/**
 * Pure (given `wasSplitLastFrame`), allocation-free (assuming `out`'s backing
 * array capacity has already reached steady-state peak — pushes only truncate
 * via `out.length = 0` first, never shrink the underlying array) recursive
 * quadtree LOD selection. Clears `out`, then appends every ChunkKey that
 * should be a rendered LEAF for this evaluation of `cameraWorldPos`/`profile`.
 * Exact recursion in 04-terrain.md section 4.4, with verified fixtures.
 */
export type ComputeDesiredChunks = (
  cameraWorldPos: Vec3Like,
  profile: QualityTerrainProfile,
  wasSplitLastFrame: WasChunkSplitLastFrame,
  out: ChunkKey[]
) => void;

// -----------------------------------------------------------------------------
// 6. Skirts (crack-hiding curtains at chunk edges — see 04-terrain.md 4.6).
// -----------------------------------------------------------------------------

export const SKIRT_DEPTH_FRACTION = 0.06;
export const SKIRT_DEPTH_MIN_M = 15;
export const SKIRT_DEPTH_MAX_M = 400;

/** `clamp(chunkSizeM * SKIRT_DEPTH_FRACTION, SKIRT_DEPTH_MIN_M, SKIRT_DEPTH_MAX_M)`. Pure formula; used by BuildChunkGeometry with `chunkSizeM = chunkSizeAtDepth(key.depth)`. */
export type SkirtDepthM = (chunkSizeM: number) => number;

// -----------------------------------------------------------------------------
// 7. Chunk geometry (built in terrain.worker.ts). Vertex/index layout, exact
//    triangle winding derivation and formulas: 04-terrain.md section 4.7.
// -----------------------------------------------------------------------------

export interface ChunkGeometry {
  /** Float32Array, interleaved world-space (x,y,z) per vertex, ABSOLUTE world coordinates — NOT chunk-local, NOT camera-relative. src/render subtracts `renderOriginWorld` at upload time (00-architecture.md section 7). Length = vertexCount * 3. Includes both the (gridQuads+1)^2 interior grid vertices and the 4*(gridQuads+1) skirt vertices (see section 4.7). */
  positions: Float32Array;
  /** Float32Array, interleaved world-space unit normal (x,y,z) per vertex. Length = vertexCount * 3. */
  normals: Float32Array;
  /** Uint32Array triangle indices. Length = indexCount, indexCount % 3 === 0. */
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
}

/**
 * Builds one chunk's geometry: samples `sampler.heightAt`/`normalAt` over a
 * `(gridQuads+1) x (gridQuads+1)` grid covering `key`'s world-space AABB,
 * plus a skirt ring of depth `SkirtDepthM(chunkSizeAtDepth(key.depth))`.
 * Pure given a pure `sampler`; allocates its 3 typed arrays fresh each call
 * (acceptable — this runs only in terrain.worker.ts, on new-chunk events,
 * never in a 120 Hz or per-render-frame hot path; see 04-terrain.md 6).
 */
export type BuildChunkGeometry = (sampler: HeightSampler, key: ChunkKey, gridQuads: number) => ChunkGeometry;

// -----------------------------------------------------------------------------
// 8. Worker protocol extension. core.ts's MainToTerrainMessage /
//    TerrainToMainMessage (requestChunk/cancel/chunkReady) have no
//    initialization message (unlike MainToSimMessage's SimInitMessage) — the
//    terrain worker still needs `TerrainParams` + `AirportFlattenZone[]` to
//    build its own internal HeightSampler before it can honour any
//    requestChunk. Since core.ts cannot be edited, this module adds the
//    missing message pair here; see 04-terrain.md section 9 for the
//    rationale. src/core's main-thread terrain-worker wiring code sends
//    TerrainInitMessage as the terrain worker's FIRST message, before any
//    core.ts MainToTerrainMessage, and must not send a requestChunk before
//    receiving TerrainReadyMessage back.
// -----------------------------------------------------------------------------

export interface TerrainInitMessage {
  type: 'terrainInit';
  params: TerrainParams;
  flattenZones: readonly AirportFlattenZone[];
  /**
   * `TERRAIN_QUALITY_PROFILES[activeQualityTier].chunkGridQuads` at the moment ChunkManager was
   * constructed. Without this, terrain.worker.ts has no way to learn the active quality tier at
   * all (see this file's own section 9 "open assumption" note, and 04-terrain.md section 4.10) and
   * previously fell back to permanently building every chunk at Low's 12x12 resolution regardless
   * of tier — at the finest LOD depth (REFERENCE_CHUNK_SIZE_M ~= 781m / 12 quads ~= 65m between
   * vertices) this is coarse enough that the rendered surface visibly diverges from the analytic
   * HeightSampler height physics uses for ground contact, i.e. visible ground clipping on anything
   * but dead-flat (flattened-airport) terrain. Runtime tier changes still are not propagated (no
   * message currently exists for that — the open assumption above is unchanged); this field only
   * fixes the INITIAL resolution matching the detected/selected tier at boot.
   */
  chunkGridQuads: number;
}
export interface TerrainReadyMessage {
  type: 'terrainReady';
}
/** Extends core.ts's MainToTerrainMessage for this module's own worker bootstrap. Call sites should type their postMessage as `MainToTerrainMessage | MainToTerrainMessageExt`. */
export type MainToTerrainMessageExt = TerrainInitMessage;
/** Extends core.ts's TerrainToMainMessage. Call sites should type their onmessage handler as `TerrainToMainMessage | TerrainToMainMessageExt`. */
export type TerrainToMainMessageExt = TerrainReadyMessage;

// -----------------------------------------------------------------------------
// 9. ChunkManager — the main-thread, stateful streaming/residency tracker
//    that src/core constructs (from a concrete src/terrain implementation)
//    and injects wherever chunk mesh data is needed (module 08's
//    terrainChunkConsumer.ts). DOM-free, Node/vitest-testable: it never
//    touches `Worker`/`postMessage` directly, only the injected
//    `sendToTerrainWorker` function and manually-fed
//    `handleTerrainWorkerMessage` calls.
// -----------------------------------------------------------------------------

export interface ResidentChunkInfo {
  readonly key: ChunkKey;
  readonly geometry: ChunkGeometry;
}

export interface ChunkManagerConfig {
  readonly qualityTier: QualityTier;
  /** Sent as TerrainInitMessage.params when the manager is constructed. */
  readonly terrainParams: TerrainParams;
  readonly flattenZones: readonly AirportFlattenZone[];
}

/** Sends one message to the terrain worker. Injected so ChunkManager stays postMessage-agnostic (and Node-testable): src/core supplies `(msg) => terrainWorker.postMessage(msg)` (with the ArrayBuffer fields of a future message, if any, added to the transfer list — none of ChunkManager's own outgoing messages carry transferables). */
export type SendToTerrainWorker = (msg: MainToTerrainMessage | MainToTerrainMessageExt) => void;

export interface ChunkManager {
  /**
   * Call once per render frame (module 08) with the camera's current world
   * position and the active quality tier. Recomputes the desired chunk set
   * (ComputeDesiredChunks) against the manager's own resident-state map,
   * issues AT MOST `MAX_REQUESTS_PER_UPDATE` new TerrainRequestChunkMessage
   * this call (nearest-desired-first; any remaining newly-desired chunks
   * are picked up on a later `update()` call once earlier requests have
   * resolved) and TerrainCancelMessage for no-longer-desired in-flight
   * requests, and fires onChunkEvicted for resident chunks that fell out of
   * the desired set. Does not itself fire onChunkReady (that happens from
   * `handleTerrainWorkerMessage` once the worker actually responds). No
   * allocation once the resident set has stabilised in steady state.
   */
  update(cameraWorldPos: Vec3Like, qualityTier: QualityTier): void;
  /** Feed one incoming terrain-worker message. src/core's main-thread message router calls this for every message the terrain worker posts. Fires onChunkReady synchronously for a `chunkReady` whose requestId is still desired (a `chunkReady` for an already-cancelled/superseded request is silently dropped). */
  handleTerrainWorkerMessage(msg: TerrainToMainMessage | TerrainToMainMessageExt): void;
  /** Single-subscriber callback, replaced (not appended) on repeated calls, invoked once per newly-resident chunk. The passed ResidentChunkInfo is only guaranteed valid for the duration of the callback. */
  onChunkReady(callback: (chunk: ResidentChunkInfo) => void): void;
  /** Single-subscriber callback invoked once per evicted chunk key (LOD merge or out-of-range). Consumer must dispose any GPU resources keyed by `key`. */
  onChunkEvicted(callback: (key: ChunkKey) => void): void;
  /** Current resident set. For debugging/HUD only — module 08's per-frame path should use the callbacks above, not poll this (this method allocates a fresh readonly array view each call). */
  getResidentChunks(): readonly ResidentChunkInfo[];
  dispose(): void;
}

export type CreateChunkManager = (config: ChunkManagerConfig, sendToTerrainWorker: SendToTerrainWorker) => ChunkManager;
