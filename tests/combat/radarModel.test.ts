import { describe, it, expect } from 'vitest';
import { radarDetectionRangeM, computeGeometry, updateSensors, createWeaponsState } from '../../src/combat';
import type { DetectableEntity, WeaponsLoadout } from '../../src/contracts/combat';
import type { HeightSampler, PilotInputs } from '../../src/contracts/core';

describe('radarDetectionRangeM', () => {
  it('matches the three tabulated cases from 07-combat.md section 4.4 (within 5 m, per section 7)', () => {
    expect(Math.abs(radarDetectionRangeM(2.0) - 63624)).toBeLessThanOrEqual(5);
    expect(Math.abs(radarDetectionRangeM(6.0) - 83730)).toBeLessThanOrEqual(5);
    expect(radarDetectionRangeM(5.0)).toBe(80000);
  });
});

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const NO_TERRAIN_SAMPLER: HeightSampler = {
  seed: 0,
  heightAt: () => -1_000_000,
  normalAt: (_x, _z, out) => { out.x = 0; out.y = 1; out.z = 0; return out; },
};

describe('computeGeometry (scan/track cone worked example)', () => {
  it('matches the 07-combat.md section 4.4 worked example: az=0.1974, in scan cone, not in track cone', () => {
    // Observer heading = PI/2 (due east) => rot = identity (architecture.md worked example A).
    const observer: DetectableEntity = { id: 1, team: 0, kind: 'aircraft', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: IDENTITY, alive: true };
    const target: DetectableEntity = { id: 2, team: 1, kind: 'aircraft', pos: { x: 500, y: 0, z: 100 }, vel: { x: 0, y: 0, z: 0 }, rot: IDENTITY, alive: true };

    const geom = computeGeometry(observer, target, NO_TERRAIN_SAMPLER);

    expect(geom.azRad).toBeCloseTo(0.1974, 4);
    expect(geom.inScanCone).toBe(true);
    expect(geom.inTrackCone).toBe(false);
  });
});

describe('computeGeometry notch (target ground-relative radial velocity, look-down only)', () => {
  const ac = (id: number, pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }): DetectableEntity => ({
    id, team: id === 1 ? 0 : 1, kind: 'aircraft', pos, vel, rot: IDENTITY, alive: true,
  });

  it('does not notch a co-speed tail chase (relative closure ~0)', () => {
    const observer = ac(1, { x: 0, y: 3000, z: 0 }, { x: 250, y: 0, z: 0 });
    const target = ac(2, { x: 5000, y: 3000, z: 0 }, { x: 250, y: 0, z: 0 });
    const geom = computeGeometry(observer, target, NO_TERRAIN_SAMPLER);
    expect(Math.abs(geom.closureMps)).toBeLessThan(1);
    expect(geom.isNotched).toBe(false);
  });

  it('notches a target beaming across the line of sight below the observer', () => {
    const observer = ac(1, { x: 0, y: 5000, z: 0 }, { x: 250, y: 0, z: 0 });
    const target = ac(2, { x: 8000, y: 2000, z: 0 }, { x: 0, y: 0, z: 250 });
    expect(computeGeometry(observer, target, NO_TERRAIN_SAMPLER).isNotched).toBe(true);
  });

  it('does not notch the same beaming target when looking up (no ground clutter behind it)', () => {
    const observer = ac(1, { x: 0, y: 2000, z: 0 }, { x: 250, y: 0, z: 0 });
    const target = ac(2, { x: 8000, y: 5000, z: 0 }, { x: 0, y: 0, z: 250 });
    expect(computeGeometry(observer, target, NO_TERRAIN_SAMPLER).isNotched).toBe(false);
  });
});

function makeWeaponsState() {
  const loadout: WeaponsLoadout = {
    stations: [
      { hardpointId: 'gun', posBodyM: { x: 3, y: 0, z: 0 }, weapon: 'gun', maxCount: 220 },
      { hardpointId: 'p1', posBodyM: { x: -1, y: 0, z: -3 }, weapon: 'radar_missile', maxCount: 4 },
    ],
  };
  return createWeaponsState(loadout, 42);
}

const NO_INPUTS: PilotInputs = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 0, gearDown: false, airbrake: false,
  trigger: false, launch: false, cycleWeapon: false, cycleTarget: false,
};

describe('updateSensors', () => {
  it('populates a Contact for a nearby aircraft with the expected bearing', () => {
    const observer: DetectableEntity = { id: 1, team: 0, kind: 'aircraft', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: IDENTITY, alive: true };
    const target: DetectableEntity = { id: 2, team: 1, kind: 'aircraft', pos: { x: 500, y: 0, z: 100 }, vel: { x: 0, y: 0, z: 0 }, rot: IDENTITY, alive: true };
    const state = makeWeaponsState();
    const outContacts: import('../../src/contracts/core').Contact[] = [];
    const outEvents: import('../../src/contracts/core').SimEvent[] = [];
    const damage = { structurePct: 1, engineHealthPct: 1, controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 }, hydraulicsOk: true, fuelLeak: false, radarHealthPct: 1, gearHealthPct: 1 };

    updateSensors(1, observer, damage, 1000, NO_INPUTS, [observer, target], NO_TERRAIN_SAMPLER, state, 0, 1 / 120, outContacts, outEvents);

    expect(outContacts.length).toBe(1);
    expect(outContacts[0]!.id).toBe(2);
    expect(outContacts[0]!.bearingRad).toBeCloseTo(0.1974, 4);
  });
});
