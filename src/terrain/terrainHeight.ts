/**
 * src/terrain/terrainHeight.ts — combined (pre-flattening) terrain height field (module 04).
 * Algorithm: docs/spec/04-terrain.md section 4.3.1 (sub-seed derivation) and 4.3.6
 * (continental band selection + domain warp + fbm/ridge blend).
 */
import type {
  TerrainParams,
  RawTerrainHeightFn,
  CreateRawTerrainHeight,
  DeriveTerrainSubSeed,
  BiomeBand,
  FbmParams,
  Vec2Like,
  CoastProfile,
} from '../contracts/terrain';
import { TerrainNoiseSeedTag, TERRAIN_WORLD_HALF_EXTENT_M } from '../contracts/terrain';
import { createNoise2D } from './noise';
import { createFbmNoise2D } from './fbm';
import { createRidgeNoise2D } from './ridge';
import { createDomainWarp2D } from './domainWarp';
import { buildShapedHeight, coastLineAt } from './theatreShapes';

/** Deterministic integer hash deriving an independent sub-seed for noise field `tag`. Never mulberry32 (see contracts/terrain.ts file header). */
export const deriveTerrainSubSeed: DeriveTerrainSubSeed = (rootSeed: number, tag: TerrainNoiseSeedTag): number => {
  let h = (rootSeed ^ Math.imul(tag, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
};

/** Sum_{i=0}^{n-1} a*r^i, plain loop form (avoids the r=1 edge case entirely). */
function sumGeometric(a: number, r: number, n: number): number {
  let sum = 0;
  let term = a;
  for (let i = 0; i < n; i++) {
    sum += term;
    term *= r;
  }
  return sum;
}

/** Last band whose fromContinental <= c. `bands` is guaranteed non-empty with a first band covering -1 (contracts/terrain.ts's TerrainParams doc comment). */
function selectBand(bands: readonly BiomeBand[], c: number): BiomeBand {
  let best: BiomeBand | undefined = bands[0];
  for (const b of bands) {
    if (c >= b.fromContinental) best = b;
  }
  return best as BiomeBand;
}

/** Builds the full noise stack (continental band select -> domain warp -> fbm/ridge blend) from `params`, deriving all 5 sub-seeds via deriveTerrainSubSeed. */
export const createRawTerrainHeight: CreateRawTerrainHeight = (params: TerrainParams): RawTerrainHeightFn => {
  const fbmNoise = createNoise2D(deriveTerrainSubSeed(params.seed, TerrainNoiseSeedTag.Fbm));
  const ridgeNoise = createNoise2D(deriveTerrainSubSeed(params.seed, TerrainNoiseSeedTag.Ridge));
  const warpXNoise = createNoise2D(deriveTerrainSubSeed(params.seed, TerrainNoiseSeedTag.WarpX));
  const warpZNoise = createNoise2D(deriveTerrainSubSeed(params.seed, TerrainNoiseSeedTag.WarpZ));
  const contNoise = createNoise2D(deriveTerrainSubSeed(params.seed, TerrainNoiseSeedTag.Continental));

  const fbm = createFbmNoise2D(fbmNoise, params.fbm);
  const ridge = createRidgeNoise2D(ridgeNoise, params.ridge);

  const contFbmParams: FbmParams = { ...params.continental, baseAmplitudeM: 1 };
  const cont = createFbmNoise2D(contNoise, contFbmParams);
  const contMax = sumGeometric(1, contFbmParams.persistence, contFbmParams.octaves);

  const warpFbmParams: FbmParams = {
    octaves: params.domainWarp.octaves,
    baseFrequency: params.domainWarp.warpFrequency,
    baseAmplitudeM: 1,
    lacunarity: 2,
    persistence: 0.5,
  };
  const warpXFbm = createFbmNoise2D(warpXNoise, warpFbmParams);
  const warpZFbm = createFbmNoise2D(warpZNoise, warpFbmParams);
  const warp = createDomainWarp2D(warpXFbm, warpZFbm, params.domainWarp);

  if (params.shape) {
    const fbmMax = sumGeometric(params.fbm.baseAmplitudeM, params.fbm.persistence, params.fbm.octaves) || 1;
    const ridgeMax = sumGeometric(params.ridge.baseAmplitudeM, params.ridge.persistence, params.ridge.octaves) || 1;
    return buildShapedHeight(params.shape, params.waterLevelM, {
      fbmN: (x, z) => fbm(x, z) / fbmMax,
      ridgeN: (x, z) => ridge(x, z) / ridgeMax,
      meander: contNoise,
      warp,
    }, params.seed);
  }

  const scratch: Vec2Like = { x: 0, z: 0 };
  const bands = params.bands;

  return (x: number, z: number): number => {
    let c = cont(x, z) / contMax;
    c = c < -1 ? -1 : c > 1 ? 1 : c;
    const band = selectBand(bands, c);
    warp(x, z, scratch);
    const fbmH = fbm(scratch.x, scratch.z);
    const ridgeH = ridge(scratch.x, scratch.z);
    const blended = fbmH + (ridgeH - fbmH) * band.ridgeBlend;
    return band.baseElevationM + blended * band.heightScale;
  };
};

/** Samples of a coast theatre's shoreline along Z every `dzM` across the world (src/render colours by distance from the sea). Undefined for non-coast terrains. */
export function buildCoastProfile(params: TerrainParams, dzM = 1000): CoastProfile | undefined {
  const shape = params.shape;
  if (!shape || shape.kind !== 'coast') return undefined;
  const meander = createNoise2D(deriveTerrainSubSeed(params.seed, TerrainNoiseSeedTag.Continental));
  const out: Vec2Like = { x: 0, z: 0 };
  const z0 = -TERRAIN_WORLD_HALF_EXTENT_M;
  const n = Math.round((2 * TERRAIN_WORLD_HALF_EXTENT_M) / dzM) + 1;
  const shoreX: number[] = [];
  const headland: number[] = [];
  for (let i = 0; i < n; i++) {
    coastLineAt(shape, meander, z0 + i * dzM, out);
    shoreX.push(out.x);
    headland.push(out.z);
  }
  return { z0, dz: dzM, shoreX, headland, plainRiseMPerKm: shape.plainRiseMPerKm, hillsStartM: shape.hillsStartM, hillsRampM: shape.hillsRampM };
}
