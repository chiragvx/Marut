/**
 * src/combat/weaponStation.ts — weapon station/loadout runtime state,
 * CombatStatus aggregation, and the top-level `fireWeapons` (gun trigger +
 * missile launch dispatch). See docs/spec/07-combat.md sections 4.1, 4.6.
 */
import {
  AG_SIGHT_FIELD_RAD,
  AgCueCode,
  AgCueFlag,
  AgModeCode,
  DlzCode,
  PodFlag,
  EntityFlag,
  LockState,
  NO_ENTITY_ID,
  WeaponKind,
  isAirToGroundKind,
  type CombatStatus,
  type EntityId,
  type EntityState,
  type HeightSampler,
  type PilotInputs,
  type SimEvent,
  type Vec3Like,
} from '../contracts/core';
import {
  MAX_SPAWN_REQUESTS_PER_TICK,
  ProjectileKind,
  type CreateWeaponsState,
  type WriteCombatStatus,
  type CreateCombatRngState,
  type FireWeapons,
  type WeaponsState,
  type WeaponStationRuntime,
  type WeaponsLoadout,
  type ProjectileSpawnRequest,
  type CombatEnvironment,
} from '../contracts/combat';
import { ccrpSolution, predictImpact, type RigidRelease } from './agSight';
import { releasePointBodyInto, releaseRatesInto } from './storeFlight';
import { createPodState } from './targetingPod';
import { designatedMapIndex, nearestGroundContact } from './groundMap';
import { rayToGround } from './lineOfSight';
import { Vec3, Quat, nextRange, type PrngState } from '../math';
import { GENERIC_RADAR_PROFILE, defaultWeaponProfile } from './weaponProfiles';
import { DECOYS_PER_PROGRAM, DECOY_PROGRAM_INTERVAL_SEC } from './countermeasures';

/**
 * Current mass (kg) and drag area (m^2) of everything still loaded on `state`'s stations. src/core
 * writes these onto the aircraft's EntityState (storesMassKg/storesDragAreaM2) each tick, so both
 * drop as rounds are fired and missiles launched. Allocation-free.
 */
export function computeStoresLoad(state: Pick<WeaponsState, 'stations'>, out: { massKg: number; dragAreaM2: number }): void {
  let massKg = 0;
  let dragAreaM2 = 0;
  for (let i = 0; i < state.stations.length; i++) {
    const st = state.stations[i]!;
    massKg += st.count * st.profile.carriageMassKg;
    const rps = st.profile.roundsPerStore;
    if (rps) {
      // Pods: the empty pod's mass and drag stay whatever is left in it.
      const pods = Math.ceil(st.maxCount / rps);
      massKg += pods * (st.profile.storeShellKg ?? 0);
      dragAreaM2 += pods * st.profile.carriageDragAreaM2;
    } else {
      dragAreaM2 += st.count * st.profile.carriageDragAreaM2;
    }
  }
  const pod = (state as Partial<WeaponsState>).pod;
  if (pod) {
    massKg += pod.profile.massKg;
    dragAreaM2 += pod.profile.dragAreaM2;
  }
  out.massKg = massKg;
  out.dragAreaM2 = dragAreaM2;
}

export const createCombatRngState: CreateCombatRngState = (subSeed) => ({ seedState: subSeed >>> 0 });

export const createWeaponsState: CreateWeaponsState = (loadout: WeaponsLoadout, rngSubSeed: number): WeaponsState => {
  const stations: WeaponStationRuntime[] = loadout.stations.map((spec) => ({
    hardpointId: spec.hardpointId,
    posBodyM: { x: spec.posBodyM.x, y: spec.posBodyM.y, z: spec.posBodyM.z },
    weapon: spec.weapon,
    count: spec.maxCount,
    maxCount: spec.maxCount,
    profile: spec.profile ?? defaultWeaponProfile(spec.weapon),
  }));

  return {
    stations,
    radar: loadout.radar ?? GENERIC_RADAR_PROFILE,
    radarMode: 'rws',
    prevRadarModeCycle: false,
    tracks: new Map(),
    selectedStoreId: stations.length > 0 ? stations[0]!.profile.id : '',
    selectedWeapon: stations.length > 0 ? stations[0]!.weapon : WeaponKind.Gun,
    gunCooldownSec: 0,
    prevLaunch: false,
    prevCycleWeapon: false,
    prevCycleTarget: false,
    selectedContactIndex: -1,
    lockState: LockState.None,
    lockedTargetId: undefined,
    lockProgressSec: 0,
    lockBreakGraceRemainingSec: 0,
    rwrWarning: false,
    missileInboundWarning: false,
    chaff: loadout.countermeasures?.chaff ?? 0,
    flares: loadout.countermeasures?.flares ?? 0,
    chaffMax: loadout.countermeasures?.chaff ?? 0,
    flaresMax: loadout.countermeasures?.flares ?? 0,
    prevFlare: false,
    prevChaff: false,
    flareRepeatSec: 0,
    chaffRepeatSec: 0,
    agValid: false,
    agImpact: { x: 0, y: 0, z: 0 },
    agTofSec: 0,
    spiValid: false,
    spi: { x: 0, y: 0, z: 0 },
    ccrpTimeToReleaseSec: Infinity,
    ccrpCrossTrackM: 0,
    designateRequest: false,
    agSightDueSec: 0,
    releasedThisPress: false,
    rocketCooldownSec: 0,
    nextRocketStation: 0,
    dlz: DlzCode.None,
    agPipperLimited: false,
    agClampValid: false,
    agClampPoint: { x: 0, y: 0, z: 0 },
    agCue: AgCueCode.None,
    agCueFlags: 0,
    agAwaySec: 0,
    ccrpReleased: false,
    ...(loadout.pod ? { pod: createPodState(loadout.pod) } : {}),
    aimPointWorld: { x: 0, y: 0, z: 0 },
    aimPointValid: false,
    rng: createCombatRngState(rngSubSeed),
  };
};

export const writeCombatStatus: WriteCombatStatus = (state, out: CombatStatus) => {
  let ammoGun = 0, missilesIr = 0, missilesRadar = 0, irRangeM = 0, radarRangeM = 0, selectedCount = 0;
  for (let i = 0; i < state.stations.length; i++) {
    const st = state.stations[i]!;
    if (st.profile.id === state.selectedStoreId) selectedCount += st.count;
    const reach = st.count > 0 ? (st.profile.envelope?.rMaxHeadOnM ?? 0) : 0;
    if (st.weapon === WeaponKind.Gun) ammoGun += st.count;
    else if (st.weapon === WeaponKind.IrMissile) { missilesIr += st.count; irRangeM = Math.max(irRangeM, reach); }
    else if (st.weapon === WeaponKind.RadarMissile) { missilesRadar += st.count; radarRangeM = Math.max(radarRangeM, reach); }
  }
  out.irMissileRangeM = irRangeM;
  out.radarMissileRangeM = radarRangeM;
  out.selectedWeapon = state.selectedWeapon;
  out.selectedStoreId = state.selectedStoreId;
  out.selectedStoreCount = selectedCount;
  out.radarMode = state.radarMode;
  out.radarMaxRangeM = state.radar.maxRangeM;
  out.radarScanAzRad = state.radar.scanAzHalfAngleRad;
  out.ammoGun = ammoGun;
  out.missilesIr = missilesIr;
  out.missilesRadar = missilesRadar;
  out.lockState = state.lockState;
  out.lockedTargetId = state.lockedTargetId;
  out.rwrWarning = state.rwrWarning;
  out.missileInboundWarning = state.missileInboundWarning;
  out.chaff = state.chaff;
  out.flares = state.flares;
  // Air-to-ground sight: CCRP with a designated point, else CCIP while there is an impact solution.
  const sighting = isAirToGroundKind(state.selectedWeapon) || gunGroundSight(state);
  out.agMode = !sighting ? AgModeCode.None : state.spiValid && state.selectedWeapon !== WeaponKind.Gun ? AgModeCode.Ccrp : state.agValid ? AgModeCode.Ccip : AgModeCode.None;
  if (!out.agImpactWorld) out.agImpactWorld = { x: 0, y: 0, z: 0 };
  if (!out.spiWorld) out.spiWorld = { x: 0, y: 0, z: 0 };
  out.agImpactWorld.x = state.agImpact.x;
  out.agImpactWorld.y = state.agImpact.y;
  out.agImpactWorld.z = state.agImpact.z;
  out.spiValid = state.spiValid;
  out.spiWorld.x = state.spi.x;
  out.spiWorld.y = state.spi.y;
  out.spiWorld.z = state.spi.z;
  const t = out.agMode === AgModeCode.Ccrp ? state.ccrpTimeToReleaseSec : state.agTofSec;
  out.agTimeSec = Number.isFinite(t) ? t : 0;
  out.agCrossTrackM = out.agMode === AgModeCode.Ccrp ? state.ccrpCrossTrackM : 0;
  const pod = state.pod;
  out.podFlags = !pod ? 0 : PodFlag.Carried | (pod.pointValid ? PodFlag.PointValid : 0) | (pod.trackId !== NO_ENTITY_ID ? PodFlag.PointTrack : 0) | (pod.designating ? PodFlag.Designating : 0) | (pod.laser ? PodFlag.Laser : 0) | (pod.masked ? PodFlag.Masked : 0);
  if (!out.podPoint) out.podPoint = { x: 0, y: 0, z: 0 };
  if (pod) {
    out.podPoint.x = pod.point.x;
    out.podPoint.y = pod.point.y;
    out.podPoint.z = pod.point.z;
    out.podFovDeg = pod.profile.fovsDeg[pod.fovIndex] ?? 0;
    out.podRangeM = pod.rangeM;
  }
  out.dlz = state.dlz;
  out.agCue = state.agCue;
  out.agCueFlags = state.agCueFlags;
  out.aimPointWorld.x = state.aimPointWorld.x;
  out.aimPointWorld.y = state.aimPointWorld.y;
  out.aimPointWorld.z = state.aimPointWorld.z;
  out.aimPointValid = state.aimPointValid;
};

function findStationWithAmmo(stations: readonly WeaponStationRuntime[], weapon: WeaponKind): WeaponStationRuntime | undefined {
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i]!;
    if (st.weapon === weapon && st.count > 0) return st;
  }
  return undefined;
}

/** The next loaded station carrying store `storeId`, or undefined. */
export function findStationWithStore(stations: readonly WeaponStationRuntime[], storeId: string): WeaponStationRuntime | undefined {
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i]!;
    if (st.profile.id === storeId && st.count > 0) return st;
  }
  return undefined;
}

/**
 * Steps the selection to the next store type (in station order) that has anything left, wrapping
 * round; the gun is one of them. Resets lock progress, since the stores' sensors differ. Returns
 * false (selection unchanged) when nothing is loaded.
 */
export function cycleSelectedStore(state: WeaponsState): boolean {
  const n = state.stations.length;
  let cur = -1;
  for (let i = 0; i < n; i++) if (state.stations[i]!.profile.id === state.selectedStoreId) { cur = i; break; }
  for (let step = 1; step <= n; step++) {
    const st = state.stations[(Math.max(cur, 0) + (cur < 0 ? step - 1 : step)) % n]!;
    if (st.count <= 0 || st.profile.id === state.selectedStoreId) continue;
    // First station of this store type after the current one: select it.
    state.selectedStoreId = st.profile.id;
    state.selectedWeapon = st.weapon;
    return true;
  }
  return false;
}

/** After a store type runs out, move to another loaded store of the same kind (e.g. Derby after the Astras), if any. */
function reselectIfEmpty(state: WeaponsState): void {
  if (findStationWithStore(state.stations, state.selectedStoreId)) return;
  const next = findStationWithAmmo(state.stations, state.selectedWeapon);
  if (next) state.selectedStoreId = next.profile.id;
}

// Scratch (allocation-free).
const _muzzleOffsetW: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
const _dirBody: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
const _dirWorld: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
const _releaseBody: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
const _tubeAxis: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
const _tubeQ = { x: 0, y: 0, z: 0, w: 1 };
const _forwardW: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };

export const fireWeapons: FireWeapons = (
  shooterId,
  shooterState,
  _shooterDamage,
  lockedTarget,
  inputs,
  state,
  _simTimeSec,
  dtSec,
  outRequests,
  outEvents,
) => {
  // Always decrement (never guard on > 0): this lets a negative "overshoot"
  // remainder carry into the next reload via `+=` below, so the achieved
  // fire rate matches GUN_ROUND_INTERVAL_SEC on average regardless of how
  // GUN_ROUND_INTERVAL_SEC divides into dtSec (avoids a systematic
  // round-up-to-the-next-tick bias that resetting to the full interval
  // every time would otherwise introduce).
  state.gunCooldownSec -= dtSec;

  // --- Gun: level-triggered, independent of selectedWeapon ---
  if (inputs.trigger && state.gunCooldownSec <= 0 && outRequests.length < MAX_SPAWN_REQUESTS_PER_TICK) {
    const gunStation = findStationWithAmmo(state.stations, WeaponKind.Gun);
    if (gunStation) {
      Quat.rotate(shooterState.rot, gunStation.posBodyM, _muzzleOffsetW);

      const gun = gunStation.profile;
      const dispersionRad = (gun.dispersionMrad / 1000) * 2; // convert 1-sigma mrad -> a symmetric jitter bound in rad
      const jitterY = rngRange(state.rng, -dispersionRad, dispersionRad);
      const jitterZ = rngRange(state.rng, -dispersionRad, dispersionRad);
      _dirBody.x = 1; _dirBody.y = jitterY; _dirBody.z = jitterZ;
      Vec3.normalize(_dirBody, _dirBody);
      Quat.rotate(shooterState.rot, _dirBody, _dirWorld);

      gunStation.count -= 1;
      state.gunCooldownSec += gun.roundIntervalSec;

      const posWorld = { x: shooterState.pos.x + _muzzleOffsetW.x, y: shooterState.pos.y + _muzzleOffsetW.y, z: shooterState.pos.z + _muzzleOffsetW.z };
      const velWorld = {
        x: shooterState.vel.x + _dirWorld.x * gun.launchSpeedMps,
        y: shooterState.vel.y + _dirWorld.y * gun.launchSpeedMps,
        z: shooterState.vel.z + _dirWorld.z * gun.launchSpeedMps,
      };

      outRequests.push({
        kind: ProjectileKind.Bullet,
        ownerId: shooterId,
        team: shooterState.team,
        posWorld,
        rotWorld: { x: shooterState.rot.x, y: shooterState.rot.y, z: shooterState.rot.z, w: shooterState.rot.w },
        velWorld,
        profile: gun,
      });
      outEvents.push({ type: 'gunFire', shooterId, pos: posWorld, dir: { x: _dirWorld.x, y: _dirWorld.y, z: _dirWorld.z } });
    }
  }

  // Weight on wheels: nothing but the gun leaves the aircraft on the ground (release interlock).
  const onGround = (shooterState.flags & EntityFlag.OnGround) !== 0;

  // --- Air-to-ground stores: bombs and rockets, no lock needed ---
  updateAgCue(state, inputs.launch, dtSec);
  state.rocketCooldownSec -= dtSec;
  if (!inputs.launch) state.releasedThisPress = false;
  if (!onGround && isAirToGroundKind(state.selectedWeapon)) {
    releaseAirToGround(shooterId, shooterState, inputs, state, outRequests, outEvents);
    state.prevLaunch = inputs.launch;
    return;
  }

  // --- Missiles: edge-triggered on `launch`, lock-gated ---
  const launchEdge = inputs.launch && !state.prevLaunch;
  if (!onGround && launchEdge && outRequests.length < MAX_SPAWN_REQUESTS_PER_TICK && lockedTarget && state.lockState === LockState.Locked) {
    let station: WeaponStationRuntime | undefined;
    let ejectionSpeed = 0;
    let projectileKind: (typeof ProjectileKind)[keyof typeof ProjectileKind] | undefined;

    const selected = findStationWithStore(state.stations, state.selectedStoreId) ?? findStationWithAmmo(state.stations, state.selectedWeapon);
    if (state.selectedWeapon === WeaponKind.RadarMissile) {
      station = selected;
      ejectionSpeed = station ? station.profile.launchSpeedMps : 0;
      projectileKind = ProjectileKind.RadarMissile;
    } else if (state.selectedWeapon === WeaponKind.IrMissile) {
      const dx = lockedTarget.pos.x - shooterState.pos.x;
      const dy = lockedTarget.pos.y - shooterState.pos.y;
      const dz = lockedTarget.pos.z - shooterState.pos.z;
      const rangeM = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const irStation = selected;
      if (irStation && rangeM >= irStation.profile.minLaunchRangeM) {
        station = irStation;
        ejectionSpeed = irStation.profile.launchSpeedMps;
        projectileKind = ProjectileKind.IrMissile;
      }
    }

    if (station && projectileKind) {
      Quat.rotate(shooterState.rot, station.posBodyM, _muzzleOffsetW);
      Quat.rotate(shooterState.rot, { x: 1, y: 0, z: 0 }, _forwardW);
      station.count -= 1;

      const posWorld = { x: shooterState.pos.x + _muzzleOffsetW.x, y: shooterState.pos.y + _muzzleOffsetW.y, z: shooterState.pos.z + _muzzleOffsetW.z };
      const velWorld = {
        x: shooterState.vel.x + _forwardW.x * ejectionSpeed,
        y: shooterState.vel.y + _forwardW.y * ejectionSpeed,
        z: shooterState.vel.z + _forwardW.z * ejectionSpeed,
      };

      outRequests.push({
        kind: projectileKind,
        ownerId: shooterId,
        team: shooterState.team,
        posWorld,
        rotWorld: { x: shooterState.rot.x, y: shooterState.rot.y, z: shooterState.rot.z, w: shooterState.rot.w },
        velWorld,
        targetId: state.lockedTargetId as EntityId,
        profile: station.profile,
      });
      // missileId is not yet known here: src/core allocates the EntityId for
      // this spawn request AFTER fireWeapons returns (see 07-combat.md
      // section 3.1, steps 4-5). It is expected to patch this event's
      // `missileId` field in place once that id exists, before the event is
      // broadcast onward.
      outEvents.push({ type: 'missileLaunch', shooterId, missileId: NO_ENTITY_ID, weapon: state.selectedWeapon });
      reselectIfEmpty(state);
    }
  }

  state.prevLaunch = inputs.launch;
};

/**
 * Bombs and rockets. Bombs: CCIP (no designated point): one bomb per press of the release button;
 * CCRP (a designated point): hold the button and the bomb goes when the solution reaches the release
 * point (with the cross-track error inside CCRP_RELEASE_CROSS_M). Rockets: a ripple while held,
 * alternating stations. Allocation-light (one request object per store released).
 */
function releaseAirToGround(shooterId: EntityId, shooter: EntityState, inputs: PilotInputs, state: WeaponsState, outRequests: ProjectileSpawnRequest[], outEvents: SimEvent[]): void {
  if (!inputs.launch || outRequests.length >= MAX_SPAWN_REQUESTS_PER_TICK) return;
  const kind = state.selectedWeapon;
  if (kind === WeaponKind.Rocket) {
    if (state.rocketCooldownSec > 0) return;
    // Next loaded station with the selected pod, round robin.
    const n = state.stations.length;
    let st: WeaponStationRuntime | undefined;
    for (let k = 0; k < n; k++) {
      const c = state.stations[(state.nextRocketStation + k) % n]!;
      if (c.profile.id === state.selectedStoreId && c.count > 0) {
        st = c;
        state.nextRocketStation = (state.nextRocketStation + k + 1) % n;
        break;
      }
    }
    if (!st) return;
    const p = st.profile;
    st.count -= 1;
    state.rocketCooldownSec = Math.max(0, state.rocketCooldownSec) + p.roundIntervalSec;
    Quat.rotate(shooter.rot, st.posBodyM, _muzzleOffsetW);
    const disp = (p.dispersionMrad / 1000) * 2;
    _dirBody.x = 1;
    _dirBody.y = rngRange(state.rng, -disp, disp);
    _dirBody.z = rngRange(state.rng, -disp, disp);
    Vec3.normalize(_dirBody, _dirBody);
    Quat.rotate(shooter.rot, _dirBody, _dirWorld);
    pushStore(shooterId, shooter, st, _dirWorld.x * p.launchSpeedMps, _dirWorld.y * p.launchSpeedMps, _dirWorld.z * p.launchSpeedMps, ProjectileKind.Rocket, outRequests, outEvents, kind);
    // The rocket points along its (dispersed) tube: the aircraft's attitude turned from +X onto it.
    const sinT = Math.hypot(_dirBody.y, _dirBody.z);
    if (sinT > 1e-9) {
      _tubeAxis.x = 0;
      _tubeAxis.y = -_dirBody.z / sinT;
      _tubeAxis.z = _dirBody.y / sinT;
      Quat.axisAngle(_tubeAxis, Math.atan2(sinT, _dirBody.x), _tubeQ);
      Quat.multiply(shooter.rot, _tubeQ, outRequests[outRequests.length - 1]!.rotWorld);
    }
    reselectIfEmpty(state);
    return;
  }
  if (kind === WeaponKind.Arm) {
    // Anti-radiation missile: at the locked emitter, or pre-briefed at the designated point.
    if (state.releasedThisPress) return;
    const st = findStationWithStore(state.stations, state.selectedStoreId);
    const locked = state.lockState === LockState.Locked && state.lockedTargetId !== undefined;
    if (!st || (!locked && !state.spiValid)) return;
    st.count -= 1;
    state.releasedThisPress = true;
    Quat.rotate(shooter.rot, st.posBodyM, _muzzleOffsetW);
    Quat.rotate(shooter.rot, { x: 1, y: 0, z: 0 }, _dirWorld);
    const v = st.profile.launchSpeedMps;
    pushStore(shooterId, shooter, st, _dirWorld.x * v, _dirWorld.y * v - 3, _dirWorld.z * v, ProjectileKind.Arm, outRequests, outEvents, kind);
    const req = outRequests[outRequests.length - 1]!;
    if (locked) req.targetId = state.lockedTargetId as EntityId;
    else req.targetPoint = { x: state.spi.x, y: state.spi.y, z: state.spi.z };
    reselectIfEmpty(state);
    return;
  }
  if (kind !== WeaponKind.Bomb && kind !== WeaponKind.GuidedBomb) return;
  if (state.releasedThisPress) return;
  const guided = kind === WeaponKind.GuidedBomb;
  const gps = guided && findStationWithStore(state.stations, state.selectedStoreId)?.profile.guided?.seeker === 'gps';
  if (gps) {
    // GPS/INS: needs coordinates (a designated point); goes on the press, from anywhere (the DLZ cue says whether it can reach).
    if (!state.spiValid) return;
  } else if (guided) {
    // Laser-guided: goes on the press (it steers the rest of the way onto the spot; the DLZ cue says
    // whether it can reach the designated point). Without a designation it is aimed like a bomb (CCIP).
  } else if (state.spiValid) {
    // CCRP: wait for the release point. Past it (held through, or pressed late) there is no
    // release at all: a late drop lands long by however far the jet has flown.
    const ttr = state.ccrpTimeToReleaseSec;
    if (!(ttr <= 0 && ttr > -CCRP_LATE_SEC && Math.abs(state.ccrpCrossTrackM) <= CCRP_RELEASE_CROSS_M)) return;
  }
  const st = findStationWithStore(state.stations, state.selectedStoreId);
  if (!st) return;
  st.count -= 1;
  state.releasedThisPress = true;
  Quat.rotate(shooter.rot, releasePointBodyInto(st.profile, st.posBodyM, _releaseBody), _muzzleOffsetW);
  // Ejected straight down off the rack (body -y).
  Quat.rotate(shooter.rot, { x: 0, y: -1, z: 0 }, _dirWorld);
  const v = st.profile.launchSpeedMps;
  pushStore(shooterId, shooter, st, _dirWorld.x * v, _dirWorld.y * v, _dirWorld.z * v, kind === WeaponKind.GuidedBomb ? ProjectileKind.GuidedBomb : ProjectileKind.Bomb, outRequests, outEvents, kind);
  const rel = outRequests[outRequests.length - 1]!;
  rel.omegaBody = releaseRatesInto(st.profile, shooter.omega, { x: 0, y: 0, z: 0 });
  state.agAwaySec = AG_AWAY_SEC;
  if (state.spiValid) state.ccrpReleased = true;
  if (gps) {
    outRequests[outRequests.length - 1]!.targetPoint = { x: state.spi.x, y: state.spi.y, z: state.spi.z };
    // Pre-planned aim points: the next weapon goes to the next one.
    const b = state.briefed;
    if (b && b.points.length > 1) {
      b.next = (b.next + 1) % b.points.length;
      designatePoint(state, b.points[b.next]!);
    }
  }
  reselectIfEmpty(state);
}

/** Makes `p` the designated point (SPI); a carried pod slaves to it (ground-stabilised, designating). */
export function designatePoint(state: WeaponsState, p: Vec3Like): void {
  state.spiValid = true;
  state.ccrpReleased = false;
  state.spi.x = p.x;
  state.spi.y = p.y;
  state.spi.z = p.z;
  if (state.pod) {
    state.pod.point.x = p.x;
    state.pod.point.y = p.y;
    state.pod.point.z = p.z;
    state.pod.pointValid = true;
    state.pod.trackId = NO_ENTITY_ID;
    state.pod.designating = true;
  }
}

/** The route's target steerpoint became active: its (first) aim point is the SPI; GPS weapons take the aim points in turn. */
export function loadBriefedTarget(state: WeaponsState, points: readonly Vec3Like[]): void {
  if (points.length === 0) return;
  state.briefed = { points: points.map((p) => ({ x: p.x, y: p.y, z: p.z })), next: 0 };
  if (state.groundMap) state.groundMap.briefed = state.briefed.points;
  designatePoint(state, state.briefed.points[0]!);
}

/**
 * The target key on the ground map (src/combat/groundMap.ts): designates the entry after the
 * designated one, the briefed aim points first and then the radar contacts nearest first, wrapping
 * round. False when the map shows nothing.
 */
export function stepGroundDesignation(state: WeaponsState): boolean {
  const map = state.groundMap;
  if (!map) return false;
  const nb = map.briefed.length;
  const total = nb + map.count;
  if (total === 0) return false;
  const next = (designatedMapIndex(state) + 1) % total;
  if (next < nb) {
    designatePoint(state, map.briefed[next]!);
    state.briefed = { points: map.briefed, next };
  } else {
    state.briefed = undefined;
    designatePoint(state, map.contacts[next - nb]!);
  }
  return true;
}

/** A designation at the pipper snaps onto a ground-map target within this, m. */
export const DESIGNATE_SNAP_M = 60;

/** CCRP releases only with the predicted impact within this of the designated point's track, m. */
export const CCRP_RELEASE_CROSS_M = 25;
/** CCRP releases only this soon after the release point, s (later = release missed). */
export const CCRP_LATE_SEC = 0.25;

function pushStore(shooterId: EntityId, shooter: EntityState, st: WeaponStationRuntime, dvx: number, dvy: number, dvz: number, kind: ProjectileKind, outRequests: ProjectileSpawnRequest[], outEvents: SimEvent[], weapon: WeaponKind): void {
  outRequests.push({
    kind,
    ownerId: shooterId,
    team: shooter.team,
    posWorld: { x: shooter.pos.x + _muzzleOffsetW.x, y: shooter.pos.y + _muzzleOffsetW.y, z: shooter.pos.z + _muzzleOffsetW.z },
    rotWorld: { x: shooter.rot.x, y: shooter.rot.y, z: shooter.rot.z, w: shooter.rot.w },
    velWorld: { x: shooter.vel.x + dvx, y: shooter.vel.y + dvy, z: shooter.vel.z + dvz },
    profile: st.profile,
  });
  outEvents.push({ type: 'missileLaunch', shooterId, missileId: NO_ENTITY_ID, weapon });
}

/** "Away" shows this long after a bomb leaves, s. */
export const AG_AWAY_SEC = 1.5;

/**
 * The release cue (AgCueCode): the next thing the pilot does with the selected air-to-ground store,
 * from the sight's solution and whether the release button is held. Rockets and CCIP bombs: aim
 * the pipper (or dive until it is in view). Unguided bombs with a designated point (CCRP): steer
 * onto the release track, hold release, and the bomb goes at the release point; past it the pass
 * is missed. Guided weapons with a designated point have their launch-zone cue (DLZ) instead.
 */
export function updateAgCue(state: WeaponsState, launchHeld: boolean, dtSec: number): void {
  state.agAwaySec = Math.max(0, state.agAwaySec - dtSec);
  state.agCueFlags = (state.agPipperLimited ? AgCueFlag.PipperLimited : 0) | (launchHeld ? AgCueFlag.LaunchHeld : 0);
  const k = state.selectedWeapon;
  if (k !== WeaponKind.Bomb && k !== WeaponKind.GuidedBomb && k !== WeaponKind.Rocket) {
    state.agCue = AgCueCode.None;
  } else if (state.agAwaySec > 0) {
    state.agCue = AgCueCode.Away;
  } else if (k === WeaponKind.Rocket) {
    state.agCue = !state.agValid ? AgCueCode.None : state.agPipperLimited ? AgCueCode.Dive : AgCueCode.Ccip;
  } else if (!state.spiValid) {
    state.agCue = state.agValid && !state.agPipperLimited ? AgCueCode.Ccip : AgCueCode.Designate;
  } else if (k === WeaponKind.GuidedBomb) {
    state.agCue = AgCueCode.None;
  } else {
    const ttr = state.ccrpTimeToReleaseSec;
    if (!Number.isFinite(ttr)) state.agCue = AgCueCode.None;
    else if (ttr <= -CCRP_LATE_SEC) state.agCue = state.ccrpReleased ? AgCueCode.None : AgCueCode.Passed;
    else if (Math.abs(state.ccrpCrossTrackM) > CCRP_RELEASE_CROSS_M) state.agCue = AgCueCode.Steer;
    else if (ttr <= 0) state.agCue = AgCueCode.Release;
    else state.agCue = launchHeld ? AgCueCode.Releasing : AgCueCode.Hold;
  }
}

/** The gun is selected with no air target designated: it gets an air-to-ground (strafing) pipper. */
function gunGroundSight(state: WeaponsState): boolean {
  return state.selectedWeapon === WeaponKind.Gun && state.lockedTargetId === undefined;
}

/** Air-to-ground sight updates per second (the impact prediction integrates a whole fall). */
export const AG_SIGHT_HZ = 40;
const _fwdSight = { x: 0, y: 0, z: 0 };
const _downSight = { x: 0, y: 0, z: 0 };
const _stationW = { x: 0, y: 0, z: 0 };
const _releasePos = { x: 0, y: 0, z: 0 };
const BODY_DOWN = { x: 0, y: -1, z: 0 };
const _ccrp = { timeToReleaseSec: 0, crossTrackM: 0 };
const _pred = { valid: false, impact: { x: 0, y: 0, z: 0 }, tofSec: 0 };
const _clampDir = { x: 0, y: 0, z: 0 };
/** How far along the pinned pipper's line of sight the ground is looked for, m. */
const CLAMP_RAY_MAX_M = 30000;
const _rigid: RigidRelease = { rot: { x: 0, y: 0, z: 0, w: 1 }, omegaBody: { x: 0, y: 0, z: 0 }, step: () => {}, windWorldMps: { x: 0, y: 0, z: 0 } };

/**
 * The air-to-ground sight for the selected store (src/combat/agSight.ts): predicted impact, a
 * pending designation (target key in A/G mode: the SPI goes where the pipper is), and the CCRP
 * solution to the SPI. Runs at AG_SIGHT_HZ while an air-to-ground store is selected, and for the
 * gun while no air target is designated (strafing pipper).
 */
export function updateAgSight(state: WeaponsState, shooter: EntityState, sampler: HeightSampler, densityAt: (altM: number) => number, dtSec: number, env?: CombatEnvironment): void {
  const gun = gunGroundSight(state);
  if (!isAirToGroundKind(state.selectedWeapon) && !gun) {
    state.agValid = false;
    state.designateRequest = false;
    return;
  }
  state.agSightDueSec -= dtSec;
  if (state.agSightDueSec > 0 && !state.designateRequest) {
    // Between sight updates the release point keeps coming closer at the same rate.
    if (Number.isFinite(state.ccrpTimeToReleaseSec)) state.ccrpTimeToReleaseSec -= dtSec;
    return;
  }
  state.agSightDueSec = 1 / AG_SIGHT_HZ;
  const st = findStationWithStore(state.stations, state.selectedStoreId) ?? state.stations.find((s) => s.profile.id === state.selectedStoreId);
  if (!st) {
    state.agValid = false;
    return;
  }
  Quat.rotate(shooter.rot, { x: 1, y: 0, z: 0 }, _fwdSight);
  Quat.rotate(shooter.rot, BODY_DOWN, _downSight);
  // From the store's own station, ejected the way the rack pushes it (as fireWeapons releases it).
  Quat.rotate(shooter.rot, releasePointBodyInto(st.profile, st.posBodyM, _releaseBody), _stationW);
  _releasePos.x = shooter.pos.x + _stationW.x;
  _releasePos.y = shooter.pos.y + _stationW.y;
  _releasePos.z = shooter.pos.z + _stationW.z;
  // Bombs and rockets with an airframe: flown as the rigid body that is released.
  let rigid: RigidRelease | undefined;
  if (env?.stepFreeBody) {
    _rigid.rot = shooter.rot;
    releaseRatesInto(st.profile, shooter.omega, _rigid.omegaBody);
    _rigid.step = env.stepFreeBody;
    _rigid.windWorldMps = env.windWorldMps;
    rigid = _rigid;
  }
  predictImpact(st.profile, _releasePos, shooter.vel, _fwdSight, sampler, densityAt, _pred, _downSight, rigid);
  state.agValid = _pred.valid;
  state.agTofSec = _pred.tofSec;
  state.agImpact.x = _pred.impact.x;
  state.agImpact.y = _pred.impact.y;
  state.agImpact.z = _pred.impact.z;
  // Beyond the sight field the pipper is pinned on its edge (AG_SIGHT_FIELD_RAD below the flight
  // path, towards the impact point); the ground under it there is what a designation takes.
  state.agPipperLimited = false;
  state.agClampValid = false;
  if (state.agValid) {
    const ix = state.agImpact.x - shooter.pos.x, iy = state.agImpact.y - shooter.pos.y, iz = state.agImpact.z - shooter.pos.z;
    const ir = Math.hypot(ix, iy, iz);
    const vs = Math.hypot(shooter.vel.x, shooter.vel.y, shooter.vel.z);
    if (ir > 1 && vs > 1) {
      const cosA = (ix * shooter.vel.x + iy * shooter.vel.y + iz * shooter.vel.z) / (ir * vs);
      const a = Math.acos(Math.max(-1, Math.min(1, cosA)));
      if (a > AG_SIGHT_FIELD_RAD) {
        state.agPipperLimited = true;
        // Slerp from the flight path towards the impact by the field angle.
        const sinA = Math.sin(a);
        const wv = Math.sin(a - AG_SIGHT_FIELD_RAD) / sinA / vs;
        const wi = Math.sin(AG_SIGHT_FIELD_RAD) / sinA / ir;
        _clampDir.x = shooter.vel.x * wv + ix * wi;
        _clampDir.y = shooter.vel.y * wv + iy * wi;
        _clampDir.z = shooter.vel.z * wv + iz * wi;
        // (The player's sight only: the AI aims at the impact point itself.)
        if (state.groundMap) state.agClampValid = rayToGround(sampler, shooter.pos, _clampDir, CLAMP_RAY_MAX_M, state.agClampPoint) > 0;
      }
    }
  }
  if (state.designateRequest) {
    state.designateRequest = false;
    const pinned = state.agPipperLimited && !!state.groundMap;
    const p = pinned ? (state.agClampValid ? state.agClampPoint : undefined) : state.agValid ? state.agImpact : undefined;
    if (p) {
      // The pod slaves to a HUD designation; one next to a target on the ground map takes the target.
      state.briefed = undefined;
      designatePoint(state, (state.groundMap && nearestGroundContact(state.groundMap, p, DESIGNATE_SNAP_M)) || p);
    }
  }
  // Launch zone of a guided weapon to the designated point: its range grows with release height.
  const g = st.profile.guided;
  if (g && state.spiValid) {
    const range = Math.hypot(state.spi.x - shooter.pos.x, state.spi.z - shooter.pos.z);
    const rMax = g.rangeSeaLevelM + (g.rangePerKmAltM * Math.max(0, shooter.pos.y - state.spi.y)) / 1000;
    state.dlz = range <= rMax ? DlzCode.InRange : DlzCode.OutOfRange;
  } else {
    state.dlz = DlzCode.None;
  }
  if (state.spiValid && state.agValid) {
    ccrpSolution(state.agImpact, state.spi, shooter.vel, _ccrp);
    state.ccrpTimeToReleaseSec = _ccrp.timeToReleaseSec;
    state.ccrpCrossTrackM = _ccrp.crossTrackM;
  } else {
    state.ccrpTimeToReleaseSec = Infinity;
    state.ccrpCrossTrackM = 0;
  }
}

/**
 * How many flares and chaff bundles the pilot's keys release this tick: a program
 * (DECOYS_PER_PROGRAM) on each press, repeating every DECOY_PROGRAM_INTERVAL_SEC while held, limited
 * by what is left. Decrements the counts. Allocation-free.
 */
export function countermeasureRelease(state: WeaponsState, flareKey: boolean, chaffKey: boolean, dtSec: number, out: { flares: number; chaff: number }): void {
  out.flares = 0;
  out.chaff = 0;
  state.flareRepeatSec -= dtSec;
  state.chaffRepeatSec -= dtSec;
  if (flareKey && (!state.prevFlare || state.flareRepeatSec <= 0) && state.flares > 0) {
    out.flares = Math.min(DECOYS_PER_PROGRAM, state.flares);
    state.flares -= out.flares;
    state.flareRepeatSec = DECOY_PROGRAM_INTERVAL_SEC;
  }
  if (chaffKey && (!state.prevChaff || state.chaffRepeatSec <= 0) && state.chaff > 0) {
    out.chaff = Math.min(DECOYS_PER_PROGRAM, state.chaff);
    state.chaff -= out.chaff;
    state.chaffRepeatSec = DECOY_PROGRAM_INTERVAL_SEC;
  }
  state.prevFlare = flareKey;
  state.prevChaff = chaffKey;
}

/** One uniform draw in [0, 1) from a combat RNG stream (mulberry32). */
export function combatRand01(rng: { seedState: number }): number {
  return rngRange(rng, 0, 1);
}

// Bridges CombatRngState to src/math's nextRange (PrngState.s) without allocating.
const _prngBridge: PrngState = { s: 0 };
function rngRange(rng: { seedState: number }, min: number, max: number): number {
  _prngBridge.s = rng.seedState >>> 0;
  const v = nextRange(_prngBridge, min, max);
  rng.seedState = _prngBridge.s;
  return v;
}
