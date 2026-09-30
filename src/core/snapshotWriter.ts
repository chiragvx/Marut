/**
 * src/core/snapshotWriter.ts — implements `WriteSnapshot` (contracts/sim.ts
 * section 6), writing the binary layout core.ts section 11 defines.
 */

import {
  ENTITY_STRIDE,
  EntityKindCode,
  HEADER_FLOATS,
  HUD_BLOCK_START,
  MAX_ENTITIES,
  NO_ENTITY_ID,
  SnapshotEntity,
  SnapshotHeader,
  SnapshotHud,
  SNAPSHOT_FLOATS,
  entityFieldOffset,
  HUD_BLOCK_FLOATS,
  MAX_SNAPSHOT_TRACKS,
  SNAPSHOT_TRACK_STRIDE,
} from '../contracts/core';
import type { EntityId } from '../contracts/core';
import type { EntityPool, SnapshotHudView, WriteSnapshot } from '../contracts/sim';

export const writeSnapshot: WriteSnapshot = (
  pool: EntityPool,
  playerEntityId: EntityId,
  tick: number,
  simTimeSec: number,
  hud: SnapshotHudView,
  out: Float64Array
): void => {
  if (out.length !== SNAPSHOT_FLOATS) {
    throw new Error(`writeSnapshot: out.length must equal SNAPSHOT_FLOATS (${SNAPSHOT_FLOATS}), got ${out.length}`);
  }

  const entityCount = Math.min(pool.liveCount, MAX_ENTITIES);
  out[SnapshotHeader.TICK_OFFSET] = tick;
  out[SnapshotHeader.SIM_TIME_SEC_OFFSET] = simTimeSec;
  out[SnapshotHeader.ENTITY_COUNT_OFFSET] = entityCount;

  let playerIndex = -1;

  for (let i = 0; i < entityCount; i++) {
    const e = pool.liveAt(i);
    if (e.id === playerEntityId && playerEntityId !== NO_ENTITY_ID) playerIndex = i;
    out[entityFieldOffset(i, SnapshotEntity.ID)] = e.id;
    out[entityFieldOffset(i, SnapshotEntity.KIND)] = EntityKindCode[e.kind];
    out[entityFieldOffset(i, SnapshotEntity.TEAM)] = e.team;
    out[entityFieldOffset(i, SnapshotEntity.POS_X)] = e.pos.x;
    out[entityFieldOffset(i, SnapshotEntity.POS_Y)] = e.pos.y;
    out[entityFieldOffset(i, SnapshotEntity.POS_Z)] = e.pos.z;
    out[entityFieldOffset(i, SnapshotEntity.ROT_X)] = e.rot.x;
    out[entityFieldOffset(i, SnapshotEntity.ROT_Y)] = e.rot.y;
    out[entityFieldOffset(i, SnapshotEntity.ROT_Z)] = e.rot.z;
    out[entityFieldOffset(i, SnapshotEntity.ROT_W)] = e.rot.w;
    out[entityFieldOffset(i, SnapshotEntity.VEL_X)] = e.vel.x;
    out[entityFieldOffset(i, SnapshotEntity.VEL_Y)] = e.vel.y;
    out[entityFieldOffset(i, SnapshotEntity.VEL_Z)] = e.vel.z;
    out[entityFieldOffset(i, SnapshotEntity.OMEGA_X)] = e.omega.x;
    out[entityFieldOffset(i, SnapshotEntity.OMEGA_Y)] = e.omega.y;
    out[entityFieldOffset(i, SnapshotEntity.OMEGA_Z)] = e.omega.z;
    out[entityFieldOffset(i, SnapshotEntity.ALIVE)] = e.alive ? 1 : 0;
    out[entityFieldOffset(i, SnapshotEntity.HP)] = e.hp;
    out[entityFieldOffset(i, SnapshotEntity.FUEL_KG)] = e.fuelKg;
    out[entityFieldOffset(i, SnapshotEntity.ELEVON_L)] = e.elevonL;
    out[entityFieldOffset(i, SnapshotEntity.ELEVON_R)] = e.elevonR;
    out[entityFieldOffset(i, SnapshotEntity.RUDDER)] = e.rudder;
    out[entityFieldOffset(i, SnapshotEntity.GEAR_POS)] = e.gearPos;
    out[entityFieldOffset(i, SnapshotEntity.THROTTLE)] = e.throttle;
    out[entityFieldOffset(i, SnapshotEntity.AFTERBURNER_ON)] = e.afterburnerOn ? 1 : 0;
    out[entityFieldOffset(i, SnapshotEntity.FLAGS)] = e.flags;
    out[entityFieldOffset(i, SnapshotEntity.STORES)] = e.stores ?? 0;
    out[entityFieldOffset(i, SnapshotEntity.STORES_B)] = e.storesB ?? 0;
  }
  // Zero any stale trailing entity blocks beyond entityCount is not required
  // (readers must only read [0, entityCount)), so no further writes needed.

  out[SnapshotHeader.PLAYER_INDEX_OFFSET] = playerIndex;

  const hudBase = HUD_BLOCK_START;
  if (playerEntityId === NO_ENTITY_ID || playerIndex === -1) {
    for (let f = 0; f < HUD_BLOCK_FLOATS; f++) out[hudBase + f] = 0;
  } else {
    out[hudBase + SnapshotHud.IAS_MPS] = hud.iasMps;
    out[hudBase + SnapshotHud.TAS_MPS] = hud.tasMps;
    out[hudBase + SnapshotHud.MACH] = hud.mach;
    out[hudBase + SnapshotHud.ALT_MSL_M] = hud.altMslM;
    out[hudBase + SnapshotHud.ALT_AGL_M] = hud.altAglM;
    out[hudBase + SnapshotHud.AOA_RAD] = hud.aoaRad;
    out[hudBase + SnapshotHud.BETA_RAD] = hud.betaRad;
    out[hudBase + SnapshotHud.G_LOAD] = hud.gLoad;
    out[hudBase + SnapshotHud.HEADING_RAD] = hud.headingRad;
    out[hudBase + SnapshotHud.PITCH_RAD] = hud.pitchRad;
    out[hudBase + SnapshotHud.ROLL_RAD] = hud.rollRad;
    out[hudBase + SnapshotHud.VSPEED_MPS] = hud.vspeedMps;
    out[hudBase + SnapshotHud.FUEL_KG] = hud.fuelKg;
    out[hudBase + SnapshotHud.THRUST_FRAC] = hud.thrustFrac;
    out[hudBase + SnapshotHud.GEAR_POS] = hud.gearPos;
    out[hudBase + SnapshotHud.WEAPON_IDX] = hud.weaponIdx;
    out[hudBase + SnapshotHud.SELECTED_STORE] = hud.selectedStore;
    out[hudBase + SnapshotHud.SELECTED_COUNT] = hud.selectedCount;
    out[hudBase + SnapshotHud.GUN_ROUNDS] = hud.gunRounds;
    out[hudBase + SnapshotHud.CHAFF] = hud.chaff;
    out[hudBase + SnapshotHud.FLARES] = hud.flares;
    out[hudBase + SnapshotHud.AG_MODE] = hud.agMode;
    out[hudBase + SnapshotHud.CCIP_X] = hud.ccipX;
    out[hudBase + SnapshotHud.CCIP_Y] = hud.ccipY;
    out[hudBase + SnapshotHud.CCIP_Z] = hud.ccipZ;
    out[hudBase + SnapshotHud.SPI_X] = hud.spiX;
    out[hudBase + SnapshotHud.SPI_Y] = hud.spiY;
    out[hudBase + SnapshotHud.SPI_Z] = hud.spiZ;
    out[hudBase + SnapshotHud.SPI_VALID] = hud.spiValid;
    out[hudBase + SnapshotHud.AG_TIME_SEC] = hud.agTimeSec;
    out[hudBase + SnapshotHud.AG_CROSS_M] = hud.agCrossM;
    out[hudBase + SnapshotHud.POD_FLAGS] = hud.podFlags;
    out[hudBase + SnapshotHud.POD_X] = hud.podX;
    out[hudBase + SnapshotHud.POD_Y] = hud.podY;
    out[hudBase + SnapshotHud.POD_Z] = hud.podZ;
    out[hudBase + SnapshotHud.POD_FOV_DEG] = hud.podFovDeg;
    out[hudBase + SnapshotHud.POD_RANGE_M] = hud.podRangeM;
    out[hudBase + SnapshotHud.DLZ] = hud.dlz;
    out[hudBase + SnapshotHud.TARGET_ID] = hud.targetId;
    out[hudBase + SnapshotHud.TARGET_RANGE_M] = hud.targetRangeM;
    out[hudBase + SnapshotHud.CLOSURE_MPS] = hud.closureMps;
    out[hudBase + SnapshotHud.LOCK_STATE] = hud.lockState;
    out[hudBase + SnapshotHud.WARNING_BITS] = hud.warningBits;
    out[hudBase + SnapshotHud.ILS_LOC] = hud.ilsLoc;
    out[hudBase + SnapshotHud.ILS_GS] = hud.ilsGs;
    out[hudBase + SnapshotHud.PIPPER_X] = hud.pipperX;
    out[hudBase + SnapshotHud.PIPPER_Y] = hud.pipperY;
    out[hudBase + SnapshotHud.PIPPER_Z] = hud.pipperZ;
    out[hudBase + SnapshotHud.PIPPER_VALID] = hud.pipperValid;
    out[hudBase + SnapshotHud.TANK_FUEL_KG] = hud.tankFuelKg;
    out[hudBase + SnapshotHud.SERVICE_STATE] = hud.serviceState;
    out[hudBase + SnapshotHud.SERVICE_FUEL_FRAC] = hud.serviceFuelFrac;
    out[hudBase + SnapshotHud.SERVICE_ARM_FRAC] = hud.serviceArmFrac;
    out[hudBase + SnapshotHud.RADAR_MODE] = hud.radarMode;
    out[hudBase + SnapshotHud.RADAR_MAX_RANGE_M] = hud.radarMaxRangeM;
    out[hudBase + SnapshotHud.RADAR_SCAN_AZ_RAD] = hud.radarScanAzRad;
    out[hudBase + SnapshotHud.AP_FLAGS] = hud.apFlags ?? 0;
    out[hudBase + SnapshotHud.AP_HDG_RAD] = hud.apHdgRad ?? 0;
    out[hudBase + SnapshotHud.AP_ALT_M] = hud.apAltM ?? 0;
    out[hudBase + SnapshotHud.AP_VS_MPS] = hud.apVsMps ?? 0;
    out[hudBase + SnapshotHud.AP_SPD_MPS] = hud.apSpdMps ?? 0;
    out[hudBase + SnapshotHud.AP_THROTTLE] = hud.apThrottle ?? 0;
    const n = Math.min(hud.trackCount, MAX_SNAPSHOT_TRACKS);
    out[hudBase + SnapshotHud.TRACK_COUNT] = n;
    const tb = hudBase + SnapshotHud.TRACKS_BASE;
    for (let k = 0; k < n * SNAPSHOT_TRACK_STRIDE; k++) out[tb + k] = hud.tracks[k]!;
  }
};

// Re-exported for tests / snapshotReader symmetry checks.
export { HEADER_FLOATS };
