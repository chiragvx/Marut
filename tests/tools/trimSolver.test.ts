/**
 * tests/tools/trimSolver.test.ts — FindTrim against a synthetic linear
 * aircraft with a closed-form trim solution. See docs/spec/12-verification.md
 * section 7. The synthetic aircraft/step function are local to this file
 * only (never part of tools/lib's own public surface), per that section's
 * own note.
 */
import { describe, expect, test } from 'vitest';
import type { StepAircraftLike, TrimCondition } from '../../src/contracts/verify';
import { TrimStatus, TRIM_RESIDUAL_TOLERANCE_MPS2 } from '../../src/contracts/verify';
import { GRAVITY_MPS2 } from '../../src/contracts/core';
import { Quat } from '../../src/math';
import { findTrim, makeTrimSeedState, isaAt } from '../../tools/lib/trimSolver';

interface SyntheticAircraftDef {
  liftSlopePerRad: number;
  dragK: number;
  cd0: number;
  wingAreaM2: number;
  massKg: number;
  thrustMaxN: number;
}

/** Commanded alpha per full stick deflection -- an arbitrary but fixed authority for this synthetic, closed-form-only aircraft. */
const SYNTHETIC_MAX_ALPHA_RAD = (25 * Math.PI) / 180;

/**
 * Closed-form point-mass step function: `out.rot`'s pitch is set directly to
 * the commanded alpha (heading/roll carried over unchanged from `state.rot`)
 * so that the generic alpha formula (00-architecture.md section 3.5, as used
 * by tools/lib/trimSolver.ts's `computeAlphaRad`) recovers exactly the
 * commanded alpha at trim -- this is what makes the closed-form check below
 * meaningful. Lift/drag/thrust are the standard flat-plate/parabolic-drag
 * point-mass equations; `def.massKg` here stands in for `condition.massKg`
 * (this synthetic aircraft has no separate concept of a variable test mass).
 */
const syntheticLinearStep: StepAircraftLike<SyntheticAircraftDef> = (state, _damage, inputs, env, def, dtSec, out) => {
  const ypr = { headingRad: 0, pitchRad: 0, rollRad: 0 };
  Quat.toYawPitchRoll(state.rot, ypr);

  const alphaRad = inputs.pitch * SYNTHETIC_MAX_ALPHA_RAD;
  const cl = def.liftSlopePerRad * alphaRad;
  const cd = def.cd0 + def.dragK * cl * cl;
  const speed = Math.hypot(state.vel.x, state.vel.y, state.vel.z);
  const q = 0.5 * env.airDensityKgM3 * speed * speed;
  const lift = cl * q * def.wingAreaM2;
  const drag = cd * q * def.wingAreaM2;
  const thrust = inputs.throttle * def.thrustMaxN;
  const forwardAccel = (thrust - drag) / def.massKg;
  const verticalAccel = (lift - def.massKg * env.gravityMps2) / def.massKg;
  const dir = speed > 1e-9 ? { x: state.vel.x / speed, y: 0, z: state.vel.z / speed } : { x: 0, y: 0, z: -1 };

  out.vel.x = state.vel.x + dir.x * forwardAccel * dtSec;
  out.vel.y = state.vel.y + verticalAccel * dtSec;
  out.vel.z = state.vel.z + dir.z * forwardAccel * dtSec;
  out.pos.x = state.pos.x + state.vel.x * dtSec;
  out.pos.y = state.pos.y + state.vel.y * dtSec;
  out.pos.z = state.pos.z + state.vel.z * dtSec;
  Quat.fromYawPitchRoll(ypr.headingRad, alphaRad, ypr.rollRad, out.rot);
  out.omega.x = 0;
  out.omega.y = 0;
  out.omega.z = 0;
  out.id = state.id;
  out.kind = state.kind;
  out.team = state.team;
  out.alive = state.alive;
  out.hp = state.hp;
  out.fuelKg = state.fuelKg;
  out.elevonL = 0;
  out.elevonR = 0;
  out.rudder = 0;
  out.gearPos = state.gearPos;
  out.throttle = inputs.throttle;
  out.afterburnerOn = inputs.afterburner;
  out.flags = state.flags;
};

function makeLevelSeedState(altitudeM: number, speedMps: number) {
  return makeTrimSeedState({ altitudeM, speedMps, bankRad: 0, massKg: 9500 });
}

describe('findTrim (synthetic linear aircraft)', () => {
  test('converges to the analytic closed-form solution', () => {
    const def: SyntheticAircraftDef = {
      liftSlopePerRad: 5.5,
      dragK: 0.06,
      cd0: 0.02,
      wingAreaM2: 38,
      massKg: 9500,
      thrustMaxN: 85000,
    };
    const condition: TrimCondition = { altitudeM: 5000, speedMps: 220, bankRad: 0, massKg: 9500 };
    const seed = makeLevelSeedState(5000, 220);
    const result = findTrim(syntheticLinearStep, def, condition, seed);

    expect(result.status).toBe(TrimStatus.Converged);
    expect(result.residualMps2).toBeLessThan(TRIM_RESIDUAL_TOLERANCE_MPS2);

    const rho = isaAt(5000).airDensityKgM3;
    const wN = def.massKg * GRAVITY_MPS2;
    const clAnalytic = (2 * wN) / (rho * 220 * 220 * def.wingAreaM2);
    const alphaAnalytic = clAnalytic / def.liftSlopePerRad;
    expect(result.alphaRad).toBeCloseTo(alphaAnalytic, 2);
  });

  test('pitchStick/throttle stay within their contractual bounds at convergence', () => {
    const def: SyntheticAircraftDef = {
      liftSlopePerRad: 5.5,
      dragK: 0.06,
      cd0: 0.02,
      wingAreaM2: 38,
      massKg: 9500,
      thrustMaxN: 85000,
    };
    const condition: TrimCondition = { altitudeM: 3000, speedMps: 200, bankRad: 0, massKg: 9500 };
    const seed = makeLevelSeedState(3000, 200);
    const result = findTrim(syntheticLinearStep, def, condition, seed);

    expect(result.pitchStick).toBeGreaterThanOrEqual(-1);
    expect(result.pitchStick).toBeLessThanOrEqual(1);
    expect(result.throttle).toBeGreaterThanOrEqual(0);
    expect(result.throttle).toBeLessThanOrEqual(1);
    expect(result.iterations).toBeGreaterThan(0);
  });

  test('an unreachable speed (thrust cannot possibly balance drag) does not falsely converge', () => {
    const def: SyntheticAircraftDef = {
      liftSlopePerRad: 5.5,
      dragK: 0.06,
      cd0: 0.02,
      wingAreaM2: 38,
      massKg: 9500,
      thrustMaxN: 1000, // far too little thrust for high-speed level flight
    };
    const condition: TrimCondition = { altitudeM: 0, speedMps: 500, bankRad: 0, massKg: 9500 };
    const seed = makeLevelSeedState(0, 500);
    const result = findTrim(syntheticLinearStep, def, condition, seed);

    expect(result.status).not.toBe(TrimStatus.Converged);
  });
});
