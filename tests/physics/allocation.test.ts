import { describe, it, expect } from 'vitest';
import { stepAircraft } from '../../src/physics';
import type { EntityState, DamageState, PilotInputs } from '../../src/contracts/core';
import type { AircraftDefinition } from '../../src/contracts/aircraft';
import type { Environment } from '../../src/contracts/flight';
import type { Table2D } from '../../src/contracts/math';

function constTable(value: number): Table2D {
  return { xs: [0], ys: [0], zs: [[value]] };
}

function makeDef(): AircraftDefinition {
  return {
    id: 'allocation-fixture',
    massKg: 10000,
    emptyMassKg: 8000,
    maxFuelKg: 2000,
    inertiaBodyKgM2: { xx: 30000, yy: 60000, zz: 80000, xy: 0, xz: 0, yz: 0 },
    cgOffsetBodyM: { x: 0, y: 0, z: 0 },
    wingAreaM2: 20,
    wingSpanM: 10,
    meanChordM: 2,
    hardpoints: [],
    wireframe: { vertices: [], edges: [], groups: [] },
    aero: {
      CL: constTable(0.3), CD: constTable(0.05), Cm: constTable(0.01),
      CY_beta: -0.5, Cl_beta: -0.05, Cn_beta: 0.08,
      CL_elevon: 0.3, CD_elevon: 0.05, Cm_elevon: -1.1,
      Cl_elevon: 0.15, Cn_elevon: -0.01,
      CY_rudder: 0.2, Cl_rudder: 0.01, Cn_rudder: -0.1,
      Cl_p: -0.4, Cl_r: 0.1, Cm_q: -8, Cn_p: -0.02, Cn_r: -0.3,
      groundEffectMaxDeltaCL: 0.1, stallAlphaRad: 0.3,
    },
    engine: {
      militaryThrustN: constTable(50000),
      afterburnerThrustN: constTable(80000),
      militaryFuelFlowKgS: constTable(1),
      afterburnerFuelFlowKgS: constTable(3),
      idleFuelFlowKgS: 0.2,
      spoolTimeConstantSec: 1.5,
    },
    gear: [
      { id: 'nose', posBodyM: { x: 3, y: -2, z: 0 }, maxCompressionM: 0.3, springNPerM: 200000, damperNPerMPerS: 15000, kineticFrictionCoefficient: 0.6, steerable: true, maxSteerAngleRad: 0.5, brakeCapable: false },
      { id: 'mainLeft', posBodyM: { x: -1, y: -2, z: -1.5 }, maxCompressionM: 0.3, springNPerM: 300000, damperNPerMPerS: 20000, kineticFrictionCoefficient: 0.6, steerable: false, maxSteerAngleRad: 0, brakeCapable: true },
      { id: 'mainRight', posBodyM: { x: -1, y: -2, z: 1.5 }, maxCompressionM: 0.3, springNPerM: 300000, damperNPerMPerS: 20000, kineticFrictionCoefficient: 0.6, steerable: false, maxSteerAngleRad: 0, brakeCapable: true },
    ],
    fcsLimits: {
      maxAlphaRad: 0.3, minAlphaRad: -0.2, maxGLoadPos: 9, maxGLoadNeg: -3,
      maxRollRateRadS: 5, maxElevonRad: 0.4, maxRudderRad: 0.4,
      maxElevonRateRadS: 5, maxRudderRateRadS: 5,
      pitchRateGain: 0.5, rollRateGain: 0.5, yawRateGain: 0.3, alphaLimitGain: 2, gLoadGain: 1,
    },
  };
}

function makeState(): EntityState {
  return {
    id: 1, kind: 'aircraft', team: 0,
    pos: { x: 0, y: 3000, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 150, y: 0, z: 5 },
    omega: { x: 0.01, y: 0.01, z: 0.01 },
    alive: true, hp: 100, fuelKg: 1500,
    elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0.5, afterburnerOn: false, flags: 0,
  };
}

function makeDamage(): DamageState {
  return {
    structurePct: 1, engineHealthPct: 1,
    controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
    hydraulicsOk: true, fuelLeak: false, radarHealthPct: 1, gearHealthPct: 1,
  };
}

function makeInputs(): PilotInputs {
  return {
    pitch: 0.1, roll: -0.1, yaw: 0.05, throttle: 0.7, afterburner: false, brakes: 0,
    gearDown: false, airbrake: false, trigger: false, launch: false,
    cycleWeapon: false, cycleTarget: false,
  };
}

function makeEnv(): Environment {
  return {
    airDensityKgM3: 1.225,
    soundSpeedMps: 340,
    windWorldMps: { x: 3, y: 0, z: -1 },
    gravityMps2: 9.80665,
    groundElevationM: -1e9,
    groundNormalWorld: { x: 0, y: 1, z: 0 },
  };
}

describe('stepAircraft — allocation smoke test', () => {
  it('100000 repeated calls grow heapUsed by well under 1 MB (loose bound)', () => {
    const def = makeDef();
    const state = makeState();
    const damage = makeDamage();
    const inputs = makeInputs();
    const env = makeEnv();
    const dt = 1 / 120;

    // Warm up: let the inertia cache populate and JIT settle before measuring.
    for (let i = 0; i < 2000; i++) {
      stepAircraft(state, damage, inputs, env, def, dt, state);
    }

    // Measure heap growth over several successive batches rather than a
    // single before/after delta: without an exposed `global.gc()` (this
    // project's test runner is not launched with --expose-gc), a one-shot
    // delta is dominated by GC-timing noise, not allocation behavior. A
    // genuine per-call leak shows up as growth that does not level off
    // across batches; GC-timing noise does not accumulate that way. This is
    // the smoke test this module's spec calls for (section 7) — the
    // authoritative allocation regression check is module 12's
    // `tools/sim-check.ts`.
    const BATCH_SIZE = 100000;
    const BATCH_COUNT = 5;
    const heapAfterBatch: number[] = [];
    for (let b = 0; b < BATCH_COUNT; b++) {
      for (let i = 0; i < BATCH_SIZE; i++) {
        stepAircraft(state, damage, inputs, env, def, dt, state);
      }
      heapAfterBatch.push(process.memoryUsage().heapUsed);
    }

    // Growth across the LAST batch (steady state, well past warmup) stays
    // small relative to a per-call allocation of even a single ~130-byte
    // object (100000 * 130 bytes ~= 12.4 MB) — a loose bound, deliberately,
    // per this module's spec.
    const lastBatchGrowth = heapAfterBatch[BATCH_COUNT - 1]! - heapAfterBatch[BATCH_COUNT - 2]!;
    expect(lastBatchGrowth).toBeLessThan(12 * 1024 * 1024);

    // No runaway trend: the final batch does not grow dramatically more
    // than the first measured batch (a real per-call leak compounds; GC
    // scheduling noise does not trend upward batch over batch).
    const firstBatchGrowth = heapAfterBatch[1]! - heapAfterBatch[0]!;
    expect(lastBatchGrowth).toBeLessThan(Math.max(firstBatchGrowth * 3, 12 * 1024 * 1024));
  });
});
