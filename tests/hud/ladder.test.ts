import { describe, expect, it } from 'vitest';
import { screenYForPitchRung } from '../../src/hud/ladder';

describe('ladder', () => {
  it('screenYForPitchRung matches the worked example (rung=10deg, pitch=0, height=600)', () => {
    expect(screenYForPitchRung(10, 0, 600)).toBeCloseTo(100, 3);
  });
});
