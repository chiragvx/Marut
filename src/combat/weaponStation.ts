/**
 * src/combat/weaponStation.ts — weapon station/loadout runtime state,
 * CombatStatus aggregation, and the top-level `fireWeapons` (gun trigger +
 * missile launch dispatch). See docs/spec/07-combat.md sections 4.1, 4.6.
 */
import { LockState, NO_ENTITY_ID, WeaponKind, type CombatStatus, type EntityId } from '../contracts/core';
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
} from '../contracts/combat';
import { Vec3, Quat, nextRange, type PrngState } from '../math';
import { GENERIC_RADAR_PROFILE, defaultWeaponProfile } from './weaponProfiles';

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
    dragAreaM2 += st.count * st.profile.carriageDragAreaM2;
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
    aimPointWorld: { x: 0, y: 0, z: 0 },
    aimPointValid: false,
    rng: createCombatRngState(rngSubSeed),
  };
};

export const writeCombatStatus: WriteCombatStatus = (state, out: CombatStatus) => {
  let ammoGun = 0, missilesIr = 0, missilesRadar = 0, irRangeM = 0, radarRangeM = 0;
  for (let i = 0; i < state.stations.length; i++) {
    const st = state.stations[i]!;
    const reach = st.count > 0 ? (st.profile.envelope?.rMaxHeadOnM ?? 0) : 0;
    if (st.weapon === WeaponKind.Gun) ammoGun += st.count;
    else if (st.weapon === WeaponKind.IrMissile) { missilesIr += st.count; irRangeM = Math.max(irRangeM, reach); }
    else if (st.weapon === WeaponKind.RadarMissile) { missilesRadar += st.count; radarRangeM = Math.max(radarRangeM, reach); }
  }
  out.irMissileRangeM = irRangeM;
  out.radarMissileRangeM = radarRangeM;
  out.selectedWeapon = state.selectedWeapon;
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

  // --- Missiles: edge-triggered on `launch`, lock-gated ---
  const launchEdge = inputs.launch && !state.prevLaunch;
  if (launchEdge && outRequests.length < MAX_SPAWN_REQUESTS_PER_TICK && lockedTarget && state.lockState === LockState.Locked) {
    let station: WeaponStationRuntime | undefined;
    let ejectionSpeed = 0;
    let projectileKind: (typeof ProjectileKind)[keyof typeof ProjectileKind] | undefined;

    if (state.selectedWeapon === WeaponKind.RadarMissile) {
      station = findStationWithAmmo(state.stations, WeaponKind.RadarMissile);
      ejectionSpeed = station ? station.profile.launchSpeedMps : 0;
      projectileKind = ProjectileKind.RadarMissile;
    } else if (state.selectedWeapon === WeaponKind.IrMissile) {
      const dx = lockedTarget.pos.x - shooterState.pos.x;
      const dy = lockedTarget.pos.y - shooterState.pos.y;
      const dz = lockedTarget.pos.z - shooterState.pos.z;
      const rangeM = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const irStation = findStationWithAmmo(state.stations, WeaponKind.IrMissile);
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
    }
  }

  state.prevLaunch = inputs.launch;
};

// Bridges CombatRngState to src/math's nextRange (PrngState.s) without allocating.
const _prngBridge: PrngState = { s: 0 };
function rngRange(rng: { seedState: number }, min: number, max: number): number {
  _prngBridge.s = rng.seedState >>> 0;
  const v = nextRange(_prngBridge, min, max);
  rng.seedState = _prngBridge.s;
  return v;
}
