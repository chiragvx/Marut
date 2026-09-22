/**
 * src/core/aiPilotAdapter.ts — adapts module 06's real `createAiPilot`
 * factory (contracts/ai.ts) to `CreateAiPilot` (contracts/sim.ts section
 * 3.3). `AiPilotSpawnParamsLike` (sim.ts) mirrors `AiPilotSpawnParams`
 * (ai.ts) field-for-field by design, and `AiPilot extends Pilot`, so this
 * adapter is a pass-through with only a return-type widening.
 */

import type { AiPilotSpawnParams } from '../contracts/ai';
import { createAiPilot as realCreateAiPilot } from '../ai';
import type { CreateAiPilot } from '../contracts/sim';

export const aiPilotAdapter: CreateAiPilot = (params) => realCreateAiPilot(params as AiPilotSpawnParams);
