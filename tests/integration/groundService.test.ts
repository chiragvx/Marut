/**
 * tests/integration/groundService.test.ts — refuelling and re-arming on a friendly stand (through
 * the real World): the prompt appears only when stopped on a stand and something needs servicing;
 * the service key refits drop tanks, fills the fuel and reloads the weapons; nothing at a hostile base.
 */
import { describe, expect, test } from 'vitest';
import type { PilotInputs } from '../../src/contracts/core';
import { HUD_BLOCK_START, SIM_DT_SEC, SNAPSHOT_FLOATS, ServiceStateCode, SnapshotHud } from '../../src/contracts/core';
import type { AirportLayout } from '../../src/contracts/airport';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';

const idle = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 1, gearDown: true,
  airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...over,
});

function setup() {
  const mission = resolveBuiltinMission('border-free');
  const world = createWorld(buildWorldDependencies(mission));
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const snap = new Float64Array(SNAPSHOT_FLOATS);
  const hud = (field: number): number => {
    world.writeSnapshot(snap);
    return snap[HUD_BLOCK_START + field]!;
  };
  const run = (sec: number, inputs: PilotInputs): void => {
    for (let t = 0; t < sec / SIM_DT_SEC; t++) {
      world.setPlayerInput(id, inputs);
      world.stepOnce();
    }
  };
  return { mission, world, id, hud, run };
}

describe('ground service at Bhisiana (shelter HAS-7)', () => {
  test('a full aircraft gets no prompt', () => {
    const { hud, run } = setup();
    run(1, idle());
    expect(hud(SnapshotHud.SERVICE_STATE)).toBe(ServiceStateCode.None);
  });

  test('R refits the tanks, refuels and reloads the gun; the HUD shows progress then completion', () => {
    const { world, id, hud, run } = setup();
    // Use it up: fire the gun, burn fuel, lose the tanks.
    run(2, idle({ trigger: true }));
    const s = world.getEntityState(id)!;
    s.fuelKg = 300;
    s.dropTankCount = 0;
    s.dropTankFuelKg = 0;
    const gunBefore = world.getCombatStatus(id)!.ammoGun;
    run(0.5, idle());
    expect(hud(SnapshotHud.SERVICE_STATE)).toBe(ServiceStateCode.Available);
    run(0.2, idle({ requestService: true }));
    run(5, idle());
    expect(hud(SnapshotHud.SERVICE_STATE)).toBe(ServiceStateCode.Servicing);
    expect(world.getEntityState(id)!.dropTankCount).toBeGreaterThan(0);
    const mid = hud(SnapshotHud.SERVICE_FUEL_FRAC);
    expect(mid).toBeGreaterThan(0.1);
    expect(mid).toBeLessThan(0.9);
    run(45, idle());
    expect(hud(SnapshotHud.SERVICE_STATE)).toBe(ServiceStateCode.Complete);
    expect(hud(SnapshotHud.SERVICE_FUEL_FRAC)).toBeGreaterThan(0.99);
    expect(world.getCombatStatus(id)!.ammoGun).toBeGreaterThan(gunBefore);
    expect(world.getEntityState(id)!.dropTankFuelKg!).toBeGreaterThan(0);
  });

  test('opening the throttle stops the service', () => {
    const { world, id, hud, run } = setup();
    world.getEntityState(id)!.fuelKg = 300;
    run(0.5, idle());
    run(0.2, idle({ requestService: true }));
    run(2, idle());
    expect(hud(SnapshotHud.SERVICE_STATE)).toBe(ServiceStateCode.Servicing);
    run(0.5, idle({ throttle: 0.6, brakes: 0 }));
    expect(hud(SnapshotHud.SERVICE_STATE)).toBe(ServiceStateCode.None);
  });

  test('no service at the hostile base', () => {
    const { mission, world, id, hud, run } = setup();
    const shahbaz = (mission.world.airports as readonly AirportLayout[]).find((a) => a.id === 'pafb-shahbaz')!;
    const spot = shahbaz.parkingSpots[0]!;
    const s = world.getEntityState(id)!;
    s.pos.x = spot.worldX;
    s.pos.z = spot.worldZ;
    s.fuelKg = 300;
    run(1, idle());
    run(0.2, idle({ requestService: true }));
    run(2, idle());
    expect(hud(SnapshotHud.SERVICE_STATE)).toBe(ServiceStateCode.None);
    expect(world.getEntityState(id)!.fuelKg).toBeLessThan(310);
  });
});
