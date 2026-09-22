import { describe, it, expect } from 'vitest';
import { AiDifficultyProfiles } from '../../src/ai/difficultyProfiles';

describe('AiDifficultyProfiles', () => {
  it('has monotonically increasing maxCommandedGLoad with skill', () => {
    expect(AiDifficultyProfiles.rookie.maxCommandedGLoad).toBeLessThan(AiDifficultyProfiles.veteran.maxCommandedGLoad);
    expect(AiDifficultyProfiles.veteran.maxCommandedGLoad).toBeLessThan(AiDifficultyProfiles.ace.maxCommandedGLoad);
  });

  it('has monotonically decreasing reactionDelaySec with skill', () => {
    expect(AiDifficultyProfiles.ace.reactionDelaySec).toBeLessThan(AiDifficultyProfiles.veteran.reactionDelaySec);
    expect(AiDifficultyProfiles.veteran.reactionDelaySec).toBeLessThan(AiDifficultyProfiles.rookie.reactionDelaySec);
  });

  it('every profile has sane bounds', () => {
    for (const id of ['rookie', 'veteran', 'ace'] as const) {
      const p = AiDifficultyProfiles[id];
      expect(p.gunAccuracyErrorStdDeg).toBeGreaterThanOrEqual(0);
      expect(p.maxSimultaneousMissilesPerTarget).toBeGreaterThanOrEqual(1);
    }
  });
});
