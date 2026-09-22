import { describe, it, expect } from 'vitest';
import { computeMissileThreat, updateSensors, createWeaponsState } from '../../src/combat';
import type { DetectableEntity, WeaponsLoadout } from '../../src/contracts/combat';
import type { Contact, HeightSampler, PilotInputs, SimEvent } from '../../src/contracts/core';

describe('computeMissileThreat (RWR)', () => {
  it('matches the 07-combat.md section 4.11 worked example', () => {
    const result = computeMissileThreat({ x: 0, y: 0, z: 0 }, { x: 3000, y: 0, z: 0 }, { x: -400, y: 0, z: 0 });
    expect(result.tCaSec).toBeCloseTo(7.5, 6);
    expect(result.missDistanceM).toBeCloseTo(0, 9);
    expect(result.isThreat).toBe(true);
  });
});

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const NO_TERRAIN_SAMPLER: HeightSampler = {
  seed: 0,
  heightAt: () => -1_000_000,
  normalAt: (_x, _z, out) => { out.x = 0; out.y = 1; out.z = 0; return out; },
};
const NO_INPUTS: PilotInputs = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 0, gearDown: false, airbrake: false,
  trigger: false, launch: false, cycleWeapon: false, cycleTarget: false,
};

describe('updateSensors missileInboundWarning', () => {
  it('reproduces the worked example end-to-end and sets missileInboundWarning=true', () => {
    const observer: DetectableEntity = { id: 1, team: 0, kind: 'aircraft', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: IDENTITY, alive: true };
    const inboundMissile: DetectableEntity = { id: 5, team: 1, kind: 'missile', pos: { x: 3000, y: 0, z: 0 }, vel: { x: -400, y: 0, z: 0 }, rot: IDENTITY, alive: true };
    const loadout: WeaponsLoadout = { stations: [{ hardpointId: 'gun', posBodyM: { x: 3, y: 0, z: 0 }, weapon: 'gun', maxCount: 220 }] };
    const state = createWeaponsState(loadout, 7);
    const damage = { structurePct: 1, engineHealthPct: 1, controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 }, hydraulicsOk: true, fuelLeak: false, radarHealthPct: 1, gearHealthPct: 1 };
    const outContacts: Contact[] = [];
    const outEvents: SimEvent[] = [];

    updateSensors(1, observer, damage, 1000, NO_INPUTS, [observer, inboundMissile], NO_TERRAIN_SAMPLER, state, 0, 1 / 120, outContacts, outEvents);

    expect(state.missileInboundWarning).toBe(true);
    expect(outEvents.some((e) => e.type === 'warning' && e.bit !== undefined)).toBe(true);
  });
});
