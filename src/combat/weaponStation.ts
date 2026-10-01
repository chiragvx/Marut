/**
 * src/combat/weaponStation.ts — weapon station/loadout runtime state,
 * CombatStatus aggregation, and the top-level `fireWeapons` (gun trigger +
 * missile launch dispatch). See docs/spec/07-combat.md sections 4.1, 4.6.
 */
import {
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
} from '../contracts/combat';
import { ccrpSolution, predictImpact } from './agSight';
import { createPodState } from './targetingPod';
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
    // CCRP: wait for the release point.
    if (!(state.ccrpTimeToReleaseSec <= 0 && Math.abs(state.ccrpCrossTrackM) <= CCRP_RELEASE_CROSS_M)) return;
  }
  const st = findStationWithStore(state.stations, state.selectedStoreId);
  if (!st) return;
  st.count -= 1;
  state.releasedThisPress = true;
  Quat.rotate(shooter.rot, st.posBodyM, _muzzleOffsetW);
  // Ejected straight down off the rack (body -y).
  Quat.rotate(shooter.rot, { x: 0, y: -1, z: 0 }, _dirWorld);
  const v = st.profile.launchSpeedMps;
  pushStore(shooterId, shooter, st, _dirWorld.x * v, _dirWorld.y * v, _dirWorld.z * v, kind === WeaponKind.GuidedBomb ? ProjectileKind.GuidedBomb : ProjectileKind.Bomb, outRequests, outEvents, kind);
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
  designatePoint(state, state.briefed.points[0]!);
}

/** CCRP releases only with the predicted impact within this of the designated point's track, m. */
export const CCRP_RELEASE_CROSS_M = 60;

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

/** The gun is selected with no air target designated: it gets an air-to-ground (strafing) pipper. */
function gunGroundSight(state: WeaponsState): boolean {
  return state.selectedWeapon === WeaponKind.Gun && state.lockedTargetId === undefined;
}

/** Air-to-ground sight updates per second (the impact prediction integrates a whole fall). */
export const AG_SIGHT_HZ = 40;
const _fwdSight = { x: 0, y: 0, z: 0 };
const _ccrp = { timeToReleaseSec: 0, crossTrackM: 0 };
const _pred = { valid: false, impact: { x: 0, y: 0, z: 0 }, tofSec: 0 };

/**
 * The air-to-ground sight for the selected store (src/combat/agSight.ts): predicted impact, a
 * pending designation (target key in A/G mode: the SPI goes where the pipper is), and the CCRP
 * solution to the SPI. Runs at AG_SIGHT_HZ while an air-to-ground store is selected, and for the
 * gun while no air target is designated (strafing pipper).
 */
export function updateAgSight(state: WeaponsState, shooter: EntityState, sampler: HeightSampler, densityAt: (altM: number) => number, dtSec: number): void {
  const gun = gunGroundSight(state);
  if (!isAirToGroundKind(state.selectedWeapon) && !gun) {
    state.agValid = false;
    state.designateRequest = false;
    return;
  }
  state.agSightDueSec -= dtSec;
  if (state.agSightDueSec > 0 && !state.designateRequest) return;
  state.agSightDueSec = 1 / AG_SIGHT_HZ;
  const st = findStationWithStore(state.stations, state.selectedStoreId) ?? state.stations.find((s) => s.profile.id === state.selectedStoreId);
  if (!st) {
    state.agValid = false;
    return;
  }
  Quat.rotate(shooter.rot, { x: 1, y: 0, z: 0 }, _fwdSight);
  predictImpact(st.profile, shooter.pos, shooter.vel, _fwdSight, sampler, densityAt, _pred);
  state.agValid = _pred.valid;
  state.agTofSec = _pred.tofSec;
  state.agImpact.x = _pred.impact.x;
  state.agImpact.y = _pred.impact.y;
  state.agImpact.z = _pred.impact.z;
  if (state.designateRequest) {
    state.designateRequest = false;
    if (state.agValid) {
      // The pod slaves to a HUD designation.
      state.briefed = undefined;
      designatePoint(state, state.agImpact);
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
