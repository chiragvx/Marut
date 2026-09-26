/**
 * src/core/snapshotReader.ts — implements `ReadSnapshotHeader`/
 * `ReadSnapshotEntity`/`ReadSnapshotHud` (contracts/sim.ts section 6). Used
 * by src/render/src/hud (main thread) and by tools/sim-check.ts.
 */

import {
  EntityKindByCode,
  HEADER_FLOATS,
  HUD_BLOCK_START,
  SnapshotEntity,
  SnapshotHeader,
  SnapshotHud,
  entityFieldOffset,
} from '../contracts/core';
import type {
  ReadSnapshotEntity,
  ReadSnapshotHeader,
  ReadSnapshotHud,
  SnapshotEntityView,
  SnapshotHeaderView,
  SnapshotHudView,
} from '../contracts/sim';

export const readSnapshotHeader: ReadSnapshotHeader = (buf: Float64Array): SnapshotHeaderView => ({
  tick: buf[SnapshotHeader.TICK_OFFSET] as number,
  simTimeSec: buf[SnapshotHeader.SIM_TIME_SEC_OFFSET] as number,
  entityCount: buf[SnapshotHeader.ENTITY_COUNT_OFFSET] as number,
  playerIndex: buf[SnapshotHeader.PLAYER_INDEX_OFFSET] as number,
});

export const readSnapshotEntity: ReadSnapshotEntity = (buf: Float64Array, index: number, out: SnapshotEntityView): SnapshotEntityView => {
  out.id = buf[entityFieldOffset(index, SnapshotEntity.ID)] as number;
  const kindCode = buf[entityFieldOffset(index, SnapshotEntity.KIND)] as number;
  out.kind = EntityKindByCode[kindCode] ?? 'aircraft';
  out.team = (buf[entityFieldOffset(index, SnapshotEntity.TEAM)] as number) as 0 | 1;
  out.pos.x = buf[entityFieldOffset(index, SnapshotEntity.POS_X)] as number;
  out.pos.y = buf[entityFieldOffset(index, SnapshotEntity.POS_Y)] as number;
  out.pos.z = buf[entityFieldOffset(index, SnapshotEntity.POS_Z)] as number;
  out.rot.x = buf[entityFieldOffset(index, SnapshotEntity.ROT_X)] as number;
  out.rot.y = buf[entityFieldOffset(index, SnapshotEntity.ROT_Y)] as number;
  out.rot.z = buf[entityFieldOffset(index, SnapshotEntity.ROT_Z)] as number;
  out.rot.w = buf[entityFieldOffset(index, SnapshotEntity.ROT_W)] as number;
  out.vel.x = buf[entityFieldOffset(index, SnapshotEntity.VEL_X)] as number;
  out.vel.y = buf[entityFieldOffset(index, SnapshotEntity.VEL_Y)] as number;
  out.vel.z = buf[entityFieldOffset(index, SnapshotEntity.VEL_Z)] as number;
  out.omega.x = buf[entityFieldOffset(index, SnapshotEntity.OMEGA_X)] as number;
  out.omega.y = buf[entityFieldOffset(index, SnapshotEntity.OMEGA_Y)] as number;
  out.omega.z = buf[entityFieldOffset(index, SnapshotEntity.OMEGA_Z)] as number;
  out.alive = (buf[entityFieldOffset(index, SnapshotEntity.ALIVE)] as number) !== 0;
  out.hp = buf[entityFieldOffset(index, SnapshotEntity.HP)] as number;
  out.fuelKg = buf[entityFieldOffset(index, SnapshotEntity.FUEL_KG)] as number;
  out.elevonL = buf[entityFieldOffset(index, SnapshotEntity.ELEVON_L)] as number;
  out.elevonR = buf[entityFieldOffset(index, SnapshotEntity.ELEVON_R)] as number;
  out.rudder = buf[entityFieldOffset(index, SnapshotEntity.RUDDER)] as number;
  out.gearPos = buf[entityFieldOffset(index, SnapshotEntity.GEAR_POS)] as number;
  out.throttle = buf[entityFieldOffset(index, SnapshotEntity.THROTTLE)] as number;
  out.afterburnerOn = (buf[entityFieldOffset(index, SnapshotEntity.AFTERBURNER_ON)] as number) !== 0;
  out.flags = buf[entityFieldOffset(index, SnapshotEntity.FLAGS)] as number;
  return out;
};

export const readSnapshotHud: ReadSnapshotHud = (buf: Float64Array, out: SnapshotHudView): SnapshotHudView => {
  const base = HUD_BLOCK_START;
  out.iasMps = buf[base + SnapshotHud.IAS_MPS] as number;
  out.tasMps = buf[base + SnapshotHud.TAS_MPS] as number;
  out.mach = buf[base + SnapshotHud.MACH] as number;
  out.altMslM = buf[base + SnapshotHud.ALT_MSL_M] as number;
  out.altAglM = buf[base + SnapshotHud.ALT_AGL_M] as number;
  out.aoaRad = buf[base + SnapshotHud.AOA_RAD] as number;
  out.betaRad = buf[base + SnapshotHud.BETA_RAD] as number;
  out.gLoad = buf[base + SnapshotHud.G_LOAD] as number;
  out.headingRad = buf[base + SnapshotHud.HEADING_RAD] as number;
  out.pitchRad = buf[base + SnapshotHud.PITCH_RAD] as number;
  out.rollRad = buf[base + SnapshotHud.ROLL_RAD] as number;
  out.vspeedMps = buf[base + SnapshotHud.VSPEED_MPS] as number;
  out.fuelKg = buf[base + SnapshotHud.FUEL_KG] as number;
  out.thrustFrac = buf[base + SnapshotHud.THRUST_FRAC] as number;
  out.gearPos = buf[base + SnapshotHud.GEAR_POS] as number;
  out.weaponIdx = buf[base + SnapshotHud.WEAPON_IDX] as number;
  out.targetId = buf[base + SnapshotHud.TARGET_ID] as number;
  out.targetRangeM = buf[base + SnapshotHud.TARGET_RANGE_M] as number;
  out.closureMps = buf[base + SnapshotHud.CLOSURE_MPS] as number;
  out.lockState = buf[base + SnapshotHud.LOCK_STATE] as number;
  out.warningBits = buf[base + SnapshotHud.WARNING_BITS] as number;
  out.ilsLoc = buf[base + SnapshotHud.ILS_LOC] as number;
  out.ilsGs = buf[base + SnapshotHud.ILS_GS] as number;
  out.pipperX = buf[base + SnapshotHud.PIPPER_X] as number;
  out.pipperY = buf[base + SnapshotHud.PIPPER_Y] as number;
  out.pipperZ = buf[base + SnapshotHud.PIPPER_Z] as number;
  out.pipperValid = buf[base + SnapshotHud.PIPPER_VALID] as number;
  out.tankFuelKg = buf[base + SnapshotHud.TANK_FUEL_KG] as number;
  out.serviceState = buf[base + SnapshotHud.SERVICE_STATE] as number;
  out.serviceFuelFrac = buf[base + SnapshotHud.SERVICE_FUEL_FRAC] as number;
  out.serviceArmFrac = buf[base + SnapshotHud.SERVICE_ARM_FRAC] as number;
  out.radarMode = buf[base + SnapshotHud.RADAR_MODE] as number;
  out.radarMaxRangeM = buf[base + SnapshotHud.RADAR_MAX_RANGE_M] as number;
  out.radarScanAzRad = buf[base + SnapshotHud.RADAR_SCAN_AZ_RAD] as number;
  out.trackCount = buf[base + SnapshotHud.TRACK_COUNT] as number;
  out.apFlags = buf[base + SnapshotHud.AP_FLAGS] as number;
  out.apHdgRad = buf[base + SnapshotHud.AP_HDG_RAD] as number;
  out.apAltM = buf[base + SnapshotHud.AP_ALT_M] as number;
  out.apVsMps = buf[base + SnapshotHud.AP_VS_MPS] as number;
  out.apSpdMps = buf[base + SnapshotHud.AP_SPD_MPS] as number;
  out.apThrottle = buf[base + SnapshotHud.AP_THROTTLE] as number;
  if (out.tracks) for (let k = 0; k < out.tracks.length; k++) out.tracks[k] = buf[base + SnapshotHud.TRACKS_BASE + k] as number;
  return out;
};

// Re-exported for symmetry with snapshotWriter.ts.
export { HEADER_FLOATS };
