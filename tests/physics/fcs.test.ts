import { describe, it, expect } from 'vitest';
import { stepFcs, computeGCommand, getTrimIntegralRad, resetFcsTrimState, entityPoolIndex, type FcsSurfaces } from '../../src/physics/fcs';
import { rateLimitStep } from '../../src/math';
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

// Regression coverage for the "controls are very sensitive" fix: a snapped full stick input used
// to feed instantly into computeGCommand/pCmd with zero onset shaping, producing a classic
// underdamped step-response overshoot (live-measured: a full pull crossed the commanded +8.0g
// ceiling then overshot to +9.49g, +18.6%, before settling). FCS_STICK_SHAPE_RATE_PER_SEC now
// rate-limits the raw stick itself before it reaches any of the control laws — these tests pin
// that the onset is genuinely gradual (not instant) and that the STEADY-STATE command is
// unchanged once fully ramped, i.e. no control authority is permanently lost.
describe('pitch/roll stick command shaping (quadruplex FBW onset limiting)', () => {
  it('a snapped full-pitch input does NOT saturate the elevon on the very first substep (previously it would have)', () => {
    const index = entityPoolIndex(300);
    resetFcsTrimState(index);
    const surfaces: FcsSurfaces = { elevonL: 0, elevonR: 0, rudder: 0 };
    const limits = makeFcsLimits({ maxGLoadPos: 9, maxElevonRad: 2, gLoadGain: 1 });

    stepFcs(index, surfaces, false, false, 0, ZERO3, ZERO3, IDENTITY, 10000, 9.80665, makeInputs({ pitch: 1 }), makeDamage(), limits, 1 / 120);

    // Old (unshaped) behaviour: computeGCommand(1, limits)=9, elevonSymCmd clamps straight to
    // maxElevonRad=2 -- i.e. full saturation on tick one. The shaped stick has only reached
    // 2.0*(1/120)=1/60 of full deflection by this point, so the command is nowhere near that.
    expect(Math.abs(surfaces.elevonL)).toBeLessThan(limits.maxElevonRad * 0.3);
  });

  it('a snapped full-roll input does NOT reach maxRollRateRadS worth of demand on the very first substep', () => {
    const index = entityPoolIndex(301);
    resetFcsTrimState(index);
    const surfaces: FcsSurfaces = { elevonL: 0, elevonR: 0, rudder: 0 };
    const limits = makeFcsLimits({ maxRollRateRadS: 5, rollRateGain: 1, maxElevonRad: 2 });

    stepFcs(index, surfaces, false, false, 0, ZERO3, ZERO3, IDENTITY, 10000, 9.80665, makeInputs({ roll: 1 }), makeDamage(), limits, 1 / 120);

    // Old (unshaped): pCmd=inputs.roll*maxRollRateRadS=5 directly, elevonDiffCmd clamps to
    // maxElevonRad=2 immediately (full aileron authority on tick one).
    const elevonDiffCmd = surfaces.elevonL - surfaces.elevonR;
    expect(Math.abs(elevonDiffCmd)).toBeLessThan(limits.maxElevonRad * 0.3);
  });

  it('steady-state (after the ~0.5s onset has fully ramped) reaches the same full authority a raw stick command always could -- no permanent authority loss, only a slower onset', () => {
    // Note: there is no longer a way to construct a genuinely "unshaped" call to compare
    // against -- the shaping in stepFcs applies unconditionally to every call now, which is the
    // whole point (every input device gets it, not just keyboard's own separate ramp). So this
    // asserts against the known analytic ceiling (computeGCommand(1,limits)=9g, clamped by
    // maxElevonRad=2) instead of a same-call comparison.
    const index = entityPoolIndex(302);
    resetFcsTrimState(index);
    const surfaces: FcsSurfaces = { elevonL: 0, elevonR: 0, rudder: 0 };
    const limits = makeFcsLimits({ maxGLoadPos: 9, maxElevonRad: 2, gLoadGain: 1, maxElevonRateRadS: 1000 }); // fast actuator so it isn't the binding constraint here
    const dt = 1 / 120;

    // Run well past FCS_STICK_SHAPE_RATE_PER_SEC's 0.5s full-scale ramp time.
    for (let i = 0; i < 120; i++) {
      stepFcs(index, surfaces, false, false, 0, ZERO3, ZERO3, IDENTITY, 10000, 9.80665, makeInputs({ pitch: 1 }), makeDamage(), limits, dt);
    }

    expect(surfaces.elevonL).toBeCloseTo(limits.maxElevonRad, 1); // fully saturated (9g commanded >> 2rad authority) once the ramp has converged
  });

  it('resetFcsTrimState zeroes the shaped-stick state so a recycled pool slot does not inherit a previous occupant\'s ramp position', () => {
    const index = entityPoolIndex(304);
    const surfaces: FcsSurfaces = { elevonL: 0, elevonR: 0, rudder: 0 };
    const limits = makeFcsLimits({ maxGLoadPos: 9, maxElevonRad: 2, gLoadGain: 1 });
    // Ramp it up first.
    for (let i = 0; i < 60; i++) {
      stepFcs(index, surfaces, false, false, 0, ZERO3, ZERO3, IDENTITY, 10000, 9.80665, makeInputs({ pitch: 1 }), makeDamage(), limits, 1 / 120);
    }
    expect(Math.abs(surfaces.elevonL)).toBeGreaterThan(limits.maxElevonRad * 0.3); // partway ramped by now

    resetFcsTrimState(index);
    surfaces.elevonL = 0;
    surfaces.elevonR = 0;
    stepFcs(index, surfaces, false, false, 0, ZERO3, ZERO3, IDENTITY, 10000, 9.80665, makeInputs({ pitch: 1 }), makeDamage(), limits, 1 / 120);
    // Back to a fresh, near-zero onset -- same bound as the very-first-substep test above.
    expect(Math.abs(surfaces.elevonL)).toBeLessThan(limits.maxElevonRad * 0.3);
  });

  it('rateLimitStep itself (already used elsewhere in this module for actuator slewing) behaves as this fix assumes: 0.5s to go 0->1 at rate 2.0/s', () => {
    let v = 0;
    for (let i = 0; i < 60; i++) v = rateLimitStep(v, 1, 2.0, 1 / 120); // 60 steps @ 1/120s = 0.5s
    expect(v).toBeCloseTo(1, 5);
  });
});
