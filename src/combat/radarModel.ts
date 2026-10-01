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
  isAirToGroundKind,
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
  type UpdateSensors,
  type RadarDetectionRangeM,
  type DetectableEntity,
  type WeaponsState,
  type RadarProfile,
  type TrackRecord,
  IFF_INTERROGATION_SEC,
  NCTR_TIME_SEC,
  ACM_FIELD_AZ_HALF_RAD,
  ACM_FIELD_EL_DOWN_RAD,
  ACM_FIELD_EL_UP_RAD,
} from '../contracts/combat';
import { Vec3, Quat, clamp, lerp } from '../math';
import { computeLeadSolution } from './leadComputingSight';
import { irDetectionRangeM } from './irMissileSeeker';
import { GENERIC_GUN_PROFILE, GENERIC_IR_MISSILE_PROFILE } from './weaponProfiles';
import { cycleSelectedStore } from './weaponStation';

export const radarDetectionRangeM: RadarDetectionRangeM = (rcsM2, radar) => {
  const raw = (radar?.referenceRangeM ?? RADAR_REFERENCE_RANGE_M) * Math.pow(rcsM2 / (radar?.referenceRcsM2 ?? RADAR_REFERENCE_RCS_M2), 0.25);
  return clamp(raw, 0, radar?.maxRangeM ?? RADAR_MAX_RANGE_M);
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

function findEntity(all: readonly DetectableEntity[], id: EntityId): DetectableEntity | undefined {
  for (let i = 0; i < all.length; i++) if (all[i]!.id === id) return all[i];
  return undefined;
}

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
export function computeGeometry(observer: DetectableEntity, target: DetectableEntity, sampler: HeightSampler, radar?: RadarProfile): Geometry {
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

  const scanAz = radar?.scanAzHalfAngleRad ?? RADAR_SCAN_AZ_HALF_ANGLE_RAD;
  const scanEl = radar?.scanElHalfAngleRad ?? RADAR_SCAN_EL_HALF_ANGLE_RAD;
  const track = radar?.trackHalfAngleRad ?? RADAR_TRACK_HALF_ANGLE_RAD;
  const inScanCone = Math.abs(azRad) <= scanAz && Math.abs(elRad) <= scanEl;
  const inTrackCone = Math.abs(azRad) <= track && Math.abs(elRad) <= track;

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
  const isNotched = lookingDown && Math.abs(targetRadialMps) < (radar?.notchClosureMps ?? RADAR_NOTCH_CLOSURE_MPS) && rangeM <= (radar?.notchMaxRangeM ?? RADAR_NOTCH_MAX_RANGE_M);

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
  track: TrackRecord;
  rangeM: number;
  azRad: number;
  elRad: number;
  closureMps: number;
  score: number;
}

// Fixed-size scratch pool of ScoredContact holders, reused across calls to
// avoid per-call array allocation for the sort/threat-scoring pass.
const MAX_SCAN_CANDIDATES = 256;
const _candidates: ScoredContact[] = new Array(MAX_SCAN_CANDIDATES);
const _used: boolean[] = new Array(MAX_SCAN_CANDIDATES).fill(false);
for (let i = 0; i < MAX_SCAN_CANDIDATES; i++) {
  _candidates[i] = { track: undefined as unknown as TrackRecord, rangeM: 0, azRad: 0, elRad: 0, closureMps: 0, score: 0 };
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
  // This aircraft's radar, IR seeker (the first IR station's missile) and gun muzzle velocity.
  const radar = state.radar;
  // The IR seeker: the selected missile's, else the first IR station's (loaded first).
  let irSeeker = GENERIC_IR_MISSILE_PROFILE.ir!;
  let gunMuzzleMps = GENERIC_GUN_PROFILE.launchSpeedMps;
  let irFound = false;
  for (let i = 0; i < state.stations.length; i++) {
    const st = state.stations[i]!;
    if (st.weapon === 'ir_missile' && st.profile.ir && st.profile.id === state.selectedStoreId) {
      irSeeker = st.profile.ir;
      irFound = true;
      break;
    }
  }
  for (let i = 0; i < state.stations.length && !irFound; i++) {
    const st = state.stations[i]!;
    if (st.weapon === 'ir_missile' && st.profile.ir) {
      irSeeker = st.profile.ir;
      if (st.count > 0) break;
    }
  }
  for (let i = 0; i < state.stations.length; i++) {
    const st = state.stations[i]!;
    if (st.weapon === 'gun') {
      gunMuzzleMps = st.profile.launchSpeedMps;
      break;
    }
  }

  // ---- 1. Detection -> track file (memory, IFF/NCTR identity) -> contacts (threat-sorted) ----
  const radarOn = observerDamage.radarHealthPct > 0;
  const tracks = state.tracks;
  for (let i = 0; i < allEntities.length; i++) {
    const e = allEntities[i]!;
    if (e.id === observerId || !e.alive || e.kind !== 'aircraft') continue;

    const geom = computeGeometry(observer, e, sampler, radar);
    if (geom.terrainMasked) continue;
    // A pulse-Doppler radar loses a target in the ground-clutter notch altogether.
    const radarDetected = radarOn && geom.inScanCone && !geom.isNotched && geom.rangeM <= radarDetectionRangeM(geom.rcsM2, radar);
    const angleFromNoseObs = Math.acos(clamp(Vec3.dot(_bearing, _forwardW), -1, 1));
    const visualDetected = geom.rangeM <= VISUAL_DETECT_RANGE_M && angleFromNoseObs <= VISUAL_FOV_HALF_ANGLE_RAD;
    if (!radarDetected && !visualDetected) continue;

    let t = tracks.get(e.id);
    if (!t) {
      t = {
        id: e.id, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, firstSeenSec: simTimeSec, lastSeenSec: simTimeSec,
        identity: 'unknown', iffSec: 0, nctrSec: 0, source: 'radar', memory: false, aspectFromNoseRad: 0, targetingMe: 0,
      };
      tracks.set(e.id, t);
    }
    t.pos.x = e.pos.x; t.pos.y = e.pos.y; t.pos.z = e.pos.z;
    t.vel.x = e.vel.x; t.vel.y = e.vel.y; t.vel.z = e.vel.z;
    t.lastSeenSec = simTimeSec;
    t.memory = false;
    t.source = radarDetected ? 'radar' : 'visual';
    t.aspectFromNoseRad = geom.aspectFromNoseRad;
    t.targetingMe = e.radarEmission?.lockedTargetId === observerId ? 1 : e.radarEmission?.trackedTargetId === observerId ? 0.5 : 0;
    // Identification: an IFF reply from a friendly transponder; a non-responder held in radar track
    // inside NCTR range is identified by its radar signature; anything close enough to see is known.
    if (t.identity === 'unknown') {
      const sameTeam = e.team === observer.team;
      if (radarDetected && radar.iffRangeM > 0 && geom.rangeM <= radar.iffRangeM) {
        if (sameTeam) {
          t.iffSec += dtSec;
          if (t.iffSec >= IFF_INTERROGATION_SEC) t.identity = 'friend';
        } else if (radar.nctrRangeM > 0 && geom.rangeM <= radar.nctrRangeM) {
          t.nctrSec += dtSec;
          if (t.nctrSec >= NCTR_TIME_SEC) t.identity = 'hostile';
        }
      }
      if (visualDetected && geom.rangeM <= VISUAL_IFF_CONFIRM_RANGE_M) t.identity = sameTeam ? 'friend' : 'hostile';
    }
  }

  // Tracks not detected this tick coast on memory (extrapolated), then drop.
  for (const t of tracks.values()) {
    if (t.lastSeenSec === simTimeSec) continue;
    if (simTimeSec - t.lastSeenSec > radar.trackMemorySec) {
      tracks.delete(t.id);
      if (state.lockedTargetId === t.id) state.lockedTargetId = undefined;
      continue;
    }
    t.memory = true;
    t.pos.x += t.vel.x * dtSec;
    t.pos.y += t.vel.y * dtSec;
    t.pos.z += t.vel.z * dtSec;
  }

  // Contacts from the track file, most threatening first.
  let candCount = 0;
  for (const t of tracks.values()) {
    if (candCount >= MAX_SCAN_CANDIDATES) break;
    const dx = t.pos.x - observer.pos.x;
    const dy = t.pos.y - observer.pos.y;
    const dz = t.pos.z - observer.pos.z;
    const rangeM = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const inv = rangeM > 1e-9 ? 1 / rangeM : 0;
    const bx = dx * inv, by = dy * inv, bz = dz * inv;
    const fwd = bx * _forwardW.x + by * _forwardW.y + bz * _forwardW.z;
    const right = bx * _rightW.x + by * _rightW.y + bz * _rightW.z;
    const up = bx * _upW.x + by * _upW.y + bz * _upW.z;
    const closureMps = -((t.vel.x - observer.vel.x) * bx + (t.vel.y - observer.vel.y) * by + (t.vel.z - observer.vel.z) * bz);
    const slot = _candidates[candCount]!;
    slot.track = t;
    slot.rangeM = rangeM;
    slot.azRad = Math.atan2(right, fwd);
    slot.elRad = Math.atan2(up, Math.sqrt(fwd * fwd + right * right));
    slot.closureMps = closureMps;
    slot.score = THREAT_SCORE_WEIGHTS.range * (1 - clamp(rangeM / radar.maxRangeM, 0, 1))
      + THREAT_SCORE_WEIGHTS.aspect * ((1 + Math.cos(t.aspectFromNoseRad)) / 2)
      + THREAT_SCORE_WEIGHTS.targetingMe * t.targetingMe
      + THREAT_SCORE_WEIGHTS.closure * clamp(closureMps / 500, 0, 1);
    candCount++;
  }

  // Selection sort descending by score, pushing directly into outContacts.
  for (let i = 0; i < candCount; i++) _used[i] = false;
  for (let k = 0; k < candCount; k++) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < candCount; i++) {
      if (_used[i]) continue;
      const sc = _candidates[i]!.score;
      if (sc > bestScore) { bestScore = sc; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    _used[bestIdx] = true;
    const c = _candidates[bestIdx]!;
    const t = c.track;
    const truth = findEntity(allEntities, t.id);
    outContacts.push({
      id: t.id,
      team: truth ? truth.team : observer.team,
      kind: 'aircraft',
      pos: { x: t.pos.x, y: t.pos.y, z: t.pos.z },
      vel: { x: t.vel.x, y: t.vel.y, z: t.vel.z },
      rangeM: c.rangeM,
      bearingRad: c.azRad,
      elevationRad: c.elRad,
      closureMps: c.closureMps,
      detectedBy: t.source,
      identified: t.identity !== 'unknown',
      identity: t.identity,
      memory: t.memory,
    });
  }

  // ---- 2/3. Edge-detect cycleTarget/cycleWeapon/radar mode against LAST tick's inputs ----
  const cycleTargetEdge = inputs.cycleTarget && !state.prevCycleTarget;
  const cycleWeaponEdge = inputs.cycleWeapon && !state.prevCycleWeapon;
  const radarModeEdge = (inputs.radarModeCycle ?? false) && !state.prevRadarModeCycle;
  state.prevCycleTarget = inputs.cycleTarget;
  state.prevCycleWeapon = inputs.cycleWeapon;
  state.prevRadarModeCycle = inputs.radarModeCycle ?? false;

  if (radarModeEdge) state.radarMode = state.radarMode === 'rws' ? 'acm' : 'rws';

  if (cycleWeaponEdge) {
    cycleSelectedStore(state);
    state.lockState = LockState.Searching;
    state.lockProgressSec = 0;
    state.lockBreakGraceRemainingSec = 0;
  }

  // Air-to-ground stores: T designates the ground point under the pipper (agSight.ts) instead.
  const airToGround = isAirToGroundKind(state.selectedWeapon);
  if (cycleTargetEdge && airToGround) {
    if (state.agValid) state.designateRequest = true;
    else {
      // Pipper off the ground: T clears the designation (and the pod stops designating).
      state.spiValid = false;
      if (state.pod) state.pod.designating = false;
    }
  }
  // Target designation: T steps through the non-friendly tracks nearest first (a stable order:
  // the next one further out than the current designation, wrapping round).
  if (cycleTargetEdge && !airToGround) {
    let curRange = -1;
    for (let i = 0; i < outContacts.length; i++) if (outContacts[i]!.id === state.lockedTargetId) curRange = outContacts[i]!.rangeM;
    let next: Contact | undefined;
    let nearest: Contact | undefined;
    for (let i = 0; i < outContacts.length; i++) {
      const c = outContacts[i]!;
      if (c.identity === 'friend' || c.id === state.lockedTargetId) continue;
      if (!nearest || c.rangeM < nearest.rangeM) nearest = c;
      if (c.rangeM > curRange && (!next || c.rangeM < next.rangeM)) next = c;
    }
    const pick = next ?? nearest;
    if (pick) {
      state.lockedTargetId = pick.id;
      state.lockState = LockState.Searching;
      state.lockProgressSec = 0;
      state.lockBreakGraceRemainingSec = 0;
    }
  }

  // Dogfight mode: with nothing designated, take the nearest non-friend in the HUD field.
  if (state.radarMode === 'acm' && (state.lockedTargetId === undefined || !tracks.has(state.lockedTargetId))) {
    let best: Contact | undefined;
    for (let i = 0; i < outContacts.length; i++) {
      const c = outContacts[i]!;
      if (c.identity === 'friend' || c.memory || c.rangeM > radar.acmRangeM) continue;
      if (Math.abs(c.bearingRad) > ACM_FIELD_AZ_HALF_RAD || c.elevationRad < -ACM_FIELD_EL_DOWN_RAD || c.elevationRad > ACM_FIELD_EL_UP_RAD) continue;
      if (!best || c.rangeM < best.rangeM) best = c;
    }
    if (best) {
      state.lockedTargetId = best.id;
      state.lockState = LockState.Searching;
      state.lockProgressSec = 0;
      state.lockBreakGraceRemainingSec = 0;
    }
  }

  // The designation's index in this tick's contacts (for the gunsight), or -1.
  state.selectedContactIndex = -1;
  for (let i = 0; i < outContacts.length; i++) if (outContacts[i]!.id === state.lockedTargetId) state.selectedContactIndex = i;

  // ---- 4. Lock state machine ----
  const prevLockState = state.lockState;

  let lockedEntity: DetectableEntity | undefined;
  if (state.lockedTargetId !== undefined) {
    for (let i = 0; i < allEntities.length; i++) {
      const e = allEntities[i]!;
      if (e.id === state.lockedTargetId && e.alive) { lockedEntity = e; break; }
    }
  }

  if ((state.selectedWeapon !== 'ir_missile' && state.selectedWeapon !== 'radar_missile') || lockedEntity === undefined) {
    state.lockState = LockState.None;
    state.lockProgressSec = 0;
    state.lockBreakGraceRemainingSec = 0;
  } else {
    const geom = computeGeometry(observer, lockedEntity, sampler, radar);
    let satisfied: boolean;
    let grace: number;
    if (state.selectedWeapon === 'radar_missile') {
      satisfied = geom.inTrackCone && !geom.isNotched && !geom.terrainMasked && geom.rangeM <= radarDetectionRangeM(geom.rcsM2, radar);
      grace = radar.lockBreakGraceSec;
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
      const threshold = state.lockState === LockState.Locked ? irSeeker.trackHalfAngleRad : irSeeker.acquireHalfAngleRad;
      satisfied = angleFromForward <= threshold && geom.rangeM <= irDetectionRangeM(geom.aspectFromNoseRad, false, irSeeker);
      grace = radar.lockBreakGraceSec;
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

    const lockTime = state.selectedWeapon === 'radar_missile' ? radar.lockTimeSec : irSeeker.lockTimeSec;
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
    if (e.id === observerId || !e.alive || e.team === observer.team || (e.kind !== 'aircraft' && e.kind !== 'ground')) continue;
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
    const result = computeLeadSolution(observer.pos, observer.vel, aimEntity.pos, aimEntity.vel, gunMuzzleMps, GRAVITY_MPS2, _aimPoint);
    state.aimPointWorld.x = _aimPoint.x;
    state.aimPointWorld.y = _aimPoint.y;
    state.aimPointWorld.z = _aimPoint.z;
    state.aimPointValid = result.valid;
  } else {
    state.aimPointValid = false;
  }

  void simTimeSec;
};
