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
    expect(out.pos.x).toBeCloseTo(102.65, 9);
    expect(out.pos.y).toBeCloseTo(201.2, 9);
    expect(out.pos.z).toBeCloseTo(300, 9);
    expect(out.useLookAt).toBe(false);
  });
});

import { chaseLook, computeChasePose, createChaseCameraState } from '../../src/render/cameraModes';
import { FREE_LOOK_MAX_DISTANCE_M, FREE_LOOK_RETURN_DELAY_SEC } from '../../src/contracts/render';

describe('chase free look', () => {
  // Identity rotation: nose east (+x), so "behind" is -x and the aircraft's right is +z.
  const pos = { x: 0, y: 1000, z: 0 };
  const rot = { x: 0, y: 0, z: 0, w: 1 };
  const settle = (state: ReturnType<typeof createChaseCameraState>, sec: number) => {
    const out = createCameraPose();
    for (let t = 0; t < sec; t += 1 / 60) computeChasePose(pos, rot, state, 1 / 60, out);
    return out;
  };

  it('with no look input, sits 15 m behind and 4 m above as before', () => {
    const out = settle(createChaseCameraState(), 1);
    expect(out.pos.x).toBeCloseTo(-15, 3);
    expect(out.pos.y).toBeCloseTo(1004, 3);
    expect(out.pos.z).toBeCloseTo(0, 3);
  });

  it('looking around swings the camera round the aircraft and zoom keeps its limits', () => {
    const s = createChaseCameraState();
    chaseLook(s, Math.PI / 2, 0, 0);
    let out = settle(s, 1);
    // A quarter turn from behind: beside the aircraft, same distance.
    expect(Math.abs(out.pos.x)).toBeLessThan(0.5);
    expect(Math.abs(out.pos.z)).toBeCloseTo(15, 0);
    chaseLook(s, 0, 0, 1000);
    out = settle(s, 1);
    expect(Math.hypot(out.pos.x, out.pos.y - 1000, out.pos.z)).toBeCloseTo(FREE_LOOK_MAX_DISTANCE_M, 0);
  });

  it('holds where you looked, then eases back behind after the delay', () => {
    const s = createChaseCameraState();
    chaseLook(s, 2, 0.5, 10);
    const held = settle(s, FREE_LOOK_RETURN_DELAY_SEC - 1);
    expect(held.pos.x).toBeGreaterThan(0); // in front of the wing line
    const back = settle(s, 6);
    expect(back.pos.x).toBeCloseTo(-15, 0);
    expect(back.pos.y).toBeCloseTo(1004, 0);
  });
});

describe('chase camera at speed', () => {
  it('keeps its distance and goes where you look however fast the aircraft flies', () => {
    const s = createChaseCameraState();
    const out = createCameraPose();
    const rot = { x: 0, y: 0, z: 0, w: 1 }; // nose east
    const pos = { x: 0, y: 1000, z: 0 };
    let minD = Infinity;
    for (let i = 0; i < 180; i++) {
      pos.x += 190 / 60; // 190 m/s east
      if (i < 60) chaseLook(s, Math.PI / 60, 0, 0); // half a turn over 1 s
      computeChasePose(pos, rot, s, 1 / 60, out);
      minD = Math.min(minD, Math.hypot(out.pos.x - pos.x, out.pos.y - pos.y, out.pos.z - pos.z));
    }
    expect(minD).toBeGreaterThan(15); // never pulled back through the aircraft
    expect(out.pos.x - pos.x).toBeCloseTo(15, 0); // in front of it, as asked
  });
});

import { keepAboveGround, computeExternalPose, createExternalOrbitState, orbitCamera } from '../../src/render/cameraModes';
import { CAMERA_MIN_GROUND_CLEARANCE_M } from '../../src/contracts/render';

describe('outside views stay above the ground', () => {
  const ground = (x: number): number => 190 + 0.02 * x; // a gentle slope

  it('lifts a camera below the ground to the clearance, leaves one above alone', () => {
    const pose = createCameraPose();
    pose.pos = { x: 100, y: 150, z: 0 };
    expect(keepAboveGround(pose, ground, CAMERA_MIN_GROUND_CLEARANCE_M)).toBe(true);
    expect(pose.pos.y).toBeCloseTo(192 + CAMERA_MIN_GROUND_CLEARANCE_M, 9);
    pose.pos.y = 300;
    expect(keepAboveGround(pose, ground, CAMERA_MIN_GROUND_CLEARANCE_M)).toBe(false);
    expect(pose.pos.y).toBe(300);
  });

  it('free look dragged all the way under the jet on the runway slides along the ground, never under or into it', () => {
    const st = createChaseCameraState();
    const pose = createCameraPose();
    const jet = { x: 0, y: 191.1, z: 0 }; // on its wheels, field at 190
    const level = { x: 0, y: 0, z: 0, w: 1 };
    const minOffsetY = 190 + CAMERA_MIN_GROUND_CLEARANCE_M - jet.y;
    for (let i = 0; i < 120; i++) {
      chaseLook(st, 0.02, -0.1, 0); // round and down, far past the ground
      computeChasePose(jet, level, st, 1 / 60, pose, minOffsetY);
      expect(pose.pos.y).toBeGreaterThanOrEqual(190 + CAMERA_MIN_GROUND_CLEARANCE_M - 1e-6);
    }
    // Still its full distance out from the jet (not tucked under a wing).
    expect(Math.hypot(pose.pos.x - jet.x, pose.pos.z - jet.z)).toBeGreaterThan(14);
    // No wind-up below the ground: one small drag up lifts the camera straight away.
    const before = pose.pos.y;
    chaseLook(st, 0, 0.1, 0);
    for (let i = 0; i < 30; i++) computeChasePose(jet, level, st, 1 / 60, pose, minOffsetY);
    expect(pose.pos.y).toBeGreaterThan(before + 1);
  });

  it('the external orbit pitched fully down stops at the ground, and pitches back up at once', () => {
    const st = createExternalOrbitState();
    const pose = createCameraPose();
    const jet = { x: 0, y: 191.1, z: 0 };
    const minOffsetY = 190 + CAMERA_MIN_GROUND_CLEARANCE_M - jet.y;
    orbitCamera(st, 0, -10, 0);
    computeExternalPose(jet, st, pose, minOffsetY);
    expect(pose.pos.y).toBeCloseTo(190 + CAMERA_MIN_GROUND_CLEARANCE_M, 6);
    orbitCamera(st, 0, 0.2, 0);
    computeExternalPose(jet, st, pose, minOffsetY);
    expect(pose.pos.y).toBeGreaterThan(190 + CAMERA_MIN_GROUND_CLEARANCE_M + 2);
  });
});
