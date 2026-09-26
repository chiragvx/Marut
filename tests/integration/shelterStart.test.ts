/**
 * tests/integration/shelterStart.test.ts — starting parked on a parking spot (inside a hardened
 * shelter): the player spawns on the spot, nose out, on its wheels, and sits still at idle.
 */
import { describe, expect, test } from 'vitest';
import type { PilotInputs } from '../../src/contracts/core';
import { EntityFlag, SIM_DT_SEC } from '../../src/contracts/core';
import type { AirportLayout } from '../../src/contracts/airport';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';

describe('shelter start (border-free: Bhisiana, HAS-7)', () => {
  test('spawns on the spot, stationary and on the ground, and stays put with brakes at idle', () => {
    const mission = resolveBuiltinMission('border-free');
    const layout = (mission.world.airports as readonly AirportLayout[]).find((a) => a.id === 'bhisiana-afs')!;
    const spot = layout.parkingSpots.find((p) => p.id === 'HAS-7')!;
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const id = world.getPlayerEntityId();
    const s0 = world.getEntityState(id)!;
    expect(Math.hypot(s0.pos.x - spot.worldX, s0.pos.z - spot.worldZ)).toBeLessThan(0.5);
    expect(Math.hypot(s0.vel.x, s0.vel.y, s0.vel.z)).toBe(0);
    const idle: PilotInputs = {
      pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 1, gearDown: true,
      airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false,
    };
    for (let t = 0; t < 5 / SIM_DT_SEC; t++) {
      world.setPlayerInput(id, idle);
      world.stepOnce();
    }
    const s = world.getEntityState(id)!;
    expect(s.alive).toBe(true);
    expect(s.flags & EntityFlag.OnGround).toBeTruthy();
    expect(Math.hypot(s.pos.x - spot.worldX, s.pos.z - spot.worldZ)).toBeLessThan(1);
    expect(Math.abs(s.pos.y - layout.elevationM)).toBeLessThan(3);
  });
});
