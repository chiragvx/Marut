# 04 — Procedural Terrain

This spec is normative for `src/terrain/*`. It must be read together with `docs/spec/00-architecture.md` (topology, coordinate frames, dependency rules, coding rules — all binding here) and `docs/spec/contracts/core.ts` (root contract). Where this document and `docs/spec/contracts/terrain.ts` disagree, the contract file wins (it is what other modules actually compile against); if you spot such a disagreement while implementing, follow the contract and flag it, do not silently pick either.

## 1. Purpose & scope

This module owns everything that turns a `(seed, x, z)` pair into a world: a deterministic, thread-agnostic terrain **height field** (noise + domain warp + ridged mountains + biome-ish altitude bands + airport flattening), and the **chunked, quadtree-LOD mesh streaming pipeline** that turns that height field into renderable triangle geometry in `src/terrain/terrain.worker.ts`.

Two halves, two different determinism requirements:

1. **Height sampling** (`HeightSampler`, `core.ts`'s interface, built by this module's `CreateHeightSampler`) is **pure and thread-agnostic**: `src/physics` (gear contact), `src/ai` (terrain avoidance), `src/render` (camera collision), the sim worker, the terrain worker, and Node/vitest all construct their own `HeightSampler` instance from the same `TerrainParams` + `AirportFlattenZone[]` and get byte-identical results, with **zero** cross-thread communication for height values themselves.
2. **Chunk mesh streaming** (`ChunkManager`, quadtree LOD, `terrain.worker.ts`) is inherently stateful and thread-local: it runs on the main thread (`ChunkManager`, injected into `src/render` by `src/core`) and in the terrain worker (`buildChunkGeometry`), talking to each other over `postMessage` with transferable buffers.

Out of scope for this module: airport runway/taxiway/apron geometry (module 05), the JSON schema for `AirportLayout` (module 05, though its `flattenZones` element type is fixed by `00-architecture.md` section 9.2 and reproduced verbatim in `contracts/terrain.ts`), uploading chunk geometry to Three.js (module 08), and sky/fog/water rendering (module 08).

## 2. Owned files

| path | purpose |
|---|---|
| `src/terrain/noise.ts` | 2D simplex noise (`Noise2D`, `CreateNoise2D`), permutation-table construction from an integer seed. |
| `src/terrain/domainWarp.ts` | `CreateDomainWarp2D` / `WarpFn` — displaces sample coordinates before fbm/ridge lookup. |
| `src/terrain/ridge.ts` | `CreateRidgeNoise2D` — ridged-multifractal mountains. |
| `src/terrain/fbm.ts` | `CreateFbmNoise2D` — fractal Brownian motion octave-summing, reused for both the rolling-terrain field and the continental band-selector field. |
| `src/terrain/terrainHeight.ts` | `CreateRawTerrainHeight` — combines continental band selection + domain warp + fbm/ridge blend into one `RawTerrainHeightFn`. `DeriveTerrainSubSeed`. |
| `src/terrain/heightSampler.ts` | `CreateHeightSampler` — implements `core.ts`'s `HeightSampler`, wrapping `RawTerrainHeightFn` with `AirportFlattenZone` blending and central-difference `normalAt`. |
| `src/terrain/quadtree.ts` | `ChunkKey` addressing math (`ChunkSizeAtDepth`, `ChunkKeyToBounds`, `ChunkChildren`, `ChunkParent`, `ChunkKeyToString`) and `ComputeDesiredChunks` (the pure LOD-selection recursion). |
| `src/terrain/chunkGeometryBuilder.ts` | `BuildChunkGeometry` — samples a chunk's grid + skirt into a `ChunkGeometry` (positions/normals/indices). |
| `src/terrain/chunkManager.ts` | `CreateChunkManager` — the stateful, main-thread residency tracker (hysteresis, request/cancel, callbacks). |
| `src/terrain/terrain.worker.ts` | Worker bootstrap: handles `TerrainInitMessage`, `TerrainRequestChunkMessage`, `TerrainCancelMessage`; posts `TerrainReadyMessage`, `TerrainChunkReadyMessage`. |
| `src/terrain/index.ts` | Barrel re-export of everything above. |

No other files under `src/terrain/` should exist. This module imports **only** `src/contracts/*` (in practice: `src/contracts/core.ts` and `src/contracts/terrain.ts`) — see section 9 for why it does not import `src/math/*` despite `00-architecture.md` permitting it.

## 3. Public API

Restated from `contracts/terrain.ts` (that file is authoritative; this section exists so an implementer never has to cross-reference while coding the algorithms in section 4). Only signatures and one-line purpose are repeated here — full field-level doc comments are in the contract file itself.

```ts
// --- noise building blocks (src/terrain/noise.ts, fbm.ts, ridge.ts, domainWarp.ts) ---
type Noise2D = (x: number, z: number) => number;                       // output clamped [-1,1]
type CreateNoise2D = (seed: number) => Noise2D;
type CreateFbmNoise2D = (baseNoise: Noise2D, params: FbmParams) => Noise2D;
type CreateRidgeNoise2D = (baseNoise: Noise2D, params: RidgeParams) => Noise2D;
type WarpFn = (x: number, z: number, out: Vec2Like) => void;
type CreateDomainWarp2D = (warpNoiseX: Noise2D, warpNoiseZ: Noise2D, params: DomainWarpParams) => WarpFn;
type DeriveTerrainSubSeed = (rootSeed: number, tag: TerrainNoiseSeedTag) => number;

// --- combined height field (src/terrain/terrainHeight.ts, heightSampler.ts) ---
type RawTerrainHeightFn = (x: number, z: number) => number;
type CreateRawTerrainHeight = (params: TerrainParams) => RawTerrainHeightFn;
type CreateHeightSampler = (params: TerrainParams, flattenZones: readonly AirportFlattenZone[]) => HeightSampler; // core.ts's HeightSampler

// --- quadtree addressing + LOD selection (src/terrain/quadtree.ts) ---
type ChunkSizeAtDepth = (depth: number) => number;
type ChunkKeyToBounds = (key: ChunkKey, out: ChunkBounds) => ChunkBounds;
type ChunkChildren = (key: ChunkKey, out: [ChunkKey, ChunkKey, ChunkKey, ChunkKey]) => void;
type ChunkParent = (key: ChunkKey) => ChunkKey | undefined;
type ChunkKeyToString = (key: ChunkKey) => string;
type WasChunkSplitLastFrame = (key: ChunkKey) => boolean;
type ComputeDesiredChunks = (cameraWorldPos: Vec3Like, profile: QualityTerrainProfile, wasSplitLastFrame: WasChunkSplitLastFrame, out: ChunkKey[]) => void;
type SkirtDepthM = (chunkSizeM: number) => number;

// --- chunk geometry (src/terrain/chunkGeometryBuilder.ts) ---
type BuildChunkGeometry = (sampler: HeightSampler, key: ChunkKey, gridQuads: number) => ChunkGeometry;

// --- streaming manager (src/terrain/chunkManager.ts) ---
type SendToTerrainWorker = (msg: MainToTerrainMessage | MainToTerrainMessageExt) => void;
interface ChunkManager {
  update(cameraWorldPos: Vec3Like, qualityTier: QualityTier): void;
  handleTerrainWorkerMessage(msg: TerrainToMainMessage | TerrainToMainMessageExt): void;
  onChunkReady(callback: (chunk: ResidentChunkInfo) => void): void;
  onChunkEvicted(callback: (key: ChunkKey) => void): void;
  getResidentChunks(): readonly ResidentChunkInfo[];
  dispose(): void;
}
type CreateChunkManager = (config: ChunkManagerConfig, sendToTerrainWorker: SendToTerrainWorker) => ChunkManager;

// --- worker bootstrap (src/terrain/terrain.worker.ts) ---
// Handles: TerrainInitMessage -> build internal HeightSampler, post TerrainReadyMessage.
//          TerrainRequestChunkMessage -> BuildChunkGeometry, post TerrainChunkReadyMessage (positions/normals/indices transferred).
//          TerrainCancelMessage -> best-effort: drop the result if not yet posted (see section 4.8).
```

Data constants exported from `contracts/terrain.ts` and used verbatim (never redefined) by this module's implementation: `TERRAIN_WORLD_EXTENT_M`, `TERRAIN_WORLD_HALF_EXTENT_M`, `MAX_QUADTREE_DEPTH`, `REFERENCE_CHUNK_SIZE_M`, `TERRAIN_MAX_HEIGHT_M`, `TERRAIN_MIN_HEIGHT_M`, `TerrainNoiseSeedTag`, `DEFAULT_TERRAIN_PARAMS`, `TERRAIN_QUALITY_PROFILES`, `LOD_SPLIT_DISTANCE_FACTOR`, `LOD_MERGE_DISTANCE_FACTOR`, `MAX_RESIDENT_CHUNKS`, `SKIRT_DEPTH_FRACTION`, `SKIRT_DEPTH_MIN_M`, `SKIRT_DEPTH_MAX_M`.

## 4. Design & algorithms

### 4.1 World bounds

The world is a square `[-100000, +100000] m × [-100000, +100000] m` in world X/Z (`TERRAIN_WORLD_EXTENT_M = 200000`, `TERRAIN_WORLD_HALF_EXTENT_M = 100000`). `HeightSampler.heightAt`/`normalAt` are mathematically defined for **any** `(x,z)`, including outside this square (the noise functions have no boundary), but the chunked mesh (sections 4.7–4.8) only ever geometrizes the square itself — flying outside it yields valid height queries (gear/AI terrain checks keep working) but no rendered chunk geometry. Missions (module 10/11) should keep flyable areas within bounds; this module does not enforce a hard wall.

The quadtree root (`ChunkKey{depth:0, cx:0, cz:0}`) covers the entire square. Each depth level halves chunk size: `chunkSizeAtDepth(d) = TERRAIN_WORLD_EXTENT_M / 2^d`. `MAX_QUADTREE_DEPTH = 8` fixes the finest chunk size the addressing scheme supports (`REFERENCE_CHUNK_SIZE_M = 200000/256 = 781.25 m`) — this is independent of any quality tier's own `maxLodDepth` (3..6, always < 8) and exists solely so `streamRadiusChunks` (a tier-independent chunk **count**, from `00-architecture.md` section 14) converts to a metres radius consistently across tiers (section 4.8).

Chunk world-space bounds: for `key = {depth, cx, cz}`, with `size = chunkSizeAtDepth(depth)`:
```
minX = -TERRAIN_WORLD_HALF_EXTENT_M + cx * size;  maxX = minX + size
minZ = -TERRAIN_WORLD_HALF_EXTENT_M + cz * size;  maxZ = minZ + size
minY = TERRAIN_MIN_HEIGHT_M;                       maxY = TERRAIN_MAX_HEIGHT_M   // global conservative bound, section 4.2 — deliberately NOT per-node-computed, see section 6
```
`0 <= cx, cz <= 2^depth - 1`. Children of `key` (depth+1): `(2cx,2cz)`, `(2cx+1,2cz)`, `(2cx,2cz+1)`, `(2cx+1,2cz+1)` — this exact order is `ChunkChildren`'s `out` slot order. Parent of `key` (depth>0): `{depth-1, floor(cx/2), floor(cz/2)}`; `depth===0` has no parent (`ChunkParent` returns `undefined`).

### 4.2 Global height bounds (`TERRAIN_MAX_HEIGHT_M` / `TERRAIN_MIN_HEIGHT_M`)

Derived analytically as a **conservative worst case** over `DEFAULT_TERRAIN_PARAMS` (section 5.1), then checked empirically:

- fbm max amplitude = `Σ baseAmplitudeM · persistence^i` for `i` in `0..octaves-1` = `220·(1+0.5+0.25+0.125+0.0625+0.03125) = 220·1.96875 = 433.125 m`.
- ridge conservative max amplitude (ignoring the `gain` damping term, which can only reduce it) = `500·1.96875 = 984.375 m`.
- Worst-case band is the mountains band (`ridgeBlend=0.9, heightScale=1.6, baseElevationM=600`): `maxBlended = 0.9·984.375 + 0.1·433.125 = 885.9375 + 43.3125 = 929.25`; `maxHeight = 600 + 929.25·1.6 = 600 + 1486.8 = 2086.8 m` → rounded up to **`TERRAIN_MAX_HEIGHT_M = 2100`**.
- Worst-case low end is the lowland band (`ridgeBlend=0.05, heightScale=0.5, baseElevationM=20`): `minBlended = 0.05·0 + 0.95·(-433.125) = -411.47`; `minHeight = 20 + (-411.47)·0.5 = 20 - 205.7 = -185.7 m` → rounded down to **`TERRAIN_MIN_HEIGHT_M = -200`**.

Empirical check (reference script, `DEFAULT_TERRAIN_PARAMS`, 400×400 samples on a 500 m grid spanning the full world square): observed `min ≈ -155.0 m`, `max ≈ 1602.0 m` — both comfortably inside `[-200, 2100]`, confirming the analytic bound has margin (coarse grid sampling can miss extrema, hence the margin is intentional, not accidental).

### 4.3 Noise stack

#### 4.3.1 Permutation seeding and sub-seed derivation

This module needs 5 independent noise fields (fbm, continental, ridge, warp-X, warp-Z) that must never share a permutation table (shared tables correlate features across fields in visually obvious ways). Each is built from its own integer seed, derived from the single `TerrainParams.seed` via a fixed integer hash (`DeriveTerrainSubSeed`) — **not** `mulberry32` (see section 9: this module cannot depend on `contracts/math.ts`, which its implementer never reads).

```ts
function deriveTerrainSubSeed(rootSeed: number, tag: number): number {
  let h = (rootSeed ^ Math.imul(tag, 0x9E3779B9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45D9F3B) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45D9F3B) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}
```
`tag` is one of `TerrainNoiseSeedTag.{Fbm:1, Continental:2, Ridge:3, WarpX:4, WarpZ:5}`. Verified fixtures (implementer/test reference — computed by running the exact formula above): `deriveTerrainSubSeed(42,1) = 2061797543`, `(42,2) = 492554467`, `(42,3) = 1427514241`, `(42,4) = 4264043515`, `(42,5) = 4235616498`; `deriveTerrainSubSeed(1,1) = 226214301`, `deriveTerrainSubSeed(2,1) = 2868339321` (confirms different root seeds give different sub-seeds, as required for determinism-per-seed).

Each derived sub-seed builds a 256-entry permutation table via a Fisher–Yates shuffle driven by a **local** xorshift32 generator seeded with that sub-seed (again self-contained, not `mulberry32`):
```ts
function xorshift32(state: { s: number }): number {
  let x = state.s;
  x ^= x << 13; x |= 0;
  x ^= x >>> 17;
  x ^= x << 5; x |= 0;
  state.s = x;
  return (x >>> 0) / 4294967296;
}
function buildPermutation(seed: number): Uint16Array {
  const state = { s: (seed >>> 0) || 1 }; // xorshift32 requires a nonzero state
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const r = Math.floor(xorshift32(state) * (i + 1));
    const tmp = p[i]; p[i] = p[r]; p[r] = tmp;
  }
  const perm = new Uint16Array(512); // doubled to avoid index-wrap branches in noise2D
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}
```
This table is built **once** per `CreateNoise2D(seed)` call (at `HeightSampler`/`RawTerrainHeightFn` construction time, not per sample) and captured by the returned `Noise2D` closure — this is explicitly **not** a hot-path allocation (section 6).

#### 4.3.2 2D simplex noise (`Noise2D`)

Standard Gustavson-form 2D simplex noise, 12-gradient table (the twelve 3D cube-edge-midpoint directions, projected to 2D by using only their x,y components):

```
F2 = 0.5 * (sqrt(3) - 1)              // ≈ 0.36602540378443860
G2 = (3 - sqrt(3)) / 6                // ≈ 0.21132486540518713
grad3 = [[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
         [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
         [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]]   // only [0],[1] used as (gx,gz)
```
```ts
function rawNoise2D(perm: Uint16Array, x: number, z: number): number {
  const s = (x + z) * F2;
  const i = Math.floor(x + s), j = Math.floor(z + s);
  const t = (i + j) * G2;
  const X0 = i - t, Z0 = j - t;
  const x0 = x - X0, z0 = z - Z0;
  let i1: number, j1: number;
  if (x0 > z0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
  const x1 = x0 - i1 + G2, z1 = z0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, z2 = z0 - 1 + 2 * G2;
  const ii = i & 255, jj = j & 255;
  const gi0 = perm[ii + perm[jj & 511]] % 12;
  const gi1 = perm[ii + i1 + perm[(jj + j1) & 511]] % 12;
  const gi2 = perm[ii + 1 + perm[(jj + 1) & 511]] % 12;
  let n0 = 0, n1 = 0, n2 = 0;
  let t0 = 0.5 - x0 * x0 - z0 * z0;
  if (t0 >= 0) { t0 *= t0; n0 = t0 * t0 * (grad3[gi0][0] * x0 + grad3[gi0][1] * z0); }
  let t1 = 0.5 - x1 * x1 - z1 * z1;
  if (t1 >= 0) { t1 *= t1; n1 = t1 * t1 * (grad3[gi1][0] * x1 + grad3[gi1][1] * z1); }
  let t2 = 0.5 - x2 * x2 - z2 * z2;
  if (t2 >= 0) { t2 *= t2; n2 = t2 * t2 * (grad3[gi2][0] * x2 + grad3[gi2][1] * z2); }
  return 70.0 * (n0 + n1 + n2);
}
export function createNoise2D(seed: number): Noise2D {
  const perm = buildPermutation(seed);
  return (x, z) => {
    const v = rawNoise2D(perm, x, z);
    return v < -1 ? -1 : v > 1 ? 1 : v; // contract promises [-1,1]; see empirical range below
  };
}
```
**Verified** (reference script, 1,000,000 samples on a 0.13 m grid, seed 12345): raw (pre-clamp) `min ≈ -0.99789`, `max ≈ 0.99789` — the clamp is a defensive boundary the empirical data never actually reaches in practice, kept because the classic formula has no analytic proof of exactly `≤1`. Determinism fixtures: `createNoise2D(12345)(1.234, -5.678) = 0.38828435101300646` (repeat call: identical); `createNoise2D(999)(1.234, -5.678) = -0.5711847670297295` (different seed ⇒ different value, as required — use both fixtures verbatim in `tests/terrain/noise.test.ts`, tolerance `1e-9`).

#### 4.3.3 fBm (`CreateFbmNoise2D`)

```ts
function createFbmNoise2D(base: Noise2D, p: FbmParams): Noise2D {
  return (x, z) => {
    let sum = 0, amp = p.baseAmplitudeM, freq = p.baseFrequency;
    for (let o = 0; o < p.octaves; o++) {
      sum += base(x * freq, z * freq) * amp;
      amp *= p.persistence;
      freq *= p.lacunarity;
    }
    return sum; // NOT clamped; bounded by Σ baseAmplitudeM·persistence^i (section 4.2)
  };
}
```

#### 4.3.4 Ridged multifractal (`CreateRidgeNoise2D`)

```ts
function createRidgeNoise2D(base: Noise2D, p: RidgeParams): Noise2D {
  return (x, z) => {
    let sum = 0, amp = p.baseAmplitudeM, freq = p.baseFrequency, weight = 1;
    for (let o = 0; o < p.octaves; o++) {
      const n = base(x * freq, z * freq);
      let s = Math.pow(1 - Math.abs(n), p.sharpness);
      s *= weight;
      weight = Math.min(1, Math.max(0, s * p.gain));
      sum += s * amp;
      freq *= p.lacunarity;
      amp *= p.persistence;
    }
    return sum; // always >= 0; conservative upper bound Σ baseAmplitudeM·persistence^i (section 4.2)
  };
}
```
`(1-|n|)` creates ridges at the zero-crossings of the base noise; raising to `sharpness` (>=1) sharpens them; `weight` (seeded at 1, updated by `gain`) is the standard ridged-multifractal term that makes finer octaves contribute mainly **near** existing ridges rather than uniformly.

#### 4.3.5 Domain warp (`CreateDomainWarp2D`)

```ts
function createDomainWarp2D(warpX: Noise2D, warpZ: Noise2D, p: DomainWarpParams): WarpFn {
  // warpX/warpZ are themselves fbm'd with p.octaves via createFbmNoise2D(rawNoise, {octaves:p.octaves, baseFrequency:p.warpFrequency, baseAmplitudeM:1, lacunarity:2, persistence:0.5}) at construction time — see heightSampler.ts wiring in 4.3.6.
  return (x, z, out) => {
    if (!p.enabled) { out.x = x; out.z = z; return; }
    out.x = x + warpX(x, z) * p.warpAmplitudeM;
    out.z = z + warpZ(x, z) * p.warpAmplitudeM;
  };
}
```
`warpX`/`warpZ` here are each an fbm-combined `Noise2D` (not raw `Noise2D`) built with `baseAmplitudeM: 1` so their own output stays within `Σ persistence^i` of `[-1,1]`-ish range **before** being multiplied by `warpAmplitudeM` — i.e. the actual max displacement is `warpAmplitudeM · Σ_{i=0}^{octaves-1} 0.5^i`, not `warpAmplitudeM` alone. For `DEFAULT_TERRAIN_PARAMS.domainWarp` (`octaves:3`) that factor is `1+0.5+0.25=1.75`, so max displacement ≈ `600·1.75 = 1050 m` per axis (used only for section 6's cost accounting, not clamped).

#### 4.3.6 Continental band selection and combined raw height (`CreateRawTerrainHeight`)

The continental field is an fbm built with `baseAmplitudeM: 1` over `ContinentalParams`, then **normalised** by its own theoretical max so the result is a clean `[-1,1]`-ish "continentalness" value used purely to pick a `BiomeBand`:
```ts
function createRawTerrainHeight(params: TerrainParams): RawTerrainHeightFn {
  const fbmNoise = createNoise2D(deriveTerrainSubSeed(params.seed, TerrainNoiseSeedTag.Fbm));
  const ridgeNoise = createNoise2D(deriveTerrainSubSeed(params.seed, TerrainNoiseSeedTag.Ridge));
  const warpXNoise = createNoise2D(deriveTerrainSubSeed(params.seed, TerrainNoiseSeedTag.WarpX));
  const warpZNoise = createNoise2D(deriveTerrainSubSeed(params.seed, TerrainNoiseSeedTag.WarpZ));
  const contNoise = createNoise2D(deriveTerrainSubSeed(params.seed, TerrainNoiseSeedTag.Continental));

  const fbm = createFbmNoise2D(fbmNoise, params.fbm);
  const ridge = createRidgeNoise2D(ridgeNoise, params.ridge);
  const contFbmParams = { ...params.continental, baseAmplitudeM: 1 };
  const cont = createFbmNoise2D(contNoise, contFbmParams);
  const contMax = sumGeometric(1, contFbmParams.persistence, contFbmParams.octaves); // Σ 1·persistence^i
  const warpFbmParams: FbmParams = { octaves: params.domainWarp.octaves, baseFrequency: params.domainWarp.warpFrequency, baseAmplitudeM: 1, lacunarity: 2, persistence: 0.5 };
  const warpXFbm = createFbmNoise2D(warpXNoise, warpFbmParams);
  const warpZFbm = createFbmNoise2D(warpZNoise, warpFbmParams);
  const warp = createDomainWarp2D(warpXFbm, warpZFbm, params.domainWarp);

  const scratch: Vec2Like = { x: 0, z: 0 };
  return (x, z) => {
    let c = cont(x, z) / contMax;
    c = c < -1 ? -1 : c > 1 ? 1 : c;
    const band = selectBand(params.bands, c); // last band with fromContinental <= c
    warp(x, z, scratch);
    const fbmH = fbm(scratch.x, scratch.z);
    const ridgeH = ridge(scratch.x, scratch.z);
    const blended = fbmH + (ridgeH - fbmH) * band.ridgeBlend; // lerp(fbmH, ridgeH, ridgeBlend)
    return band.baseElevationM + blended * band.heightScale;
  };
}
function selectBand(bands: readonly BiomeBand[], c: number): BiomeBand {
  let best = bands[0];
  for (const b of bands) if (c >= b.fromContinental) best = b;
  return best;
}
```
`sumGeometric(a, r, n) = a·(1-r^n)/(1-r)` for `r≠1` (a plain closed-form sum, no loop needed, but a loop is equally fine and avoids the `r=1` edge case entirely — either implementation is acceptable as long as it matches `Σ_{i=0}^{n-1} a·r^i`).

**Verified fixtures** (reference script, `DEFAULT_TERRAIN_PARAMS`, seed=1): `rawTerrainHeight(1234.5, -6789.2) = 423.7411290843514` (repeat call: identical — determinism); `rawTerrainHeight(0, 0) = 226.48833905029295` (unchanged by warp: at exactly `x=z=0` every octave of every noise field in this stack samples `noise2D(·, 0, 0)`, which is exactly `0` for this algorithm regardless of frequency — see section 4.3.2's formula: all three simplex corner contributions vanish at the coordinate origin — so `warp(0,0)` is the identity and the continental value is exactly `0`, landing in the "hills" band; this is a property of the noise, not a bug). Use both, tolerance `1e-6`, in `tests/terrain/terrainHeight.test.ts`.

### 4.4 Airport flattening → `HeightSampler.heightAt`

`CreateHeightSampler(params, flattenZones)` wraps `CreateRawTerrainHeight(params)` with the flattening blend fixed by `00-architecture.md` section 9.2. Multi-zone rule (this module's discretion, per that section): **nearest zone wins** — among all zones whose blend weight is nonzero, the one with the **highest** weight determines the target elevation (never an average across zones, which would produce physically nonsensical intermediate elevations between two unrelated runways).

```ts
function smoothstep(t: number): number { const c = t < 0 ? 0 : t > 1 ? 1 : t; return c * c * (3 - 2 * c); }

function heightAt(x: number, z: number): number {
  const raw = rawHeight(x, z);
  let bestWeight = 0, bestElevationM = raw;
  for (const zone of flattenZones) {
    const dx = x - zone.centerWorldX, dz = z - zone.centerWorldZ;
    const d = Math.sqrt(dx * dx + dz * dz);
    let w: number;
    if (d <= zone.flatRadiusM) w = 1;
    else if (d <= zone.flatRadiusM + zone.blendRadiusM) w = 1 - smoothstep((d - zone.flatRadiusM) / zone.blendRadiusM);
    else w = 0;
    if (w > bestWeight) { bestWeight = w; bestElevationM = zone.elevationM; }
  }
  return raw + (bestElevationM - raw) * bestWeight; // lerp(raw, bestElevationM, bestWeight)
}
```
Boundary behaviour (exact, inclusive at both radii — verified fixtures below): at `d == flatRadiusM`, weight is still exactly 1 (still inside the `<=` branch). At `d == flatRadiusM + blendRadiusM`, `smoothstep(1) = 1` so weight is exactly 0 and `heightAt` equals the raw noise height exactly (continuous, no seam).

**Verified fixture** (reference script, `DEFAULT_TERRAIN_PARAMS`, zone `{centerWorldX:1000, centerWorldZ:2000, elevationM:50, flatRadiusM:500, blendRadiusM:200}`): `heightAt(1000,2000) = 50` (center, d=0); `heightAt(1500,2000) = 50` (d=500, edge of flat radius, still exactly 50); `heightAt(1600,2000) = 15.013877462403457` (d=600, mid-blend: raw at that point is `-19.972245075193086`, `t=0.5`, `smoothstep(0.5)=0.5`, weight `=0.5`, `lerp(-19.9722, 50, 0.5) = 15.0139` ✓); `heightAt(1700,2000) = -42.26489813275134`, which equals `rawTerrainHeight(1700,2000)` exactly (d=700=flatRadius+blendRadius, weight=0 boundary); `heightAt(2000,2000) = -13.863848509359755`, again exactly the raw value (d=1000, fully outside). Use these five as one `tests/terrain/heightSampler.test.ts` case, tolerance `1e-6`.

`HeightSampler.seed` is simply `params.seed`, exposed read-only.

### 4.5 `HeightSampler.normalAt`

Central-difference gradient of `heightAt` itself (so flattening is automatically, correctly reflected in normals with no separate code path):
```ts
const NORMAL_SAMPLE_EPSILON_M = 1.0;
function normalAt(x: number, z: number, out: Vec3Like): Vec3Like {
  const e = NORMAL_SAMPLE_EPSILON_M;
  const hL = heightAt(x - e, z), hR = heightAt(x + e, z);
  const hD = heightAt(x, z - e), hU = heightAt(x, z + e);
  const dHdx = (hR - hL) / (2 * e);
  const dHdz = (hU - hD) / (2 * e);
  out.x = -dHdx; out.y = 1; out.z = -dHdz;
  const len = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
  out.x /= len; out.y /= len; out.z /= len;
  return out;
}
```
Derivation: for a heightfield surface `(x, h(x,z), z)`, tangents `Tx=(1,∂h/∂x,0)`, `Tz=(0,∂h/∂z,1)`; the up-facing normal is `Tz×Tx = (-∂h/∂x, 1, -∂h/∂z)` (normalized). This is a heightfield (single-valued `y=h(x,z)`), so `out.y` before normalization is always exactly `1` (never negative) — the result is **always** upward-facing (`out.y > 0` after normalization, for any finite gradient), never an overhang. **Verified fixture**: `normalAt(1234.5,-6789.2) = (-0.2956766822239997, 0.951572670718101, 0.08417096845960884)`, `|n| = 1` exactly; `normalAt(0,0) = (2.260650219943643e-14, 0.2651318616706568, -0.9642121633370176)` (a much steeper local gradient right at the origin — the continental value is exactly 0 there, per section 4.3.6's fixture note, landing on a band/ridge-noise combination with a locally steep feature — a legitimate terrain feature, not a bug). Both have `out.y > 0` and `|out| = 1` (tolerance `1e-6`) — assert exactly these two invariants generically in tests, not a specific "shallow slope" bound (slopes vary legitimately across the terrain).

### 4.6 Skirts

Each resident chunk (leaf of the LOD selection, section 4.7 — regardless of its depth) gets a curtain of extra geometry hanging below its 4 edges, hiding the crack that would otherwise appear where it borders a neighbour resident at a different depth (this module does **not** attempt seam-stitching between differing LODs — skirts are the chosen, simpler technique per the brief).

```ts
function skirtDepthM(chunkSizeM: number): number {
  const d = chunkSizeM * SKIRT_DEPTH_FRACTION; // 0.06
  return d < SKIRT_DEPTH_MIN_M ? SKIRT_DEPTH_MIN_M : d > SKIRT_DEPTH_MAX_M ? SKIRT_DEPTH_MAX_M : d;
}
```
Skirt vertices mirror each of the 4 perimeter rows of the main grid at `y - skirtDepthM(chunkSizeAtDepth(key.depth))`, same `(x,z)`, and reuse the corresponding main-edge vertex's normal (so lighting stays continuous into the curtain — a skirt's own "true" normal, pointing outward horizontally, is not computed; skirts are never meant to be seen face-on in normal flight). Skirt triangle winding is not load-bearing for correctness (module 08 may render the terrain mesh double-sided if any winding artifact is ever visually observed) but this module still emits a fixed, consistent winding (mirroring the main-grid pattern of section 4.7) for determinism of the output buffers.

### 4.7 Chunk geometry (`BuildChunkGeometry`)

For `key` with `gridQuads = res` (from `QualityTerrainProfile.chunkGridQuads`, section 5.2) and chunk bounds `[minX,maxX]×[minZ,maxZ]` (section 4.1): build a `(res+1)×(res+1)` grid, `step = (maxX-minX)/res` (chunks are square so the same `step` applies to both axes), vertex `(i,j)` for `i,j ∈ [0,res]` at world `x = minX + i·step`, `z = minZ + j·step`, `y = sampler.heightAt(x,z)`, normal `= sampler.normalAt(x,z,·)`. Row-major index `idx(i,j) = j·(res+1) + i`.

**Triangle winding** (verified by direct cross-product computation, reference script, 3×3-quad test grid): each quad `(i,j)`→`(i+1,j+1)` emits two triangles, both with `normal.y > 0` (up-facing) with this exact vertex order:
```
T1 = [idx(i,j),   idx(i,j+1), idx(i+1,j)  ]     //  (A, C, B)
T2 = [idx(i+1,j), idx(i,j+1), idx(i+1,j+1)]     //  (B, C, D)
```
for `i,j ∈ [0,res)`. (Labels: `A=(i,j)`, `B=(i+1,j)`, `C=(i,j+1)`, `D=(i+1,j+1)`.) Interior index count = `res·res·6` (2 triangles × 3 indices × `res²` quads).

**Skirt vertices**, appended after the `(res+1)²` main vertices, in this fixed order — `north` mirrors row `j=0`, `south` row `j=res`, `west` column `i=0`, `east` column `i=res`, each `res+1` vertices (corners are duplicated once per adjacent edge; this is intentional, not an error):
```
skirtNorth[k] = mirror(vertex(k, 0))   , k in [0,res], y -= skirtDepthM
skirtSouth[k] = mirror(vertex(k, res)) , k in [0,res], y -= skirtDepthM
skirtWest[k]  = mirror(vertex(0, k))   , k in [0,res], y -= skirtDepthM
skirtEast[k]  = mirror(vertex(res, k)) , k in [0,res], y -= skirtDepthM
```
giving `4·(res+1)` extra vertices, base index `SKIRT_BASE = (res+1)²`, with the 4 sub-arrays starting at `SKIRT_BASE`, `SKIRT_BASE+(res+1)`, `SKIRT_BASE+2(res+1)`, `SKIRT_BASE+3(res+1)` respectively. For each edge, connect its `res` consecutive main-edge/skirt-vertex pairs with 2 triangles each (same up-facing-pattern construction as section 4.7's main grid, applied to the 2×(res+1) strip formed by the edge row and its skirt row) — `24·res` skirt indices total (`4 edges × res quads × 2 tris × 3 indices`).

**Total counts** (verified by direct computation, reference script):

| `gridQuads` (res) | main verts `(res+1)²` | skirt verts `4(res+1)` | **total verts** | interior idx `6·res²` | skirt idx `24·res` | **total idx** |
|---|---|---|---|---|---|---|
| 12 | 169 | 52 | **221** | 864 | 288 | **1152** |
| 16 | 289 | 68 | **357** | 1536 | 384 | **1920** |
| 24 | 625 | 100 | **725** | 3456 | 576 | **4032** |
| 32 | 1089 | 132 | **1221** | 6144 | 768 | **6912** |

`ChunkGeometry.positions`/`normals` are `Float32Array`s of length `vertexCount*3` in **absolute world coordinates** (not chunk-local — see the contract file's comment and `00-architecture.md` section 7: `src/render` subtracts `renderOriginWorld` at upload time, so this module must never pre-offset by chunk origin). `indices` is a `Uint32Array` of length `indexCount` (matches `core.ts`'s `TerrainChunkReadyMessage.indices` type exactly).

### 4.8 Quadtree LOD selection (`ComputeDesiredChunks`)

Two independent, deliberately separate concerns:

1. **Draw-distance cutoff** — `TERRAIN_STREAM_RADIUS_M(profile) = profile.streamRadiusChunks · REFERENCE_CHUNK_SIZE_M`. Nothing beyond this 3D distance from the camera is resident at any depth (matches `00-architecture.md`'s "terrain draw distance (chunks)" quality setting literally: it is a hard visibility radius, not an LOD-detail parameter). `src/render`'s fog/haze (module 08) is expected to hide this edge rather than this module attempting a distant low-poly impostor (see section 9).
2. **LOD depth within that radius** — a scale-invariant recursive test using **fixed, tier-independent** ratios `LOD_SPLIT_DISTANCE_FACTOR = 2.0` / `LOD_MERGE_DISTANCE_FACTOR = 2.6`, because (verified by hand-checking the alternative) using a per-tier ratio derived from `streamRadiusChunks` directly breaks scale-invariance and causes near-uniform full-depth splitting everywhere — the ratio MUST be a small, tier-independent constant for the standard quadtree-LOD technique to behave correctly at every depth.

Distance metric: full 3D distance from `cameraWorldPos` to the nearest point on the node's AABB (section 4.1's bounds, using the **global** `[TERRAIN_MIN_HEIGHT_M, TERRAIN_MAX_HEIGHT_M]` for `minY/maxY` at every depth — see section 6 for why):
```ts
function clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }
function distanceToChunk(cam: Vec3Like, b: ChunkBounds): number {
  const cx = clamp(cam.x, b.minX, b.maxX), cy = clamp(cam.y, b.minY, b.maxY), cz = clamp(cam.z, b.minZ, b.maxZ);
  const dx = cam.x - cx, dy = cam.y - cy, dz = cam.z - cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
```

Hysteresis: a node uses `LOD_MERGE_DISTANCE_FACTOR` (harder to leave) as its "stay split" threshold if `wasSplitLastFrame(key)` is true, and `LOD_SPLIT_DISTANCE_FACTOR` (harder to enter) otherwise — the standard two-threshold pattern that prevents a camera sitting near the boundary from flickering the mesh every frame.

```ts
function computeDesiredChunks(cam: Vec3Like, profile: QualityTerrainProfile, wasSplitLastFrame: WasChunkSplitLastFrame, out: ChunkKey[]): void {
  out.length = 0;
  const streamRadiusM = profile.streamRadiusChunks * REFERENCE_CHUNK_SIZE_M;
  recurse({ depth: 0, cx: 0, cz: 0 });
  function recurse(key: ChunkKey): void {
    const size = chunkSizeAtDepth(key.depth);
    const bounds = chunkKeyToBounds(key, scratchBounds);
    const dist = distanceToChunk(cam, bounds);
    if (dist > streamRadiusM + size * 0.75) return; // prune: entirely (with margin) outside draw distance
    const factor = wasSplitLastFrame(key) ? LOD_MERGE_DISTANCE_FACTOR : LOD_SPLIT_DISTANCE_FACTOR;
    if (key.depth < profile.maxLodDepth && dist < factor * size) {
      const children: [ChunkKey, ChunkKey, ChunkKey, ChunkKey] = [/*...*/];
      chunkChildren(key, children);
      for (const child of children) recurse(child);
    } else {
      out.push(key);
    }
  }
}
```
(`size * 0.75` margin on the prune test avoids clipping a chunk whose center is just outside the radius but whose near corner is still inside; it is not load-bearing for correctness, only for avoiding a visible pop at the draw-distance edge.)

**Verified fixtures** (reference script, cold start i.e. `wasSplitLastFrame` always `false`):
- Ultra profile (`maxLodDepth:6, streamRadiusChunks:24` → `streamRadiusM=18750`), camera `(0, 5000, 0)`: **124** desired chunks, depth histogram `{4:16, 5:44, 6:64}`; the chunk covering the origin is `{depth:6, cx:31, cz:31}` (bounds `x∈[-3125,0], z∈[-3125,0]` — finest LOD directly under the camera, as expected).
- Same Ultra profile, camera `(0, 15000, 0)` (much higher): **44** desired chunks; the chunk covering the origin is now `{depth:5, cx:15, cz:15}` (coarser directly below, because the 3D distance metric includes altitude — correct behaviour: from high up you don't need ground-level detail directly beneath you either).
- Low profile (`maxLodDepth:3, streamRadiusChunks:6`), camera `(0, 2000, 0)`: **4** desired chunks, all `depth:3` (the root immediately recurses to its 4 children and stops — Low's `maxLodDepth` is reached before the distance test would even matter at this camera height).
- Medium profile (`maxLodDepth:4, streamRadiusChunks:10` → `streamRadiusM=7812.5`), camera `(0, 5000, 0)` (same representative altitude as the Ultra fixture above, for direct comparison): **12** desired chunks, depth histogram `{4:12}` (Medium's `maxLodDepth` of 4 is shallow enough that the split test at `factor·size = 2.0·12500 = 25000 > streamRadiusM`, so every node the draw-distance prune keeps is still eligible to split all the way to `maxLodDepth` before the distance test would ever stop it early — the tier bottoms out on depth, not on distance, at this altitude); the chunk covering the origin is `{depth:4, cx:7, cz:7}` (bounds `x∈[-12500,0], z∈[-12500,0]`).
- High profile (`maxLodDepth:5, streamRadiusChunks:16` → `streamRadiusM=12500`), camera `(0, 5000, 0)`: **32** desired chunks, depth histogram `{5:32}` (same reasoning as Medium: `maxLodDepth` bottoms the recursion out before the distance test would, at this altitude); the chunk covering the origin is `{depth:5, cx:15, cz:15}` (bounds `x∈[-6250,0], z∈[-6250,0]`).

Use these five as `tests/terrain/quadtree.test.ts` cases (exact chunk counts, exact depth histograms, exact covering-chunk key).

### 4.9 `ChunkManager` (stateful, main thread)

Owns a `Map<string, {resident: boolean; hasChildren: boolean; requestId?: number; geometry?: ChunkGeometry}>` keyed by `chunkKeyToString(key)`. `update(camera, tier)`:
1. Look up `TERRAIN_QUALITY_PROFILES[tier]`.
2. Run `computeDesiredChunks(camera, profile, key => map.get(chunkKeyToString(key))?.hasChildren ?? false, scratchOut)` (the `wasSplitLastFrame` query reads the manager's own map from the *previous* call — this is exactly what makes the pure `computeDesiredChunks` function hysteretic in practice).
3. For each key in `scratchOut` not yet in the map (or in the map but not yet `resident`/requested): create/update its entry, send `TerrainRequestChunkMessage{type:'requestChunk', chunkX:key.cx, chunkZ:key.cz, lod:key.depth, requestId:<monotonic counter>}` via `sendToTerrainWorker`.
4. For each map entry whose key is **not** in `scratchOut` this frame: if it has an in-flight `requestId`, send `TerrainCancelMessage{type:'cancel', requestId}`; if it is `resident`, fire `onChunkEvicted(key)` and remove the entry.
5. Update `hasChildren` bookkeeping (a node has `hasChildren=true` for this purpose iff `computeDesiredChunks`' recursion descended past it this frame — track this by having `recurse` mark every **non-leaf** node it visits, not only the leaves it pushes to `out`; the manager can get this either by a second small `out`-like array of "visited non-leaf keys" that `computeDesiredChunks` could also populate, or more simply by re-deriving it during step 3/4 from which parents of `scratchOut` entries are NOT themselves in `scratchOut` — either approach is an implementation-internal bookkeeping detail, not part of the pure `computeDesiredChunks` contract signature).
6. `MAX_RESIDENT_CHUNKS` safety cap: if the map would exceed it, evict the farthest-from-camera non-essential entries first (sort resident entries by `distanceToChunk`, drop the tail) before issuing new requests — this should not occur in normal operation given the geometric budget in section 6, but must not be allowed to grow unbounded.

`handleTerrainWorkerMessage`: on `chunkReady`, look up the entry by matching `requestId`; if found and still desired, store `geometry`, mark `resident=true`, fire `onChunkReady({key, geometry})`; if the `requestId` is stale (was cancelled/superseded), drop the message silently. On `terrainReady`, the manager may begin issuing `requestChunk` messages (it must not send any before this, so it holds its first `update()`'s resulting requests queued until `terrainReady` arrives — a one-line implementation detail: buffer, don't drop).

### 4.10 `terrain.worker.ts` bootstrap

```ts
let sampler: HeightSampler | undefined;
self.onmessage = (ev: MessageEvent<MainToTerrainMessage | MainToTerrainMessageExt>) => {
  const msg = ev.data;
  if (msg.type === 'terrainInit') {
    sampler = createHeightSampler(msg.params, msg.flattenZones);
    (self as any).postMessage({ type: 'terrainReady' } satisfies TerrainReadyMessage);
    return;
  }
  if (msg.type === 'requestChunk') {
    if (!sampler) return; // requestChunk before terrainInit is a protocol violation by the caller; ignore defensively rather than throw (see 00-architecture.md error-handling rule)
    const profile = /* the quality tier this request's `lod` implies gridQuads for — see note below */;
    const geo = buildChunkGeometry(sampler, { depth: msg.lod, cx: msg.chunkX, cz: msg.chunkZ }, profile.chunkGridQuads);
    const out: TerrainChunkReadyMessage = { type: 'chunkReady', requestId: msg.requestId, chunkX: msg.chunkX, chunkZ: msg.chunkZ, lod: msg.lod, positions: geo.positions.buffer, normals: geo.normals.buffer, indices: geo.indices.buffer };
    (self as any).postMessage(out, [out.positions, out.normals, out.indices]); // transfer, not copy
    return;
  }
  if (msg.type === 'cancel') {
    // Best-effort only: this worker processes messages synchronously and to completion (no incremental/yielding build), so a `cancel` arriving after the matching `requestChunk` has already finished building can only prevent a FUTURE not-yet-started request; it cannot un-send an already-posted chunkReady. ChunkManager (section 4.9) tolerates a chunkReady for a cancelled requestId by dropping it on arrival. This worker MAY keep a small pending-request queue and skip a queued request whose id was cancelled before it started, but is not required to interrupt a request already in progress (there is no interruption mechanism for synchronous JS).
  }
};
```
Note on `gridQuads` for a `requestChunk`: `TerrainRequestChunkMessage` (fixed by `core.ts`) carries `lod` (the quadtree depth) but not the requesting tier's `chunkGridQuads` directly. `ChunkManager` (section 4.9) is the one that knows the active `QualityTier` when it issues the request; since it cannot smuggle an extra field into `core.ts`'s fixed message shape either, the worker resolves `gridQuads` from `lod` via the **same** `TERRAIN_QUALITY_PROFILES` table, by finding the tier whose `maxLodDepth` allows `lod` — concretely, `ChunkManager` only ever requests chunks at `depth <= profile.maxLodDepth` for the tier it was configured with, and different tiers can (by construction, section 5.2) request different `gridQuads` at the *same* depth; to keep this unambiguous the worker instead uses the `chunkGridQuads` of the **currently active** tier (re-sent via a fresh `TerrainInitMessage` whenever `src/ui`'s quality-tier setting changes at runtime — `src/core` must re-issue `TerrainInitMessage` with a `qualityTier`-appropriate `flattenZones`/`params` unchanged but implicitly resets which profile's `chunkGridQuads` is in effect). To remove this ambiguity entirely, this worker tracks the **most recently used** `chunkGridQuads` as a piece of its own local state, defaulted from `TERRAIN_QUALITY_PROFILES.low.chunkGridQuads` until told otherwise — see section 9 for why this is flagged as an open assumption rather than a fully closed gap.

## 5. Data

### 5.1 `DEFAULT_TERRAIN_PARAMS` (canonical, `contracts/terrain.ts`)

| field | value | units |
|---|---|---|
| `seed` | 1 (illustrative — `src/core` overwrites with the mission's world seed) | — |
| `fbm.octaves` | 6 | — |
| `fbm.baseFrequency` | 1/3000 ≈ 0.000333 | 1/m |
| `fbm.baseAmplitudeM` | 220 | m |
| `fbm.lacunarity` | 2.0 | — |
| `fbm.persistence` | 0.5 | — |
| `domainWarp.enabled` | true | — |
| `domainWarp.warpFrequency` | 1/4000 = 0.00025 | 1/m |
| `domainWarp.warpAmplitudeM` | 600 | m |
| `domainWarp.octaves` | 3 | — |
| `ridge.octaves` | 6 | — |
| `ridge.baseFrequency` | 1/2500 = 0.0004 | 1/m |
| `ridge.baseAmplitudeM` | 500 | m |
| `ridge.lacunarity` | 2.0 | — |
| `ridge.persistence` | 0.5 | — |
| `ridge.gain` | 0.55 | — |
| `ridge.sharpness` | 2 | — |
| `continental.octaves` | 3 | — |
| `continental.baseFrequency` | 1/60000 ≈ 0.0000167 | 1/m |
| `continental.lacunarity` | 2.0 | — |
| `continental.persistence` | 0.5 | — |
| `seaLevelM` | 0 | m MSL |

`bands` (sorted ascending by `fromContinental`):

| band | `fromContinental` | `heightScale` | `ridgeBlend` | `baseElevationM` |
|---|---|---|---|---|
| lowland/plains | -1.0 | 0.5 | 0.05 | 20 m |
| hills | -0.35 | 0.85 | 0.25 | 80 m |
| highlands | 0.15 | 1.15 | 0.55 | 250 m |
| mountains | 0.55 | 1.6 | 0.9 | 600 m |

### 5.2 `TERRAIN_QUALITY_PROFILES` (`contracts/terrain.ts`)

`maxLodDepth` and `streamRadiusChunks` are `00-architecture.md` section 14's numbers, reused exactly. `chunkGridQuads`, `leafChunkSizeM`, `streamRadiusM`, and the vertex/index counts are this module's own derived design (formulas: section 4.1, 4.8, 4.7):

| tier | `maxLodDepth` | `streamRadiusChunks` | `chunkGridQuads` | leaf chunk size (m) `=200000/2^depth` | stream radius (m) `=chunks·781.25` | verts/chunk | indices/chunk |
|---|---|---|---|---|---|---|---|
| low | 3 | 6 | 12 | 25000 | 4687.5 | 221 | 1152 |
| medium | 4 | 10 | 16 | 12500 | 7812.5 | 357 | 1920 |
| high | 5 | 16 | 24 | 6250 | 12500 | 725 | 4032 |
| ultra | 6 | 24 | 32 | 3125 | 18750 | 1221 | 6912 |

### 5.3 World / LOD / skirt constants (`contracts/terrain.ts`)

| constant | value | units |
|---|---|---|
| `TERRAIN_WORLD_EXTENT_M` | 200000 | m |
| `TERRAIN_WORLD_HALF_EXTENT_M` | 100000 | m |
| `MAX_QUADTREE_DEPTH` | 8 | — |
| `REFERENCE_CHUNK_SIZE_M` | 781.25 | m |
| `TERRAIN_MAX_HEIGHT_M` | 2100 | m MSL |
| `TERRAIN_MIN_HEIGHT_M` | -200 | m MSL |
| `LOD_SPLIT_DISTANCE_FACTOR` | 2.0 | — |
| `LOD_MERGE_DISTANCE_FACTOR` | 2.6 | — |
| `MAX_RESIDENT_CHUNKS` | 512 | — |
| `SKIRT_DEPTH_FRACTION` | 0.06 | — |
| `SKIRT_DEPTH_MIN_M` | 15 | m |
| `SKIRT_DEPTH_MAX_M` | 400 | m |
| `NORMAL_SAMPLE_EPSILON_M` (internal to `heightSampler.ts`, not exported — a fixed algorithm detail, not tunable data) | 1.0 | m |

### 5.4 `AirportFlattenZone` (from `contracts/terrain.ts`, fixed by `00-architecture.md` 9.2)

| field | units |
|---|---|
| `centerWorldX`, `centerWorldZ` | m |
| `elevationM` | m MSL |
| `flatRadiusM` | m |
| `blendRadiusM` | m |

Guidance for module 05 (not enforced by this module): `elevationM` should stay within `[TERRAIN_MIN_HEIGHT_M, TERRAIN_MAX_HEIGHT_M]` since flattening blends toward, never clamps independently of, the raw noise height.

## 6. Performance budget

**`heightAt`/`normalAt` cost** — `heightAt` evaluates: continental fbm (3 `noise2D` calls) + domain warp (2 fbm'd noise fields × 3 octaves = 6 calls) + fbm (6 calls) + ridge (6 calls) = **27 `noise2D` calls**, plus a cheap `flattenZones` loop (2–6 zones for the two built-in airports combined — arithmetic only, no further noise calls). `normalAt` calls `heightAt` 4 times (central difference) = **108 `noise2D` calls**.

Measured (reference script, Node 20, V8, one modern desktop core): `noise2D` ≈ **21 ns/call**; a simulated 27-call `heightAt` ≈ **0.5 µs/call**. Budgeting 3× headroom for low-end mobile Safari/Chrome: target **≤ 1.5 µs/`heightAt` call, ≤ 6 µs/`normalAt` call** on Low-tier mobile devices. At `SIM_HZ=120`, with up to ~10 active aircraft each needing 1 `heightAt`/tick (gear AGL check) plus AI terrain-avoidance lookahead (budget ≤8 extra `heightAt` samples/tick per AI aircraft, per module 06's own spec), worst case ≈ `120 · 10 · 9 = 10800` `heightAt` calls/s ≈ 16 ms/s of budget even at the pessimistic mobile estimate — well under 1% of a 120 Hz tick's total time budget.

**Chunk build cost** — `buildChunkGeometry` for an Ultra chunk (1221 verts) calls `heightAt`+`normalAt` once per vertex: `1221 · (1+4) · 27 ≈ 165000` `noise2D` calls ≈ **3.5 ms** at the measured desktop rate (up to ~10 ms on mobile). This runs in `terrain.worker.ts`, off the render/sim hot path, but `terrain.worker.ts` processes each `requestChunk` synchronously to completion with no yielding, so an unbounded burst of newly-desired chunks in one `ChunkManager.update()` call (e.g. a fast dive, or the floating-origin rebase in `00-architecture.md` section 7) would serialise into a multi-frame worker backlog. This is bounded, not merely a future profiling concern: `MAX_REQUESTS_PER_UPDATE = 4` (`contracts/terrain.ts`) is a REQUIRED cap on `ChunkManager.update()`'s outgoing `requestChunk` count per call — newly-desired chunks beyond that count, nearest-first, are picked up on a subsequent `update()` call once earlier requests resolve, so a fast camera move degrades to "briefly coarser LOD for a few frames," never an unbounded worker queue (see `contracts/terrain.ts`'s `MAX_REQUESTS_PER_UPDATE` doc comment for the full rationale).

**Resident chunk budget** (geometric estimate, not a hard limit beyond `MAX_RESIDENT_CHUNKS=512`): a disc of radius `streamRadiusM` filled mostly at the finest LOD near the camera plus a ring of coarser ancestors further out. All four figures below reuse each tier's exact `computeDesiredChunks` fixture from section 4.8 (same representative camera altitude of 5000 m, except Low which uses its own 2000 m cold-start fixture) multiplied by that tier's per-chunk vertex/index counts from the section 5.2 table:

| tier | resident chunks | vertices | indices | triangles |
|---|---|---|---|---|
| low | 4 (cold-start @ 2000 m) | `4 · 221 = 884` | `4 · 1152 = 4608` | `1536` |
| medium | 12 (@ 5000 m) | `12 · 357 = 4284` | `12 · 1920 = 23040` | `7680` |
| high | 32 (@ 5000 m) | `32 · 725 = 23200` | `32 · 4032 = 129024` | `43008` |
| ultra | 124 (@ 5000 m) | `124 · 1221 ≈ 151400` | `124 · 6912 ≈ 857000` | `≈286000` |

Low's figure is trivial. Medium and High — the tiers `11-ui.md`'s benchmark/GPU-classification scoring (combined scores 1–4, its section 4.2) is expected to select for a typical 2022 mid-range Android phone — sit comfortably below Ultra's desktop-only figure (23.2 K and 129 K resident vertices/indices respectively vs. Ultra's 151 K/857 K), confirming the tier ladder scales resident geometry roughly linearly with `streamRadiusChunks²`-ish growth (not exactly quadratic because `maxLodDepth` also increases) rather than jumping straight from "trivial" to "desktop-only." Ultra remains reasonable for a "no heavy game engine" desktop target.

**Allocation policy**: `buildChunkGeometry` allocates its 3 typed arrays fresh per call — this is **not** a hot-path violation per `00-architecture.md` section 2's definition (chunk builds are event-driven, at most a few dozen per second even during fast camera movement, never once-per-tick or once-per-frame). `ComputeDesiredChunks` and `ChunkManager.update()` **do** run once per render frame and must not allocate in steady state: reuse the `out` array (truncate via `.length=0`, never reallocate once it has reached its peak size), reuse the `scratchBounds`/`children` scratch objects across calls, and do not create new closures inside `update()`. `chunkKeyToString` allocates a string per call but is only invoked on map insert/delete (state-change edges), not per resident chunk per frame.

## 7. Unit tests to write

All under `tests/terrain/`, mirroring `src/terrain/<file>.ts` per `00-architecture.md`'s naming convention.

**`tests/terrain/noise.test.ts`**
- `createNoise2D(12345)(1.234, -5.678)` equals `0.38828435101300646` (tolerance `1e-9`); calling it again with the same args returns the identical value (determinism).
- `createNoise2D(999)(1.234, -5.678)` equals `-0.5711847670297295` (tolerance `1e-9`) and is `!==` the seed-12345 value above.
- Sampling a `50×50` grid at step `0.13` with seed `12345`: every value satisfies `-1 <= v <= 1`; `max(|v|) > 0.9` (confirms the practical range is actually reached, not degenerate near 0).

**`tests/terrain/fbm.test.ts` / `tests/terrain/ridge.test.ts`**
- `createFbmNoise2D` output magnitude never exceeds `Σ baseAmplitudeM·persistence^i` (assert over 1000 random `(x,z)` with `DEFAULT_TERRAIN_PARAMS.fbm`: `|fbm(x,z)| <= 433.125 + 1e-6`).
- `createRidgeNoise2D` output is always `>= -1e-9` (never negative) and never exceeds `984.375 + 1e-6`, over 1000 random samples with `DEFAULT_TERRAIN_PARAMS.ridge`.

**`tests/terrain/domainWarp.test.ts`**
- With `enabled: false`, `warp(x,z,out)` sets `out.x===x, out.z===z` exactly, for several sample points.
- With `enabled: true` and `DEFAULT_TERRAIN_PARAMS.domainWarp`, displacement magnitude `sqrt((out.x-x)^2+(out.z-z)^2) <= 600*1.75 + 1e-6 = 1050.000001` for 1000 random samples.

**`tests/terrain/terrainHeight.test.ts`**
- `createRawTerrainHeight(DEFAULT_TERRAIN_PARAMS)(1234.5, -6789.2)` equals `423.7411290843514` (tolerance `1e-6`); repeat call identical.
- `(0,0)` equals `226.48833905029295` (tolerance `1e-6`).
- Sampling a `50×50` grid over the full world square: every value within `[TERRAIN_MIN_HEIGHT_M, TERRAIN_MAX_HEIGHT_M] = [-200, 2100]`.

**`tests/terrain/heightSampler.test.ts`**
- The 5-point flattening fixture from section 4.4 (`heightAt` at d=0,500,600,700,1000 around the example zone), each within `1e-6` of the values given there.
- `normalAt(1234.5,-6789.2)` within `1e-6` of `(-0.2956766822239997, 0.951572670718101, 0.08417096845960884)`; `|n|` within `1e-9` of `1`.
- `normalAt(0,0)`: `out.y > 0` and `|out|` within `1e-9` of `1` (generic invariants; do not hardcode a "shallow slope" expectation — see section 4.5).
- `createHeightSampler(DEFAULT_TERRAIN_PARAMS, []).seed === DEFAULT_TERRAIN_PARAMS.seed`.

**`tests/terrain/quadtree.test.ts`**
- `chunkSizeAtDepth(0) === 200000`; `chunkSizeAtDepth(6) === 3125`; `chunkSizeAtDepth(8) === 781.25`.
- `chunkChildren({depth:0,cx:0,cz:0}, out)` yields exactly `[{1,0,0},{1,1,0},{1,0,1},{1,1,1}]`.
- `chunkParent({depth:1,cx:1,cz:0})` equals `{depth:0,cx:0,cz:0}`; `chunkParent({depth:0,cx:0,cz:0})` is `undefined`.
- The 5 `computeDesiredChunks` fixtures from section 4.8 (Ultra @ alt 5000 → 124 chunks, depth histogram `{4:16,5:44,6:64}`, origin-covering key `{6,31,31}`; Ultra @ alt 15000 → 44 chunks, origin-covering key `{5,15,15}`; Low @ alt 2000 → 4 chunks, all depth 3; Medium @ alt 5000 → 12 chunks, depth histogram `{4:12}`, origin-covering key `{4,7,7}`; High @ alt 5000 → 32 chunks, depth histogram `{5:32}`, origin-covering key `{5,15,15}`), each an exact assertion (not a range).

**`tests/terrain/chunkGeometryBuilder.test.ts`**
- For each tier's `chunkGridQuads` (12,16,24,32), `buildChunkGeometry(sampler, {depth:tier.maxLodDepth,cx:0,cz:0}, gridQuads).vertexCount`/`.indexCount` exactly match the table in section 4.7 (221/1152, 357/1920, 725/4032, 1221/6912).
- Every triangle in the interior grid (first `res*res*6` indices) has an up-facing normal: for each triangle, compute `cross(posB-posA, posC-posA).y > 0` from the raw `positions` buffer (using the exact index order of section 4.7) — assert true for all `res*res` interior quads at `gridQuads=12`.
- `positions` values are absolute world coordinates: for chunk `{depth:6,cx:31,cz:31}` (bounds `x,z ∈ [-3125,0]`), every `positions[3*i]` (x) and `positions[3*i+2]` (z) for a MAIN (non-skirt) vertex lies within `[-3125-1e-6, 0+1e-6]`.

**`tests/terrain/chunkManager.test.ts`**
- Construct with a `sendToTerrainWorker` stub that records messages; call `update(camera, 'low')` before any `terrainInit`/`terrainReady` round-trip — assert zero `requestChunk` messages are sent until `handleTerrainWorkerMessage({type:'terrainReady'})` is called, after which the buffered requests are flushed (assert `sendToTerrainWorker` is called with the same `requestChunk`s that a bare `computeDesiredChunks` call would have produced for that camera/tier).
- Feed a synthetic `chunkReady` for one of the pending `requestId`s; assert `onChunkReady`'s callback fires exactly once with the matching `key`.
- Call `update()` again with a camera position that no longer needs that chunk (moved far away); assert `onChunkEvicted` fires with that chunk's key and a subsequent `handleTerrainWorkerMessage` for its (now-stale) `requestId` is silently ignored (no callback fires).

**`tools/sim-check.ts` (module 12, cross-module)**: assert that two independently-constructed `HeightSampler`s (`createHeightSampler(DEFAULT_TERRAIN_PARAMS, [])` called twice, simulating "sim worker" and "terrain worker" instances) agree exactly (`===`, not just tolerance) on `heightAt` for 100 random points — the thread-agnostic-determinism requirement from section 1.

## 8. Acceptance criteria

1. `contracts/terrain.ts` compiles standalone with `tsc --noEmit --strict` (no external imports beyond `./core`) — mechanically checked by module 12's Audit phase.
2. Every test in section 7 passes with the exact numeric fixtures given (not just "close enough" ranges where an exact value was specified).
3. `createHeightSampler(p, zones).heightAt` and `.normalAt` never call `Math.random()` or reference `window`/`document`/`self` (mechanically checked by running under plain Node with those globals undefined/throwing).
4. `buildChunkGeometry` never throws for any `ChunkKey` with `0 <= depth <= MAX_QUADTREE_DEPTH` and any `gridQuads` in `{12,16,24,32}`.
5. `ComputeDesiredChunks`'s output for any camera position and tier contains no duplicate `ChunkKey` and no key whose ancestor is also present (leaves only — no node is both split and reported as its own leaf).
6. `ChunkManager` never calls `sendToTerrainWorker` with a `requestChunk` before it has received `terrainReady` from a prior `terrainInit`-implied round trip (section 4.9/7).
7. No file under `src/terrain/` imports anything outside `src/contracts/core.ts` and `src/contracts/terrain.ts` (grep-checkable).
8. `heightAt`/`normalAt` measured cost (a Node micro-benchmark, 100000 calls) stays within an order of magnitude of the section 6 desktop figures (≤ 5 µs/call amortized) — a regression guard, not a strict mobile-parity requirement (mobile timing cannot be measured in CI).

## 9. Open assumptions

- **No dependency on `contracts/math.ts`.** `00-architecture.md`'s dependency rules permit `src/terrain` to import `src/math/*`, but per the stated single-pass build order this module's implementer reads only `00-architecture.md` + `core.ts` + this file + `contracts/terrain.ts` — never `contracts/math.ts`. Every formula in section 4 is therefore fully self-contained (own noise, own permutation seeding via a local hash + xorshift32, own smoothstep/clamp/lerp), deliberately never assuming `mulberry32`'s exact signature or a `Vec3`/`Quat` class's exact method names. If, at actual integration time, `src/math` turns out to export something directly reusable (e.g. its own `smoothstep`), swapping this module's inline copy for that import is a safe drop-in optimization, never required by this spec.
- **`core.ts`'s `MainToTerrainMessage`/`TerrainToMainMessage` have no init message.** Unlike `MainToSimMessage` (which has `SimInitMessage`), the terrain worker's message union as fixed in `core.ts` only has `requestChunk`/`cancel` (main→terrain) and `chunkReady` (terrain→main) — no way to deliver `TerrainParams`/`AirportFlattenZone[]` to the worker before its first request. Since `core.ts` cannot be edited, `contracts/terrain.ts` adds `TerrainInitMessage`/`TerrainReadyMessage` (`MainToTerrainMessageExt`/`TerrainToMainMessageExt`) as this module's own extension, and `src/core`'s worker-wiring code (module 10) must type its terrain-worker `postMessage` call site as the union of `core.ts`'s type plus this extension. This is flagged for module 10's implementer, who — like every other module — only reads `00-architecture.md` + `core.ts` + its own spec, and so will not see this file; **module 10's own spec (`10-core-worker.md`) must independently document sending `TerrainInitMessage` first**, since that is the only place its implementer will read it. This spec cannot itself guarantee that document says so.
- **Quality-tier changes at runtime and `chunkGridQuads` ambiguity (section 4.10).** `TerrainRequestChunkMessage` carries `lod` (depth) but not which tier's `chunkGridQuads` should apply, and a player changing quality tier mid-flight (module 11's settings screen) could in principle race a still-in-flight request built against the old tier's resolution. This spec resolves it by having the worker track the most-recently-told-tier's `chunkGridQuads` as local state (re-synced via a fresh `TerrainInitMessage` whenever the tier changes) rather than per-request, which is simple but means a request issued in the brief window between a tier change and the corresponding `TerrainInitMessage` resend could build at the wrong resolution once. Given quality-tier changes are rare (a settings-menu action, not a per-frame event) and the visual effect of one stale-resolution chunk is negligible, this is judged an acceptable simplification rather than a correctness bug; module 10/11 may tighten this further (e.g. by having `ChunkManager` fully tear down and reconstruct its worker connection on a tier change) without violating this contract.
- **Hard draw-distance cutoff, no distant low-poly impostor.** Terrain beyond `TERRAIN_STREAM_RADIUS_M` (4.7–18.75 km depending on tier) is simply not rendered, relying on module 08's fog/haze to hide the edge, rather than this module providing a coarse "whole world always resident at depth 0" fallback. This trades away a distant mountain skyline (which a real flight sim would show from high altitude) for a much smaller, more predictable resident-chunk budget (section 6) appropriate to "no heavy game engine" / mobile targets. If a future pass wants a distant skyline, the natural extension is a second, much-coarser always-resident ring computed the same way with a second, larger radius — not specified here because it was not required by the brief's explicit chunk/LOD description.
- **`AirportFlattenZone.elevationM` range is a convention, not enforced.** Section 5.4 asks module 05 to keep zone elevations within `[TERRAIN_MIN_HEIGHT_M, TERRAIN_MAX_HEIGHT_M]`; this module does not clamp or validate that (flattening always blends toward, never clamps, the configured elevation), so a wildly out-of-range `elevationM` would produce a visually implausible but not crash-inducing result. Module 05's own spec, which this module's drafter has not read, is responsible for picking sane values for `rangpur-afb.json`/`konarak-coastal.json`.
- **Multi-zone blend rule ("nearest zone wins").** `00-architecture.md` section 9.2 explicitly leaves the multi-zone blending rule to this module. Nearest-wins (highest single-zone weight, never averaged) was chosen because averaging two unrelated runways' elevations mid-blend would be physically nonsensical; this only matters where two `AirportFlattenZone`s' blend radii overlap, which is expected to be rare (module 05's own airports are single, spatially separated footprints).
- **Public-data sparsity note (N/A for this module).** Unlike modules 02/03 (Tejas flight/aero data), this module's subject (procedural noise-based terrain) has no real-world analogue to approximate — all constants in section 5 are original tuning choices for visual variety and performance, not derived from or approximating any real dataset.
