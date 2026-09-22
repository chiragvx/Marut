/**
 * src/terrain/domainWarp.ts — domain-warping for more natural ridgelines (module 04).
 * Algorithm: docs/spec/04-terrain.md section 4.3.5.
 */
import type { Noise2D, CreateDomainWarp2D, DomainWarpParams, WarpFn, Vec2Like } from '../contracts/terrain';

/**
 * `warpNoiseX`/`warpNoiseZ` are each an fbm-combined Noise2D (not raw), built
 * by the caller (see terrainHeight.ts) with baseAmplitudeM: 1. Writes the
 * warped (x,z) into `out`, no allocation. If `params.enabled` is false,
 * writes `out.x = x; out.z = z` unchanged.
 */
export const createDomainWarp2D: CreateDomainWarp2D = (
  warpNoiseX: Noise2D,
  warpNoiseZ: Noise2D,
  params: DomainWarpParams
): WarpFn => {
  return (x: number, z: number, out: Vec2Like): void => {
    if (!params.enabled) {
      out.x = x;
      out.z = z;
      return;
    }
    out.x = x + warpNoiseX(x, z) * params.warpAmplitudeM;
    out.z = z + warpNoiseZ(x, z) * params.warpAmplitudeM;
  };
};
