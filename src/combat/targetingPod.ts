/**
 * src/combat/targetingPod.ts — the targeting pod (Litening class): a FLIR/TV sensor on a gimbal
 * under the intake with a laser designator/rangefinder.
 *
 * Model: the pod is ground-stabilised on a point. Slewing (pod view, arrow keys) sweeps the line of
 * sight across the picture at a rate scaled to the field of view and re-casts it onto the terrain.
 * The track key (I) point-tracks the nearest ground unit to the crosshair (the point then follows
 * it) or, pressed again, drops back to area track; either way the pod then designates: its point is
 * the SPI the weapons use. Zoom (U) steps wide / medium / narrow. The laser (K held, or automatic in
 * the last seconds of a laser-guided bomb's fall) lases the point when it is in view and in range.
 * The line of sight is masked above the wing plane (the pod hangs under the intake) and by terrain.
 * Allocation-free.
 */
import { NO_ENTITY_ID, type EntityState, type HeightSampler, type PilotInputs, type Vec3Like } from '../contracts/core';
import type { DetectableEntity, PodState, SensorPodProfile } from '../contracts/combat';
import { Quat } from '../math';
import { rayToGround, terrainLineOfSight } from './lineOfSight';

/** How far the pod looks for ground, m, and how close to the crosshair point track finds a unit, m. */
const POD_MAX_RANGE_M = 45000;
const POINT_TRACK_RADIUS_M = 40;
/** Slew rate: fields of view per second at full deflection. */
const SLEW_FOV_PER_SEC = 0.6;
/** The terrain line-of-sight check runs at this rate (it samples the whole line). */
const LOS_HZ = 10;
const D2R = Math.PI / 180;

export function createPodState(profile: SensorPodProfile): PodState {
  return {
    profile,
    point: { x: 0, y: 0, z: 0 },
    pointValid: false,
    trackId: NO_ENTITY_ID,
    designating: false,
    fovIndex: 0,
    laser: false,
    masked: false,
    rangeM: 0,
    prevZoom: false,
    prevTrack: false,
    losDueSec: 0,
    terrainMasked: false,
  };
}

const _dir = { x: 0, y: 0, z: 0 };
const _right = { x: 0, y: 0, z: 0 };
const _up = { x: 0, y: 0, z: 0 };
const _hit = { x: 0, y: 0, z: 0 };
const _body = { x: 0, y: 0, z: 0 };
const _look = { x: 0, y: 0, z: 0 };

function norm(v: Vec3Like): number {
  const l = Math.hypot(v.x, v.y, v.z);
  if (l > 1e-9) {
    v.x /= l;
    v.y /= l;
    v.z /= l;
  }
  return l;
}

/**
 * One tick of the pod on aircraft `shooter`. `autoLase` = one of this aircraft's laser-guided bombs
 * is in its terminal phase. Returns true when the pod designates (the caller sets the SPI to
 * `pod.point`).
 */
export function updatePod(pod: PodState, shooter: EntityState, inputs: PilotInputs, entities: readonly DetectableEntity[], sampler: HeightSampler, autoLase: boolean, dtSec: number): boolean {
  const p = shooter.pos;
  // First use: look 20 deg below the nose.
  if (!pod.pointValid) {
    Quat.rotate(shooter.rot, { x: Math.cos(20 * D2R), y: -Math.sin(20 * D2R), z: 0 }, _look);
    if (rayToGround(sampler, p, _look, POD_MAX_RANGE_M, _hit) < 0) {
      _hit.x = p.x;
      _hit.z = p.z;
      _hit.y = sampler.heightAt(p.x, p.z);
    }
    pod.point.x = _hit.x;
    pod.point.y = _hit.y;
    pod.point.z = _hit.z;
    pod.pointValid = true;
  }

  // Point track: follow the unit (a wreck stays trackable).
  if (pod.trackId !== NO_ENTITY_ID) {
    let found = false;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i]!;
      if (e.id !== pod.trackId) continue;
      if (e.alive) {
        pod.point.x = e.pos.x;
        pod.point.y = e.pos.y + 1;
        pod.point.z = e.pos.z;
        found = true;
      }
      break;
    }
    if (!found) pod.trackId = NO_ENTITY_ID;
  }

  // Line of sight and its picture axes (right = dir x up, up = right x dir).
  _dir.x = pod.point.x - p.x;
  _dir.y = pod.point.y - p.y;
  _dir.z = pod.point.z - p.z;
  pod.rangeM = norm(_dir);
  _right.x = -_dir.z;
  _right.y = 0;
  _right.z = _dir.x;
  if (norm(_right) < 1e-6) {
    _right.x = 1;
    _right.z = 0;
  }
  _up.x = _right.y * _dir.z - _right.z * _dir.y;
  _up.y = _right.z * _dir.x - _right.x * _dir.z;
  _up.z = _right.x * _dir.y - _right.y * _dir.x;

  // Slew: sweep the line of sight and re-cast it on the ground (breaks point track).
  const sx = inputs.podSlewX ?? 0;
  const sy = inputs.podSlewY ?? 0;
  if (Math.abs(sx) > 0.01 || Math.abs(sy) > 0.01) {
    pod.trackId = NO_ENTITY_ID;
    const fov = (pod.profile.fovsDeg[pod.fovIndex] ?? 10) * D2R;
    const k = fov * SLEW_FOV_PER_SEC * dtSec;
    _look.x = _dir.x + (_right.x * sx + _up.x * sy) * k;
    _look.y = _dir.y + (_right.y * sx + _up.y * sy) * k;
    _look.z = _dir.z + (_right.z * sx + _up.z * sy) * k;
    norm(_look);
    if (rayToGround(sampler, p, _look, POD_MAX_RANGE_M, _hit) >= 0) {
      pod.point.x = _hit.x;
      pod.point.y = _hit.y;
      pod.point.z = _hit.z;
    }
  }

  // Zoom (edge).
  const zoom = inputs.podZoom ?? false;
  if (zoom && !pod.prevZoom) pod.fovIndex = (pod.fovIndex + 1) % Math.max(1, pod.profile.fovsDeg.length);
  pod.prevZoom = zoom;

  // Track (edge): point track the nearest ground unit, or back to area track; designate either way.
  const track = inputs.podTrack ?? false;
  if (track && !pod.prevTrack) {
    if (pod.trackId !== NO_ENTITY_ID) {
      pod.trackId = NO_ENTITY_ID;
    } else {
      let best = POINT_TRACK_RADIUS_M;
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i]!;
        if (e.kind !== 'ground' || !e.alive) continue;
        const d = Math.hypot(e.pos.x - pod.point.x, e.pos.z - pod.point.z);
        if (d < best) {
          best = d;
          pod.trackId = e.id;
        }
      }
    }
    pod.designating = true;
  }
  pod.prevTrack = track;

  // Masking: the gimbal can't see above the wing plane; terrain (checked at LOS_HZ).
  Quat.rotateInverse(shooter.rot, _dir, _body);
  const gimbalMasked = _body.y > Math.sin(pod.profile.maxUpDeg * D2R);
  pod.losDueSec -= dtSec;
  if (pod.losDueSec <= 0) {
    pod.losDueSec = 1 / LOS_HZ;
    _look.x = pod.point.x;
    _look.y = pod.point.y + 2;
    _look.z = pod.point.z;
    pod.terrainMasked = !terrainLineOfSight(sampler, p, _look, 0, 30, 60);
  }
  pod.masked = gimbalMasked || pod.terrainMasked;

  pod.laser = ((inputs.laser ?? false) || autoLase) && !pod.masked && pod.rangeM <= pod.profile.laserRangeM;
  return pod.designating;
}
