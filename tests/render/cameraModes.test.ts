import { describe, expect, it } from 'vitest';
import { expSmooth } from '../../src/render/mathInternal';
import { computeCockpitPose, createCameraPose } from '../../src/render/cameraModes';

describe('cameraModes', () => {
  it('exponential smoothing: tau=0.15, dt=0.15 moves ~63.2% of the way', () => {
    const alpha = 1 - Math.exp(-1);
    expect(alpha).toBeCloseTo(0.6321206, 6);
    expect(expSmooth(0, 10, 0.15, 0.15)).toBeCloseTo(6.321206, 4);
  });

  it('cockpit eye world position with identity player rotation', () => {
    const out = createCameraPose();
    computeCockpitPose({ x: 100, y: 200, z: 300 }, { x: 0, y: 0, z: 0, w: 1 }, out);
    expect(out.pos.x).toBeCloseTo(100.35, 9);
    expect(out.pos.y).toBeCloseTo(201.05, 9);
    expect(out.pos.z).toBeCloseTo(300, 9);
    expect(out.useLookAt).toBe(false);
  });
});
