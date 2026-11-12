import { describe, expect, test } from 'vitest';
import { Quat } from '../../src/math';
import { bellRate, flyPath, follower, holdGamma } from '../../src/ui/flightPath';
import { makeAircraft } from '../../src/ui/showcase';

const deg = Math.PI / 180;
const nose = (q: { x: number; y: number; z: number; w: number }) => Quat.rotate(q, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });

describe('reel flight model', () => {
  test('level flight holds its height and heading', () => {
    const jet = makeAircraft();
    const tr = flyPath({ start: { x: 0, y: 500, z: 0 }, headingRad: 0, speed: 200, durationSec: 5, holdSpeed: true, turbulence: 0 });
    tr.sample(5, jet);
    expect(Math.abs(jet.pos.y - 500)).toBeLessThan(2);
    expect(Math.abs(jet.pos.x)).toBeLessThan(1);
    expect(jet.pos.z).toBeCloseTo(-1000, -1);
  });

  test('a banked pull turns the path, the nose rides above it, and the jet bleeds speed', () => {
    const jet = makeAircraft();
    const tr = flyPath({
      start: { x: 0, y: 1000, z: 0 },
      headingRad: 0,
      speed: 200,
      durationSec: 3,
      throttle: () => 1,
      roll: (t) => bellRate(t, 0, 0.6, 80 * deg),
      load: (t, s) => (t < 0.6 ? holdGamma(s, 0) : 6),
      turbulence: 0,
    });
    tr.sample(3, jet);
    const s = tr.state(3);
    expect(s.bank).toBeGreaterThan(70 * deg);
    // Turned right (east, +x) well away from north.
    expect(Math.atan2(s.u.x, -s.u.z)).toBeGreaterThan(20 * deg);
    expect(s.speed).toBeLessThan(195);
    // Angle of attack: the nose is off the flight path towards the lift.
    const n = nose(jet.rot);
    const off = Math.acos(Math.min(1, n.x * s.u.x + n.y * s.u.y + n.z * s.u.z));
    expect(off).toBeGreaterThan(5 * deg);
  });

  test('a full aileron roll comes back wings level', () => {
    const tr = flyPath({ start: { x: 0, y: 1000, z: 0 }, headingRad: 0, speed: 210, durationSec: 3, holdSpeed: true, roll: (t) => bellRate(t, 0.5, 2.1, 2 * Math.PI), turbulence: 0 });
    expect(Math.abs(tr.state(3).bank)).toBeLessThan(3 * deg);
  });

  test('anchor puts the track through a point at a time', () => {
    const jet = makeAircraft();
    const tr = flyPath({ start: { x: 0, y: 0, z: 0 }, headingRad: 0, speed: 250, durationSec: 4, holdSpeed: true }).anchor(2, { x: 10, y: 20, z: 30 });
    tr.sample(2, jet);
    expect(jet.pos.x).toBeCloseTo(10, 3);
    expect(jet.pos.y).toBeCloseTo(20, 3);
    expect(jet.pos.z).toBeCloseTo(30, 3);
  });

  test('the camera follower keeps up with steady motion and lags a change in it', () => {
    const f = follower(6, 4, (t, o) => Object.assign(o, { x: 250 * t + (t > 3 ? 20 * (t - 3) ** 2 : 0), y: 0, z: 0 }));
    const o = { x: 0, y: 0, z: 0 };
    expect(f(2.5, o).x).toBeCloseTo(625, 0);
    // Accelerating at 40 m/s^2: behind by about a / omega^2 = 2.5 m once settled.
    const want = 250 * 5.5 + 20 * 2.5 ** 2;
    expect(want - f(5.5, o).x).toBeGreaterThan(1.5);
    expect(want - f(5.5, o).x).toBeLessThan(4);
  });
});
