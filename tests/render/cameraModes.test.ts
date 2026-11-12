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
    expect(out.pos.x).toBeCloseTo(103.53, 9);
    expect(out.pos.y).toBeCloseTo(200.84, 9);
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
    chaseLook(s, 2, 0.5, 0);
    const held = settle(s, FREE_LOOK_RETURN_DELAY_SEC - 1);
    expect(held.pos.x).toBeGreaterThan(0); // in front of the wing line
    const back = settle(s, 6);
    expect(back.pos.x).toBeCloseTo(-15, 0);
    expect(back.pos.y).toBeCloseTo(1004, 0);
  });

  it('zoom is proportional and stays; re-centre can be turned off', () => {
    const s = createChaseCameraState();
    chaseLook(s, 0, 0, 2); // two notches out: x 1.15^2
    let out = settle(s, FREE_LOOK_RETURN_DELAY_SEC + 6);
    expect(Math.hypot(out.pos.x, out.pos.y - 1000, out.pos.z)).toBeCloseTo(Math.hypot(15, 4) * 1.15 ** 2, 1);
    s.returnDelaySec = Infinity;
    chaseLook(s, 1.5, 0, 0);
    out = settle(s, 20);
    expect(out.pos.x).toBeGreaterThan(-10); // still off to the side
  });

  it('leans a little with the bank', () => {
    const s = createChaseCameraState();
    const bank = { x: Math.sin(0.4), y: 0, z: 0, w: Math.cos(0.4) }; // 46 deg about the nose (+x)
    const out = createCameraPose();
    for (let t = 0; t < 2; t += 1 / 60) computeChasePose(pos, bank, s, 1 / 60, out);
    expect(Math.abs(out.up.z)).toBeGreaterThan(0.1);
    expect(out.up.y).toBeGreaterThan(0.85);
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

import { cockpitGlance, computeFlybyPose, createCockpitLookState, createFlybyState, lookCamera, createCameraModeState } from '../../src/render/cameraModes';
import { CameraMode, COCKPIT_VERTICAL_FOV_DEG, EXTERNAL_ORBIT_DEFAULT_RADIUS_M } from '../../src/contracts/render';

describe('the views are distinct', () => {
  const level = { x: 0, y: 0, z: 0, w: 1 }; // nose east (+x)
  const jet = { x: 0, y: 1000, z: 0 };

  it('orbit: starts ahead of the nose on the front quarter, and turns with the heading', () => {
    const st = createExternalOrbitState();
    const pose = createCameraPose();
    computeExternalPose(jet, st, pose, -Infinity, level, 1 / 60);
    expect(pose.pos.x).toBeGreaterThan(10); // ahead of the nose (east)
    expect(Math.abs(pose.pos.z)).toBeGreaterThan(10); // off to one side
    expect(Math.hypot(pose.pos.x, pose.pos.y - 1000, pose.pos.z)).toBeCloseTo(EXTERNAL_ORBIT_DEFAULT_RADIUS_M, 3);
    // Jet turned to face north (-z): after a few seconds the camera is ahead of it again (north).
    const north = { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) }; // +90 deg about +y: +x -> -z
    for (let t = 0; t < 6; t += 1 / 60) computeExternalPose(jet, st, pose, -Infinity, north, 1 / 60);
    expect(pose.pos.z).toBeLessThan(-10);
    // Zoom out by steps, proportionally.
    orbitCamera(st, 0, 0, 3);
    expect(st.radiusM).toBeCloseTo(EXTERNAL_ORBIT_DEFAULT_RADIUS_M * 1.15 ** 3, 6);
  });

  it('fly-by: stands beside the flight path ahead, and its telephoto tightens as the jet nears', () => {
    const st = createFlybyState();
    const pose = createCameraPose();
    const vel = { x: 200, y: 0, z: 0 };
    const p = { ...jet };
    computeFlybyPose(p, level, vel, st, pose, 1 / 60);
    expect(st.fixedPos.x).toBeGreaterThan(300);
    expect(Math.abs(st.fixedPos.z)).toBeGreaterThan(40); // not on the path
    const far = pose.fovDeg;
    p.x = st.fixedPos.x - 150;
    for (let t = 0; t < 1; t += 1 / 60) computeFlybyPose(p, level, vel, st, pose, 1 / 60);
    expect(pose.fovDeg).toBeGreaterThan(far); // wider when close (the jet stays framed)
    const firstSide = Math.sign(st.fixedPos.z);
    p.x = st.fixedPos.x + 700; // long gone past
    computeFlybyPose(p, level, vel, st, pose, 1 / 60);
    expect(Math.sign(st.fixedPos.z)).toBe(-firstSide); // the next one on the other side
  });

  it('HUD only: a glance springs back when let go; zoom changes the field of view and stays', () => {
    const state = createCameraModeState();
    lookCamera(CameraMode.Cockpit, state, 0.8, 0, 0);
    expect(state.cockpit.yawRad).toBeCloseTo(0.8, 6);
    const pose = createCameraPose();
    for (let t = 0; t < 2; t += 1 / 60) computeCockpitPose(jet, level, pose, state.cockpit, 1 / 60);
    expect(Math.abs(state.cockpit.yawRad)).toBeLessThan(0.01);
    const look = createCockpitLookState();
    cockpitGlance(look, 0, 0, -3);
    expect(look.fovDeg).toBeCloseTo(COCKPIT_VERTICAL_FOV_DEG / 1.15 ** 3, 6);
    computeCockpitPose(jet, level, pose, look, 1);
    expect(pose.fovDeg).toBeCloseTo(look.fovDeg, 6);
  });
});
