import { describe, expect, it } from 'vitest';
import { lerp, quatNlerp } from '../../src/render/mathInternal';
import {
  computeInterpFraction,
  createIdMatchTable,
  findPrevSlot,
  rebuildMatchTable,
  type SnapshotFrame,
} from '../../src/render/snapshotInterpolation';

describe('snapshotInterpolation', () => {
  it('lerp interpolates linearly', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
  });

  it('quatNlerp matches the axisAngle(Y,45deg) special case from identity', () => {
    const out = { x: 0, y: 0, z: 0, w: 1 };
    quatNlerp({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0.7071068, z: 0, w: 0.7071068 }, 0.5, out);
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo(0.3826834, 6);
    expect(out.z).toBeCloseTo(0, 6);
    expect(out.w).toBeCloseTo(0.9238795, 6);
  });

  it('id-match table: exact-id re-check wins over a hash-key collision', () => {
    const table = createIdMatchTable();
    const prev: Pick<SnapshotFrame, 'entityCount' | 'id'> = {
      entityCount: 2,
      id: Float64Array.from([5 * 65536 + 3, 9 * 65536 + 3]),
    };
    rebuildMatchTable(table, prev);
    expect(findPrevSlot(table, prev, 9 * 65536 + 3)).toBe(1);
    expect(findPrevSlot(table, prev, 2 * 65536 + 3)).toBe(-1);
  });

  it('interpolation fraction is clamped to 1, never extrapolated', () => {
    expect(computeInterpFraction(520, 0)).toBe(1);
  });
});
