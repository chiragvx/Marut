/**
 * src/ai/energyState.ts — specific energy height, used by BFM selection and
 * Extension/Disengage triggers. See docs/spec/06-ai.md section 4.6.
 */
import type { ComputeEnergyHeightM } from '../contracts/ai';
import { GRAVITY_MPS2 } from '../contracts/core';

export const computeEnergyHeightM: ComputeEnergyHeightM = (altitudeM, trueAirspeedMps) =>
  altitudeM + (trueAirspeedMps * trueAirspeedMps) / (2 * GRAVITY_MPS2);
