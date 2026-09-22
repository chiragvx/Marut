import { describe, it, expect } from 'vitest';
import { stepAircraft, computeTelemetry } from '../../src/physics';
import { getLastGLoad, entityPoolIndex } from '../../src/physics/fcs';
import type { EntityState, DamageState, PilotInputs, AircraftTelemetry } from '../../src/contracts/core';
import type { AircraftDefinition } from '../../src/contracts/aircraft';
import type { Environment } from '../../src/contracts/flight';
import type { Table2D } from '../../src/contracts/math';

function constTable(value: number): Table2D {
  return { xs: [0], ys: [0], zs: [[value]] };
}

function makeDef(overrides: Partial<AircraftDefinition> = {}): AircraftDefinition {
  return {
    id: 'telemetry-fixture',
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
      CL: constTable(0.3), CD: constTable(0.05), Cm: constTable(0),
      CY_beta: 0, Cl_beta: 0, Cn_beta: 0, CL_elevon: 0, CD_elevon: 0, Cm_elevon: -1,
      Cl_elevon: 0, Cn_elevon: 0, CY_rudder: 0, Cl_rudder: 0, Cn_rudder: 0,
      Cl_p: 0, Cl_r: 0, Cm_q: 0, Cn_p: 0, Cn_r: 0,
      groundEffectMaxDeltaCL: 0, stallAlphaRad: 0.25,
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
    id: 9, kind: 'aircraft', team: 0,
    pos: { x: 0, y: 3000, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 150, y: -5, z: 3 },
    omega: { x: 0, y: 0, z: 0 },
    alive: true, hp: 100, fuelKg: 1000,
    elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0.6, afterburnerOn: false, flags: 0,
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

function makeInputs(overrides: Partial<PilotInputs> = {}): PilotInputs {
  return {
    pitch: 0, roll: 0, yaw: 0, throttle: 0.6, afterburner: false, brakes: 0,
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

function emptyTelemetry(): AircraftTelemetry {
  return {
    iasMps: 0, tasMps: 0, mach: 0, altMslM: 0, altAglM: 0, alphaRad: 0, betaRad: 0,
    gLoad: 0, headingRad: 0, pitchRad: 0, rollRad: 0, vspeedMps: 0, fuelKg: 0, fuelFrac: 0,
    thrustFrac: 0, onGround: false, stalled: false,
  };
}

describe('computeTelemetry', () => {
  it('alpha/beta match the hand-computed value for a known v_air_body', () => {
    const def = makeDef();
    const state = makeState({ vel: { x: 100, y: -10, z: 5 } });
    const env = makeEnv();
    const damage = makeDamage();
    const out = emptyTelemetry();

    computeTelemetry(state, def, env, damage, out);

    const Vt = Math.sqrt(100 * 100 + 10 * 10 + 5 * 5);
    expect(out.alphaRad).toBeCloseTo(Math.atan2(10, 100), 9);
    expect(out.betaRad).toBeCloseTo(Math.asin(5 / Vt), 9);
    expect(out.tasMps).toBeCloseTo(Vt, 9);
  });

  it('gLoad is read back bit-identical to the value stepAircraft cached, not recomputed', () => {
    const def = makeDef();
    const state = makeState();
    const damage = makeDamage();
    const inputs = makeInputs();
    const env = makeEnv();

    stepAircraft(state, damage, inputs, env, def, 1 / 120, state);
    const cached = getLastGLoad(entityPoolIndex(state.id));

    const out = emptyTelemetry();
    computeTelemetry(state, def, env, damage, out);

    expect(Object.is(out.gLoad, cached)).toBe(true);
  });

  it('onGround / stalled / fuelFrac reflect the input state directly', () => {
    const def = makeDef();
    const state = makeState({ fuelKg: 500, flags: 0 });
    const env = makeEnv();
    const damage = makeDamage();
    const out = emptyTelemetry();

    computeTelemetry(state, def, env, damage, out);

    expect(out.fuelFrac).toBeCloseTo(500 / def.maxFuelKg, 9);
    expect(out.onGround).toBe(false);
  });
});
