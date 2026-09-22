import { describe, it, expect } from 'vitest';
import { stepAircraft, sampleWind, createGustState } from '../../src/physics';
import { createPrng, nextFloat01 } from '../../src/math';
import type { EntityState, DamageState, PilotInputs, WeatherConfig } from '../../src/contracts/core';
import type { AircraftDefinition } from '../../src/contracts/aircraft';
import type { Environment } from '../../src/contracts/flight';
import type { Table2D } from '../../src/contracts/math';

function constTable(value: number): Table2D {
  return { xs: [0], ys: [0], zs: [[value]] };
}

function makeDef(): AircraftDefinition {
  return {
    id: 'determinism-fixture',
    massKg: 10000,
    emptyMassKg: 8000,
    maxFuelKg: 2000,
    inertiaBodyKgM2: { xx: 30000, yy: 60000, zz: 80000, xy: 500, xz: -200, yz: 100 },
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

function makeState(id: number): EntityState {
  return {
    id, kind: 'aircraft', team: 0,
    pos: { x: 0, y: 3000, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 150, y: 0, z: 0 },
    omega: { x: 0, y: 0, z: 0 },
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

function scriptedInputs(tick: number): PilotInputs {
  return {
    pitch: Math.sin(tick * 0.013) * 0.4,
    roll: Math.cos(tick * 0.021) * 0.3,
    yaw: Math.sin(tick * 0.007) * 0.2,
    throttle: 0.5 + 0.3 * Math.sin(tick * 0.003),
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

const WEATHER: WeatherConfig = {
  windWorldMps: { x: 5, y: 0, z: -2 },
  gustMps: 3,
  turbulence: 0.4,
};

function runSim(entityId: number, ticks: number): EntityState {
  const def = makeDef();
  const state = makeState(entityId);
  const damage = makeDamage();
  const prng = createPrng(123456);
  const gust = createGustState();
  const wind = { x: 0, y: 0, z: 0 };
  const dt = 1 / 120;

  for (let tick = 0; tick < ticks; tick++) {
    sampleWind(WEATHER, gust, () => nextFloat01(prng), dt, wind);
    const env: Environment = {
      airDensityKgM3: 1.225,
      soundSpeedMps: 340,
      windWorldMps: { x: wind.x, y: wind.y, z: wind.z },
      gravityMps2: 9.80665,
      groundElevationM: -1e9,
      groundNormalWorld: { x: 0, y: 1, z: 0 },
    };
    const inputs = scriptedInputs(tick);
    stepAircraft(state, damage, inputs, env, def, dt, state);
  }
  return state;
}

describe('determinism', () => {
  it('identical seed + identical scripted input stream => bit-identical EntityState after 3600 ticks', () => {
    const a = runSim(100, 3600);
    const b = runSim(200, 3600);

    expect(Object.is(a.pos.x, b.pos.x)).toBe(true);
    expect(Object.is(a.pos.y, b.pos.y)).toBe(true);
    expect(Object.is(a.pos.z, b.pos.z)).toBe(true);
    expect(Object.is(a.rot.x, b.rot.x)).toBe(true);
    expect(Object.is(a.rot.y, b.rot.y)).toBe(true);
    expect(Object.is(a.rot.z, b.rot.z)).toBe(true);
    expect(Object.is(a.rot.w, b.rot.w)).toBe(true);
    expect(Object.is(a.vel.x, b.vel.x)).toBe(true);
    expect(Object.is(a.vel.y, b.vel.y)).toBe(true);
    expect(Object.is(a.vel.z, b.vel.z)).toBe(true);
    expect(Object.is(a.omega.x, b.omega.x)).toBe(true);
    expect(Object.is(a.omega.y, b.omega.y)).toBe(true);
    expect(Object.is(a.omega.z, b.omega.z)).toBe(true);
    expect(Object.is(a.fuelKg, b.fuelKg)).toBe(true);
    expect(Object.is(a.elevonL, b.elevonL)).toBe(true);
    expect(Object.is(a.elevonR, b.elevonR)).toBe(true);
    expect(Object.is(a.rudder, b.rudder)).toBe(true);
    expect(Object.is(a.gearPos, b.gearPos)).toBe(true);
    expect(Object.is(a.throttle, b.throttle)).toBe(true);
    expect(a.afterburnerOn).toBe(b.afterburnerOn);
    expect(a.flags).toBe(b.flags);
  });
});
