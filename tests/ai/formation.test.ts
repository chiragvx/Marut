import { describe, it, expect } from 'vitest';
import { headingFromVelocity, computeFormationTargetPos } from '../../src/ai/formation';

describe('headingFromVelocity', () => {
  it('north (-Z) is heading 0', () => {
    expect(headingFromVelocity({ x: 0, y: 0, z: -50 })).toBeCloseTo(0, 9);
  });

  it('east (+X) is heading PI/2', () => {
    expect(headingFromVelocity({ x: 50, y: 0, z: 0 })).toBeCloseTo(Math.PI / 2, 9);
  });

  it('falls back to 0 below MIN_SPEED_FOR_HEADING_MPS', () => {
    expect(headingFromVelocity({ x: 1, y: 0, z: 0 })).toBe(0);
  });
});

describe('computeFormationTargetPos', () => {
  it('matches the worked example', () => {
    const out = { x: 0, y: 0, z: 0 };
    const result = computeFormationTargetPos(
      { x: 1000, y: 2000, z: 500 },
      { x: 50, y: 0, z: 0 },
      { role: 'wingman', leaderId: 1, slotRightM: 100, slotBackM: 150, slotUpM: -20 },
      out
    );
    expect(result.x).toBeCloseTo(850, 6);
    expect(result.y).toBeCloseTo(1980, 6);
    expect(result.z).toBeCloseTo(600, 6);
  });
});
