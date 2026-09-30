import { describe, expect, it } from 'vitest';
import { NO_ENTITY_ID, SNAPSHOT_FLOATS } from '../../src/contracts/core';
import type { SnapshotEntityView, SnapshotHudView } from '../../src/contracts/sim';
import { createEntityPool } from '../../src/core/entityPool';
import { writeSnapshot } from '../../src/core/snapshotWriter';
import { readSnapshotEntity, readSnapshotHeader, readSnapshotHud } from '../../src/core/snapshotReader';

function makeHud(): SnapshotHudView {
  return {
    iasMps: 123.4, tasMps: 130, mach: 0.4, altMslM: 5000, altAglM: 4500, aoaRad: 0.05, betaRad: -0.01,
    gLoad: 1.2, headingRad: 1.5, pitchRad: 0.1, rollRad: -0.2, vspeedMps: 3, fuelKg: 2000, thrustFrac: 0.6,
    gearPos: 0, weaponIdx: 1, selectedStore: 4, selectedCount: 2, gunRounds: 180, chaff: 12, flares: 8, agMode: 1, ccipX: 10, ccipY: 20, ccipZ: 30, spiX: 1, spiY: 2, spiZ: 3, spiValid: 1, agTimeSec: 4.5, agCrossM: -12, podFlags: 3, podX: 7, podY: 8, podZ: 9, podFovDeg: 5, podRangeM: 9000, dlz: 2, targetId: 7, targetRangeM: 4000, closureMps: 50, lockState: 2,
    warningBits: 5, ilsLoc: 0.1, ilsGs: -0.1, pipperX: 10, pipperY: 20, pipperZ: 30, pipperValid: 1, tankFuelKg: 1500, serviceState: 2, serviceFuelFrac: 0.5, serviceArmFrac: 0.25, radarMode: 1, radarMaxRangeM: 200000, radarScanAzRad: 1, trackCount: 1, tracks: Float64Array.from({ length: 256 }, (_, k) => (k < 8 ? k + 1 : 0)),
  };
}

function emptyEntityView(): SnapshotEntityView {
  return {
    id: NO_ENTITY_ID, kind: 'aircraft', team: 0, pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 }, alive: false, hp: 0, fuelKg: 0, elevonL: 0,
    elevonR: 0, rudder: 0, gearPos: 0, throttle: 0, afterburnerOn: false, flags: 0,
  };
}

describe('snapshot write/read round-trip', () => {
  it('header + entity + hud all round-trip exactly', () => {
    const pool = createEntityPool({ aircraft: 2, missile: 0, bullet: 0, effect: 0 });
    const id0 = pool.allocate('aircraft', 0);
    const id1 = pool.allocate('aircraft', 1);
    const s0 = pool.get(id0);
    if (!s0) throw new Error('unreachable');
    s0.pos.x = 10;
    s0.pos.y = 20;
    s0.pos.z = 30;
    s0.rot.w = 0.5;
    s0.vel.x = 100;
    s0.omega.z = 0.3;
    s0.elevonL = 0.05;
    s0.afterburnerOn = true;
    s0.flags = 7;

    const buf = new Float64Array(SNAPSHOT_FLOATS);
    writeSnapshot(pool, id0, 99, 12.5, makeHud(), buf);

    const header = readSnapshotHeader(buf);
    expect(header.tick).toBe(99);
    expect(header.simTimeSec).toBe(12.5);
    expect(header.entityCount).toBe(2);
    expect(header.playerIndex).toBe(0);

    const view = emptyEntityView();
    readSnapshotEntity(buf, 0, view);
    expect(view.id).toBe(id0);
    expect(view.pos).toEqual({ x: 10, y: 20, z: 30 });
    expect(view.rot.w).toBe(0.5);
    expect(view.vel.x).toBe(100);
    expect(view.omega.z).toBeCloseTo(0.3, 12);
    expect(view.elevonL).toBeCloseTo(0.05, 12);
    expect(view.afterburnerOn).toBe(true);
    expect(view.flags).toBe(7);

    const view1 = emptyEntityView();
    readSnapshotEntity(buf, 1, view1);
    expect(view1.id).toBe(id1);

    const hudView: SnapshotHudView = makeHud();
    readSnapshotHud(buf, hudView);
    expect(hudView.iasMps).toBeCloseTo(123.4, 12);
    expect(hudView.targetId).toBe(7);
    expect(hudView.lockState).toBe(2);
    expect(hudView.pipperValid).toBe(1);
    expect(hudView.tankFuelKg).toBe(1500);
    expect(hudView.serviceState).toBe(2);
    expect(hudView.serviceFuelFrac).toBe(0.5);
    expect(hudView.serviceArmFrac).toBe(0.25);
    expect(hudView.radarMode).toBe(1);
    expect(hudView.trackCount).toBe(1);
    expect(Array.from(hudView.tracks.slice(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
