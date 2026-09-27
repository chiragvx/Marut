/**
 * src/render/cameraModes.ts
 *
 * Cockpit/chase/external/flyby camera pose computation. 08-render.md
 * section 4.2. Each mode is a pure function of (player pose, mode-owned
 * state); `computeCameraPose` is the dispatcher `SceneRenderer.renderFrame`
 * calls once per frame.
 */

import type { QuatLike, Vec3Like } from '../contracts/core';
import {
  CHASE_CAM_DISTANCE_M,
  CHASE_CAM_HEIGHT_M,
  CHASE_CAM_SMOOTHING_TAU_SEC,
  CameraMode,
  FREE_LOOK_MAX_DISTANCE_M,
  FREE_LOOK_MIN_DISTANCE_M,
  FREE_LOOK_RETURN_DELAY_SEC,
  FREE_LOOK_RETURN_TAU_SEC,
  COCKPIT_EYE_OFFSET_BODY_M,
  EXTERNAL_ORBIT_DEFAULT_PITCH_RAD,
  EXTERNAL_ORBIT_DEFAULT_RADIUS_M,
  EXTERNAL_ORBIT_MAX_RADIUS_M,
  EXTERNAL_ORBIT_MIN_RADIUS_M,
  FLYBY_HEIGHT_OFFSET_M,
  FLYBY_PLACEMENT_DISTANCE_M,
  FLYBY_RESET_DISTANCE_M,
} from '../contracts/render';
import { clamp, expSmooth, rotateVecByQuat, vec3Length, vec3Normalize } from './mathInternal';

/** Body-forward, fixed unit vector (00-architecture.md section 3.2: body +X is nose). Module-scope constant, not per-call. */
const BODY_FORWARD: Readonly<Vec3Like> = { x: 1, y: 0, z: 0 };

/** External-orbit pitch clamp, rad (~80 deg), avoids gimbal flip at the poles. */
const EXTERNAL_ORBIT_PITCH_CLAMP_RAD = 1.4;

/**
 * Result of any per-mode pose function. When `useLookAt` is true, the caller
 * (src/render/scene.ts) points the Three.js camera at `lookAt`; otherwise it
 * sets the camera's orientation directly from `rot` (cockpit only). Both
 * `rot`/`lookAt` fields always exist (never null) to stay allocation-free;
 * only the one selected by `useLookAt` is meaningful this call.
 */
export interface CameraPose {
  pos: Vec3Like;
  rot: QuatLike;
  lookAt: Vec3Like;
  useLookAt: boolean;
}

export function createCameraPose(): CameraPose {
  return {
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    lookAt: { x: 0, y: 0, z: 0 },
    useLookAt: false,
  };
}

// -----------------------------------------------------------------------------
// Cockpit.
// -----------------------------------------------------------------------------

export function computeCockpitPose(playerPos: Readonly<Vec3Like>, playerRot: Readonly<QuatLike>, out: CameraPose): CameraPose {
  rotateVecByQuat(playerRot, COCKPIT_EYE_OFFSET_BODY_M, out.pos);
  out.pos.x += playerPos.x;
  out.pos.y += playerPos.y;
  out.pos.z += playerPos.z;
  out.rot.x = playerRot.x;
  out.rot.y = playerRot.y;
  out.rot.z = playerRot.z;
  out.rot.w = playerRot.w;
  out.useLookAt = false;
  return out;
}

// -----------------------------------------------------------------------------
// Chase.
// -----------------------------------------------------------------------------

export interface ChaseCameraState {
  smoothedPos: Vec3Like;
  initialized: boolean;
  /** Free look, added to the default view: yaw (rad, + = view swings to the aircraft's right), elevation (rad, + = from higher up), extra distance (m). */
  lookYawRad: number;
  lookPitchRad: number;
  lookZoomM: number;
  /** Seconds since the player last looked around. */
  lookIdleSec: number;
}

export function createChaseCameraState(): ChaseCameraState {
  return { smoothedPos: { x: 0, y: 0, z: 0 }, initialized: false, lookYawRad: 0, lookPitchRad: 0, lookZoomM: 0, lookIdleSec: Infinity };
}

/** Default chase offset as a distance and an elevation angle (15 m back, 4 m up). */
const CHASE_RANGE_M = Math.hypot(CHASE_CAM_DISTANCE_M, CHASE_CAM_HEIGHT_M);
const CHASE_ELEVATION_RAD = Math.atan2(CHASE_CAM_HEIGHT_M, CHASE_CAM_DISTANCE_M);
/** Free look never goes past looking straight down or up at the aircraft. */
const CHASE_LOOK_ELEVATION_LIMIT_RAD = 1.45;

/** Applies a free-look input (drag/scroll) and restarts the return-to-behind delay. */
export function chaseLook(state: ChaseCameraState, deltaYawRad: number, deltaPitchRad: number, deltaZoomM: number): void {
  state.lookYawRad = Math.atan2(Math.sin(state.lookYawRad + deltaYawRad), Math.cos(state.lookYawRad + deltaYawRad));
  state.lookPitchRad = clamp(state.lookPitchRad + deltaPitchRad, -CHASE_LOOK_ELEVATION_LIMIT_RAD - CHASE_ELEVATION_RAD, CHASE_LOOK_ELEVATION_LIMIT_RAD - CHASE_ELEVATION_RAD);
  state.lookZoomM = clamp(state.lookZoomM + deltaZoomM, FREE_LOOK_MIN_DISTANCE_M - CHASE_RANGE_M, FREE_LOOK_MAX_DISTANCE_M - CHASE_RANGE_M);
  state.lookIdleSec = 0;
}

const scratchChaseForward: Vec3Like = { x: 0, y: 0, z: 0 };

export function computeChasePose(
  playerPos: Readonly<Vec3Like>,
  playerRot: Readonly<QuatLike>,
  state: ChaseCameraState,
  frameDtSec: number,
  out: CameraPose
): CameraPose {
  // After a while without looking around, ease the view back behind the aircraft.
  state.lookIdleSec += frameDtSec;
  if (state.lookIdleSec > FREE_LOOK_RETURN_DELAY_SEC) {
    state.lookYawRad = expSmooth(state.lookYawRad, 0, FREE_LOOK_RETURN_TAU_SEC, frameDtSec);
    state.lookPitchRad = expSmooth(state.lookPitchRad, 0, FREE_LOOK_RETURN_TAU_SEC, frameDtSec);
    state.lookZoomM = expSmooth(state.lookZoomM, 0, FREE_LOOK_RETURN_TAU_SEC, frameDtSec);
  }

  rotateVecByQuat(playerRot, BODY_FORWARD, scratchChaseForward);
  // Default: behind along the nose, a little above. As a direction and elevation from the
  // aircraft, then turned by the free look.
  const fx = scratchChaseForward.x;
  const fy = scratchChaseForward.y;
  const fz = scratchChaseForward.z;
  const ox = -fx * CHASE_CAM_DISTANCE_M;
  const oy = -fy * CHASE_CAM_DISTANCE_M + CHASE_CAM_HEIGHT_M;
  const oz = -fz * CHASE_CAM_DISTANCE_M;
  let desiredX: number;
  let desiredY: number;
  let desiredZ: number;
  if (state.lookYawRad === 0 && state.lookPitchRad === 0 && state.lookZoomM === 0) {
    desiredX = playerPos.x + ox;
    desiredY = playerPos.y + oy;
    desiredZ = playerPos.z + oz;
  } else {
    const r0 = Math.hypot(ox, oy, oz);
    const azimuth = Math.atan2(ox, oz) + state.lookYawRad;
    const elevation = clamp(Math.asin(clamp(oy / r0, -1, 1)) + state.lookPitchRad, -CHASE_LOOK_ELEVATION_LIMIT_RAD, CHASE_LOOK_ELEVATION_LIMIT_RAD);
    const r = r0 + state.lookZoomM;
    const h = r * Math.cos(elevation);
    desiredX = playerPos.x + h * Math.sin(azimuth);
    desiredY = playerPos.y + r * Math.sin(elevation);
    desiredZ = playerPos.z + h * Math.cos(azimuth);
  }

  if (!state.initialized) {
    state.smoothedPos.x = desiredX;
    state.smoothedPos.y = desiredY;
    state.smoothedPos.z = desiredZ;
    state.initialized = true;
  } else {
    state.smoothedPos.x = expSmooth(state.smoothedPos.x, desiredX, CHASE_CAM_SMOOTHING_TAU_SEC, frameDtSec);
    state.smoothedPos.y = expSmooth(state.smoothedPos.y, desiredY, CHASE_CAM_SMOOTHING_TAU_SEC, frameDtSec);
    state.smoothedPos.z = expSmooth(state.smoothedPos.z, desiredZ, CHASE_CAM_SMOOTHING_TAU_SEC, frameDtSec);
  }

  out.pos.x = state.smoothedPos.x;
  out.pos.y = state.smoothedPos.y;
  out.pos.z = state.smoothedPos.z;
  out.lookAt.x = playerPos.x;
  out.lookAt.y = playerPos.y + 1;
  out.lookAt.z = playerPos.z;
  out.useLookAt = true;
  return out;
}

// -----------------------------------------------------------------------------
// External (orbit).
// -----------------------------------------------------------------------------

export interface ExternalOrbitState {
  yawRad: number;
  pitchRad: number;
  radiusM: number;
}

export function createExternalOrbitState(): ExternalOrbitState {
  return {
    yawRad: 0,
    pitchRad: EXTERNAL_ORBIT_DEFAULT_PITCH_RAD,
    radiusM: EXTERNAL_ORBIT_DEFAULT_RADIUS_M,
  };
}

/** Mutates `state` per `SceneRenderer.orbitCamera`'s contract. */
export function orbitCamera(state: ExternalOrbitState, deltaYawRad: number, deltaPitchRad: number, deltaZoomM: number): void {
  state.yawRad += deltaYawRad;
  state.pitchRad = clamp(state.pitchRad + deltaPitchRad, -EXTERNAL_ORBIT_PITCH_CLAMP_RAD, EXTERNAL_ORBIT_PITCH_CLAMP_RAD);
  state.radiusM = clamp(state.radiusM + deltaZoomM, EXTERNAL_ORBIT_MIN_RADIUS_M, EXTERNAL_ORBIT_MAX_RADIUS_M);
}

export function computeExternalPose(playerPos: Readonly<Vec3Like>, state: ExternalOrbitState, out: CameraPose): CameraPose {
  const r = state.radiusM;
  const yaw = state.yawRad;
  const pitch = state.pitchRad;
  out.pos.x = playerPos.x + r * Math.cos(pitch) * Math.sin(yaw);
  out.pos.y = playerPos.y + r * Math.sin(pitch);
  out.pos.z = playerPos.z - r * Math.cos(pitch) * Math.cos(yaw);
  out.lookAt.x = playerPos.x;
  out.lookAt.y = playerPos.y;
  out.lookAt.z = playerPos.z;
  out.useLookAt = true;
  return out;
}

// -----------------------------------------------------------------------------
// Flyby (world-fixed).
// -----------------------------------------------------------------------------

export interface FlybyState {
  fixedPos: Vec3Like;
  initialized: boolean;
}

export function createFlybyState(): FlybyState {
  return { fixedPos: { x: 0, y: 0, z: 0 }, initialized: false };
}

const scratchFlybyVelNorm: Vec3Like = { x: 0, y: 0, z: 0 };

export function computeFlybyPose(
  playerPos: Readonly<Vec3Like>,
  playerRot: Readonly<QuatLike>,
  playerVelWorld: Readonly<Vec3Like>,
  state: FlybyState,
  out: CameraPose
): CameraPose {
  const speed = vec3Length(playerVelWorld);
  if (speed < 1) {
    rotateVecByQuat(playerRot, BODY_FORWARD, scratchFlybyVelNorm);
  } else {
    vec3Normalize(playerVelWorld, scratchFlybyVelNorm);
  }

  let needsReplace = !state.initialized;
  if (state.initialized) {
    const dx = playerPos.x - state.fixedPos.x;
    const dy = playerPos.y - state.fixedPos.y;
    const dz = playerPos.z - state.fixedPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const dot = dx * scratchFlybyVelNorm.x + dy * scratchFlybyVelNorm.y + dz * scratchFlybyVelNorm.z;
    if (dist > FLYBY_RESET_DISTANCE_M && dot < 0) needsReplace = true;
  }

  if (needsReplace) {
    state.fixedPos.x = playerPos.x + scratchFlybyVelNorm.x * FLYBY_PLACEMENT_DISTANCE_M;
    state.fixedPos.y = playerPos.y + scratchFlybyVelNorm.y * FLYBY_PLACEMENT_DISTANCE_M + FLYBY_HEIGHT_OFFSET_M;
    state.fixedPos.z = playerPos.z + scratchFlybyVelNorm.z * FLYBY_PLACEMENT_DISTANCE_M;
    state.initialized = true;
  }

  out.pos.x = state.fixedPos.x;
  out.pos.y = state.fixedPos.y;
  out.pos.z = state.fixedPos.z;
  out.lookAt.x = playerPos.x;
  out.lookAt.y = playerPos.y;
  out.lookAt.z = playerPos.z;
  out.useLookAt = true;
  return out;
}

// -----------------------------------------------------------------------------
// Dispatcher.
// -----------------------------------------------------------------------------

export interface CameraModeState {
  chase: ChaseCameraState;
  external: ExternalOrbitState;
  flyby: FlybyState;
}

export function createCameraModeState(): CameraModeState {
  return {
    chase: createChaseCameraState(),
    external: createExternalOrbitState(),
    flyby: createFlybyState(),
  };
}

/** One pure dispatch per `SceneRenderer.renderFrame` call. */
export function computeCameraPose(
  mode: CameraMode,
  playerPos: Readonly<Vec3Like>,
  playerRot: Readonly<QuatLike>,
  playerVelWorld: Readonly<Vec3Like>,
  state: CameraModeState,
  frameDtSec: number,
  out: CameraPose
): CameraPose {
  switch (mode) {
    case CameraMode.Cockpit:
      return computeCockpitPose(playerPos, playerRot, out);
    case CameraMode.Chase:
      return computeChasePose(playerPos, playerRot, state.chase, frameDtSec, out);
    case CameraMode.External:
      return computeExternalPose(playerPos, state.external, out);
    case CameraMode.Flyby:
      return computeFlybyPose(playerPos, playerRot, playerVelWorld, state.flyby, out);
    default:
      return computeCockpitPose(playerPos, playerRot, out);
  }
}
