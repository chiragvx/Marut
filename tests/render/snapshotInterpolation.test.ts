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

import { SNAPSHOT_FLOATS, SnapshotHeader } from '../../src/contracts/core';
import { advanceRenderClock, createSnapshotDoubleBuffer, ingestSnapshotIntoBuffer, RENDER_DELAY_SEC } from '../../src/render/snapshotInterpolation';

describe('render clock (snapshots played on the sim clock)', () => {
  const view = new Float64Array(SNAPSHOT_FLOATS);
  const snap = (simSec: number): Float64Array => {
    view[SnapshotHeader.SIM_TIME_SEC_OFFSET] = simSec;
    view[SnapshotHeader.ENTITY_COUNT_OFFSET] = 0;
    view[SnapshotHeader.PLAYER_INDEX_OFFSET] = -1;
    return view;
  };

  it('advances evenly although snapshots arrive in bursts', () => {
    const buf = createSnapshotDoubleBuffer();
    const frameMs = 1000 / 60;
    // Snapshots every 1/60 s of sim time, delivered in uneven clumps (as the worker timer does).
    const gaps = [16, 16, 30, 4, 16, 28, 8, 16, 16, 12, 22, 16];
    let sim = 0;
    let arrive = 0;
    let k = 0;
    const steps: number[] = [];
    let last = NaN;
    for (let t = 0; t < 3000; t += frameMs) {
      while (arrive <= t) {
        ingestSnapshotIntoBuffer(buf, snap(sim), arrive);
        sim += 1 / 60;
        arrive += gaps[k++ % gaps.length]!;
      }
      const f = advanceRenderClock(buf, t);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      if (t > 1000) steps.push((buf.renderSimSec - last) * 1000);
      last = buf.renderSimSec;
    }
    // Every frame moves the view on by about one frame's worth of sim time.
    for (const s of steps) {
      expect(s).toBeGreaterThan(frameMs * 0.9);
      expect(s).toBeLessThan(frameMs * 1.1);
    }
    // And it stays a little behind the newest snapshot.
    expect(buf.latest.simTimeSec - buf.renderSimSec).toBeGreaterThan(RENDER_DELAY_SEC * 0.3);
  });

  it('stops at the newest snapshot when the sim pauses, and restarts with a new world', () => {
    const buf = createSnapshotDoubleBuffer();
    for (let i = 0; i < 10; i++) {
      ingestSnapshotIntoBuffer(buf, snap(i / 60), i * 16.7);
      advanceRenderClock(buf, i * 16.7);
    }
    for (let t = 200; t < 1200; t += 16.7) advanceRenderClock(buf, t);
    expect(buf.renderSimSec).toBeCloseTo(9 / 60, 6);
    ingestSnapshotIntoBuffer(buf, snap(0), 1300); // a new mission: its clock starts at 0
    advanceRenderClock(buf, 1300);
    expect(buf.renderSimSec).toBe(0);
    expect(buf.count).toBe(1);
  });
});
