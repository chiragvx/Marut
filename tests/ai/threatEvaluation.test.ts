import { describe, it, expect } from 'vitest';
import type { Contact, PilotContext } from '../../src/contracts/core';
import { AiDifficultyProfiles } from '../../src/contracts/ai';
import { scoreThreatContact, selectTarget } from '../../src/ai/threatEvaluation';
import { computeAspectAngleRad } from '../../src/ai/formation';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 2,
    team: 1,
    kind: 'aircraft',
    pos: { x: 0, y: 5000, z: 5000 },
    vel: { x: 0, y: 0, z: -100 },
    rangeM: 5000,
    bearingRad: 0,
    elevationRad: 0,
    closureMps: 0,
    detectedBy: 'radar',
    identified: true,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PilotContext> = {}): PilotContext {
  return {
    self: {
      id: 1,
      kind: 'aircraft',
      team: 0,
      pos: { x: 0, y: 5000, z: 0 },
      rot: { x: 0, y: 0, z: 0, w: 1 },
      vel: { x: 0, y: 0, z: 0 },
      omega: { x: 0, y: 0, z: 0 },
      alive: true,
      hp: 100,
      fuelKg: 1000,
      elevonL: 0,
      elevonR: 0,
      rudder: 0,
      gearPos: 0,
      throttle: 0.5,
      afterburnerOn: false,
      flags: 0,
    },
    selfDamage: {
      structurePct: 1,
      engineHealthPct: 1,
      controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
      hydraulicsOk: true,
      fuelLeak: false,
      radarHealthPct: 1,
      gearHealthPct: 1,
    },
    telemetry: {
      iasMps: 200,
      tasMps: 200,
      mach: 0.5,
      altMslM: 5000,
      altAglM: 5000,
      alphaRad: 0,
      betaRad: 0,
      gLoad: 1,
      headingRad: 0,
      pitchRad: 0,
      rollRad: 0,
      vspeedMps: 0,
      fuelKg: 1000,
      fuelFrac: 0.7,
      thrustFrac: 0.5,
      onGround: false,
      stalled: false,
    },
    contacts: [],
    combat: {
      selectedWeapon: 'gun',
      ammoGun: 200,
      missilesIr: 2,
      missilesRadar: 2,
      lockState: 'none',
      lockedTargetId: undefined,
      rwrWarning: false,
      missileInboundWarning: false,
      aimPointWorld: { x: 0, y: 0, z: 0 },
      aimPointValid: false,
    },
    sampler: { seed: 1, heightAt: () => 0, normalAt: (_x, _z, out) => ({ ...out, x: 0, y: 1, z: 0 }) },
    navDb: { getAirport: () => undefined, listAirports: () => [], nearestAirport: () => undefined, getRunway: () => undefined },
    windWorldMps: { x: 0, y: 0, z: 0 },
    simTimeSec: 0,
    ...overrides,
  };
}

describe('scoreThreatContact', () => {
  it('matches the worked example', () => {
    const ctx = makeCtx();
    const contact = makeContact({
      pos: { x: 0, y: 6500, z: 5000 }, // 1500 above self, 5000 south (so bearing-to-self is due north)
      vel: { x: 0, y: 0, z: -100 }, // heading 0 (north) -> pointed straight at self -> aspect 0
      rangeM: 5000,
      closureMps: 100,
    });
    const score = scoreThreatContact(ctx, contact, AiDifficultyProfiles.veteran);
    expect(score).toBeCloseTo(7.428571, 3);
  });
});

describe('computeAspectAngleRad', () => {
  it('head-on: observed pointed straight back at observer gives 0', () => {
    const result = computeAspectAngleRad(Math.PI, { x: 0, y: 0, z: -1000 }, { x: 0, y: 0, z: 0 });
    expect(result).toBeCloseTo(0, 6);
  });

  it('tail-on: observed heading away from observer gives +-PI', () => {
    const result = computeAspectAngleRad(0, { x: 0, y: 0, z: -1000 }, { x: 0, y: 0, z: 0 });
    expect(Math.abs(result)).toBeCloseTo(Math.PI, 6);
  });
});

describe('selectTarget', () => {
  const difficulty = AiDifficultyProfiles.veteran;

  it('keeps the current target when the score gap is under the hysteresis threshold', () => {
    const current = makeContact({ id: 10, rangeM: 6000, pos: { x: 0, y: 5000, z: 6000 }, vel: { x: 0, y: 0, z: 0 } });
    const better = makeContact({ id: 11, rangeM: 1000, pos: { x: 0, y: 5000, z: 6000 }, vel: { x: 0, y: 0, z: 0 } });
    const target = selectTarget(makeCtx(), [current, better], 10, difficulty);
    expect(target?.id).toBe(10);
  });

  it('switches once the score gap exceeds the hysteresis threshold', () => {
    const current = makeContact({ id: 10, rangeM: 10000, pos: { x: 0, y: 5000, z: 6000 }, vel: { x: 0, y: 0, z: 0 } });
    const better = makeContact({ id: 11, rangeM: 0, pos: { x: 0, y: 5000, z: 6000 }, vel: { x: 0, y: 0, z: 0 } });
    const target = selectTarget(makeCtx(), [current, better], 10, difficulty);
    expect(target?.id).toBe(11);
  });

  it('never returns an unidentified contact, even as the only / highest-scoring one', () => {
    const contact = makeContact({ id: 20, identified: false, rangeM: 100 });
    const target = selectTarget(makeCtx(), [contact], undefined, difficulty);
    expect(target).toBeUndefined();
  });

  it('never returns a friendly (same-team) contact', () => {
    const contact = makeContact({ id: 21, team: 0, identified: true, rangeM: 100 });
    const target = selectTarget(makeCtx(), [contact], undefined, difficulty);
    expect(target).toBeUndefined();
  });
});
