/**
 * tests/combat/storeSelection.test.ts — the pilot selects weapons by store type: two radar missiles
 * (Astra, Derby) are separate selections, and a store that runs out hands over to another of its kind.
 */
import { describe, expect, it } from 'vitest';
import { createWeaponsState, cycleSelectedStore, fireWeapons, writeCombatStatus } from '../../src/combat';
import { ASRAAM, ASTRA_MK1, DERBY, GENERIC_GUN_PROFILE } from '../../src/catalog';
import type { DetectableEntity, ProjectileSpawnRequest, WeaponsLoadout } from '../../src/contracts/combat';
import { LockState, type CombatStatus, type DamageState, type EntityState, type PilotInputs, type SimEvent } from '../../src/contracts/core';

const loadout: WeaponsLoadout = {
  stations: [
    { hardpointId: 'gun', posBodyM: { x: 3, y: 0, z: 0 }, weapon: 'gun', maxCount: 220, profile: GENERIC_GUN_PROFILE },
    { hardpointId: 'outer-l', posBodyM: { x: -2, y: 0, z: -3 }, weapon: 'ir_missile', maxCount: 2, profile: ASRAAM },
    { hardpointId: 'mid-l', posBodyM: { x: -2, y: 0, z: -2 }, weapon: 'radar_missile', maxCount: 1, profile: ASTRA_MK1 },
    { hardpointId: 'mid-r', posBodyM: { x: -2, y: 0, z: 2 }, weapon: 'radar_missile', maxCount: 1, profile: ASTRA_MK1 },
    { hardpointId: 'inner-l', posBodyM: { x: -1, y: 0, z: -1 }, weapon: 'radar_missile', maxCount: 1, profile: DERBY },
  ],
};

const shooter: EntityState = {
  id: 1, kind: 'aircraft', team: 0, pos: { x: 0, y: 5000, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 250, y: 0, z: 0 },
  omega: { x: 0, y: 0, z: 0 }, alive: true, hp: 100, fuelKg: 1000, elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 1, afterburnerOn: false, flags: 0,
};
const damage: DamageState = {
  structurePct: 1, engineHealthPct: 1, controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 }, hydraulicsOk: true, fuelLeak: false, radarHealthPct: 1, gearHealthPct: 1,
};
const target: DetectableEntity = { id: 9, team: 1, kind: 'aircraft', pos: { x: 20000, y: 5000, z: 0 }, vel: { x: -250, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, alive: true };
const launch = (on: boolean): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 1, afterburner: false, brakes: 0, gearDown: false, airbrake: false, trigger: false, launch: on, cycleWeapon: false, cycleTarget: false,
});

describe('store selection', () => {
  it('cycles gun -> ASRAAM -> Astra -> Derby -> gun, each store type once', () => {
    const s = createWeaponsState(loadout, 1);
    const seen = [s.selectedStoreId];
    for (let i = 0; i < 4; i++) {
      cycleSelectedStore(s);
      seen.push(s.selectedStoreId);
    }
    expect(seen).toEqual(['gsh-23', 'asraam', 'astra-mk1', 'derby', 'gsh-23']);
    cycleSelectedStore(s);
    expect(s.selectedWeapon).toBe('ir_missile');
  });

  it('fires the selected store, reports its count, and moves on to the Derby when the Astras are gone', () => {
    const s = createWeaponsState(loadout, 1);
    cycleSelectedStore(s);
    cycleSelectedStore(s);
    expect(s.selectedStoreId).toBe('astra-mk1');
    s.lockState = LockState.Locked;
    s.lockedTargetId = target.id;
    const status = { aimPointWorld: { x: 0, y: 0, z: 0 } } as CombatStatus;
    writeCombatStatus(s, status);
    expect(status.selectedStoreId).toBe('astra-mk1');
    expect(status.selectedStoreCount).toBe(2);

    const fired: string[] = [];
    for (let i = 0; i < 6; i++) {
      const req: ProjectileSpawnRequest[] = [];
      const ev: SimEvent[] = [];
      fireWeapons(1, shooter, damage, target, launch(true), s, i, 1 / 120, req, ev);
      fireWeapons(1, shooter, damage, target, launch(false), s, i, 1 / 120, req, ev);
      for (const r of req) fired.push(r.profile!.id);
    }
    expect(fired).toEqual(['astra-mk1', 'astra-mk1', 'derby']);
    writeCombatStatus(s, status);
    expect(status.selectedStoreId).toBe('derby');
    expect(status.selectedStoreCount).toBe(0);
    expect(status.missilesRadar).toBe(0);
    expect(status.missilesIr).toBe(2);
  });
});
