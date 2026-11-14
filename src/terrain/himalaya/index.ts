/**
 * src/terrain/himalaya/index.ts — the Himalaya theatre's terrain (height.ts, layout.ts), and what the
 * renderer needs to colour it: the lakes and a baked copy of the regional dryness field.
 */
import { LAKE_REGION_EL, dryAt, lakeShapes } from './height';

export { heightAt as himalayaHeightAt, waterLevelAt as himalayaWaterLevelAt } from './height';

/** Dryness texture: 1 km texels over +-150 km (past the 200 km world, for the far terrain). */
const DRY_HALF_M = 150_000;
const DRY_STEP_M = 1000;

export interface AlpineEnvironment {
  lakes: { x: number; z: number; rx: number; rz: number; rotRad: number; level: number }[];
  lakeRegionEl: number;
  dry: { originM: number; stepM: number; n: number; data: Uint8Array };
}

/** The lakes and the dryness field, for SceneEnvironment.alpine. */
export function buildAlpineEnvironment(): AlpineEnvironment {
  const n = Math.round((2 * DRY_HALF_M) / DRY_STEP_M) + 1;
  const data = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const d = dryAt(-DRY_HALF_M + i * DRY_STEP_M, -DRY_HALF_M + j * DRY_STEP_M);
      data[j * n + i] = Math.round(Math.min(1, Math.max(0, d)) * 255);
    }
  }
  return { lakes: lakeShapes(), lakeRegionEl: LAKE_REGION_EL, dry: { originM: -DRY_HALF_M, stepM: DRY_STEP_M, n, data } };
}
