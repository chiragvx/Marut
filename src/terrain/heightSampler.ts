/**
 * src/terrain/heightSampler.ts — implements core.ts's HeightSampler (module 04).
 * Combines raw terrain height with AirportFlattenZone blending (docs/spec/04-terrain.md
 * section 4.4) and a central-difference normalAt (section 4.5).
 */
import type { HeightSampler, Vec3Like } from '../contracts/core';
import type { TerrainParams, AirportFlattenZone, CreateHeightSampler } from '../contracts/terrain';
import { createRawTerrainHeight } from './terrainHeight';

/** Fixed algorithm detail, not tunable data (04-terrain.md section 5.3). */
const NORMAL_SAMPLE_EPSILON_M = 1.0;

function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/**
 * Builds the module's HeightSampler. Multi-zone rule: nearest-zone-wins
 * (highest single-zone weight, never averaged) — see 04-terrain.md section 4.4.
 */
export const createHeightSampler: CreateHeightSampler = (
  params: TerrainParams,
  flattenZones: readonly AirportFlattenZone[]
): HeightSampler => {
  const rawHeight = createRawTerrainHeight(params);
  const waterLevelM = params.waterLevelM;

  /** Ground height including airport flattening, before the water surface is applied. */
  function groundHeightAt(x: number, z: number): number {
    const raw = rawHeight(x, z);
    let bestWeight = 0;
    let bestElevationM = raw;
    for (const zone of flattenZones) {
      const dx = x - zone.centerWorldX;
      const dz = z - zone.centerWorldZ;
      const d = Math.sqrt(dx * dx + dz * dz);
      let w: number;
      if (d <= zone.flatRadiusM) w = 1;
      else if (d <= zone.flatRadiusM + zone.blendRadiusM) w = 1 - smoothstep((d - zone.flatRadiusM) / zone.blendRadiusM);
      else w = 0;
      if (w > bestWeight) {
        bestWeight = w;
        bestElevationM = zone.elevationM;
      }
    }
    return raw + (bestElevationM - raw) * bestWeight;
  }

  function heightAt(x: number, z: number): number {
    const h = groundHeightAt(x, z);
    return waterLevelM !== undefined && h < waterLevelM ? waterLevelM : h;
  }

  function isWaterAt(x: number, z: number): boolean {
    return waterLevelM !== undefined && groundHeightAt(x, z) < waterLevelM;
  }

  function normalAt(x: number, z: number, out: Vec3Like): Vec3Like {
    const e = NORMAL_SAMPLE_EPSILON_M;
    const hL = heightAt(x - e, z);
    const hR = heightAt(x + e, z);
    const hD = heightAt(x, z - e);
    const hU = heightAt(x, z + e);
    const dHdx = (hR - hL) / (2 * e);
    const dHdz = (hU - hD) / (2 * e);
    out.x = -dHdx;
    out.y = 1;
    out.z = -dHdz;
    const len = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
    out.x /= len;
    out.y /= len;
    out.z /= len;
    return out;
  }

  return {
    seed: params.seed,
    heightAt,
    normalAt,
    ...(waterLevelM !== undefined ? { isWaterAt, waterLevelM, groundHeightAt } : {}),
  };
};
