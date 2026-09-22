import { describe, expect, it } from 'vitest';
import type { CameraState } from '../../src/contracts/render';
import { createScreenProjection, projectWorldToScreen } from '../../src/hud/targetBox';

function makeCamera(elements: readonly number[]): CameraState {
  return {
    viewProjectionMatrix: elements,
    originWorld: { x: 0, y: 0, z: 0 },
    worldPos: { x: 0, y: 0, z: 0 },
  };
}

describe('targetBox / projectWorldToScreen', () => {
  it('projects a point through an identity-like matrix', () => {
    const camera = makeCamera([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const out = createScreenProjection();
    projectWorldToScreen(camera, { x: 0.5, y: 0.25, z: 0 }, 800, 600, out);
    expect(out.xPx).toBeCloseTo(600, 9);
    expect(out.yPx).toBeCloseTo(225, 9);
    expect(out.visible).toBe(true);
  });

  it('marks a point behind the camera (clipW <= 1e-6) as not visible', () => {
    const camera = makeCamera([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1]);
    const out = createScreenProjection();
    projectWorldToScreen(camera, { x: 0, y: 0, z: 0 }, 800, 600, out);
    expect(out.visible).toBe(false);
  });
});
