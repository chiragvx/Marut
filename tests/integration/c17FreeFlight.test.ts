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
    // Parked or lined up at idle the spoilers stay down (lift dump only on a landing roll).
    expect(s!.spoilerPos ?? 0).toBeLessThan(0.01);
  });
});

/** Steps a Free Flight start for a few seconds at idle, brakes on; the player's state and height above the ground. */
function settle(mission: ReturnType<typeof freeFlightMission>, sec: number) {
  const m = { ...mission, weather: calm };
  const deps = buildWorldDependencies(m);
  const world = createWorld(deps);
  world.loadMission(m);
  const id = world.getPlayerEntityId();
  const onGround = m.playerStart.pos === undefined;
  const inputs: PilotInputs = {
    pitch: 0, roll: 0, yaw: 0, throttle: onGround ? 0 : 0.8, afterburner: false, brakes: onGround ? 1 : 0, gearDown: onGround, airbrake: false,
    trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, nwsEnabled: true,
  };
  for (let i = 0; i < Math.round(sec / SIM_DT_SEC); i++) {
    world.setPlayerInput(id, inputs);
    world.stepOnce();
  }
  const s = world.getEntityState(id)!;
  return { s, agl: s.pos.y - deps.sampler.heightAt(s.pos.x, s.pos.z) };
}

describe('Simikot in Free Flight', () => {
  test('is an open base', () => {
    const b = BASES.find((x) => x.id === 'simikot');
    expect(b).toBeDefined();
    expect(b!.locked).toBeFalsy();
  });

  test('no Parked start for the C-17 (no stand on the 40 m apron fits a 53 m jet); the Tejas parks', () => {
    expect(parkingSpotFor('simikot', 'c-17')).toBeUndefined();
    expect(freeFlightMission('simikot', 'parked', 'c-17').playerStart.parkingSpotId).toBeUndefined();
    // The other Himalaya bases still have room for it.
    expect(parkingSpotFor('fukche', 'c-17')).toBeDefined();
    const { s, agl } = settle(freeFlightMission('simikot', 'parked'), 3);
    expect(s.alive).toBe(true);
    expect(agl).toBeGreaterThan(0);
    expect(agl).toBeLessThan(4);
  });

  test.each(['tejas-mk1a', 'c-17'] as const)('%s: runway start rests on the gear at 2,971 m, spoilers down', (jet) => {
    const m = freeFlightMission('simikot', 'runway', jet);
    expect(m.playerStart.airportId).toBe('simikot');
    const { s, agl } = settle(m, 3);
    expect(s.alive).toBe(true);
    expect(s.pos.y).toBeGreaterThan(2971);
    expect(agl).toBeGreaterThan(0);
    expect(agl).toBeLessThan(8);
    expect(s.spoilerPos ?? 0).toBeLessThan(0.01);
  });

  test.each(['tejas-mk1a', 'c-17'] as const)('%s: air start on the runway 28 ravine approach, clear of the ridges', (jet) => {
    const m = freeFlightMission('simikot', 'air', jet);
    expect(m.playerStart.pos).toBeDefined();
    expect(m.playerStart.headingRad).toBeCloseTo(4.950078, 4);
    const { s, agl } = settle(m, 5);
    expect(s.alive).toBe(true);
    expect(agl).toBeGreaterThan(300);
  });
});
