/**
 * src/render/cockpit/head.ts — the pilot's head in the 3D cockpit.
 *
 * The eye turns about a neck pivot below and behind it (so looking around moves the eye the way a
 * real head does, with parallax against the canopy frame), leans out over the shoulder when looking
 * far back, and drops forward a little when looking down at the consoles. G pushes the head down
 * into the seat; buffet near the AoA limit, transonic buffet and the runway shake it.
 *
 * Output is in the cockpit frame (body axes, origin at the design eye point): the eye position
 * and the camera orientation (a three.js camera looks down its -Z, so the base orientation turns
 * -Z onto body +X).
 */

import * as THREE from 'three';
import {
  COCKPIT3D_MAX_FOV_DEG,
  COCKPIT3D_MAX_PITCH_DOWN_RAD,
  COCKPIT3D_MAX_PITCH_UP_RAD,
  COCKPIT3D_MAX_YAW_RAD,
  COCKPIT3D_MIN_FOV_DEG,
  COCKPIT3D_VERTICAL_FOV_DEG,
} from '../../contracts/render';

export interface HeadState {
  /** Where the pilot is looking: yaw (+ = left), pitch (+ = up), rad; vertical field of view, deg. */
  yaw: number;
  pitch: number;
  fovDeg: number;
  /** Smoothed versions actually drawn. */
  yawS: number;
  pitchS: number;
  fovS: number;
  /** Smoothed G offset of the head, m. */
  gSag: number;
  gSagVel: number;
  time: number;
}

export function createHeadState(): HeadState {
  return { yaw: 0, pitch: 0, fovDeg: COCKPIT3D_VERTICAL_FOV_DEG, yawS: 0, pitchS: 0, fovS: COCKPIT3D_VERTICAL_FOV_DEG, gSag: 0, gSagVel: 0, time: 0 };
}

export function lookHead(h: HeadState, dYaw: number, dPitch: number, dFov: number): void {
  h.yaw = Math.max(-COCKPIT3D_MAX_YAW_RAD, Math.min(COCKPIT3D_MAX_YAW_RAD, h.yaw + dYaw));
  h.pitch = Math.max(-COCKPIT3D_MAX_PITCH_DOWN_RAD, Math.min(COCKPIT3D_MAX_PITCH_UP_RAD, h.pitch + dPitch));
  h.fovDeg = Math.max(COCKPIT3D_MIN_FOV_DEG, Math.min(COCKPIT3D_MAX_FOV_DEG, h.fovDeg + dFov));
}

export function recenterHead(h: HeadState): void {
  h.yaw = 0;
  h.pitch = 0;
  h.fovDeg = COCKPIT3D_VERTICAL_FOV_DEG;
}

export interface HeadMotionInput {
  g: number;
  aoaDeg: number;
  mach: number;
  iasKt: number;
  onGround: boolean;
  groundSpeedMps: number;
}

/** Neck pivot relative to the eye (behind and below it), m. */
const NECK_TO_EYE = new THREE.Vector3(0.1, 0.12, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
/** Camera -Z onto body +X, camera +Y onto body +Y. */
const CAMERA_BASE = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, -Math.PI / 2);

const qYaw = new THREE.Quaternion();
const qPitch = new THREE.Quaternion();
const qShake = new THREE.Quaternion();
const eShake = new THREE.Euler();
const tmp = new THREE.Vector3();

const smooth = (x: number, a: number, b: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Advances the head and writes the eye position and camera orientation (cockpit frame).
 * Returns the smoothed vertical field of view, deg.
 */
export function updateHead(h: HeadState, dt: number, m: Readonly<HeadMotionInput>, eyeOut: THREE.Vector3, rotOut: THREE.Quaternion): number {
  h.time += dt;
  // The view follows the pointer with a short lag (a head has mass), zoom a little slower.
  const kLook = 1 - Math.exp(-dt / 0.05);
  h.yawS += (h.yaw - h.yawS) * kLook;
  h.pitchS += (h.pitch - h.pitchS) * kLook;
  h.fovS += (h.fovDeg - h.fovS) * (1 - Math.exp(-dt / 0.12));

  // G: the head sinks under positive G and lifts under negative (spring-damper, ~0.15 s).
  const gTarget = Math.max(-0.035, Math.min(0.02, -(m.g - 1) * 0.0055));
  const w = 2 * Math.PI * 2.2;
  const acc = w * w * (gTarget - h.gSag) - 2 * 0.8 * w * h.gSagVel;
  h.gSagVel += acc * dt;
  h.gSag += h.gSagVel * dt;

  // Eye about the neck pivot.
  qYaw.setFromAxisAngle(AXIS_Y, h.yawS);
  qPitch.setFromAxisAngle(AXIS_Z, h.pitchS);
  const qLook = qYaw.multiply(qPitch);
  tmp.copy(NECK_TO_EYE).applyQuaternion(qLook);
  eyeOut.set(-NECK_TO_EYE.x, -NECK_TO_EYE.y, 0).add(tmp);
  // Torso: lean out over the shoulder looking back, forward and down looking at the consoles.
  const back = smooth(Math.abs(h.yawS), 0.9, 2.4);
  eyeOut.z += -Math.sign(h.yawS) * 0.13 * back;
  eyeOut.x += 0.05 * back;
  const down = smooth(-h.pitchS, 0.25, 1.1);
  eyeOut.x += 0.07 * down;
  eyeOut.y -= 0.04 * down;
  eyeOut.y += h.gSag;

  // Shake: buffet near the AoA limit, transonic buffet, runway roughness.
  const speedK = Math.min(1, m.iasKt / 120);
  const buffet = smooth(m.aoaDeg, 15, 23) * speedK * 1.0 + smooth(m.mach, 0.9, 0.98) * (1 - smooth(m.mach, 1.02, 1.1)) * 0.5;
  const rumble = m.onGround ? Math.min(1, m.groundSpeedMps / 50) * 0.7 : 0;
  const a = buffet + rumble;
  if (a > 0.001) {
    const t = h.time;
    const n1 = Math.sin(t * 71.3) * 0.6 + Math.sin(t * 113.7 + 1.3) * 0.4;
    const n2 = Math.sin(t * 83.1 + 2.1) * 0.6 + Math.sin(t * 131.9 + 0.4) * 0.4;
    const n3 = Math.sin(t * 57.7 + 4.2) * 0.5 + Math.sin(t * 97.3 + 3.3) * 0.5;
    eyeOut.y += n1 * 0.0022 * a;
    eyeOut.z += n2 * 0.0012 * a;
    eShake.set(n3 * 0.0018 * a, n2 * 0.0012 * a, n1 * 0.0022 * a);
    qShake.setFromEuler(eShake);
    rotOut.copy(qLook).multiply(qShake).multiply(CAMERA_BASE);
  } else {
    rotOut.copy(qLook).multiply(CAMERA_BASE);
  }
  return h.fovS;
}
