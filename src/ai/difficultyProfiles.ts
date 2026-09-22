/**
 * src/ai/difficultyProfiles.ts — re-exports contracts/ai.ts's AiDifficultyProfiles.
 * The CONTRACT (not this file) is the source of truth for the numbers; see
 * docs/spec/06-ai.md section 5.1.
 */
import { AiDifficultyProfiles } from '../contracts/ai';
import type { AiDifficultyProfile } from '../contracts/ai';

export { AiDifficultyProfiles };
export type { AiDifficultyProfile };
