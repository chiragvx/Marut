import { describe, expect, it } from 'vitest';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { tejasDefinition } from '../../src/aircraft';

describe('drop tanks at spawn', () => {
  it('the player spawns with full drop tanks on the fuel_tank hardpoints; AI aircraft fly clean', () => {
    const mission = resolveBuiltinMission('dogfight-1v1');
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const playerId = world.getPlayerEntityId();
    const player = world.getEntityState(playerId)!;
    const tankHardpoints = tejasDefinition.hardpoints.filter((h) => h.type === 'fuel_tank').length;
    expect(player.dropTankCount).toBe(tankHardpoints);
    expect(player.dropTankFuelKg).toBe(tankHardpoints * tejasDefinition.dropTank!.capacityKg);
    // World exposes no entity listing on its public interface; its pool is the implementation's.
    const pool = (world as unknown as { pool: { liveCount: number; liveAt(i: number): { id: number; kind: string; dropTankCount?: number } } }).pool;
    let aiAircraft = 0;
    for (let i = 0; i < pool.liveCount; i++) {
      const s = pool.liveAt(i);
      if (s.id === playerId || s.kind !== 'aircraft') continue;
      aiAircraft++;
      expect(s.dropTankCount ?? 0).toBe(0);
    }
    expect(aiAircraft).toBeGreaterThan(0);
  });
});

describe('setPlayerInput', () => {
  it('forwards every PilotInputs field, including the optional ones', () => {
    const mission = resolveBuiltinMission('free-flight');
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const id = world.getPlayerEntityId();
    world.setPlayerInput(id, {
      pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 0, gearDown: true, airbrake: false,
      trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, jettisonTanks: true, alphaLimiterDisabled: true,
    });
    world.stepOnce();
    // Regression: both used to be dropped by the field-by-field copy (the Settings AoA-limiter
    // toggle never reached the sim, and tanks could not be jettisoned).
    expect(world.getEntityState(id)!.dropTankCount).toBe(0);
    const inputs = (world as unknown as { aircraft: Map<number, { inputs: { alphaLimiterDisabled?: boolean } }> }).aircraft.get(id)!.inputs;
    expect(inputs.alphaLimiterDisabled).toBe(true);
  });
});
