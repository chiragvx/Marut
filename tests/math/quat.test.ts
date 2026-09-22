import { describe, it, expect } from 'vitest';
import { Quat, createQuat, bodyRateP, bodyRateQ, bodyRateR } from '../../src/math';

/** forwardWorld(heading) = (sin(heading), 0, -cos(heading)) — 00-architecture.md section 3.1 */
function forwardWorld(headingRad: number) {
  return { x: Math.sin(headingRad), y: 0, z: -Math.cos(headingRad) };
}

describe('Quat.fromYawPitchRoll / toYawPitchRoll — sign convention worked examples (00-architecture.md section 3.3)', () => {
  it('worked example A: heading=PI/2 (east), pitch=0, roll=0 -> identity', () => {
    const out = createQuat();
    Quat.fromYawPitchRoll(Math.PI / 2, 0, 0, out);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(out.z).toBeCloseTo(0, 9);
    expect(out.w).toBeCloseTo(1, 9);
  });

  it('worked example B: heading=0 (north), pitch=15deg, roll=0', () => {
    const out = createQuat();
    Quat.fromYawPitchRoll(0, 15 * (Math.PI / 180), 0, out);
    expect(out.x).toBeCloseTo(0.09229595564125724, 9);
    expect(out.y).toBeCloseTo(0.7010573846499778, 9);
    expect(out.z).toBeCloseTo(0.09229595564125725, 9);
    expect(out.w).toBeCloseTo(0.7010573846499779, 9);
  });

  it('worked example B rotated: body-forward (1,0,0) -> forwardWorld = (0, sin15, -cos15)', () => {
    const q = createQuat();
    Quat.fromYawPitchRoll(0, 15 * (Math.PI / 180), 0, q);
    const out = { x: 0, y: 0, z: 0 };
    Quat.rotate(q, { x: 1, y: 0, z: 0 }, out);
    expect(Math.abs(out.x)).toBeLessThan(1e-9);
    expect(out.y).toBeCloseTo(Math.sin(15 * (Math.PI / 180)), 9);
    expect(out.z).toBeCloseTo(-Math.cos(15 * (Math.PI / 180)), 9);
    // Cross-check against the world-frame forwardWorld() formula directly.
    const fw = forwardWorld(0);
    // heading=0, but pitch tilts nose up out of the horizontal plane, so we only
    // check that the un-pitched (heading-only) horizontal direction agrees in sign
    // with forwardWorld(0)'s horizontal (z) component (both point north, -Z).
    expect(Math.sign(out.z)).toBe(Math.sign(fw.z));
  });

  it('round trip of worked example B', () => {
    const q = { x: 0.09229595564125724, y: 0.7010573846499778, z: 0.09229595564125725, w: 0.7010573846499779 };
    const out = { headingRad: 0, pitchRad: 0, rollRad: 0 };
    Quat.toYawPitchRoll(q, out);
    expect(Math.abs(out.headingRad)).toBeLessThan(1e-6);
    expect(out.pitchRad).toBeCloseTo(0.2617993878, 9);
    expect(Math.abs(out.rollRad)).toBeLessThan(1e-6);
  });

  it('heading sanity: forwardWorld(0) = north (-Z), forwardWorld(PI/2) = east (+X), forwardWorld(PI) = south (+Z)', () => {
    expect(forwardWorld(0)).toEqual({ x: 0, y: 0, z: -1 });
    const east = forwardWorld(Math.PI / 2);
    expect(east.x).toBeCloseTo(1, 9);
    expect(east.z).toBeCloseTo(0, 9);
    const south = forwardWorld(Math.PI);
    expect(south.x).toBeCloseTo(0, 9);
    expect(south.z).toBeCloseTo(1, 9);
  });

  it('heading=PI/2 (east) via fromYawPitchRoll rotates body-forward to world +X', () => {
    const q = createQuat();
    Quat.fromYawPitchRoll(Math.PI / 2, 0, 0, q);
    const out = { x: 0, y: 0, z: 0 };
    Quat.rotate(q, { x: 1, y: 0, z: 0 }, out);
    expect(out.x).toBeCloseTo(1, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(out.z).toBeCloseTo(0, 9);
  });

  it('roll sign: +roll = right wing down -> body +Z (right wing) rotates toward world -Y', () => {
    // heading=PI/2 (east, identity-equivalent orientation) + roll=+90deg:
    // body +Z (right wing) should rotate to point toward world -Y (down).
    const q = createQuat();
    Quat.fromYawPitchRoll(Math.PI / 2, 0, Math.PI / 2, q);
    const out = { x: 0, y: 0, z: 0 };
    Quat.rotate(q, { x: 0, y: 0, z: 1 }, out);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(-1, 9);
    expect(out.z).toBeCloseTo(0, 9);
  });

  it('pitch sign: +pitch = nose up -> body +X (nose) gains +Y (world up) component', () => {
    const q = createQuat();
    Quat.fromYawPitchRoll(Math.PI / 2, 10 * (Math.PI / 180), 0, q);
    const out = { x: 0, y: 0, z: 0 };
    Quat.rotate(q, { x: 1, y: 0, z: 0 }, out);
    expect(out.y).toBeGreaterThan(0);
  });

  it('randomized round trip: fromYawPitchRoll -> toYawPitchRoll -> fromYawPitchRoll reproduces q (double-cover aware)', () => {
    // Deterministic pseudo-random sampling (no Math.random in sim code; this
    // is a non-hot-path test file, but we still use the project PRNG for
    // reproducibility of the test itself).
    let seed = 1234567 >>> 0;
    function nextUnit(): number {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const TWO_PI = Math.PI * 2;
    const maxPitch = 89.9 * (Math.PI / 180);
    for (let n = 0; n < 2000; n++) {
      const heading = nextUnit() * TWO_PI;
      const pitch = (nextUnit() * 2 - 1) * maxPitch;
      const roll = (nextUnit() * 2 - 1) * Math.PI;

      const q1 = createQuat();
      Quat.fromYawPitchRoll(heading, pitch, roll, q1);
      const ypr = { headingRad: 0, pitchRad: 0, rollRad: 0 };
      Quat.toYawPitchRoll(q1, ypr);
      const q2 = createQuat();
      Quat.fromYawPitchRoll(ypr.headingRad, ypr.pitchRad, ypr.rollRad, q2);

      const sameSign =
        Math.abs(q1.x - q2.x) < 1e-6 &&
        Math.abs(q1.y - q2.y) < 1e-6 &&
        Math.abs(q1.z - q2.z) < 1e-6 &&
        Math.abs(q1.w - q2.w) < 1e-6;
      const flippedSign =
        Math.abs(q1.x + q2.x) < 1e-6 &&
        Math.abs(q1.y + q2.y) < 1e-6 &&
        Math.abs(q1.z + q2.z) < 1e-6 &&
        Math.abs(q1.w + q2.w) < 1e-6;
      expect(sameSign || flippedSign).toBe(true);
    }
  });
});

describe('Quat.rotate / rotateInverse', () => {
  it('rotateInverse is the exact inverse of rotate for a unit quaternion', () => {
    const q = createQuat();
    Quat.fromYawPitchRoll(1.1, 0.3, -0.4, q);
    const v = { x: 5, y: -2, z: 7 };
    const world = { x: 0, y: 0, z: 0 };
    Quat.rotate(q, v, world);
    const back = { x: 0, y: 0, z: 0 };
    Quat.rotateInverse(q, world, back);
    expect(back.x).toBeCloseTo(v.x, 9);
    expect(back.y).toBeCloseTo(v.y, 9);
    expect(back.z).toBeCloseTo(v.z, 9);
  });
});

describe('Quat.multiply / conjugate / identity', () => {
  it('identity is the multiplicative identity', () => {
    const q = createQuat();
    Quat.fromYawPitchRoll(0.5, 0.2, 0.1, q);
    const id = createQuat();
    Quat.identity(id);
    const out = createQuat();
    Quat.multiply(q, id, out);
    expect(Quat.equals(out, q, 1e-9)).toBe(true);
  });

  it('q * conj(q) = identity', () => {
    const q = createQuat();
    Quat.fromYawPitchRoll(0.5, 0.2, 0.1, q);
    const conj = createQuat();
    Quat.conjugate(q, conj);
    const out = createQuat();
    Quat.multiply(q, conj, out);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(out.z).toBeCloseTo(0, 9);
    expect(out.w).toBeCloseTo(1, 9);
  });
});

describe('Quat.integrate', () => {
  it('worked example: identity, omega=(0,0,1), dt=0.01', () => {
    const out = createQuat();
    Quat.integrate({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 1 }, 0.01, out);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(out.z).toBeCloseTo(0.004999937501171851, 9);
    expect(out.w).toBeCloseTo(0.9999875002343701, 9);
  });

  it('length stays within 1e-9 of 1 after 10000 sequential integrate calls (renormalization check)', () => {
    let q = { x: 0, y: 0, z: 0, w: 1 };
    const omega = { x: 0.3, y: -0.2, z: 0.5 };
    for (let i = 0; i < 10000; i++) {
      Quat.integrate(q, omega, 1 / 120, q);
    }
    expect(Math.abs(Quat.length(q) - 1)).toBeLessThan(1e-9);
  });
});

describe('Quat.slerp / nlerp', () => {
  it('slerp worked example: identity -> axisAngle(Y,PI/2), t=0.5', () => {
    const b = createQuat();
    Quat.axisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2, b);
    const out = createQuat();
    Quat.slerp({ x: 0, y: 0, z: 0, w: 1 }, b, 0.5, out);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(0.3826834323650898, 9);
    expect(out.z).toBeCloseTo(0, 9);
    expect(out.w).toBeCloseTo(0.9238795325112868, 9);
    expect(Quat.length(out)).toBeCloseTo(1, 9);
  });

  it('slerp takes the shortest path', () => {
    const b = createQuat();
    Quat.axisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2, b);
    const bNeg = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
    const outShort = createQuat();
    Quat.slerp({ x: 0, y: 0, z: 0, w: 1 }, b, 0.5, outShort);
    const outLong = createQuat();
    Quat.slerp({ x: 0, y: 0, z: 0, w: 1 }, bNeg, 0.5, outLong);
    expect(Quat.equals(outShort, outLong, 1e-9)).toBe(true);
  });
});

describe('body rate accessors (00-architecture.md section 3.4: p=wx, q=wz, r=-wy)', () => {
  it('bodyRateP/Q/R match the worked example {x:2,y:3,z:5}', () => {
    const omega = { x: 2, y: 3, z: 5 };
    expect(bodyRateP(omega)).toBe(2);
    expect(bodyRateQ(omega)).toBe(5);
    expect(bodyRateR(omega)).toBe(-3);
  });

  it('rotation about +X (pure p, right roll) matches bodyRateP sign: right wing (+Z) moves toward -Y (down) initially', () => {
    // A small positive rotation about body +X should move the right-wing
    // point (0,0,1) toward -Y (down), matching "+roll = right wing down".
    const q = createQuat();
    Quat.identity(q);
    Quat.integrate(q, { x: 0.01, y: 0, z: 0 }, 1, q); // one 1s "tick" at 0.01 rad/s for a tiny-angle check
    const out = { x: 0, y: 0, z: 0 };
    Quat.rotate(q, { x: 0, y: 0, z: 1 }, out);
    expect(bodyRateP({ x: 0.01, y: 0, z: 0 })).toBeGreaterThan(0);
    expect(out.y).toBeLessThan(0);
  });

  it('rotation about +Z (pure q, nose-up pitch rate) matches bodyRateQ sign: nose (+X) moves toward +Y (up)', () => {
    const q = createQuat();
    Quat.identity(q);
    Quat.integrate(q, { x: 0, y: 0, z: 0.01 }, 1, q);
    const out = { x: 0, y: 0, z: 0 };
    Quat.rotate(q, { x: 1, y: 0, z: 0 }, out);
    expect(bodyRateQ({ x: 0, y: 0, z: 0.01 })).toBeGreaterThan(0);
    expect(out.y).toBeGreaterThan(0);
  });

  it('rotation about +Y (pure -r, since r=-wy) matches bodyRateR sign: positive wy moves nose (+X) toward -Z (i.e. nose LEFT, negative r)', () => {
    const q = createQuat();
    Quat.identity(q);
    Quat.integrate(q, { x: 0, y: 0.01, z: 0 }, 1, q);
    const out = { x: 0, y: 0, z: 0 };
    Quat.rotate(q, { x: 1, y: 0, z: 0 }, out);
    // omega=(0,+0.01,0) => r = -wy = -0.01 < 0 (nose-right rate is negative, i.e. nose moves left).
    expect(bodyRateR({ x: 0, y: 0.01, z: 0 })).toBeLessThan(0);
    // +wy rotates +X (nose) toward +Z (right wing) by the right-hand rule about +Y,
    // i.e. the nose swings toward the right-wing axis => world z component increases toward +Z...
    // Concretely: axisAngle(Y, theta) rotates X toward -Z for theta>0 in a right-handed
    // frame (X x Y = Z means rotating about Y takes Z->X->-Z->-X->Z, i.e. X moves toward -Z).
    expect(out.z).toBeLessThan(0);
  });
});
