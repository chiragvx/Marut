import { describe, it, expect } from 'vitest';
import type { Contact, PilotContext } from '../../src/contracts/core';
import { AiDifficultyProfiles, TacticalState } from '../../src/contracts/ai';
import {
  evaluateTacticalTransition,
  buildGoalForEngageBvr,
  buildGoalForMerge,
  buildGoalForDisengage,
} from '../../src/ai/tacticalFsm';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 2,
    team: 1,
    kind: 'aircraft',
    pos: { x: 0, y: 3000, z: -3000 },
    vel: { x: 0, y: 0, z: 100 },
    rangeM: 3000,
    bearingRad: 0,
    elevationRad: 0,
    closureMps: 50,
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
    sampler: { seed: 1, heightAt: () => -10000, normalAt: (_x, _z, out) => ({ ...out, x: 0, y: 1, z: 0 }) },
    navDb: { getAirport: () => undefined, listAirports: () => [], nearestAirport: () => undefined, getRunway: () => undefined },
    windWorldMps: { x: 0, y: 0, z: 0 },
    simTimeSec: 0,
    ...overrides,
  };
}

const difficulty = AiDifficultyProfiles.veteran;

describe('evaluateTacticalTransition', () => {
  it('rule 1: missile warning noticed -> Defensive, ignoring dwell', () => {
    const ctx = makeCtx();
    const result = evaluateTacticalTransition(ctx, TacticalState.Patrol, 0.01, difficulty, true, true);
    expect(result).toBe(TacticalState.Defensive);
  });

  it('dwell blocks an otherwise-valid transition until MIN_STATE_DWELL_SEC elapses', () => {
    // rangeM=6000 > ENGAGE_BVR_MIN_RANGE_M(5000) so rule 9 (Intercept) is the
    // eventual match once the dwell timer clears.
    const ctx = makeCtx({ contacts: [makeContact({ rangeM: 6000 })] });
    const early = evaluateTacticalTransition(ctx, TacticalState.Patrol, 0.5, difficulty, true, false);
    expect(early).toBe(TacticalState.Patrol);
    const late = evaluateTacticalTransition(ctx, TacticalState.Patrol, 1.6, difficulty, true, false);
    expect(late).toBe(TacticalState.Intercept);
  });

  it('rule 8 (BVR) takes priority over rule 9 (Intercept) when a radar shot is ready', () => {
    const ctx = makeCtx({
      contacts: [makeContact({ rangeM: 9000 })],
      combat: { ...makeCtx().combat, lockState: 'locked', missilesRadar: 2 },
    });
    const result = evaluateTacticalTransition(ctx, TacticalState.Patrol, 2.0, difficulty, true, false);
    expect(result).toBe(TacticalState.EngageBvr);
  });

  it('rule 9 (Intercept) when no radar shot is ready and range is beyond BVR-engage minimum', () => {
    const ctx = makeCtx({ contacts: [makeContact({ rangeM: 9000 })] });
    const result = evaluateTacticalTransition(ctx, TacticalState.Patrol, 2.0, difficulty, true, false);
    expect(result).toBe(TacticalState.Intercept);
  });

  it('rule 2: fuel-critical -> Disengage, ignoring dwell', () => {
    const ctx = makeCtx({ telemetry: { ...makeCtx().telemetry, fuelFrac: 0.2 } });
    const result = evaluateTacticalTransition(ctx, TacticalState.Bfm, 0.01, difficulty, true, false);
    expect(result).toBe(TacticalState.Disengage);
  });

  it('rule 2 also fires from a long Intercept even though rule 9 would otherwise match', () => {
    const ctx = makeCtx({
      telemetry: { ...makeCtx().telemetry, fuelFrac: 0.2 },
      contacts: [makeContact({ rangeM: 9000 })],
    });
    const result = evaluateTacticalTransition(ctx, TacticalState.Intercept, 40, difficulty, true, false);
    expect(result).toBe(TacticalState.Disengage);
  });

  it('rule 7: no candidate -> Patrol', () => {
    const ctx = makeCtx({ contacts: [] });
    const result = evaluateTacticalTransition(ctx, TacticalState.Intercept, 5, difficulty, true, false);
    expect(result).toBe(TacticalState.Patrol);
  });

  it('rule 10: Merge inside VISUAL_MANOEUVRE_RANGE_M..ENGAGE_BVR_MIN_RANGE_M', () => {
    const ctx = makeCtx({ contacts: [makeContact({ rangeM: 2500 })] });
    const result = evaluateTacticalTransition(ctx, TacticalState.Intercept, 5, difficulty, true, false);
    expect(result).toBe(TacticalState.Merge);
  });

  it('rule 11: Defensive when the nearby contact has a threatening (nose-on) aspect', () => {
    // Contact heading straight at self (north, from south of self).
    const ctx = makeCtx({
      contacts: [makeContact({ rangeM: 1000, pos: { x: 0, y: 3000, z: 3000 }, vel: { x: 0, y: 0, z: -50 } })],
    });
    const result = evaluateTacticalTransition(ctx, TacticalState.Merge, 5, difficulty, true, false);
    expect(result).toBe(TacticalState.Defensive);
  });

  it('rule 12: Bfm otherwise, close range and non-threatening aspect', () => {
    // Contact flying away from self (heading matches bearing away).
    const ctx = makeCtx({
      contacts: [makeContact({ rangeM: 1000, pos: { x: 0, y: 3000, z: -1000 }, vel: { x: 0, y: 0, z: -50 } })],
    });
    const result = evaluateTacticalTransition(ctx, TacticalState.Merge, 5, difficulty, true, false);
    expect(result).toBe(TacticalState.Bfm);
  });

  it('no home airport: resolveHomeRunway is undefined, so Rtb never transitions to Land', () => {
    const ctx = makeCtx({ contacts: [] });
    let state: TacticalState = TacticalState.Rtb;
    for (let i = 0; i < 20; i++) {
      state = evaluateTacticalTransition(ctx, state, 5, difficulty, true, false, undefined, undefined);
    }
    expect(state).toBe(TacticalState.Rtb);
  });
});

describe('buildGoalForEngageBvr', () => {
  it('clamps the altitude band tighter than Intercept and holds a stable BVR speed', () => {
    const target = makeContact({ pos: { x: 0, y: 4500, z: -3000 }, bearingRad: 0.2 });
    const ctx = makeCtx();
    const out = { pitchMode: 'g_load' as const, desiredGLoad: 1, desiredAltitudeM: 0, desiredBankRad: 0, desiredSpeedMps: 0, gearDown: false, airbrake: false };
    const goal = buildGoalForEngageBvr(ctx, target, out);
    expect(goal.desiredAltitudeM).toBeCloseTo(ctx.telemetry.altMslM + 1000, 6);
    expect(goal.desiredSpeedMps).toBe(220);
  });
});

describe('buildGoalForMerge', () => {
  it('matches the worked example', () => {
    const target = makeContact({ bearingRad: 0.4 });
    const ctx = makeCtx();
    const out = { pitchMode: 'g_load' as const, desiredGLoad: 1, desiredAltitudeM: 0, desiredBankRad: 0, desiredSpeedMps: 0, gearDown: false, airbrake: false };
    const goal = buildGoalForMerge(ctx, target, out);
    expect(goal.desiredBankRad).toBeCloseTo(0.52, 6);
    expect(goal.desiredSpeedMps).toBe(280);
  });
});

describe('buildGoalForDisengage', () => {
  it('turns away from the threat bearing at full power', () => {
    const target = makeContact({ bearingRad: -0.7 });
    const ctx = makeCtx();
    const out = { pitchMode: 'g_load' as const, desiredGLoad: 1, desiredAltitudeM: 0, desiredBankRad: 0, desiredSpeedMps: 0, gearDown: false, airbrake: false };
    const goal = buildGoalForDisengage(ctx, target, out);
    expect(goal.desiredBankRad).toBeCloseTo(-0.349066, 6);
    expect(goal.throttleOverride).toBe(1.0);
    expect(goal.afterburnerOverride).toBe(true);
    expect(goal.desiredGLoad).toBe(1.0);
  });

  it('wings-level with no candidate at all', () => {
    const ctx = makeCtx();
    const out = { pitchMode: 'g_load' as const, desiredGLoad: 1, desiredAltitudeM: 0, desiredBankRad: 0, desiredSpeedMps: 0, gearDown: false, airbrake: false };
    const goal = buildGoalForDisengage(ctx, undefined, out);
    expect(goal.desiredBankRad).toBe(0);
  });
});
