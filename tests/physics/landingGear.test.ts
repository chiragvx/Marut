import { describe, it, expect } from 'vitest';
import { computeGearLeg, type GearLegOutput } from '../../src/physics/landingGear';
import { stepAircraft } from '../../src/physics';
import type { EntityState, DamageState, PilotInputs } from '../../src/contracts/core';
import type { AircraftDefinition, GearDefinition } from '../../src/contracts/aircraft';
import type { Environment } from '../../src/contracts/flight';
import type { Table2D } from '../../src/contracts/math';

function constTable(value: number): Table2D {
  return { xs: [0], ys: [0], zs: [[value]] };
}

function makeGearDef(overrides: Partial<GearDefinition> = {}): GearDefinition {
  return {
    id: 'mainLeft',
    posBodyM: { x: 0, y: -2, z: 0 },
    maxCompressionM: 0.3,
    springNPerM: 400000,
    damperNPerMPerS: 30000,
    kineticFrictionCoefficient: 0.5,
    steerable: false,
    maxSteerAngleRad: 0,
    brakeCapable: true,
    ...overrides,
  };
}

function makeGearState(overrides: Partial<{ pos: { x: number; y: number; z: number }; rot: { x: number; y: number; z: number; w: number }; vel: { x: number; y: number; z: number }; omega: { x: number; y: number; z: number }; gearPos: number }> = {}) {
  return {
    pos: { x: 0, y: 2, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    omega: { x: 0, y: 0, z: 0 },
    gearPos: 1,
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
    gearDown: true,
    airbrake: false,
    trigger: false,
    launch: false,
    cycleWeapon: false,
    cycleTarget: false,
    ...overrides,
  };
}

function makeEnv(groundElevationM: number): Environment {
  return {
    airDensityKgM3: 1.225,
    soundSpeedMps: 340,
    windWorldMps: { x: 0, y: 0, z: 0 },
    gravityMps2: 9.80665,
    groundElevationM,
    groundNormalWorld: { x: 0, y: 1, z: 0 },
  };
}

describe('computeGearLeg', () => {
  it('hard stop: overtravel engages the stiffness multiplier', () => {
    const legDef = makeGearDef({ maxCompressionM: 0.3, springNPerM: 100000, damperNPerMPerS: 0 });
    // Ground placed so penetration == maxCompressionM exactly, and a second fixture with penetration == 2*maxCompressionM.
    const env1 = makeEnv(legDef.posBodyM.y + legDef.maxCompressionM);
    const state1 = makeGearState({ pos: { x: 0, y: 0, z: 0 } });
    const out1: GearLegOutput = { legForceWorld: { x: 0, y: 0, z: 0 }, legMomentBody: { x: 0, y: 0, z: 0 }, onGround: false };
    computeGearLeg(state1, legDef, makeInputs(), env1, out1);

    const env2 = makeEnv(legDef.posBodyM.y + 2 * legDef.maxCompressionM);
    const state2 = makeGearState({ pos: { x: 0, y: 0, z: 0 } });
    const out2: GearLegOutput = { legForceWorld: { x: 0, y: 0, z: 0 }, legMomentBody: { x: 0, y: 0, z: 0 }, onGround: false };
    computeGearLeg(state2, legDef, makeInputs(), env2, out2);

    expect(out2.legForceWorld.y).toBeGreaterThan(20 * out1.legForceWorld.y);
  });

  it('braking: full brakes reach the kinetic friction limit', () => {
    const legDef = makeGearDef({ brakeCapable: true, kineticFrictionCoefficient: 0.6 });
    const env = makeEnv(legDef.posBodyM.y + 0.1); // 0.1 m penetration
    const state = makeGearState({ pos: { x: 0, y: 0, z: 0 }, vel: { x: 20, y: 0, z: 0 } });
    const out: GearLegOutput = { legForceWorld: { x: 0, y: 0, z: 0 }, legMomentBody: { x: 0, y: 0, z: 0 }, onGround: false };

    computeGearLeg(state, legDef, makeInputs({ brakes: 1 }), env, out);

    const normalForceMag = out.legForceWorld.y; // pure spring, zero damper contribution (vel.y=0)
    const longForceMag = Math.abs(out.legForceWorld.x);
    expect(Math.abs(longForceMag - legDef.kineticFrictionCoefficient * normalForceMag)).toBeLessThan(1e-6);
  });

  it('no contact when penetration <= 0', () => {
    const legDef = makeGearDef();
    const env = makeEnv(legDef.posBodyM.y - 1); // ground well below the wheel
    const state = makeGearState({ pos: { x: 0, y: 0, z: 0 } });
    const out: GearLegOutput = { legForceWorld: { x: 1, y: 1, z: 1 }, legMomentBody: { x: 1, y: 1, z: 1 }, onGround: true };

    computeGearLeg(state, legDef, makeInputs(), env, out);

    expect(out.onGround).toBe(false);
    expect(out.legForceWorld).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('no contact when gearPos below the contact threshold', () => {
    const legDef = makeGearDef();
    const env = makeEnv(legDef.posBodyM.y + 0.1);
    const state = makeGearState({ pos: { x: 0, y: 0, z: 0 }, gearPos: 0.5 });
    const out: GearLegOutput = { legForceWorld: { x: 1, y: 1, z: 1 }, legMomentBody: { x: 1, y: 1, z: 1 }, onGround: true };

    computeGearLeg(state, legDef, makeInputs(), env, out);

    expect(out.onGround).toBe(false);
  });
});

describe('stepAircraft — landing gear static equilibrium (full pipeline)', () => {
  it('a symmetrically-loaded 3-leg fixture at analytic equilibrium settles (|vel.y| stays small after one step)', () => {
    const k = 400000;
    const massKg = 10000;
    const g = 9.80665;
    const compressionM = (massKg * g) / (3 * k);
    const legH = 2;

    const gearDefs: GearDefinition[] = [
      makeGearDef({ id: 'nose', posBodyM: { x: 2, y: -legH, z: 0 }, springNPerM: k, brakeCapable: false, steerable: true, maxSteerAngleRad: 0.5 }),
      makeGearDef({ id: 'mainLeft', posBodyM: { x: -1, y: -legH, z: -1.5 }, springNPerM: k }),
      makeGearDef({ id: 'mainRight', posBodyM: { x: -1, y: -legH, z: 1.5 }, springNPerM: k }),
    ];

    const def: AircraftDefinition = {
      id: 'test-aircraft',
      massKg,
      emptyMassKg: massKg * 0.8,
      maxFuelKg: 2000,
      inertiaBodyKgM2: { xx: 30000, yy: 60000, zz: 80000, xy: 0, xz: 0, yz: 0 },
      cgOffsetBodyM: { x: 0, y: 0, z: 0 },
      wingAreaM2: 0,
      wingSpanM: 10,
      meanChordM: 2,
      hardpoints: [],
      wireframe: { vertices: [], edges: [], groups: [] },
      aero: {
        CL: constTable(0), CD: constTable(0), Cm: constTable(0),
        CY_beta: 0, Cl_beta: 0, Cn_beta: 0, CL_elevon: 0, CD_elevon: 0, Cm_elevon: 0,
        Cl_elevon: 0, Cn_elevon: 0, CY_rudder: 0, Cl_rudder: 0, Cn_rudder: 0,
        Cl_p: 0, Cl_r: 0, Cm_q: 0, Cn_p: 0, Cn_r: 0,
        groundEffectMaxDeltaCL: 0, stallAlphaRad: 1,
      },
      engine: {
        militaryThrustN: constTable(0), afterburnerThrustN: constTable(0),
        militaryFuelFlowKgS: constTable(0), afterburnerFuelFlowKgS: constTable(0),
        idleFuelFlowKgS: 0, spoolTimeConstantSec: 1,
      },
      gear: gearDefs,
      fcsLimits: {
        maxAlphaRad: 0.3, minAlphaRad: -0.2, maxGLoadPos: 9, maxGLoadNeg: -3,
        maxRollRateRadS: 5, maxElevonRad: 0.4, maxRudderRad: 0.4,
        maxElevonRateRadS: 5, maxRudderRateRadS: 5,
        pitchRateGain: 0, rollRateGain: 0, yawRateGain: 0, alphaLimitGain: 0, gLoadGain: 0,
      },
    };

    const state: EntityState = {
      id: 1, kind: 'aircraft', team: 0,
      pos: { x: 0, y: legH - compressionM, z: 0 },
      rot: { x: 0, y: 0, z: 0, w: 1 },
      vel: { x: 0, y: 0, z: 0 },
      omega: { x: 0, y: 0, z: 0 },
      // emptyMassKg (0.8*massKg) + fuel = massKg, which the analytic equilibrium above assumes.
      alive: true, hp: 100, fuelKg: massKg * 0.2,
      elevonL: 0, elevonR: 0, rudder: 0, gearPos: 1, throttle: 0, afterburnerOn: false, flags: 0,
    };
    const damage: DamageState = {
      structurePct: 1, engineHealthPct: 1,
      controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
      hydraulicsOk: true, fuelLeak: false, radarHealthPct: 1, gearHealthPct: 1,
    };
    const inputs = makeInputs({ gearDown: true });
    const env = makeEnv(0);

    stepAircraft(state, damage, inputs, env, def, 1 / 120, state);

    expect(Math.abs(state.vel.y)).toBeLessThan(0.01);
  });
});
