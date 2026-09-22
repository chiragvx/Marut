import { describe, it, expect } from 'vitest';
import { stepEngine, computeAppliedThrustN, sampleThrustN } from '../../src/physics/engine';
import type { EntityState, PilotInputs, DamageState } from '../../src/contracts/core';
import type { AircraftDefinition } from '../../src/contracts/aircraft';
import type { Table2D } from '../../src/contracts/math';

function constTable(value: number): Table2D {
  return { xs: [0], ys: [0], zs: [[value]] };
}

function makeDef(spoolTimeConstantSec: number): AircraftDefinition {
  return {
    id: 'test-aircraft',
    massKg: 10000,
    emptyMassKg: 8000,
    maxFuelKg: 2000,
    inertiaBodyKgM2: { xx: 1, yy: 1, zz: 1, xy: 0, xz: 0, yz: 0 },
    cgOffsetBodyM: { x: 0, y: 0, z: 0 },
    wingAreaM2: 1,
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
      militaryThrustN: constTable(50000),
      afterburnerThrustN: constTable(80000),
      militaryFuelFlowKgS: constTable(1.0),
      afterburnerFuelFlowKgS: constTable(3.0),
      idleFuelFlowKgS: 0.2,
      spoolTimeConstantSec,
    },
    gear: [],
    fcsLimits: {
      maxAlphaRad: 0.3,
      minAlphaRad: -0.2,
      maxGLoadPos: 9,
      maxGLoadNeg: -3,
      maxRollRateRadS: 5,
      maxElevonRad: 0.4,
      maxRudderRad: 0.4,
      maxElevonRateRadS: 5,
      maxRudderRateRadS: 5,
      pitchRateGain: 1,
      rollRateGain: 1,
      yawRateGain: 1,
      alphaLimitGain: 2,
      gLoadGain: 1,
    },
  };
}

function makeState(overrides: Partial<EntityState> = {}): EntityState {
  return {
    id: 1,
    kind: 'aircraft',
    team: 0,
    pos: { x: 0, y: 0, z: 0 },
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

describe('stepEngine', () => {
  it('spool lag reaches 63.2% of commanded throttle after one time constant', () => {
    const def = makeDef(2.0);
    const state = makeState({ throttle: 0 });
    const inputs = makeInputs({ throttle: 1 });
    const damage = makeDamage();
    const thrust = { x: 0, y: 0, z: 0 };

    stepEngine(state, inputs, damage, def, 0, 2.0, thrust);

    expect(Math.abs(state.throttle - (1 - Math.exp(-1))) / (1 - Math.exp(-1))).toBeLessThan(0.01);
  });

  it('flameout: engineHealthPct=0 forces thrust to exactly 0 regardless of throttle/afterburner', () => {
    const def = makeDef(0.5);
    const state = makeState({ throttle: 1 });
    const inputs = makeInputs({ throttle: 1, afterburner: true });
    const damage = makeDamage({ engineHealthPct: 0 });
    const thrust = { x: 999, y: 999, z: 999 };

    stepEngine(state, inputs, damage, def, 0, 1 / 240, thrust);

    expect(thrust.x).toBe(0);
    expect(thrust.y).toBe(0);
    expect(thrust.z).toBe(0);
  });

  it('flameout: no fuel available also forces thrust to 0', () => {
    const def = makeDef(0.5);
    const state = makeState({ throttle: 1, fuelKg: 0 });
    const inputs = makeInputs({ throttle: 1 });
    const damage = makeDamage();
    const thrust = { x: 999, y: 999, z: 999 };

    stepEngine(state, inputs, damage, def, 0, 1 / 240, thrust);

    expect(thrust.x).toBe(0);
  });

  it('fuel burns at the commanded flow rate and never goes negative', () => {
    const def = makeDef(0.0001); // near-instant spool
    const state = makeState({ throttle: 1, fuelKg: 0.05 });
    const inputs = makeInputs({ throttle: 1 });
    const damage = makeDamage();
    const thrust = { x: 0, y: 0, z: 0 };

    stepEngine(state, inputs, damage, def, 0, 1, thrust); // 1 s at ~1 kg/s military flow, only 0.05 kg available

    expect(state.fuelKg).toBe(0);
  });
});

describe('computeAppliedThrustN / sampleThrustN (telemetry thrustFrac helpers)', () => {
  it('applied thrust matches the raw military table scaled by throttle and health', () => {
    const def = makeDef(1);
    const n = computeAppliedThrustN(def.engine, 0, 0, 0.5, false, 0.8, true);
    expect(n).toBeCloseTo(0.5 * 50000 * 0.8, 6);
  });

  it('sampleThrustN returns the afterburner table when afterburnerOn', () => {
    const def = makeDef(1);
    expect(sampleThrustN(def.engine, 0, 0, true)).toBe(80000);
    expect(sampleThrustN(def.engine, 0, 0, false)).toBe(50000);
  });
});
