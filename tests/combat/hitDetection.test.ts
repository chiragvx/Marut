import { describe, it, expect } from 'vitest';
import { segmentHitsEllipsoid, closestApproachOnSegment, DEFAULT_AIRCRAFT_HIT_ELLIPSOID_M } from '../../src/combat';

describe('segmentHitsEllipsoid', () => {
  it('matches the 07-combat.md section 4.9 worked example', () => {
    const out = { hit: false, tEntry: NaN };
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    segmentHitsEllipsoid(
      { x: 0, y: 0, z: -50 },
      { x: 0, y: 0, z: 50 },
      { x: 0, y: 0, z: 0 },
      identity,
      DEFAULT_AIRCRAFT_HIT_ELLIPSOID_M,
      out,
    );
    expect(out.hit).toBe(true);
    expect(out.tEntry).toBeCloseTo(0.4589, 3);
  });

  it('misses a parallel segment offset beyond the x semi-axis (6.6 m)', () => {
    // Same direction as the worked example (travelling along world Z),
    // shifted +10 m along X — well outside the 6.6 m x semi-axis, so the
    // segment never enters the ellipsoid at any point along its length.
    const out = { hit: false, tEntry: NaN };
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    segmentHitsEllipsoid(
      { x: 10, y: 0, z: -50 },
      { x: 10, y: 0, z: 50 },
      { x: 0, y: 0, z: 0 },
      identity,
      DEFAULT_AIRCRAFT_HIT_ELLIPSOID_M,
      out,
    );
    expect(out.hit).toBe(false);
  });
});

describe('closestApproachOnSegment', () => {
  it('perpendicular offset: midpoint of the segment is the closest point', () => {
    const dist = closestApproachOnSegment({ x: 0, y: 0, z: -50 }, { x: 0, y: 0, z: 50 }, { x: 3, y: 0, z: 0 });
    expect(dist).toBeCloseTo(3, 9);
  });
});
