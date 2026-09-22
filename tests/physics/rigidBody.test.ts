import { describe, it, expect } from 'vitest';
import { stepAircraft } from '../../src/physics';
import { bodyRateP, bodyRateR } from '../../src/math';
import type { EntityState, DamageState, PilotInputs } from '../../src/contracts/core';
import type { AircraftDefinition } from '../../src/contracts/aircraft';
import type { Environment } from '../../src/contracts/flight';
import type { Table2D } from '../../src/contracts/math';

function constTable(value: number): Table2D {
  return { xs: [0], ys: [0], zs: [[value]] };
}

function makeDef(overrides: Partial<AircraftDefinition> = {}): AircraftDefinition {
  return {
    id: 'test-aircraft',
    massKg: 10000,
    emptyMassKg: 8000,
    maxFuelKg: 2000,
    inertiaBodyKgM2: { xx: 100, yy: 100, zz: 100, xy: 0, xz: 0, yz: 0 },
    cgOffsetBodyM: { x: 0, y: 0, z: 0 },
    wingAreaM2: 0,
    wingSpanM: 1,
    meanChordM: 1,
    hardpoints: [],
    wireframe: { vertices: [], edges: [], groups: [] },
    aero: {
      CL: constTable(0),
      CD: constTable(0),
      Cm: constTable(0),
      CY_beta: 0,
      Cl_beta: 0,
      Cn_beta: 0,
      CL_elevon: 0,
      CD_elevon: 0,
      Cm_elevon: 0,
      Cl_elevon: 0,
      Cn_elevon: 0,
      CY_rudder: 0,
      Cl_rudder: 0,
      Cn_rudder: 0,
      Cl_p: 0,
      Cl_r: 0,
      Cm_q: 0,
      Cn_p: 0,
      Cn_r: 0,
      groundEffectMaxDeltaCL: 0,
      stallAlphaRad: 1,
    },
    engine: {
      militaryThrustN: constTable(0),
      afterburnerThrustN: constTable(0),
      militaryFuelFlowKgS: constTable(0),
      afterburnerFuelFlowKgS: constTable(0),
      idleFuelFlowKgS: 0,
      spoolTimeConstantSec: 1,
    },
    gear: [],
    fcsLimits: {
      maxAlphaRad: 0.3,
      minAlphaRad: -0.2,
      maxGLoadPos: 9,
      maxGLoadNeg: -3,
      maxRollRateRadS: 5,
      maxElevonRad: 0.4363,
      maxRudderRad: 0.4363,
      maxElevonRateRadS: 5,
      maxRudderRateRadS: 5,
      pitchRateGain: 0,
      rollRateGain: 0,
      yawRateGain: 0,
      alphaLimitGain: 0,
      gLoadGain: 0,
    },
    ...overrides,
  };
}

function makeState(overrides: Partial<EntityState> = {}): EntityState {
  return {
    id: 1,
    kind: 'aircraft',
    team: 0,
    pos: { x: 0, y: 5000, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    omega: { x: 0, y: 0, z: 0 },
    alive: true,
    hp: 100,
    fuelKg: 1000,
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    gearPos: 0,
    throttle: 0,
    afterburnerOn: false,
    flags: 0,
    ...overrides,
  };
}

function makeDamage(overrides: Partial<DamageState> = {}): DamageState {
  return {
    structurePct: 1,
    engineHealthPct: 1,
    controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
    hydraulicsOk: true,
    fuelLeak: false,
    radarHealthPct: 1,
    gearHealthPct: 1,
    ...overrides,
  };
}

function makeInputs(overrides: Partial<PilotInputs> = {}): PilotInputs {
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

describe('stepAircraft — rigid body integration', () => {
  it('free fall: semi-implicit Euler is exact for constant acceleration', () => {
    const def = makeDef();
    const state = makeState();
    const damage = makeDamage();
    const inputs = makeInputs();
    const env = makeEnv();
    const dt = 1 / 120;

    for (let i = 0; i < 120; i++) {
      stepAircraft(state, damage, inputs, env, def, dt, state);
    }

    expect(Math.abs(state.vel.y - -9.80665)).toBeLessThan(1e-9);
  });

  it('quaternion stays unit length under sustained constant angular velocity', () => {
    const def = makeDef();
    const state = makeState({ omega: { x: 0.5, y: 0.3, z: -0.2 } });
    const damage = makeDamage();
    const inputs = makeInputs();
    const env = makeEnv();
    const dt = 1 / 120;

    for (let i = 0; i < 1000; i++) {
      stepAircraft(state, damage, inputs, env, def, dt, state);
    }

    const qLen = Math.sqrt(state.rot.x ** 2 + state.rot.y ** 2 + state.rot.z ** 2 + state.rot.w ** 2);
    expect(Math.abs(qLen - 1)).toBeLessThan(1e-9);
    // With a spherical inertia tensor and zero applied moment, omega must not drift.
    expect(state.omega.x).toBeCloseTo(0.5, 9);
    expect(state.omega.y).toBeCloseTo(0.3, 9);
    expect(state.omega.z).toBeCloseTo(-0.2, 9);
  });

  it('yaw sign mapping: positive Cn (rudder-equivalent) produces positive bodyRateR', () => {
    const airDensityKgM3 = 1.225;
    const Vt = Math.sqrt((2 * 1000) / airDensityKgM3); // qBar = 1000 Pa at S=b=1
    const beta = 0.1;
    const vx = Vt * Math.cos(beta);
    const vz = Vt * Math.sin(beta);

    const def = makeDef({
      wingAreaM2: 1,
      wingSpanM: 1,
      meanChordM: 1,
      inertiaBodyKgM2: { xx: 100, yy: 100, zz: 100, xy: 0, xz: 0, yz: 0 },
      aero: {
        ...makeDef().aero,
        Cn_beta: 1.0, // Cn_std = Cn_beta * beta = 0.1 at beta=0.1
      },
    });
    const state = makeState({ vel: { x: vx, y: 0, z: vz }, omega: { x: 0, y: 0, z: 0 } });
    const damage = makeDamage();
    const inputs = makeInputs();
    const env = makeEnv({ airDensityKgM3 });
    const dt = 1 / 120;

    stepAircraft(state, damage, inputs, env, def, dt, state);

    const r = bodyRateR(state.omega);
    expect(r).toBeGreaterThan(0);
    expect(Math.abs(r - 0.008333) / 0.008333).toBeLessThan(0.05);
  });

  it('roll sign mapping: positive elevonDiff (elevonL - elevonR) produces positive bodyRateP (roll right)', () => {
    const def = makeDef({
      wingAreaM2: 1,
      wingSpanM: 1,
      meanChordM: 1,
      aero: {
        ...makeDef().aero,
        Cl_elevon: 1.0,
      },
    });
    const state = makeState({
      vel: { x: 40, y: 0, z: 0 },
      omega: { x: 0, y: 0, z: 0 },
      elevonL: 0.1,
      elevonR: -0.1,
    });
    const damage = makeDamage();
    const inputs = makeInputs();
    const env = makeEnv();
    const dt = 1 / 120;

    stepAircraft(state, damage, inputs, env, def, dt, state);

    expect(bodyRateP(state.omega)).toBeGreaterThan(0);
  });
});
