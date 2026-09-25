/**
 * src/combat/radarModel.ts — the per-tick, per-aircraft sensor/lock/RWR
 * update (`updateSensors`): contact building (radar r^4 range equation,
 * scan/track cones, ground-clutter notch, terrain-LOS masking, visual
 * detection, threat scoring), the lock-state machine, RWR (missile-inbound
 * + radar-lock warnings), and the gunsight aim-point publication.
 * See docs/spec/07-combat.md sections 4.1, 4.4-4.11.
 */
import {
  GRAVITY_MPS2,
  WarningBit,
  LockState,
  type Vec3Like,
  type Contact,
  type SimEvent,
  type HeightSampler,
  type PilotInputs,
  type DamageState,
  type EntityId,
} from '../contracts/core';
import {
  RADAR_REFERENCE_RANGE_M,
  RADAR_REFERENCE_RCS_M2,
  RADAR_MAX_RANGE_M,
  RADAR_SCAN_AZ_HALF_ANGLE_RAD,
  RADAR_SCAN_EL_HALF_ANGLE_RAD,
  RADAR_TRACK_HALF_ANGLE_RAD,
  RADAR_LOCK_TIME_SEC,
  RADAR_LOCK_BREAK_GRACE_SEC,
  RADAR_NOTCH_CLOSURE_MPS,
  RADAR_NOTCH_MAX_RANGE_M,
  TERRAIN_LOS_MASK_MARGIN_M,
  DEFAULT_AIRCRAFT_RCS_NOSE_ON_M2,
  DEFAULT_AIRCRAFT_RCS_BROADSIDE_M2,
  VISUAL_DETECT_RANGE_M,
  VISUAL_FOV_HALF_ANGLE_RAD,
  VISUAL_IFF_CONFIRM_RANGE_M,
  THREAT_SCORE_WEIGHTS,
  RWR_MISSILE_THREAT_TIME_SEC,
  RWR_MISSILE_THREAT_RADIUS_M,
  IR_LOCK_TIME_SEC,
  IR_SEEKER_ACQUIRE_HALF_ANGLE_RAD,
  IR_SEEKER_TRACK_HALF_ANGLE_RAD,
  GUN_MUZZLE_VELOCITY_MPS,
  type UpdateSensors,
  type RadarDetectionRangeM,
  type DetectableEntity,
  type WeaponsState,
} from '../contracts/combat';
import { Vec3, Quat, clamp, lerp } from '../math';
import { computeLeadSolution } from './leadComputingSight';
import { irDetectionRangeM } from './irMissileSeeker';

export const radarDetectionRangeM: RadarDetectionRangeM = (rcsM2) => {
  const raw = RADAR_REFERENCE_RANGE_M * Math.pow(rcsM2 / RADAR_REFERENCE_RCS_M2, 0.25);
  return clamp(raw, 0, RADAR_MAX_RANGE_M);
};

const WORLD_FORWARD_BODY: Vec3Like = { x: 1, y: 0, z: 0 };
const WORLD_UP_BODY: Vec3Like = { x: 0, y: 1, z: 0 };
const WORLD_RIGHT_BODY: Vec3Like = { x: 0, y: 0, z: 1 };
const LOS_SAMPLE_FRACTIONS: readonly number[] = [0.25, 0.5, 0.75];

// Scratch (allocation-free).
const _forwardW: Vec3Like = { x: 0, y: 0, z: 0 };
const _rightW: Vec3Like = { x: 0, y: 0, z: 0 };
const _upW: Vec3Like = { x: 0, y: 0, z: 0 };
const _bearing: Vec3Like = { x: 0, y: 0, z: 0 };
const _relVel: Vec3Like = { x: 0, y: 0, z: 0 };
const _targetForwardW: Vec3Like = { x: 0, y: 0, z: 0 };
const _toObserver: Vec3Like = { x: 0, y: 0, z: 0 };
const _scaledVel: Vec3Like = { x: 0, y: 0, z: 0 };
const _missVec: Vec3Like = { x: 0, y: 0, z: 0 };
const _aimPoint: Vec3Like = { x: 0, y: 0, z: 0 };

/** Exported (beyond contracts/combat.ts's fixed public surface) so unit tests can assert the section 4.4 az/el/cone worked example directly. */
export interface Geometry {
  rangeM: number;
  azRad: number;
  elRad: number;
  inScanCone: boolean;
  inTrackCone: boolean;
  isNotched: boolean;
  terrainMasked: boolean;
  aspectFromNoseRad: number;
  rcsM2: number;
  closureMps: number;
}

/**
 * Computes the full per-candidate sensor geometry (range/az/el/cones/notch/
 * terrain-LOS/aspect/RCS) between `observer` and `target`. Self-contained
 * (derives the observer's forward/right/up axes internally) so it is safe
 * to call standalone, e.g. from unit tests reproducing 07-combat.md's
 * section 4.4 worked example, as well as from `updateSensors` itself.
 */
export function computeGeometry(observer: DetectableEntity, target: DetectableEntity, sampler: HeightSampler): Geometry {
  Quat.rotate(observer.rot, WORLD_FORWARD_BODY, _forwardW);
  Quat.rotate(observer.rot, WORLD_RIGHT_BODY, _rightW);
  Quat.rotate(observer.rot, WORLD_UP_BODY, _upW);

  const dx = target.pos.x - observer.pos.x;
  const dy = target.pos.y - observer.pos.y;
  const dz = target.pos.z - observer.pos.z;
  const rangeM = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const invRange = rangeM > 1e-9 ? 1 / rangeM : 0;
  _bearing.x = dx * invRange; _bearing.y = dy * invRange; _bearing.z = dz * invRange;

  const fwdDot = Vec3.dot(_bearing, _forwardW);
  const rightDot = Vec3.dot(_bearing, _rightW);
  const upDot = Vec3.dot(_bearing, _upW);
  const azRad = Math.atan2(rightDot, fwdDot);
  const elRad = Math.atan2(upDot, Math.sqrt(fwdDot * fwdDot + rightDot * rightDot));

  const inScanCone = Math.abs(azRad) <= RADAR_SCAN_AZ_HALF_ANGLE_RAD && Math.abs(elRad) <= RADAR_SCAN_EL_HALF_ANGLE_RAD;
  const inTrackCone = Math.abs(azRad) <= RADAR_TRACK_HALF_ANGLE_RAD && Math.abs(elRad) <= RADAR_TRACK_HALF_ANGLE_RAD;

  _relVel.x = target.vel.x - observer.vel.x;
  _relVel.y = target.vel.y - observer.vel.y;
  _relVel.z = target.vel.z - observer.vel.z;
  const closureMps = -Vec3.dot(_relVel, _bearing);
  // Ground-clutter notch: a pulse-Doppler radar loses a target whose OWN ground-relative radial
  // velocity is near zero (it moves at the same Doppler as the ground clutter), and only when the
  // radar is looking down into that clutter. The earlier test on relative closure had it
  // backwards: a same-speed tail chase (closure ~0) was notched and could never be locked, while a
  // target beaming across the nose (closure = the observer's own speed) was not.
  const targetRadialMps = Vec3.dot(target.vel, _bearing);
  const lookingDown = _bearing.y < 0;
  const isNotched = lookingDown && Math.abs(targetRadialMps) < RADAR_NOTCH_CLOSURE_MPS && rangeM <= RADAR_NOTCH_MAX_RANGE_M;

  let terrainMasked = false;
  for (let i = 0; i < LOS_SAMPLE_FRACTIONS.length; i++) {
    const f = LOS_SAMPLE_FRACTIONS[i]!;
    const midX = observer.pos.x + dx * f;
    const midZ = observer.pos.z + dz * f;
    const terrainHeight = sampler.heightAt(midX, midZ);
    const losH = observer.pos.y + dy * f;
    if (terrainHeight + TERRAIN_LOS_MASK_MARGIN_M > losH) { terrainMasked = true; break; }
  }

  Quat.rotate(target.rot, WORLD_FORWARD_BODY, _targetForwardW);
  const aspectDot = clamp(Vec3.dot(_targetForwardW, _bearing), -1, 1);
  const aspectFromNoseRad = Math.acos(aspectDot);

  const sig = target.radarSignature;
  const noseRcs = sig ? sig.noseOnRcsM2 : DEFAULT_AIRCRAFT_RCS_NOSE_ON_M2;
  const broadsideRcs = sig ? sig.broadsideRcsM2 : DEFAULT_AIRCRAFT_RCS_BROADSIDE_M2;
  const rcsM2 = lerp(noseRcs, broadsideRcs, Math.sin(aspectFromNoseRad));

  return { rangeM, azRad, elRad, inScanCone, inTrackCone, isNotched, terrainMasked, aspectFromNoseRad, rcsM2, closureMps };
}

/**
 * Straight-line-extrapolated closest-approach RWR threat check (07-combat.md
 * section 4.11), exported (beyond contracts/combat.ts's fixed public
 * surface) so unit tests can assert the worked example's `tCaSec`/
 * `missDistanceM` directly. Allocation-free.
 */
export function computeMissileThreat(observerPos: Vec3Like, missilePos: Vec3Like, missileVel: Vec3Like): { tCaSec: number; missDistanceM: number; isThreat: boolean } {
  const velLenSq = missileVel.x * missileVel.x + missileVel.y * missileVel.y + missileVel.z * missileVel.z;
  if (velLenSq < 1e-9) return { tCaSec: NaN, missDistanceM: NaN, isThreat: false };
  _toObserver.x = observerPos.x - missilePos.x;
  _toObserver.y = observerPos.y - missilePos.y;
  _toObserver.z = observerPos.z - missilePos.z;
  const tCaSec = Vec3.dot(_toObserver, missileVel) / velLenSq;
  if (tCaSec < 0 || tCaSec > RWR_MISSILE_THREAT_TIME_SEC) return { tCaSec, missDistanceM: NaN, isThreat: false };
  Vec3.scale(missileVel, tCaSec, _scaledVel);
  Vec3.sub(_toObserver, _scaledVel, _missVec);
  const missDistanceM = Vec3.length(_missVec);
  return { tCaSec, missDistanceM, isThreat: missDistanceM <= RWR_MISSILE_THREAT_RADIUS_M };
}

interface ScoredContact {
  entity: DetectableEntity;
  geom: Geometry;
  detectedBy: 'radar' | 'visual';
  identified: boolean;
  score: number;
}

// Fixed-size scratch pool of ScoredContact holders, reused across calls to
// avoid per-call array allocation for the sort/threat-scoring pass.
const MAX_SCAN_CANDIDATES = 256;
const _candidates: ScoredContact[] = new Array(MAX_SCAN_CANDIDATES);
const _used: boolean[] = new Array(MAX_SCAN_CANDIDATES).fill(false);
for (let i = 0; i < MAX_SCAN_CANDIDATES; i++) {
  _candidates[i] = { entity: undefined as unknown as DetectableEntity, geom: undefined as unknown as Geometry, detectedBy: 'radar', identified: false, score: 0 };
}

export const updateSensors: UpdateSensors = (
  observerId,
  observer,
  observerDamage,
  _observerAltAglM,
  inputs,
  allEntities,
  sampler,
  state,
  simTimeSec,
  dtSec,
  outContacts,
  outEvents,
) => {
  Quat.rotate(observer.rot, WORLD_FORWARD_BODY, _forwardW);
  Quat.rotate(observer.rot, WORLD_RIGHT_BODY, _rightW);
  Quat.rotate(observer.rot, WORLD_UP_BODY, _upW);

  // ---- 1. Build contacts (radar + visual, terrain-LOS-masked, threat-sorted) ----
  let candCount = 0;
  for (let i = 0; i < allEntities.length && candCount < MAX_SCAN_CANDIDATES; i++) {
    const e = allEntities[i]!;
    if (e.id === observerId || !e.alive || e.kind !== 'aircraft') continue;

    const geom = computeGeometry(observer, e, sampler);
    if (geom.terrainMasked) continue;

    const radarDetected = geom.inScanCone && geom.rangeM <= radarDetectionRangeM(geom.rcsM2);
    const angleFromNoseObs = Math.acos(clamp(Vec3.dot(_bearing, _forwardW), -1, 1));
    const visualDetected = geom.rangeM <= VISUAL_DETECT_RANGE_M && angleFromNoseObs <= VISUAL_FOV_HALF_ANGLE_RAD;
    if (!radarDetected && !visualDetected) continue;

    let detectedBy: 'radar' | 'visual';
    let identified: boolean;
    if (radarDetected) {
      detectedBy = 'radar';
      identified = observerDamage.radarHealthPct > 0 && geom.inTrackCone && !geom.isNotched;
    } else {
      detectedBy = 'visual';
      identified = geom.rangeM <= VISUAL_IFF_CONFIRM_RANGE_M;
    }

    const targetingMeTerm = e.radarEmission?.lockedTargetId === observerId ? 1 : e.radarEmission?.trackedTargetId === observerId ? 0.5 : 0;
    const score = THREAT_SCORE_WEIGHTS.range * (1 - clamp(geom.rangeM / RADAR_MAX_RANGE_M, 0, 1))
      + THREAT_SCORE_WEIGHTS.aspect * ((1 + Math.cos(geom.aspectFromNoseRad)) / 2)
      + THREAT_SCORE_WEIGHTS.targetingMe * targetingMeTerm
      + THREAT_SCORE_WEIGHTS.closure * clamp(geom.closureMps / 500, 0, 1);

    const slot = _candidates[candCount]!;
    slot.entity = e;
    slot.geom = geom;
    slot.detectedBy = detectedBy;
    slot.identified = identified;
    slot.score = score;
    candCount++;
  }

  // Selection sort descending by score, pushing directly into outContacts.
  for (let i = 0; i < candCount; i++) _used[i] = false;
  for (let k = 0; k < candCount; k++) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < candCount; i++) {
      if (_used[i]) continue;
      const s = _candidates[i]!.score;
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    _used[bestIdx] = true;
    const c = _candidates[bestIdx]!;
    outContacts.push({
      id: c.entity.id,
      team: c.entity.team,
      kind: c.entity.kind,
      pos: { x: c.entity.pos.x, y: c.entity.pos.y, z: c.entity.pos.z },
      vel: { x: c.entity.vel.x, y: c.entity.vel.y, z: c.entity.vel.z },
      rangeM: c.geom.rangeM,
      bearingRad: c.geom.azRad,
      elevationRad: c.geom.elRad,
      closureMps: c.geom.closureMps,
      detectedBy: c.detectedBy,
      identified: c.identified,
    });
  }

  // ---- 2/3. Edge-detect cycleTarget/cycleWeapon against LAST tick's inputs ----
  const cycleTargetEdge = inputs.cycleTarget && !state.prevCycleTarget;
  const cycleWeaponEdge = inputs.cycleWeapon && !state.prevCycleWeapon;
  state.prevCycleTarget = inputs.cycleTarget;
  state.prevCycleWeapon = inputs.cycleWeapon;

  if (cycleWeaponEdge) {
    const kinds: (typeof state.selectedWeapon)[] = [];
    for (let i = 0; i < state.stations.length; i++) {
      const st = state.stations[i]!;
      if (st.count > 0 && !kinds.includes(st.weapon)) kinds.push(st.weapon);
    }
    if (kinds.length > 0) {
      const curIdx = kinds.indexOf(state.selectedWeapon);
      const nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % kinds.length;
      state.selectedWeapon = kinds[nextIdx]!;
    }
    state.lockState = LockState.Searching;
    state.lockProgressSec = 0;
    state.lockBreakGraceRemainingSec = 0;
  }

  if (cycleTargetEdge && outContacts.length > 0) {
    state.selectedContactIndex = (state.selectedContactIndex + 1) % outContacts.length;
    state.lockedTargetId = outContacts[state.selectedContactIndex]!.id;
    state.lockState = LockState.Searching;
    state.lockProgressSec = 0;
    state.lockBreakGraceRemainingSec = 0;
  }

  // ---- 4. Lock state machine ----
  const prevLockState = state.lockState;

  let lockedEntity: DetectableEntity | undefined;
  if (state.lockedTargetId !== undefined) {
    for (let i = 0; i < allEntities.length; i++) {
      const e = allEntities[i]!;
      if (e.id === state.lockedTargetId && e.alive) { lockedEntity = e; break; }
    }
  }

  if (state.selectedWeapon === 'gun' || lockedEntity === undefined) {
    state.lockState = LockState.None;
    state.lockProgressSec = 0;
    state.lockBreakGraceRemainingSec = 0;
  } else {
    const geom = computeGeometry(observer, lockedEntity, sampler);
    let satisfied: boolean;
    let grace: number;
    if (state.selectedWeapon === 'radar_missile') {
      satisfied = geom.inTrackCone && !geom.isNotched && !geom.terrainMasked && geom.rangeM <= radarDetectionRangeM(geom.rcsM2);
      grace = RADAR_LOCK_BREAK_GRACE_SEC;
    } else {
      // ir_missile — recompute bearing to the locked target explicitly (the
      // scratch `_bearing` above was last written by the candidate loop and
      // may not correspond to this specific target).
      const dx = lockedEntity.pos.x - observer.pos.x;
      const dy = lockedEntity.pos.y - observer.pos.y;
      const dz = lockedEntity.pos.z - observer.pos.z;
      const rng = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const bx = rng > 1e-9 ? dx / rng : 0, by = rng > 1e-9 ? dy / rng : 0, bz = rng > 1e-9 ? dz / rng : 1;
      const angleFromForward = Math.acos(clamp(bx * _forwardW.x + by * _forwardW.y + bz * _forwardW.z, -1, 1));
      const threshold = state.lockState === LockState.Locked ? IR_SEEKER_TRACK_HALF_ANGLE_RAD : IR_SEEKER_ACQUIRE_HALF_ANGLE_RAD;
      satisfied = angleFromForward <= threshold && geom.rangeM <= irDetectionRangeM(geom.aspectFromNoseRad, false);
      grace = RADAR_LOCK_BREAK_GRACE_SEC;
    }

    if (satisfied) {
      state.lockProgressSec += dtSec;
      state.lockBreakGraceRemainingSec = grace;
    } else {
      state.lockBreakGraceRemainingSec -= dtSec;
      if (state.lockBreakGraceRemainingSec <= 0) {
        state.lockState = LockState.Searching;
        state.lockProgressSec = 0;
      }
    }

    const lockTime = state.selectedWeapon === 'radar_missile' ? RADAR_LOCK_TIME_SEC : IR_LOCK_TIME_SEC;
    if (state.lockProgressSec >= lockTime) state.lockState = LockState.Locked;
    else if (state.lockProgressSec >= lockTime * 0.3) state.lockState = LockState.Tracking;
    else state.lockState = LockState.Searching;
  }

  if (prevLockState !== LockState.Locked && state.lockState === LockState.Locked) {
    outEvents.push({ type: 'lockAcquired', observerId, targetId: state.lockedTargetId as EntityId, weapon: state.selectedWeapon });
  }
  if (prevLockState === LockState.Locked && state.lockState !== LockState.Locked) {
    outEvents.push({ type: 'lockLost', observerId, targetId: state.lockedTargetId as EntityId });
  }

  // ---- 5. RWR: missile-inbound + radar-lock warnings ----
  let missileInboundWarning = false;
  for (let i = 0; i < allEntities.length; i++) {
    const e = allEntities[i]!;
    if (e.id === observerId || !e.alive || e.kind !== 'missile' || e.team === observer.team) continue;
    if (computeMissileThreat(observer.pos, e.pos, e.vel).isThreat) { missileInboundWarning = true; break; }
  }

  let rwrWarning = false;
  for (let i = 0; i < allEntities.length; i++) {
    const e = allEntities[i]!;
    if (e.id === observerId || !e.alive || e.team === observer.team || e.kind !== 'aircraft') continue;
    if (e.radarEmission && (e.radarEmission.trackedTargetId === observerId || e.radarEmission.lockedTargetId === observerId)) {
      rwrWarning = true;
      break;
    }
  }

  if (missileInboundWarning !== state.missileInboundWarning) {
    outEvents.push({ type: 'warning', entityId: observerId, bit: WarningBit.MissileLaunch, active: missileInboundWarning });
  }
  state.missileInboundWarning = missileInboundWarning;

  if (rwrWarning !== state.rwrWarning) {
    outEvents.push({ type: 'warning', entityId: observerId, bit: WarningBit.MissileLock, active: rwrWarning });
  }
  state.rwrWarning = rwrWarning;

  // ---- 6. Gunsight aim-point publication (regardless of selectedWeapon) ----
  let aimEntity: DetectableEntity | undefined = lockedEntity;
  if (!aimEntity && state.selectedContactIndex >= 0 && state.selectedContactIndex < outContacts.length) {
    const c = outContacts[state.selectedContactIndex]!;
    for (let i = 0; i < allEntities.length; i++) {
      const e = allEntities[i]!;
      if (e.id === c.id) { aimEntity = e; break; }
    }
  }

  if (aimEntity) {
    const result = computeLeadSolution(observer.pos, observer.vel, aimEntity.pos, aimEntity.vel, GUN_MUZZLE_VELOCITY_MPS, GRAVITY_MPS2, _aimPoint);
    state.aimPointWorld.x = _aimPoint.x;
    state.aimPointWorld.y = _aimPoint.y;
    state.aimPointWorld.z = _aimPoint.z;
    state.aimPointValid = result.valid;
  } else {
    state.aimPointValid = false;
  }

  void simTimeSec;
};
