/**
 * tests/core/snapshotWriter.test.ts — written buffer decodes via
 * entityFieldOffset back to the source EntityState. See
 * docs/spec/12-verification.md section 7.
 */
import { describe, expect, test } from 'vitest';
import {
  entityFieldOffset,
  HEADER_FLOATS,
  ENTITY_STRIDE,
  SNAPSHOT_FLOATS,
  SnapshotEntity,
  SnapshotHeader,
  NO_ENTITY_ID,
} from '../../src/contracts/core';
import type { SnapshotHudView } from '../../src/contracts/sim';
import { createEntityPool } from '../../src/core/entityPool';
import { writeSnapshot } from '../../src/core/snapshotWriter';

function makeZeroHud(): SnapshotHudView {
  return {
    iasMps: 0, tasMps: 0, mach: 0, altMslM: 0, altAglM: 0, aoaRad: 0, betaRad: 0, gLoad: 0,
    headingRad: 0, pitchRad: 0, rollRad: 0, vspeedMps: 0, fuelKg: 0, thrustFrac: 0, gearPos: 0,
    weaponIdx: 0, targetId: NO_ENTITY_ID, targetRangeM: 0, closureMps: 0, lockState: 0, warningBits: 0,
    ilsLoc: 0, ilsGs: 0, pipperX: 0, pipperY: 0, pipperZ: 0, pipperValid: 0, tankFuelKg: -1,
  };
}

describe('entityFieldOffset', () => {
  test('matches the documented formula', () => {
    expect(entityFieldOffset(3, SnapshotEntity.POS_Y)).toBe(HEADER_FLOATS + 3 * ENTITY_STRIDE + SnapshotEntity.POS_Y);
  });
});

describe('writeSnapshot', () => {
  test('throws if out.length !== SNAPSHOT_FLOATS', () => {
    const pool = createEntityPool({ aircraft: 1, missile: 0, bullet: 0, effect: 0 });
    const hud = makeZeroHud();
    expect(() => writeSnapshot(pool, NO_ENTITY_ID, 0, 0, hud, new Float64Array(4))).toThrow();
  });

  test('a written EntityState round-trips into the raw buffer at entityFieldOffset', () => {
    const pool = createEntityPool({ aircraft: 1, missile: 0, bullet: 0, effect: 0 });
    const id = pool.allocate('aircraft', 1);
    const state = pool.get(id);
    expect(state).toBeDefined();
    if (state === undefined) return;
    state.pos.x = 123.5;
    state.pos.y = 4567.25;
    state.pos.z = -890;
    state.rot.x = 0.1;
    state.rot.y = 0.2;
    state.rot.z = 0.3;
    state.rot.w = 0.9;
    state.vel.x = 50;
    state.vel.y = -1.5;
    state.vel.z = -200;
    state.fuelKg = 1234;
    state.throttle = 0.75;

    const buf = new Float64Array(SNAPSHOT_FLOATS);
    writeSnapshot(pool, id, 42, 3.5, makeZeroHud(), buf);

    expect(buf[SnapshotHeader.TICK_OFFSET]).toBe(42);
    expect(buf[SnapshotHeader.SIM_TIME_SEC_OFFSET]).toBe(3.5);
    expect(buf[SnapshotHeader.ENTITY_COUNT_OFFSET]).toBe(1);
    expect(buf[SnapshotHeader.PLAYER_INDEX_OFFSET]).toBe(0);

    expect(buf[entityFieldOffset(0, SnapshotEntity.ID)]).toBe(id);
    expect(buf[entityFieldOffset(0, SnapshotEntity.TEAM)]).toBe(1);
    expect(buf[entityFieldOffset(0, SnapshotEntity.POS_X)]).toBe(123.5);
    expect(buf[entityFieldOffset(0, SnapshotEntity.POS_Y)]).toBe(4567.25);
    expect(buf[entityFieldOffset(0, SnapshotEntity.POS_Z)]).toBe(-890);
    expect(buf[entityFieldOffset(0, SnapshotEntity.ROT_W)]).toBe(0.9);
    expect(buf[entityFieldOffset(0, SnapshotEntity.VEL_Z)]).toBe(-200);
    expect(buf[entityFieldOffset(0, SnapshotEntity.FUEL_KG)]).toBe(1234);
    expect(buf[entityFieldOffset(0, SnapshotEntity.THROTTLE)]).toBe(0.75);
    expect(buf[entityFieldOffset(0, SnapshotEntity.ALIVE)]).toBe(1);
  });

  test('PLAYER_INDEX_OFFSET is -1 and the HUD block is all zero when playerEntityId is NO_ENTITY_ID', () => {
    const pool = createEntityPool({ aircraft: 1, missile: 0, bullet: 0, effect: 0 });
    pool.allocate('aircraft', 0);
    const buf = new Float64Array(SNAPSHOT_FLOATS);
    const hud = makeZeroHud();
    hud.iasMps = 999; // must be ignored since there is no player this tick
    writeSnapshot(pool, NO_ENTITY_ID, 1, 0, hud, buf);
    expect(buf[SnapshotHeader.PLAYER_INDEX_OFFSET]).toBe(-1);
    const hudBlockStart = HEADER_FLOATS + 400 * ENTITY_STRIDE;
    for (let f = 0; f < 27; f++) {
      expect(buf[hudBlockStart + f]).toBe(0);
    }
  });

  test('SNAPSHOT_FLOATS matches HEADER_FLOATS + MAX_ENTITIES*ENTITY_STRIDE + HUD_BLOCK_FLOATS', () => {
    expect(SNAPSHOT_FLOATS).toBe(HEADER_FLOATS + 400 * ENTITY_STRIDE + 28); // 28: SnapshotHud.TANK_FUEL_KG added for drop tanks
  });
});
