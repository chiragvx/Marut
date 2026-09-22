import { describe, it, expect } from 'vitest';
import type { Contact, PilotContext, PilotInputs } from '../../src/contracts/core';
import { AiDifficultyProfiles } from '../../src/contracts/ai';
import { estimateWeaponEnvelope, decideWeaponEmployment, createWeaponEmploymentState } from '../../src/ai/weaponEmployment';
import { createPrng } from '../../src/math';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 5,
    team: 1,
    kind: 'aircraft',
    pos: { x: 0, y: 0, z: -500 },
    vel: { x: 0, y: 0, z: 0 },
    rangeM: 500,
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
      pos: { x: 0, y: 0, z: 0 },
      rot: { x: 0, y: 0, z: 0, w: 1 },
      vel: { x: 0, y: 0, z: 200 },
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
      mach: 0.6,
      altMslM: 3000,
      altAglM: 3000,
      alphaRad: 0,
      betaRad: 0,
      gLoad: 1,
      headingRad: 0,
      pitchRad: 0,
      rollRad: 0,
      vspeedMps: 0,
      fuelKg: 1000,
      fuelFrac: 0.7,
      thrustFrac: 0.7,
      onGround: false,
      stalled: false,
    },
    contacts: [],
    combat: {
      selectedWeapon: 'ir_missile',
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

function makeOut(): PilotInputs {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0,
    afterburner: false,
    brakes: 0,
    gearDown: false,
    airbrake: false,
    trigger: false,
    launch: false,
    cycleWeapon: false,
    cycleTarget: false,
  };
}

describe('estimateWeaponEnvelope', () => {
  it('gun: in envelope at 500m range and ~2.86 deg lead-bearing offset', () => {
    const bearingRad = 0.05;
    const range = 500;
    const target = makeContact({
      rangeM: range,
      pos: { x: range * Math.sin(bearingRad), y: 0, z: -range * Math.cos(bearingRad) },
      vel: { x: 0, y: 0, z: 0 },
    });
    const est = estimateWeaponEnvelope(makeCtx(), 'gun', target);
    expect(est.inEnvelope).toBe(true);
  });

  it('gun: out of envelope beyond max range', () => {
    const target = makeContact({ rangeM: 1000, pos: { x: 0, y: 0, z: -1000 }, vel: { x: 0, y: 0, z: 0 } });
    const est = estimateWeaponEnvelope(makeCtx(), 'gun', target);
    expect(est.inEnvelope).toBe(false);
  });

  it('radar missile requires a full lock, not just tracking', () => {
    const target = makeContact({ rangeM: 10000 });
    const trackingCtx = makeCtx({ combat: { ...makeCtx().combat, lockState: 'tracking' } });
    const lockedCtx = makeCtx({ combat: { ...makeCtx().combat, lockState: 'locked' } });
    expect(estimateWeaponEnvelope(trackingCtx, 'radar_missile', target).inEnvelope).toBe(false);
    expect(estimateWeaponEnvelope(lockedCtx, 'radar_missile', target).inEnvelope).toBe(true);
  });
});

describe('decideWeaponEmployment launch cooldown', () => {
  it('blocks a second launch at the same target inside the cooldown window, allows it after', () => {
    const target = makeContact({ id: 5, rangeM: 3000, bearingRad: 0 }); // within IR envelope
    const state = createWeaponEmploymentState();
    const rng = createPrng(1);
    const difficulty = AiDifficultyProfiles.veteran;

    const out1 = makeOut();
    decideWeaponEmployment(makeCtx({ simTimeSec: 10 }), target, difficulty, 5, 1 / 120, state, rng, out1);
    expect(out1.launch).toBe(true);
    expect(state.lastLaunchSimTimeSec).toBe(10);

    const out2 = makeOut();
    decideWeaponEmployment(makeCtx({ simTimeSec: 11 }), target, difficulty, 5, 1 / 120, state, rng, out2);
    expect(out2.launch).toBe(false);

    const out3 = makeOut();
    decideWeaponEmployment(makeCtx({ simTimeSec: 13.1 }), target, difficulty, 5, 1 / 120, state, rng, out3);
    expect(out3.launch).toBe(true);
  });
});
