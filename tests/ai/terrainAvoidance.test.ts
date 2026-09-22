import { describe, it, expect } from 'vitest';
import type { EntityState, PilotContext } from '../../src/contracts/core';
import { AiDifficultyProfiles } from '../../src/contracts/ai';
import { computeTerrainAvoidanceGoal } from '../../src/ai/terrainAvoidance';

function makeSelf(overrides: Partial<EntityState> = {}): EntityState {
  return {
    id: 1,
    kind: 'aircraft',
    team: 0,
    pos: { x: 0, y: 1000, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 250, y: 0, z: 0 },
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
    ...overrides,
  };
}

function makeCtx(heightAt: (x: number, z: number) => number, self: EntityState): PilotContext {
  return {
    self,
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
      iasMps: 250,
      tasMps: 250,
      mach: 0.7,
      altMslM: self.pos.y,
      altAglM: self.pos.y,
      alphaRad: 0,
      betaRad: 0,
      gLoad: 1,
      headingRad: Math.PI / 2,
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
    sampler: { seed: 1, heightAt, normalAt: (_x, _z, out) => ({ ...out, x: 0, y: 1, z: 0 }) },
    navDb: { getAirport: () => undefined, listAirports: () => [], nearestAirport: () => undefined, getRunway: () => undefined },
    windWorldMps: { x: 0, y: 0, z: 0 },
    simTimeSec: 0,
  };
}

const CLEAR_GROUND_Y = -5000; // always far below -> always clear

describe('computeTerrainAvoidanceGoal', () => {
  it('uses 16 samples at 250 m/s horizontal speed', () => {
    let calls = 0;
    const self = makeSelf({ vel: { x: 250, y: 0, z: 0 } });
    const ctx = makeCtx((_x, _z) => {
      calls++;
      return CLEAR_GROUND_Y;
    }, self);
    computeTerrainAvoidanceGoal(ctx, { pitchMode: 'g_load', desiredGLoad: 1, desiredAltitudeM: 0, desiredBankRad: 0, desiredSpeedMps: 0, gearDown: false, airbrake: false }, 1 / 120, AiDifficultyProfiles.veteran);
    expect(calls).toBe(16);
  });

  it('uses 5 samples at 60 m/s horizontal speed', () => {
    let calls = 0;
    const self = makeSelf({ vel: { x: 60, y: 0, z: 0 } });
    const ctx = makeCtx((_x, _z) => {
      calls++;
      return CLEAR_GROUND_Y;
    }, self);
    computeTerrainAvoidanceGoal(ctx, { pitchMode: 'g_load', desiredGLoad: 1, desiredAltitudeM: 0, desiredBankRad: 0, desiredSpeedMps: 0, gearDown: false, airbrake: false }, 1 / 120, AiDifficultyProfiles.veteran);
    expect(calls).toBe(5);
  });

  it('returns undefined over clear terrain', () => {
    const self = makeSelf();
    const ctx = makeCtx(() => CLEAR_GROUND_Y, self);
    const result = computeTerrainAvoidanceGoal(ctx, { pitchMode: 'g_load', desiredGLoad: 1, desiredAltitudeM: 0, desiredBankRad: 0, desiredSpeedMps: 0, gearDown: false, airbrake: false }, 1 / 120, AiDifficultyProfiles.veteran);
    expect(result).toBeUndefined();
  });

  it('detects a narrow ridge that the old fixed 5-sample scheme would alias past', () => {
    // Old fixed-5-sample scheme at 250 m/s samples x = 0, 375, 750, 1125, 1500
    // (spacing ~375m). A ridge centered at x=300 with half-width 50 (spans
    // 250..350) falls between the old scheme's x=0 and x=375 samples, so the
    // old scheme sees clear terrain at both flanks and misses it entirely.
    // The new adaptive scheme (16 samples, 100m spacing: x=0,100,200,...,1500)
    // samples exactly x=300, landing inside the ridge.
    const self = makeSelf({ pos: { x: 0, y: 1000, z: 0 }, vel: { x: 250, y: 0, z: 0 } });
    const ctx = makeCtx((x, _z) => {
      if (Math.abs(x - 300) <= 50) return 900; // 100m clearance < MIN_CLEARANCE_M(150)
      return CLEAR_GROUND_Y;
    }, self);
    const result = computeTerrainAvoidanceGoal(ctx, { pitchMode: 'g_load', desiredGLoad: 1, desiredAltitudeM: 0, desiredBankRad: 0, desiredSpeedMps: 0, gearDown: false, airbrake: false }, 1 / 120, AiDifficultyProfiles.veteran);
    expect(result).toBeDefined();
  });

  it('hard minimum clearance commands max commanded g and afterburner', () => {
    const self = makeSelf({ vel: { x: 250, y: 0, z: 0 }, pos: { x: 0, y: 1000, z: 0 } });
    const ctx = makeCtx(() => 1000 - 50, self); // 50m clearance < HARD_MIN_CLEARANCE_M(60)
    const result = computeTerrainAvoidanceGoal(ctx, { pitchMode: 'g_load', desiredGLoad: 1, desiredAltitudeM: 0, desiredBankRad: 0, desiredSpeedMps: 0, gearDown: false, airbrake: false }, 1 / 120, AiDifficultyProfiles.veteran)!;
    expect(result.desiredGLoad).toBe(AiDifficultyProfiles.veteran.maxCommandedGLoad);
    expect(result.afterburnerOverride).toBe(true);
  });

  it('soft minimum clearance commands 70% max g and no afterburner', () => {
    const self = makeSelf({ vel: { x: 250, y: 0, z: 0 }, pos: { x: 0, y: 1000, z: 0 } });
    const ctx = makeCtx(() => 1000 - 100, self); // 100m clearance: HARD(60) <= 100 < MIN(150)
    const result = computeTerrainAvoidanceGoal(ctx, { pitchMode: 'g_load', desiredGLoad: 1, desiredAltitudeM: 0, desiredBankRad: 0, desiredSpeedMps: 0, gearDown: false, airbrake: false }, 1 / 120, AiDifficultyProfiles.veteran)!;
    expect(result.desiredGLoad).toBeCloseTo(AiDifficultyProfiles.veteran.maxCommandedGLoad * 0.7, 6);
    expect(result.afterburnerOverride).toBe(false);
  });
});
