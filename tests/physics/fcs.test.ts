import { describe, it, expect } from 'vitest';
import { stepFcs, computeGCommand, getTrimIntegralRad, resetFcsTrimState, entityPoolIndex, type FcsSurfaces } from '../../src/physics/fcs';
import type { PilotInputs, DamageState } from '../../src/contracts/core';
import type { FcsLimits } from '../../src/contracts/aircraft';

function makeFcsLimits(overrides: Partial<FcsLimits> = {}): FcsLimits {
  return {
    maxAlphaRad: 0.3,
    minAlphaRad: -0.2,
    maxGLoadPos: 9,
    maxGLoadNeg: -3,
    maxRollRateRadS: 5,
    maxElevonRad: 2,
    maxRudderRad: 0.4,
    maxElevonRateRadS: 100,
    maxRudderRateRadS: 100,
    pitchRateGain: 0,
    rollRateGain: 0,
    yawRateGain: 0,
    alphaLimitGain: 2,
    gLoadGain: 1,
    ...overrides,
  };
}

function makeInputs(overrides: Partial<PilotInputs> = {}): PilotInputs {
  return {
    pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 0,
    gearDown: false, airbrake: false, trigger: false, launch: false,
    cycleWeapon: false, cycleTarget: false,
    ...overrides,
  };
}

function makeDamage(overrides: Partial<DamageState> = {}): DamageState {
  return {
    structurePct: 1, engineHealthPct: 1,
    controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
    hydraulicsOk: true, fuelLeak: false, radarHealthPct: 1, gearHealthPct: 1,
    ...overrides,
  };
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const ZERO3 = { x: 0, y: 0, z: 0 };

describe('computeGCommand', () => {
  it('stick centered (pitch=0) commands exactly 1g', () => {
    expect(computeGCommand(0, makeFcsLimits())).toBe(1.0);
  });
  it('full aft stick (pitch=1) commands exactly maxGLoadPos', () => {
    const limits = makeFcsLimits({ maxGLoadPos: 9 });
    expect(computeGCommand(1, limits)).toBe(9);
  });
  it('full forward stick (pitch=-1) commands exactly maxGLoadNeg', () => {
    const limits = makeFcsLimits({ maxGLoadNeg: -3 });
    expect(computeGCommand(-1, limits)).toBe(-3);
  });
});

describe('stepFcs', () => {
  it('alpha limiter reduces commanded elevon deflection vs. a fixture where alpha never crosses the limit', () => {
    const massKg = 10000;
    const g = 9.80665;
    const limits = makeFcsLimits({ alphaLimitGain: 2 });
    const alphaOverLimit = limits.maxAlphaRad + 0.1;

    const limited: FcsSurfaces = { elevonL: 0, elevonR: 0, rudder: 0 };
    stepFcs(0, limited, false, false, alphaOverLimit, ZERO3, ZERO3, IDENTITY, massKg, g, makeInputs({ pitch: 1 }), makeDamage(), limits, 1 / 120);

    // "Unlimited" reference: identical fixture, but alpha stays comfortably under the
    // limit so the alpha-limiter branch never engages (gCmd stays the raw stick command).
    const unlimited: FcsSurfaces = { elevonL: 0, elevonR: 0, rudder: 0 };
    stepFcs(1, unlimited, false, false, 0, ZERO3, ZERO3, IDENTITY, massKg, g, makeInputs({ pitch: 1 }), makeDamage(), limits, 1 / 120);

    expect(limited.elevonL).toBeLessThan(unlimited.elevonL);
  });

  it('hydraulics failure freezes the surfaces and resets the trim integral', () => {
    const index = entityPoolIndex(42);
    resetFcsTrimState(index);
    const surfaces: FcsSurfaces = { elevonL: 0.12, elevonR: 0.08, rudder: 0.03 };
    const before = { ...surfaces };

    stepFcs(index, surfaces, false, false, 0, ZERO3, ZERO3, IDENTITY, 10000, 9.80665, makeInputs({ pitch: 1 }), makeDamage({ hydraulicsOk: false }), makeFcsLimits(), 1 / 120);

    expect(surfaces).toEqual(before);
    expect(getTrimIntegralRad(index)).toBe(0);
  });

  it('trim integral resets to exactly 0 on a ground-contact transition (touchdown)', () => {
    const index = entityPoolIndex(43);
    resetFcsTrimState(index);
    const surfaces: FcsSurfaces = { elevonL: 0, elevonR: 0, rudder: 0 };
    // A few airborne steps to build up a nonzero trim integral.
    for (let i = 0; i < 5; i++) {
      stepFcs(index, surfaces, false, false, 0, ZERO3, { x: 0, y: -5000, z: 0 }, IDENTITY, 10000, 9.80665, makeInputs(), makeDamage(), makeFcsLimits({ gLoadGain: 0.3 }), 1 / 120);
    }
    expect(getTrimIntegralRad(index)).not.toBe(0);

    // Touchdown: currentOnGround=true, wasOnGroundAtEntry=false.
    stepFcs(index, surfaces, true, false, 0, ZERO3, ZERO3, IDENTITY, 10000, 9.80665, makeInputs(), makeDamage(), makeFcsLimits(), 1 / 120);
    expect(getTrimIntegralRad(index)).toBe(0);
  });

  it('trim integral resets to exactly 0 on a liftoff transition even though the substep is airborne', () => {
    const index = entityPoolIndex(44);
    resetFcsTrimState(index);
    const surfaces: FcsSurfaces = { elevonL: 0, elevonR: 0, rudder: 0 };
    for (let i = 0; i < 5; i++) {
      stepFcs(index, surfaces, false, false, 0, ZERO3, { x: 0, y: -5000, z: 0 }, IDENTITY, 10000, 9.80665, makeInputs(), makeDamage(), makeFcsLimits({ gLoadGain: 0.3 }), 1 / 120);
    }
    expect(getTrimIntegralRad(index)).not.toBe(0);

    // Liftoff: currentOnGround=false, wasOnGroundAtEntry=true => transitioned.
    stepFcs(index, surfaces, false, true, 0, ZERO3, ZERO3, IDENTITY, 10000, 9.80665, makeInputs(), makeDamage(), makeFcsLimits(), 1 / 120);
    expect(getTrimIntegralRad(index)).toBe(0);
  });

  it('trim-integral action closes a steady-state g error a low proportional gain alone would leave', () => {
    // Synthetic linear plant: gLoad = k * elevonSym (elevonL === elevonR, no roll/rudder channel).
    const index = entityPoolIndex(45);
    resetFcsTrimState(index);
    const massKg = 10000;
    const g = 9.80665;
    // Plant gain chosen for two constraints together: with
    // maxElevonRateRadS effectively unlimited relative to dt, the actuator
    // reaches its command almost exactly each step, making this a
    // near-instantaneous (zero-lag) plant, so the discrete P-loop's
    // step-to-step gain (gLoadGain*k) must stay under 1 to avoid
    // oscillating/diverging rather than settling; AND the elevonSym the
    // proportional term alone settles at (gLoadGain/(1+gLoadGain*k)) must
    // leave enough headroom under FCS_TRIM_INTEGRAL_MAX_RAD (0.2094 rad,
    // fcs.ts, non-FcsLimits-tunable) for the integral term to reach the
    // elevonSym (=1/k) that actually zeroes the error.
    const k = 30; // g per rad
    const limits = makeFcsLimits({ gLoadGain: 0.03233, pitchRateGain: 0, maxElevonRateRadS: 100, maxElevonRad: 2 });
    const inputs = makeInputs({ pitch: 0 }); // gCmd = 1
    const damage = makeDamage();
    const surfaces: FcsSurfaces = { elevonL: 0, elevonR: 0, rudder: 0 };
    const dt = 1 / 120;

    let elevonSym = 0;
    let gLoad = k * elevonSym;
    let gLoadAt2s = NaN;

    const totalSteps = 20 * 120;
    for (let step = 1; step <= totalSteps; step++) {
      const totalForceWorld = { x: 0, y: massKg * g * (gLoad - 1), z: 0 };
      stepFcs(index, surfaces, false, false, 0, ZERO3, totalForceWorld, IDENTITY, massKg, g, inputs, damage, limits, dt);
      elevonSym = (surfaces.elevonL + surfaces.elevonR) / 2;
      gLoad = k * elevonSym;
      if (step === 2 * 120) gLoadAt2s = gLoad;
    }

    // Proportional-only fixed point: gCmd*(Kg*k)/(1+Kg*k) with Kg*k≈0.97 is
    // still only ≈0.492 of gCmd (a >5% error) at t=2s, before the integral
    // term has had much time to act.
    expect(Math.abs(gLoadAt2s - 1.0) / 1.0).toBeGreaterThan(0.05);
    // The integral term closes it to within 1% by t=20s.
    expect(Math.abs(gLoad - 1.0) / 1.0).toBeLessThan(0.01);
  });
});
