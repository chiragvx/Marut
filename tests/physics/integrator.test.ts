import { describe, it, expect } from 'vitest';
import { stepAircraft } from '../../src/physics';
import type { EntityState, DamageState, PilotInputs } from '../../src/contracts/core';
import type { AircraftDefinition } from '../../src/contracts/aircraft';
import type { Environment } from '../../src/contracts/flight';
import type { Table2D } from '../../src/contracts/math';

function constTable(value: number): Table2D {
  return { xs: [0], ys: [0], zs: [[value]] };
}

function makeDef(overrides: Partial<AircraftDefinition> = {}): AircraftDefinition {
  return {
    id: 'integrator-fixture',
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
      // A strong Cm(alpha) and Cm_elevon so a working aero/FCS path would
      // visibly perturb omega — used to prove the structural-failure path
      // truly skips 4.4/4.5/4.9, not just "happens to produce zero" here.
      CL: constTable(0.3), CD: constTable(0.05), Cm: constTable(0.5),
      CY_beta: 0, Cl_beta: 0, Cn_beta: 0.5, CL_elevon: 0, CD_elevon: 0, Cm_elevon: -1,
      Cl_elevon: 0.5, Cn_elevon: 0, CY_rudder: 0, Cl_rudder: 0, Cn_rudder: 0,
      Cl_p: 0, Cl_r: 0, Cm_q: 0, Cn_p: 0, Cn_r: 0,
      groundEffectMaxDeltaCL: 0, stallAlphaRad: 0.3,
    },
    engine: {
      militaryThrustN: constTable(50000),
      afterburnerThrustN: constTable(80000),
      militaryFuelFlowKgS: constTable(1),
      afterburnerFuelFlowKgS: constTable(3),
      idleFuelFlowKgS: 0.2,
      spoolTimeConstantSec: 1,
    },
    gear: [],
    fcsLimits: {
      maxAlphaRad: 0.3, minAlphaRad: -0.2, maxGLoadPos: 9, maxGLoadNeg: -3,
      maxRollRateRadS: 5, maxElevonRad: 0.4, maxRudderRad: 0.4,
      maxElevonRateRadS: 5, maxRudderRateRadS: 5,
      pitchRateGain: 0.5, rollRateGain: 0.5, yawRateGain: 0.3, alphaLimitGain: 2, gLoadGain: 1,
    },
    ...overrides,
  };
}

function makeState(overrides: Partial<EntityState> = {}): EntityState {
  return {
    id: 5, kind: 'aircraft', team: 0,
    pos: { x: 0, y: 3000, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 150, y: 0, z: 10 },
    omega: { x: 0, y: 0, z: 0 },
    alive: true, hp: 0, fuelKg: 1000,
    elevonL: 0.05, elevonR: -0.02, rudder: 0.01, gearPos: 0, throttle: 0.8, afterburnerOn: false, flags: 0,
    ...overrides,
  };
}

function makeInputs(overrides: Partial<PilotInputs> = {}): PilotInputs {
  return {
    pitch: 0.8, roll: 0.5, yaw: 0.3, throttle: 1, afterburner: true, brakes: 0,
    gearDown: false, airbrake: false, trigger: false, launch: false,
    cycleWeapon: false, cycleTarget: false,
    ...overrides,
  };
}

function makeEnv(overrides: Partial<Environment> = {}): Environment {
  return {
    airDensityKgM3: 1.225,
    soundSpeedMps: 340,
    windWorldMps: { x: 0, y: 0, z: 0 },
    gravityMps2: 9.80665,
    groundElevationM: -1e9,
    groundNormalWorld: { x: 0, y: 1, z: 0 },
    ...overrides,
  };
}

describe('stepAircraft — structural failure short-circuit (section 4.10)', () => {
  it('structurePct<=0 leaves elevon/rudder positions frozen and produces no aero-driven rotation', () => {
    const def = makeDef();
    const state = makeState();
    const damage: DamageState = {
      structurePct: 0, engineHealthPct: 1,
      controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
      hydraulicsOk: true, fuelLeak: false, radarHealthPct: 1, gearHealthPct: 1,
    };
    const inputs = makeInputs();
    const env = makeEnv();

    for (let i = 0; i < 10; i++) {
      stepAircraft(state, damage, inputs, env, def, 1 / 120, state);
    }

    expect(state.elevonL).toBe(0.05);
    expect(state.elevonR).toBe(-0.02);
    expect(state.rudder).toBe(0.01);
    // No aero moment => no omega change (gear=[] so no other moment source either).
    expect(state.omega).toEqual({ x: 0, y: 0, z: 0 });
    // Gravity still applies (ballistic fall).
    expect(state.vel.y).toBeLessThan(0);
  });

  it('with structurePct=1, the same fixture DOES produce nonzero rotation (control for the test above)', () => {
    const def = makeDef();
    const state = makeState();
    const damage: DamageState = {
      structurePct: 1, engineHealthPct: 1,
      controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
      hydraulicsOk: true, fuelLeak: false, radarHealthPct: 1, gearHealthPct: 1,
    };
    const inputs = makeInputs();
    const env = makeEnv();

    stepAircraft(state, damage, inputs, env, def, 1 / 120, state);

    expect(state.omega).not.toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('stepAircraft — out-parameter aliasing', () => {
  it('accepts a separate out object distinct from state (out does not need to alias state)', () => {
    const def = makeDef();
    const state = makeState();
    const out = makeState({ pos: { x: -1, y: -1, z: -1 } });
    const damage: DamageState = {
      structurePct: 1, engineHealthPct: 1,
      controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
      hydraulicsOk: true, fuelLeak: false, radarHealthPct: 1, gearHealthPct: 1,
    };
    const inputs = makeInputs({ pitch: 0, roll: 0, yaw: 0, afterburner: false });
    const env = makeEnv();

    stepAircraft(state, damage, inputs, env, def, 1 / 120, out);

    // out now reflects the stepped result, not its own stale initial pos, and
    // the original `state` object passed in was left untouched by this call.
    expect(out.pos.x).not.toBe(-1);
    expect(state.pos).toEqual({ x: 0, y: 3000, z: 0 });
  });
});

describe('stepAircraft — inertia cache keyed by AircraftDefinition.id', () => {
  it('two distinct aircraft definitions integrate independently (no cross-contamination via the cache)', () => {
    const defA = makeDef({ id: 'aircraft-a', inertiaBodyKgM2: { xx: 1000, yy: 1000, zz: 1000, xy: 0, xz: 0, yz: 0 } });
    const defB = makeDef({ id: 'aircraft-b', inertiaBodyKgM2: { xx: 999999, yy: 999999, zz: 999999, xy: 0, xz: 0, yz: 0 } });
    const damage: DamageState = {
      structurePct: 1, engineHealthPct: 1,
      controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
      hydraulicsOk: true, fuelLeak: false, radarHealthPct: 1, gearHealthPct: 1,
    };
    const inputs = makeInputs();
    const env = makeEnv();

    const stateA = makeState({ id: 10 });
    const stateB = makeState({ id: 11 });
    stepAircraft(stateA, damage, inputs, env, defA, 1 / 120, stateA);
    stepAircraft(stateB, damage, inputs, env, defB, 1 / 120, stateB);

    // Much lower inertia => much larger angular response to the same moment.
    expect(Math.abs(stateA.omega.z)).toBeGreaterThan(Math.abs(stateB.omega.z) * 10);
  });
});
