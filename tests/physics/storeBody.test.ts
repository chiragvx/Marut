/**
 * tests/physics/storeBody.test.ts — the free-store rigid body: ballistic without air, weathercocks
 * when its normal force acts behind the CG, diverges when it acts ahead, and a tumble stays bounded.
 */
import { describe, expect, test } from 'vitest';
import { stepStoreBody, type StoreBodyParams, type StoreBodyState } from '../../src/physics/storeBody';
import { Quat } from '../../src/math';

const DT = 1 / 120;
const STILL = { x: 0, y: 0, z: 0 };

function body(speedMps: number, alphaRad: number): StoreBodyState {
  // Nose along +X, pitched up by alpha relative to a level flight path along +X.
  const rot = { x: 0, y: 0, z: 0, w: 1 };
  Quat.axisAngle({ x: 0, y: 0, z: 1 }, alphaRad, rot);
  return { pos: { x: 0, y: 5000, z: 0 }, vel: { x: speedMps, y: 0, z: 0 }, rot, omega: { x: 0, y: 0, z: 0 } };
}

const BASE: StoreBodyParams = {
  massKg: 250, lengthM: 3, diameterM: 0.4, cdAxial: 0.2, cnAlpha: 2, cdCrossflow: 1.2,
  cpOffsetM: -0.4, cpFixed: true, crossflowArmM: 0, cmq: 6, clp: 0.5,
};

/** Angle between the body's nose and its velocity, rad. */
function alphaOf(s: StoreBodyState): number {
  const nose = { x: 0, y: 0, z: 0 };
  Quat.rotate(s.rot, { x: 1, y: 0, z: 0 }, nose);
  const v = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
  return Math.acos(Math.max(-1, Math.min(1, (nose.x * s.vel.x + nose.y * s.vel.y + nose.z * s.vel.z) / v)));
}

describe('stepStoreBody', () => {
  test('in a vacuum it is a ballistic point (and keeps its attitude)', () => {
    const s = body(200, 0.1);
    const rot0 = { ...s.rot };
    for (let i = 0; i < 240; i++) stepStoreBody(s, BASE, { densityKgM3: 0, windWorldMps: STILL, gravityMps2: 9.81 }, DT);
    expect(s.pos.x).toBeCloseTo(400, 6);
    expect(s.pos.y).toBeCloseTo(5000 - 0.5 * 9.81 * 4, 0);
    expect(Quat.equals(s.rot, rot0, 1e-9)).toBe(true);
  });

  test('a finned store (normal force behind the CG) weathercocks into the airflow', () => {
    const s = body(250, 0.25);
    const alphas: number[] = [];
    for (let i = 0; i < 360; i++) {
      stepStoreBody(s, BASE, { densityKgM3: 0.74, windWorldMps: STILL, gravityMps2: 9.81 }, DT);
      alphas.push(alphaOf(s));
    }
    // Swings through and settles: well under the release angle after 3 s, and it did oscillate.
    expect(alphas[alphas.length - 1]!).toBeLessThan(0.03);
    expect(Math.min(...alphas.slice(0, 120))).toBeLessThan(0.1);
  });

  test('the same store with the force ahead of the CG diverges (tumbles)', () => {
    const s = body(250, 0.05);
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      stepStoreBody(s, { ...BASE, cpOffsetM: 0.4, cpFixed: false }, { densityKgM3: 0.74, windWorldMps: STILL, gravityMps2: 9.81 }, DT);
      peak = Math.max(peak, alphaOf(s));
    }
    expect(peak).toBeGreaterThan(1.2);
  });

  test('a tumbling store stays finite and slows down', () => {
    const s = body(250, 0.05);
    const p = { ...BASE, massKg: 140, lengthM: 4, diameterM: 0.72, cpOffsetM: 0.4, cpFixed: false, cdAxial: 0.12 };
    for (let i = 0; i < 30 / DT; i++) stepStoreBody(s, p, { densityKgM3: 1.0, windWorldMps: STILL, gravityMps2: 9.81 }, DT);
    const v = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    expect(Number.isFinite(v) && Number.isFinite(s.omega.z)).toBe(true);
    // A tumbling 140 kg tank comes down at a few tens of m/s, not 250.
    expect(v).toBeLessThan(90);
    expect(Math.hypot(s.omega.x, s.omega.y, s.omega.z)).toBeLessThan(30);
  });

  test('wind: in a steady wind it ends up drifting with the air', () => {
    const s = body(0, 0);
    s.vel.x = 0;
    for (let i = 0; i < 40 / DT; i++) stepStoreBody(s, BASE, { densityKgM3: 1.0, windWorldMps: { x: 0, y: 0, z: 15 }, gravityMps2: 9.81 }, DT);
    expect(s.vel.z).toBeGreaterThan(8);
  });
});

describe('stepStoreBody: drag rise, ballute, thrust', () => {
  const STILL_ENV = { densityKgM3: 1.0, soundSpeedMps: 330, windWorldMps: STILL, gravityMps2: 0 };
  const decel = (p: StoreBodyParams, v: number): number => {
    const s = body(v, 0);
    stepStoreBody(s, p, STILL_ENV, DT);
    return (v - s.vel.x) / DT;
  };

  test('axial drag rises through the sound barrier', () => {
    const p = { ...BASE, machDragRise: 1 };
    const sub = decel(p, 0.7 * 330) / (0.7 * 0.7);
    const trans = decel(p, 1.1 * 330) / (1.1 * 1.1);
    expect(trans / sub).toBeGreaterThan(1.9);
    expect(trans / sub).toBeLessThan(2.1);
  });

  test('a ballute adds its drag and holds the body into the airflow', () => {
    expect(decel({ ...BASE, trailingCdA: 0.9, trailingArmM: -2.5 }, 200)).toBeGreaterThan(decel(BASE, 200) * 5);
    // Without fins (neutral), a ballute alone weathercocks the body.
    const s = body(200, 0.3);
    const p = { ...BASE, cnAlpha: 0, trailingCdA: 0.9, trailingArmM: -2.5 };
    for (let i = 0; i < 240; i++) stepStoreBody(s, p, { ...STILL_ENV, gravityMps2: 9.81 }, DT);
    expect(alphaOf(s)).toBeLessThan(0.05);
  });

  test('thrust acts along the nose', () => {
    const s = body(0, 0);
    stepStoreBody(s, { ...BASE, thrustN: 2500 }, { ...STILL_ENV, densityKgM3: 0 }, 1);
    expect(s.vel.x).toBeCloseTo(10, 6);
    expect(s.vel.y).toBeCloseTo(0, 9);
  });
});
