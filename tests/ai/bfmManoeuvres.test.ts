import { describe, it, expect } from 'vitest';
import type { Contact, PilotContext } from '../../src/contracts/core';
import { AiDifficultyProfiles, BfmManoeuvre, TacticalState } from '../../src/contracts/ai';
import type { FlightGoal } from '../../src/contracts/ai';
import { selectBfmManoeuvre, buildBfmGoal, createJinkState } from '../../src/ai/bfmManoeuvres';
import { createPrng } from '../../src/math';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 2,
    team: 1,
    kind: 'aircraft',
    pos: { x: 0, y: 3000, z: 3000 },
    vel: { x: 0, y: 0, z: 0 },
    rangeM: 1000,
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
      pos: { x: 0, y: 3000, z: 0 },
      rot: { x: 0, y: 0, z: 0, w: 1 },
      vel: { x: 200, y: 0, z: 0 },
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

function makeGoal(): FlightGoal {
  return { pitchMode: 'g_load', desiredGLoad: 1, desiredAltitudeM: 0, desiredBankRad: 0, desiredSpeedMps: 0, gearDown: false, airbrake: false };
}

describe('selectBfmManoeuvre offensive selection', () => {
  const difficulty = AiDifficultyProfiles.veteran;

  it('HighYoYo when far off-boresight, close, and closing', () => {
    const target = makeContact({ bearingRad: 1.65, rangeM: 500, closureMps: 10 });
    const ctx = makeCtx();
    const result = selectBfmManoeuvre(ctx, target, TacticalState.Bfm, difficulty, undefined, 0);
    expect(result).toBe(BfmManoeuvre.HighYoYo);
  });

  it('LowYoYo when tight angle-off, energy-deficient, and close', () => {
    const selfEnergyHeightM = 3000 + (200 * 200) / (2 * 9.80665);
    const target = makeContact({
      bearingRad: 0.2,
      rangeM: 800,
      pos: { x: 0, y: selfEnergyHeightM + 200, z: 3000 },
      vel: { x: 0, y: 0, z: 0 },
    });
    const ctx = makeCtx();
    const result = selectBfmManoeuvre(ctx, target, TacticalState.Bfm, difficulty, undefined, 0);
    expect(result).toBe(BfmManoeuvre.LowYoYo);
  });
});

describe('buildBfmGoal', () => {
  it('PurePursuit uses raw BASE_PURSUIT_G_LOAD, unscaled by bfmSkillMultiplier', () => {
    const target = makeContact({ bearingRad: 0.5, elevationRad: 0 });
    const out = makeGoal();
    const result = buildBfmGoal(makeCtx(), target, BfmManoeuvre.PurePursuit, AiDifficultyProfiles.rookie, out);
    expect(result.desiredBankRad).toBeCloseTo(0.65, 6);
    expect(result.desiredGLoad).toBeCloseTo(3.0, 6);
  });

  it('LeadPursuit offsets the bearing before applying the bank gain', () => {
    const target = makeContact({ bearingRad: 0.3, elevationRad: 0 });
    const out = makeGoal();
    const result = buildBfmGoal(makeCtx(), target, BfmManoeuvre.LeadPursuit, AiDifficultyProfiles.veteran, out);
    expect(result.desiredBankRad).toBeCloseTo(0.730339, 5);
  });
});

describe('Jink determinism', () => {
  it('two independent identically-seeded PRNG streams produce bit-identical, non-constant sequences', () => {
    const target = makeContact();
    const ctx = makeCtx();
    const rngA = createPrng(42);
    const rngB = createPrng(42);
    const jinkA = createJinkState();
    const jinkB = createJinkState();
    const seqA: number[] = [];
    const seqB: number[] = [];

    for (let tick = 0; tick < 200; tick++) {
      const t = tick * (1 / 120);
      const outA = buildBfmGoal(ctx, target, BfmManoeuvre.Jink, AiDifficultyProfiles.veteran, makeGoal(), rngA, t, jinkA);
      const outB = buildBfmGoal(ctx, target, BfmManoeuvre.Jink, AiDifficultyProfiles.veteran, makeGoal(), rngB, t, jinkB);
      seqA.push(outA.desiredBankRad);
      seqB.push(outB.desiredBankRad);
    }

    expect(seqA).toEqual(seqB);
    expect(new Set(seqA).size).toBeGreaterThan(1);
  });
});

describe('selectBfmManoeuvre hysteresis', () => {
  const difficulty = AiDifficultyProfiles.veteran;

  it('holds the previous manoeuvre under the dwell time even as inputs straddle a threshold', () => {
    const ctx = makeCtx();
    let previous: ReturnType<typeof selectBfmManoeuvre> = BfmManoeuvre.LeadPursuit;
    for (let tick = 0; tick < 100; tick++) {
      const rangeM = tick % 2 === 0 ? 590 : 610;
      const target = makeContact({ bearingRad: 1.65, rangeM, closureMps: 10 });
      const timeInManoeuvreSec = tick * (1 / 120);
      const result = selectBfmManoeuvre(ctx, target, TacticalState.Bfm, difficulty, previous, timeInManoeuvreSec);
      if (timeInManoeuvreSec < 1.0) {
        expect(result).toBe(BfmManoeuvre.LeadPursuit);
      }
      previous = result;
    }
  });

  it('a missile-warning Notch fires immediately, bypassing the dwell gate', () => {
    const ctx = makeCtx({ combat: { ...makeCtx().combat, missileInboundWarning: true } });
    const target = makeContact();
    const result = selectBfmManoeuvre(ctx, target, TacticalState.Defensive, difficulty, BfmManoeuvre.LeadPursuit, 0.01);
    expect(result).toBe(BfmManoeuvre.Notch);
  });
});
