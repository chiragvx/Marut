/**
 * src/render/cameraModes.ts
 *
 * Cockpit/chase/external/flyby camera pose computation. 08-render.md
 * section 4.2. Each mode is a pure function of (player pose, mode-owned
 * state); `computeCameraPose` is the dispatcher `SceneRenderer.renderFrame`
 * calls once per frame.
 *
 * Each view has its own job:
 * - HUD only (Cockpit): the pilot's eye, straight ahead; glance round (springs back), zoom the view.
 * - Chase: close behind, lagging a touch and leaning with the bank; free look eases back behind.
 * - Orbit (External): a showcase camera from the front quarter that turns with the heading; drag
 *   it anywhere round the jet and it stays there.
 * - Fly-by: a camera standing beside the flight path ahead, telephoto-tracking the jet past.
 * Zoom is proportional (CAMERA_ZOOM_STEP_FACTOR a step) and stays where you leave it.
 */

import type { QuatLike, Vec3Like } from '../contracts/core';
import {
  CAMERA_ZOOM_STEP_FACTOR,
  CHASE_BANK_FOLLOW,
  COCKPIT_GLANCE_RETURN_DELAY_SEC,
  COCKPIT_GLANCE_RETURN_TAU_SEC,
  COCKPIT_MAX_FOV_DEG,
  COCKPIT_MIN_FOV_DEG,
  COCKPIT_VERTICAL_FOV_DEG,
  EXTERNAL_ORBIT_DEFAULT_YAW_RAD,
  EXTERNAL_ORBIT_HEADING_TAU_SEC,
  FLYBY_FRAME_M,
  FLYBY_SIDE_OFFSET_M,
  FLYBY_MAX_LEAD_M,
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
  /** With useLookAt: the camera's up direction (world). */
  up: Vec3Like;
  /** Field of view this frame, deg; 0 = the mode's default. */
  fovDeg: number;
}

export function createCameraPose(): CameraPose {
  return {
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    lookAt: { x: 0, y: 0, z: 0 },
    useLookAt: false,
    up: { x: 0, y: 1, z: 0 },
    fovDeg: 0,
  };
}

/** Zoom steps to a scale factor (+ = out). */
export const zoomFactor = (steps: number): number => Math.pow(CAMERA_ZOOM_STEP_FACTOR, steps);

// -----------------------------------------------------------------------------
// Cockpit.
// -----------------------------------------------------------------------------

/** A camera looks down its -Z; this turns that onto body +X (the nose): -90 deg about body Y. */
const CAMERA_TO_BODY: Readonly<QuatLike> = { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };

export interface CockpitLookState {
  /** Glance, rad: yaw + = look left, pitch + = look up. Springs back when idle. */
  yawRad: number;
  pitchRad: number;
  fovDeg: number;
  idleSec: number;
}

export function createCockpitLookState(): CockpitLookState {
  return { yawRad: 0, pitchRad: 0, fovDeg: COCKPIT_VERTICAL_FOV_DEG, idleSec: Infinity };
}

/** HUD-only glance and zoom (yaw + = view turns left, pitch + = look up; zoom steps + = wider). */
export function cockpitGlance(state: CockpitLookState, deltaYawRad: number, deltaPitchRad: number, zoomSteps: number): void {
  if (deltaYawRad !== 0 || deltaPitchRad !== 0) {
    state.yawRad = clamp(state.yawRad + deltaYawRad, -2.4, 2.4);
    state.pitchRad = clamp(state.pitchRad + deltaPitchRad, -1.1, 1.3);
    state.idleSec = 0;
  }
  if (zoomSteps !== 0) state.fovDeg = clamp(state.fovDeg * zoomFactor(zoomSteps), COCKPIT_MIN_FOV_DEG, COCKPIT_MAX_FOV_DEG);
}

const scratchQ: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
function quatMulInto(a: Readonly<QuatLike>, b: Readonly<QuatLike>, out: QuatLike): QuatLike {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

export function computeCockpitPose(playerPos: Readonly<Vec3Like>, playerRot: Readonly<QuatLike>, out: CameraPose, look?: CockpitLookState, frameDtSec = 0): CameraPose {
  rotateVecByQuat(playerRot, COCKPIT_EYE_OFFSET_BODY_M, out.pos);
  out.pos.x += playerPos.x;
  out.pos.y += playerPos.y;
  out.pos.z += playerPos.z;
  // out.rot = playerRot * CAMERA_TO_BODY (playerRot alone looked out along body -Z: the left
  // wing), then the glance in camera space (yaw about its up, pitch about its right).
  quatMulInto(playerRot, CAMERA_TO_BODY, out.rot);
  out.fovDeg = 0;
  if (look) {
    look.idleSec += frameDtSec;
    if (look.idleSec > COCKPIT_GLANCE_RETURN_DELAY_SEC) {
      look.yawRad = expSmooth(look.yawRad, 0, COCKPIT_GLANCE_RETURN_TAU_SEC, frameDtSec);
      look.pitchRad = expSmooth(look.pitchRad, 0, COCKPIT_GLANCE_RETURN_TAU_SEC, frameDtSec);
      if (Math.abs(look.yawRad) < 1e-4) look.yawRad = 0;
      if (Math.abs(look.pitchRad) < 1e-4) look.pitchRad = 0;
    }
    if (look.yawRad !== 0) {
      scratchQ.x = 0;
      scratchQ.y = Math.sin(look.yawRad / 2);
      scratchQ.z = 0;
      scratchQ.w = Math.cos(look.yawRad / 2);
      quatMulInto(out.rot, scratchQ, out.rot);
    }
    if (look.pitchRad !== 0) {
      scratchQ.x = Math.sin(look.pitchRad / 2);
      scratchQ.y = 0;
      scratchQ.z = 0;
      scratchQ.w = Math.cos(look.pitchRad / 2);
      quatMulInto(out.rot, scratchQ, out.rot);
    }
    out.fovDeg = look.fovDeg;
  }
  out.useLookAt = false;
  return out;
}

// -----------------------------------------------------------------------------
// Chase.
// -----------------------------------------------------------------------------

export interface ChaseCameraState {
  /**
   * The camera's offset from the aircraft, smoothed. Smoothing the offset (not the world position)
   * keeps the lag independent of speed: world-position smoothing trailed ~speed x tau behind (28 m
   * at 190 m/s), which pulled the camera back through the aircraft when looking to the side or
   * front, and made the view jump with uneven frame times.
   */
  smoothedOffset: Vec3Like;
  /** The offset's length, smoothed on its own, so a swing round the aircraft follows the circle instead of cutting across it. */
  smoothedRangeM: number;
  initialized: boolean;
  /** Free look, added to the default view: yaw (rad, + = view swings to the aircraft's right), elevation (rad, + = from higher up), extra distance (m). */
  lookYawRad: number;
  lookPitchRad: number;
  lookZoomM: number;
  /** Seconds since the player last looked around. */
  lookIdleSec: number;
  /** Ease back behind after this many s without looking (Infinity = never). The zoom stays. */
  returnDelaySec: number;
  /** The camera's up, smoothed (leans with the bank by CHASE_BANK_FOLLOW). */
  up: Vec3Like;
}

export function createChaseCameraState(): ChaseCameraState {
  return { smoothedOffset: { x: 0, y: 0, z: 0 }, smoothedRangeM: 0, initialized: false, lookYawRad: 0, lookPitchRad: 0, lookZoomM: 0, lookIdleSec: Infinity, returnDelaySec: FREE_LOOK_RETURN_DELAY_SEC, up: { x: 0, y: 1, z: 0 } };
}

/** Default chase offset as a distance and an elevation angle (15 m back, 4 m up). */
const CHASE_RANGE_M = Math.hypot(CHASE_CAM_DISTANCE_M, CHASE_CAM_HEIGHT_M);
const CHASE_ELEVATION_RAD = Math.atan2(CHASE_CAM_HEIGHT_M, CHASE_CAM_DISTANCE_M);
/** Free look never goes past looking straight down or up at the aircraft. */
const CHASE_LOOK_ELEVATION_LIMIT_RAD = 1.45;

/**
 * Applies a free-look input (drag / arrows) and restarts the return-to-behind delay; zoom steps
 * (+ = out) scale the distance and stay (a zoom alone does not hold the view off-centre).
 */
export function chaseLook(state: ChaseCameraState, deltaYawRad: number, deltaPitchRad: number, zoomSteps: number): void {
  if (deltaYawRad !== 0 || deltaPitchRad !== 0) {
    state.lookYawRad = Math.atan2(Math.sin(state.lookYawRad + deltaYawRad), Math.cos(state.lookYawRad + deltaYawRad));
    state.lookPitchRad = clamp(state.lookPitchRad + deltaPitchRad, -CHASE_LOOK_ELEVATION_LIMIT_RAD - CHASE_ELEVATION_RAD, CHASE_LOOK_ELEVATION_LIMIT_RAD - CHASE_ELEVATION_RAD);
    state.lookIdleSec = 0;
  }
  if (zoomSteps !== 0) {
    const r = clamp((CHASE_RANGE_M + state.lookZoomM) * zoomFactor(zoomSteps), FREE_LOOK_MIN_DISTANCE_M, FREE_LOOK_MAX_DISTANCE_M);
    state.lookZoomM = r - CHASE_RANGE_M;
  }
}

const scratchChaseForward: Vec3Like = { x: 0, y: 0, z: 0 };

/**
 * Raises an offset from the aircraft to at least `minY` by turning it round the aircraft, keeping
 * its distance and bearing (so the view slides up along the ground instead of ending up under the
 * aircraft). Returns true if it moved.
 */
function liftOffsetOnSphere(o: Vec3Like, minY: number): boolean {
  if (!(o.y < minY)) return false;
  const r = Math.hypot(o.x, o.y, o.z);
  const y = Math.min(minY, r);
  const hOld = Math.hypot(o.x, o.z);
  const hNew = Math.sqrt(Math.max(0, r * r - y * y));
  if (hOld > 1e-6) {
    o.x *= hNew / hOld;
    o.z *= hNew / hOld;
  } else {
    o.z = -hNew;
  }
  o.y = y;
  return true;
}
const scratchOffset: Vec3Like = { x: 0, y: 0, z: 0 };

export function computeChasePose(
  playerPos: Readonly<Vec3Like>,
  playerRot: Readonly<QuatLike>,
  state: ChaseCameraState,
  frameDtSec: number,
  out: CameraPose,
  /** Lowest the camera may be relative to the aircraft, m (the ground below plus a margin). */
  minOffsetY = -Infinity,
  /** The aircraft's size against the Tejas's (a C-17 is ~4x): the default offset and the zoom scale with it. */
  scale = 1
): CameraPose {
  // After a while without looking around, ease the view back behind the aircraft.
  state.lookIdleSec += frameDtSec;
  if (state.lookIdleSec > state.returnDelaySec) {
    state.lookYawRad = expSmooth(state.lookYawRad, 0, FREE_LOOK_RETURN_TAU_SEC, frameDtSec);
    state.lookPitchRad = expSmooth(state.lookPitchRad, 0, FREE_LOOK_RETURN_TAU_SEC, frameDtSec);
    if (Math.abs(state.lookYawRad) < 1e-5) state.lookYawRad = 0;
    if (Math.abs(state.lookPitchRad) < 1e-5) state.lookPitchRad = 0;
  }

  rotateVecByQuat(playerRot, BODY_FORWARD, scratchChaseForward);
  // Default: behind along the nose, a little above. As a direction and elevation from the
  // aircraft, then turned by the free look.
  const fx = scratchChaseForward.x;
  const fy = scratchChaseForward.y;
  const fz = scratchChaseForward.z;
  const ox = -fx * CHASE_CAM_DISTANCE_M * scale;
  const oy = (-fy * CHASE_CAM_DISTANCE_M + CHASE_CAM_HEIGHT_M) * scale;
  const oz = -fz * CHASE_CAM_DISTANCE_M * scale;
  let dx: number;
  let dy: number;
  let dz: number;
  if (state.lookYawRad === 0 && state.lookPitchRad === 0 && state.lookZoomM === 0) {
    dx = ox;
    dy = oy;
    dz = oz;
  } else {
    const r0 = Math.hypot(ox, oy, oz);
    const azimuth = Math.atan2(ox, oz) + state.lookYawRad;
    const elevation = clamp(Math.asin(clamp(oy / r0, -1, 1)) + state.lookPitchRad, -CHASE_LOOK_ELEVATION_LIMIT_RAD, CHASE_LOOK_ELEVATION_LIMIT_RAD);
    const r = r0 + state.lookZoomM * scale;
    const h = r * Math.cos(elevation);
    dx = h * Math.sin(azimuth);
    dy = r * Math.sin(elevation);
    dz = h * Math.cos(azimuth);
  }
  // Never below the ground: swing up round the aircraft, and don't let free look wind further
  // down than the ground allows (dragging back up then answers at once).
  scratchOffset.x = dx;
  scratchOffset.y = dy;
  scratchOffset.z = dz;
  if (liftOffsetOnSphere(scratchOffset, minOffsetY)) {
    dx = scratchOffset.x;
    dy = scratchOffset.y;
    dz = scratchOffset.z;
    if (state.lookPitchRad !== 0 || state.lookYawRad !== 0 || state.lookZoomM !== 0) {
      const r0 = Math.hypot(ox, oy, oz);
      const base = Math.asin(clamp(oy / r0, -1, 1));
      const r = Math.hypot(dx, dy, dz);
      state.lookPitchRad = Math.max(state.lookPitchRad, Math.asin(clamp(dy / r, -1, 1)) - base);
    }
  }

  const o = state.smoothedOffset;
  const range = Math.hypot(dx, dy, dz);
  if (!state.initialized) {
    o.x = dx;
    o.y = dy;
    o.z = dz;
    state.smoothedRangeM = range;
    state.initialized = true;
  } else {
    o.x = expSmooth(o.x, dx, CHASE_CAM_SMOOTHING_TAU_SEC, frameDtSec);
    o.y = expSmooth(o.y, dy, CHASE_CAM_SMOOTHING_TAU_SEC, frameDtSec);
    o.z = expSmooth(o.z, dz, CHASE_CAM_SMOOTHING_TAU_SEC, frameDtSec);
    state.smoothedRangeM = expSmooth(state.smoothedRangeM, range, CHASE_CAM_SMOOTHING_TAU_SEC, frameDtSec);
    // Direction from the smoothed offset, distance from the smoothed range: stays on the sphere.
    const len = Math.hypot(o.x, o.y, o.z);
    if (len > 0.5) {
      const k = state.smoothedRangeM / len;
      o.x *= k;
      o.y *= k;
      o.z *= k;
    }
  }

  // The smoothing can lag below the floor for a moment: keep the drawn camera above it too.
  liftOffsetOnSphere(o, minOffsetY);
  out.pos.x = playerPos.x + o.x;
  out.pos.y = playerPos.y + o.y;
  out.pos.z = playerPos.z + o.z;
  out.lookAt.x = playerPos.x;
  out.lookAt.y = playerPos.y + scale;
  out.lookAt.z = playerPos.z;
  // Lean with the bank a little (the horizon tilts as the jet rolls), smoothed; upright when
  // inverted rather than flipping.
  rotateVecByQuat(playerRot, BODY_UP, scratchUp);
  const k = scratchUp.y > 0 ? CHASE_BANK_FOLLOW : 0;
  const u = state.up;
  u.x = expSmooth(u.x, scratchUp.x * k, 0.25, frameDtSec);
  u.y = expSmooth(u.y, 1 - k + scratchUp.y * k, 0.25, frameDtSec);
  u.z = expSmooth(u.z, scratchUp.z * k, 0.25, frameDtSec);
  const ul = Math.hypot(u.x, u.y, u.z) || 1;
  out.up.x = u.x / ul;
  out.up.y = u.y / ul;
  out.up.z = u.z / ul;
  out.fovDeg = 0;
  out.useLookAt = true;
  return out;
}

const BODY_UP: Readonly<Vec3Like> = { x: 0, y: 1, z: 0 };
const scratchUp: Vec3Like = { x: 0, y: 0, z: 0 };

/**
 * Lifts an outside camera to at least `clearanceM` above the ground or water under it. The chase
 * and orbit views already keep above the ground under the aircraft (minOffsetY); this catches
 * the rest: rising ground under the camera itself, and the fly-by camera. Returns true if lifted.
 */
export function keepAboveGround(pose: CameraPose, groundAt: (x: number, z: number) => number, clearanceM: number): boolean {
  const floor = groundAt(pose.pos.x, pose.pos.z) + clearanceM;
  if (!(pose.pos.y < floor)) return false;
  pose.pos.y = floor;
  return true;
}

// -----------------------------------------------------------------------------
// External (orbit).
// -----------------------------------------------------------------------------

export interface ExternalOrbitState {
  /** Round the jet from straight behind, rad (+ = round its left side). */
  yawRad: number;
  pitchRad: number;
  radiusM: number;
  /** The jet's heading, smoothed, rad (the orbit turns with it). NaN until the first frame. */
  headingRad: number;
}

export function createExternalOrbitState(): ExternalOrbitState {
  return {
    yawRad: EXTERNAL_ORBIT_DEFAULT_YAW_RAD,
    pitchRad: EXTERNAL_ORBIT_DEFAULT_PITCH_RAD,
    radiusM: EXTERNAL_ORBIT_DEFAULT_RADIUS_M,
    headingRad: NaN,
  };
}

/** Mutates `state` per `SceneRenderer.orbitCamera`'s contract (zoom in steps, + = out). */
export function orbitCamera(state: ExternalOrbitState, deltaYawRad: number, deltaPitchRad: number, zoomSteps: number): void {
  state.yawRad = Math.atan2(Math.sin(state.yawRad + deltaYawRad), Math.cos(state.yawRad + deltaYawRad));
  state.pitchRad = clamp(state.pitchRad + deltaPitchRad, -EXTERNAL_ORBIT_PITCH_CLAMP_RAD, EXTERNAL_ORBIT_PITCH_CLAMP_RAD);
  state.radiusM = clamp(state.radiusM * zoomFactor(zoomSteps), EXTERNAL_ORBIT_MIN_RADIUS_M, EXTERNAL_ORBIT_MAX_RADIUS_M);
}

const scratchExtFwd: Vec3Like = { x: 0, y: 0, z: 0 };

export function computeExternalPose(
  playerPos: Readonly<Vec3Like>,
  state: ExternalOrbitState,
  out: CameraPose,
  minOffsetY = -Infinity,
  playerRot?: Readonly<QuatLike>,
  frameDtSec = 0,
  /** The aircraft's size against the Tejas's: the orbit's radius scales with it. */
  scale = 1
): CameraPose {
  // The jet's heading (forward = (sin h, -cos h) in x, z), smoothed so a turn sweeps the camera
  // round; held while the nose points nearly straight up or down.
  if (playerRot) {
    rotateVecByQuat(playerRot, BODY_FORWARD, scratchExtFwd);
    if (Math.hypot(scratchExtFwd.x, scratchExtFwd.z) > 0.2) {
      const h = Math.atan2(scratchExtFwd.x, -scratchExtFwd.z);
      if (Number.isNaN(state.headingRad)) state.headingRad = h;
      else {
        const d = Math.atan2(Math.sin(h - state.headingRad), Math.cos(h - state.headingRad));
        state.headingRad += d * (1 - Math.exp(-frameDtSec / EXTERNAL_ORBIT_HEADING_TAU_SEC));
      }
    }
  }
  const heading = Number.isNaN(state.headingRad) ? 0 : state.headingRad;
  const r = state.radiusM * scale;
  // Straight behind is the heading + pi; yaw + swings round the left side.
  const az = heading + Math.PI + state.yawRad;
  // Never below the ground: the orbit stops at the lowest pitch the ground allows (and stays
  // there, so pitching back up answers at once).
  if (r * Math.sin(state.pitchRad) < minOffsetY) state.pitchRad = Math.asin(clamp(minOffsetY / r, -1, 1));
  const pitch = state.pitchRad;
  out.pos.x = playerPos.x + r * Math.cos(pitch) * Math.sin(az);
  out.pos.y = playerPos.y + r * Math.sin(pitch);
  out.pos.z = playerPos.z - r * Math.cos(pitch) * Math.cos(az);
  out.lookAt.x = playerPos.x;
  out.lookAt.y = playerPos.y;
  out.lookAt.z = playerPos.z;
  out.up.x = 0;
  out.up.y = 1;
  out.up.z = 0;
  out.fovDeg = 0;
  out.useLookAt = true;
  return out;
}

// -----------------------------------------------------------------------------
// Flyby (world-fixed).
// -----------------------------------------------------------------------------

export interface FlybyState {
  fixedPos: Vec3Like;
  initialized: boolean;
  /** Which side of the flight path the next camera stands (alternates). */
  side: 1 | -1;
  /** Telephoto framing: x the default (FLYBY_FRAME_M); wheel zoom. */
  zoom: number;
  /** Field of view, smoothed, deg (NaN = snap on the next frame). */
  fovDeg: number;
  /** How far ahead this camera was placed, m (its hold after the pass scales with the speed too). */
  leadM: number;
}

export function createFlybyState(): FlybyState {
  return { fixedPos: { x: 0, y: 0, z: 0 }, initialized: false, side: 1, zoom: 1, fovDeg: NaN, leadM: FLYBY_PLACEMENT_DISTANCE_M };
}

/** Fly-by zoom (steps, + = wider). */
export function flybyZoom(state: FlybyState, zoomSteps: number): void {
  state.zoom = clamp(state.zoom * zoomFactor(zoomSteps), 0.3, 6);
}

const scratchFlybyVelNorm: Vec3Like = { x: 0, y: 0, z: 0 };

export function computeFlybyPose(
  playerPos: Readonly<Vec3Like>,
  playerRot: Readonly<QuatLike>,
  playerVelWorld: Readonly<Vec3Like>,
  state: FlybyState,
  out: CameraPose,
  frameDtSec = 0,
  /** The aircraft's size against the Tejas's: the camera stands off and frames in proportion. */
  scale = 1
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
    // Gone past (and away from) the camera, held ~3 s after the pass however fast (a supersonic
    // pass is not cut short), or turned off somewhere else entirely.
    const dot = dx * scratchFlybyVelNorm.x + dy * scratchFlybyVelNorm.y + dz * scratchFlybyVelNorm.z;
    const holdM = Math.max(FLYBY_RESET_DISTANCE_M, speed * 3);
    if ((dist > holdM && dot > 0) || dist > Math.max(FLYBY_PLACEMENT_DISTANCE_M * 2.5, state.leadM * 1.6)) needsReplace = true;
  }

  if (needsReplace) {
    // Ahead along the flight path (about 4 s, up to FLYBY_MAX_LEAD_M), standing off to one side
    // of it (further at speed, so the pass does not whip across), a little above: the jet comes
    // at the camera, passes close by and goes away.
    const v = scratchFlybyVelNorm;
    let sx = -v.z;
    let sz = v.x;
    const sl = Math.hypot(sx, sz);
    if (sl > 1e-3) {
      sx /= sl;
      sz /= sl;
    } else {
      sx = 1;
      sz = 0;
    }
    const lead = clamp(speed * 4, FLYBY_PLACEMENT_DISTANCE_M * 0.3, Math.max(FLYBY_PLACEMENT_DISTANCE_M, Math.min(FLYBY_MAX_LEAD_M, speed * 4)));
    const side = FLYBY_SIDE_OFFSET_M * scale * clamp(speed / 250, 1, 2.5);
    state.leadM = lead;
    state.fixedPos.x = playerPos.x + v.x * lead + sx * side * state.side;
    state.fixedPos.y = playerPos.y + v.y * lead + FLYBY_HEIGHT_OFFSET_M * scale;
    state.fixedPos.z = playerPos.z + v.z * lead + sz * side * state.side;
    state.side = state.side === 1 ? -1 : 1;
    state.initialized = true;
    state.fovDeg = NaN;
  }

  out.pos.x = state.fixedPos.x;
  out.pos.y = state.fixedPos.y;
  out.pos.z = state.fixedPos.z;
  out.lookAt.x = playerPos.x;
  out.lookAt.y = playerPos.y;
  out.lookAt.z = playerPos.z;
  out.up.x = 0;
  out.up.y = 1;
  out.up.z = 0;
  // Telephoto: frame about FLYBY_FRAME_M x zoom round the jet, whatever its distance.
  const dist = Math.hypot(playerPos.x - state.fixedPos.x, playerPos.y - state.fixedPos.y, playerPos.z - state.fixedPos.z);
  const want = clamp((2 * Math.atan((FLYBY_FRAME_M * scale * state.zoom) / 2 / Math.max(dist, 1)) * 180) / Math.PI, 2.5, 75);
  state.fovDeg = Number.isNaN(state.fovDeg) ? want : expSmooth(state.fovDeg, want, 0.12, frameDtSec);
  out.fovDeg = state.fovDeg;
  out.useLookAt = true;
  return out;
}

// -----------------------------------------------------------------------------
// Dispatcher.
// -----------------------------------------------------------------------------

export interface CameraModeState {
  cockpit: CockpitLookState;
  chase: ChaseCameraState;
  external: ExternalOrbitState;
  flyby: FlybyState;
  /** The followed aircraft's length against the Tejas's (1; a C-17 ~4): the outside views keep their framing. */
  subjectScale: number;
}

export function createCameraModeState(): CameraModeState {
  return {
    cockpit: createCockpitLookState(),
    chase: createChaseCameraState(),
    external: createExternalOrbitState(),
    flyby: createFlybyState(),
    subjectScale: 1,
  };
}

/** SceneRenderer.orbitCamera for `mode` (see its contract). */
export function lookCamera(mode: CameraMode, state: CameraModeState, deltaYawRad: number, deltaPitchRad: number, zoomSteps: number): void {
  switch (mode) {
    case CameraMode.Cockpit:
      // A drag down (pitch +) looks down from the cockpit, where outside it raises the camera.
      cockpitGlance(state.cockpit, deltaYawRad, -deltaPitchRad, zoomSteps);
      return;
    case CameraMode.Chase:
      chaseLook(state.chase, deltaYawRad, deltaPitchRad, zoomSteps);
      return;
    case CameraMode.External:
      orbitCamera(state.external, deltaYawRad, deltaPitchRad, zoomSteps);
      return;
    case CameraMode.Flyby:
      flybyZoom(state.flyby, zoomSteps);
      return;
    default:
  }
}

/** One pure dispatch per `SceneRenderer.renderFrame` call. */
export function computeCameraPose(
  mode: CameraMode,
  playerPos: Readonly<Vec3Like>,
  playerRot: Readonly<QuatLike>,
  playerVelWorld: Readonly<Vec3Like>,
  state: CameraModeState,
  frameDtSec: number,
  out: CameraPose,
  /** Chase and orbit: lowest the camera may be relative to the aircraft, m (see keepAboveGround). */
  minOffsetY = -Infinity
): CameraPose {
  switch (mode) {
    case CameraMode.Cockpit:
      return computeCockpitPose(playerPos, playerRot, out, state.cockpit, frameDtSec);
    case CameraMode.Chase:
      return computeChasePose(playerPos, playerRot, state.chase, frameDtSec, out, minOffsetY, state.subjectScale);
    case CameraMode.External:
      return computeExternalPose(playerPos, state.external, out, minOffsetY, playerRot, frameDtSec, state.subjectScale);
    case CameraMode.Flyby:
      return computeFlybyPose(playerPos, playerRot, playerVelWorld, state.flyby, out, frameDtSec, state.subjectScale);
    default:
      return computeCockpitPose(playerPos, playerRot, out);
  }
}
