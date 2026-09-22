import { describe, expect, it } from 'vitest';
import { localPos, shouldRebase } from '../../src/render/floatingOrigin';

describe('floatingOrigin', () => {
  it('does not rebase at exactly the threshold distance (strict >)', () => {
    expect(shouldRebase({ x: 0, y: 0, z: 0 }, { x: 4000, y: 0, z: 0 })).toBe(false);
  });

  it('rebases just past the threshold distance', () => {
    expect(shouldRebase({ x: 0, y: 0, z: 0 }, { x: 4000.001, y: 0, z: 0 })).toBe(true);
  });

  it('computes render-local position from origin and absolute world position', () => {
    const out = { x: 0, y: 0, z: 0 };
    localPos({ x: 12345678.125, y: 500, z: -2000000 }, { x: 12345688.125, y: 505, z: -2000003 }, out);
    expect(out.x).toBeCloseTo(10, 9);
    expect(out.y).toBeCloseTo(5, 9);
    expect(out.z).toBeCloseTo(-3, 9);
  });
});
