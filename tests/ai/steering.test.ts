import { describe, it, expect } from 'vitest';
import type { AircraftTelemetry, EntityState, PilotContext, PilotInputs } from '../../src/contracts/core';
import { EntityFlag } from '../../src/contracts/core';
import type { FlightGoal } from '../../src/contracts/ai';
import { PitchMode } from '../../src/contracts/ai';
import { createSteerToGoal } from '../../src/ai/steering';

function makeTelemetry(overrides: Partial<AircraftTelemetry> = {}): AircraftTelemetry {
  return {
    iasMps: 230,
    tasMps: 230,
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
    ...overrides,
  };
}

function makeSelf(overrides: Partial<EntityState> = {}): EntityState {
  return {
    id: 1,
    kind: 'aircraft',
    team: 0,
    pos: { x: 0, y: 3000, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 230, y: 0, z: 0 },
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

function makeCtx(overrides: Partial<PilotContext> = {}): PilotContext {
  return {
    self: makeSelf(),
    selfDamage: {
      structurePct: 1,
      engineHealthPct: 1,
      controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
      hydraulicsOk: true,
      fuelLeak: false,
      radarHealthPct: 1,
      gearHealthPct: 1,
    },
    telemetry: makeTelemetry(),
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
    sampler: {
      seed: 1,
      heightAt: () => 0,
      normalAt: (_x, _z, out) => {
        out.x = 0;
        out.y = 1;
        out.z = 0;
        return out;
      },
    },
    navDb: {
      getAirport: () => undefined,
      listAirports: () => [],
      nearestAirport: () => undefined,
      getRunway: () => undefined,
    },
    windWorldMps: { x: 0, y: 0, z: 0 },
    simTimeSec: 0,
    ...overrides,
  };
}

function makeGoal(overrides: Partial<FlightGoal> = {}): FlightGoal {
  return {
    pitchMode: PitchMode.GLoad,
    desiredGLoad: 1,
    desiredAltitudeM: 0,
    desiredBankRad: 0,
    desiredSpeedMps: 0,
    throttleOverride: undefined,
    afterburnerOverride: undefined,
    gearDown: false,
    airbrake: false,
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

describe('steerToGoal', () => {
  it('bank proportional term', () => {
    const steer = createSteerToGoal();
    const ctx = makeCtx({ telemetry: makeTelemetry({ rollRad: 0 }) });
    const goal = makeGoal({ desiredBankRad: 0.349066 });
    const out = makeOut();
    steer(ctx, goal, 1 / 120, out);
    expect(out.roll).toBeCloseTo(0.767945, 3);
  });

  it('bank rate damping term', () => {
    const steer = createSteerToGoal();
    const ctx = makeCtx({ self: makeSelf({ omega: { x: 0.5, y: 0, z: 0 } }), telemetry: makeTelemetry({ rollRad: 0 }) });
    const goal = makeGoal({ desiredBankRad: 0 });
    const out = makeOut();
    steer(ctx, goal, 1 / 120, out);
    expect(out.roll).toBeCloseTo(-0.175, 6);
  });

  it('g_load pitch term', () => {
    const steer = createSteerToGoal();
    const ctx = makeCtx({ telemetry: makeTelemetry({ gLoad: 1 }) });
    const goal = makeGoal({ pitchMode: PitchMode.GLoad, desiredGLoad: 4 });
    const out = makeOut();
    steer(ctx, goal, 1 / 120, out);
    expect(out.pitch).toBeCloseTo(0.36, 6);
  });

  it('altitude_hold pitch term', () => {
    const steer = createSteerToGoal();
    const ctx = makeCtx({ telemetry: makeTelemetry({ altMslM: 2500, pitchRad: 0, alphaRad: 0.05 }) });
    const goal = makeGoal({ pitchMode: PitchMode.AltitudeHold, desiredAltitudeM: 3000 });
    const out = makeOut();
    steer(ctx, goal, 1 / 120, out);
    expect(out.pitch).toBeCloseTo(0.449066, 3);
  });

  it('yaw coordination term', () => {
    const steer = createSteerToGoal();
    const ctx = makeCtx({ telemetry: makeTelemetry({ betaRad: 0.1 }) });
    const goal = makeGoal();
    const out = makeOut();
    steer(ctx, goal, 1 / 120, out);
    expect(out.yaw).toBeCloseTo(0.14, 6);
  });

  it('speed hold P+bias term (worked example, isolated from the integral via dtSec=0)', () => {
    // 06-ai.md section 4.3's worked example ("integral starts at 0 ...
    // out.throttle = clamp(0.5 + 0.008*20 + 0, 0, 1) = 0.66") is evaluating
    // the P+bias terms with a zero integral CONTRIBUTION, not literally the
    // first call at some nonzero dtSec (the pseudocode's own
    // `speedIntegral += speedErrorMps * dtSec` runs before the iTerm is
    // read, so any dtSec > 0 makes iTerm strictly nonzero on the very first
    // call). dtSec=0 isolates exactly the P+bias terms the example checks;
    // the dt-accumulating integral itself is exercised by the next test.
    const steer = createSteerToGoal();
    const ctx = makeCtx({ telemetry: makeTelemetry({ iasMps: 230 }) });
    const goal = makeGoal({ desiredSpeedMps: 250 });
    const out = makeOut();
    steer(ctx, goal, 0, out);
    expect(out.throttle).toBeCloseTo(0.66, 6);
  });

  it('speed hold integral accumulates over real dt', () => {
    const steer = createSteerToGoal();
    const ctx = makeCtx({ telemetry: makeTelemetry({ iasMps: 230 }) });
    const goal = makeGoal({ desiredSpeedMps: 250 });
    const out = makeOut();
    const dtSec = 1 / 120;
    steer(ctx, goal, dtSec, out);
    const expectedITerm = 0.0015 * (20 * dtSec);
    expect(out.throttle).toBeCloseTo(0.66 + expectedITerm, 9);
  });

  it('bank command saturates at +-1', () => {
    const steer = createSteerToGoal();
    const ctx = makeCtx({ telemetry: makeTelemetry({ rollRad: -2.0 }) });
    const goal = makeGoal({ desiredBankRad: 0 });
    const out = makeOut();
    steer(ctx, goal, 1 / 120, out);
    expect(out.roll).toBe(1);
  });

  it('throttleOverride bypasses the speed loop and resets the integral without a discontinuity', () => {
    const steer = createSteerToGoal();
    const ctx = makeCtx({ telemetry: makeTelemetry({ iasMps: 230 }) });
    const out = makeOut();

    // Build up some integral first.
    for (let i = 0; i < 50; i++) steer(ctx, makeGoal({ desiredSpeedMps: 250 }), 1 / 120, out);

    steer(ctx, makeGoal({ throttleOverride: 0.3 }), 1 / 120, out);
    expect(out.throttle).toBe(0.3);

    // Remove the override: next tick's throttle should be close to the
    // bias+P term alone (integral was reset to 0), not jump wildly.
    steer(ctx, makeGoal({ desiredSpeedMps: 250 }), 1 / 120, out);
    const expectedNoIntegral = 0.5 + 0.008 * 20;
    expect(Math.abs(out.throttle - expectedNoIntegral)).toBeLessThan(0.01);
  });

  it('writes gear/airbrake and grounded brakes', () => {
    const steer = createSteerToGoal();
    const ctx = makeCtx({ self: makeSelf({ flags: EntityFlag.OnGround }) });
    const goal = makeGoal({ gearDown: true, airbrake: true, desiredSpeedMps: 2 });
    const out = makeOut();
    steer(ctx, goal, 1 / 120, out);
    expect(out.gearDown).toBe(true);
    expect(out.airbrake).toBe(true);
    expect(out.brakes).toBe(1);
  });
});
