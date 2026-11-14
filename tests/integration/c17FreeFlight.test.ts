/**
 * tests/integration/c17FreeFlight.test.ts — Free Flight offers the C-17: every open base gives it a
 * runway and an air start (a Parked start only where the base has a transport stand), and on the
 * runway it rests on its gear and survives a few seconds of idle.
 */
import { describe, expect, test } from 'vitest';
import { SIM_DT_SEC, type PilotInputs } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld } from '../../src/core';
import { BASES, freeFlightMission, parkingSpotFor } from '../../src/core/missions/catalogue';

const calm = { windWorldMps: { x: 0, y: 0, z: 0 }, gustMps: 0, turbulence: 0 };
const open = BASES.filter((b) => !b.locked);

describe('C-17 in Free Flight', () => {
  test.each(open.map((b) => b.id))('%s: starts fly the C-17', (baseId) => {
    for (const start of ['runway', 'air'] as const) {
      const m = freeFlightMission(baseId, start, 'c-17');
      expect(m.playerStart.aircraftId).toBe('c-17');
    }
    const spot = parkingSpotFor(baseId, 'c-17');
    const parked = freeFlightMission(baseId, 'parked', 'c-17');
    if (spot) expect(parked.playerStart.parkingSpotId).toBe(spot);
    else expect(parked.playerStart.parkingSpotId).toBeUndefined();
    // The Tejas keeps its shelter.
    expect(freeFlightMission(baseId, 'parked').playerStart.parkingSpotId).toBe(BASES.find((b) => b.id === baseId)!.parkingSpotId);
  });

  test.each(open.map((b) => b.id))('%s: runway start rests on the gear', (baseId) => {
    const mission = { ...freeFlightMission(baseId, 'runway', 'c-17'), weather: calm };
    const deps = buildWorldDependencies(mission);
    const world = createWorld(deps);
    world.loadMission(mission);
    const id = world.getPlayerEntityId();
    const inputs: PilotInputs = {
      pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 1, gearDown: true, airbrake: false,
      trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, nwsEnabled: true,
    };
    for (let i = 0; i < Math.round(3 / SIM_DT_SEC); i++) {
      world.setPlayerInput(id, inputs);
      world.stepOnce();
    }
    const s = world.getEntityState(id);
    expect(s).toBeDefined();
    expect(s!.alive).toBe(true);
    const agl = s!.pos.y - deps.sampler.heightAt(s!.pos.x, s!.pos.z);
    expect(agl).toBeGreaterThan(0);
    expect(agl).toBeLessThan(8);
  });
});
