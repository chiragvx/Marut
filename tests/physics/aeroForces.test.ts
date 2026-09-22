import { describe, it, expect } from 'vitest';
import { computeAeroForceMoment, computeAirspeedFrame, type AirspeedFrame, type AeroOutput } from '../../src/physics/aeroForces';
import type { AircraftDefinition } from '../../src/contracts/aircraft';
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
    inertiaBodyKgM2: { xx: 30000, yy: 60000, zz: 80000, xy: 0, xz: 0, yz: 0 },
    cgOffsetBodyM: { x: 0, y: 0, z: 0 },
    wingAreaM2: 20,
    wingSpanM: 10,
    meanChordM: 2,
    hardpoints: [],
    wireframe: { vertices: [], edges: [], groups: [] },
    aero: {
      CL: constTable(0.3),
      CD: constTable(0.05),
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
      groundEffectMaxDeltaCL: 0.15,
      stallAlphaRad: 0.3,
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
      pitchRateGain: 1,
      rollRateGain: 1,
      yawRateGain: 1,
      alphaLimitGain: 2,
      gLoadGain: 1,
    },
    ...overrides,
  };
}

describe('computeAeroForceMoment', () => {
  it('alpha=0, beta=0 sanity check: drag aft, lift up, no side force', () => {
    const def = makeDef();
    const frame: AirspeedFrame = { alpha: 0, beta: 0, Vt: 100, mach: 0.3, qBar: 1000 };
    const out: AeroOutput = { forceBody: { x: 0, y: 0, z: 0 }, momentBody: { x: 0, y: 0, z: 0 } };

    computeAeroForceMoment(frame, 0, 0, 0, { x: 0, y: 0, z: 0 }, 1000, def, out);

    expect(Math.abs(out.forceBody.x - -1000)).toBeLessThan(1e-6);
    expect(Math.abs(out.forceBody.y - 6000)).toBeLessThan(1e-6);
    expect(Math.abs(out.forceBody.z - 0)).toBeLessThan(1e-6);
  });

  it('ground effect increases lift near the ground', () => {
    const def = makeDef();
    const frame: AirspeedFrame = { alpha: 0, beta: 0, Vt: 100, mach: 0.3, qBar: 1000 };
    const outGround: AeroOutput = { forceBody: { x: 0, y: 0, z: 0 }, momentBody: { x: 0, y: 0, z: 0 } };
    const outFree: AeroOutput = { forceBody: { x: 0, y: 0, z: 0 }, momentBody: { x: 0, y: 0, z: 0 } };

    computeAeroForceMoment(frame, 0, 0, 0, { x: 0, y: 0, z: 0 }, 0, def, outGround);
    computeAeroForceMoment(frame, 0, 0, 0, { x: 0, y: 0, z: 0 }, def.wingSpanM * 2, def, outFree);

    expect(outGround.forceBody.y).toBeGreaterThan(outFree.forceBody.y);
    const expectedRatio = 1 + def.aero.groundEffectMaxDeltaCL;
    expect(outGround.forceBody.y / outFree.forceBody.y).toBeCloseTo(expectedRatio, 2);
  });

  it('Vt below MIN_AIRSPEED_FOR_AERO_MPS zeroes alpha/beta/qBar and all aero force/moment', () => {
    const def = makeDef();
    const frame: AirspeedFrame = { alpha: 0, beta: 0, Vt: 0, mach: 0, qBar: 0 };
    computeAirspeedFrame({ x: 0.2, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0 }, 1.225, 340, frame);
    expect(frame.alpha).toBe(0);
    expect(frame.beta).toBe(0);
    expect(frame.qBar).toBe(0);

    const out: AeroOutput = { forceBody: { x: 1, y: 1, z: 1 }, momentBody: { x: 1, y: 1, z: 1 } };
    computeAeroForceMoment(frame, 0.1, -0.1, 0.1, { x: 0.5, y: 0.5, z: 0.5 }, 1000, def, out);
    // toBeCloseTo (not toEqual) so a legitimate -0 from `-Nmom`/`-Cn*0` (still
    // exactly zero-valued, since qBar=0) doesn't fail a strict-object-equality check.
    expect(out.forceBody.x).toBeCloseTo(0, 10);
    expect(out.forceBody.y).toBeCloseTo(0, 10);
    expect(out.forceBody.z).toBeCloseTo(0, 10);
    expect(out.momentBody.x).toBeCloseTo(0, 10);
    expect(out.momentBody.y).toBeCloseTo(0, 10);
    expect(out.momentBody.z).toBeCloseTo(0, 10);
  });
});

describe('computeAirspeedFrame', () => {
  it('matches the alpha/beta formula from 00-architecture.md section 3.5', () => {
    const frame: AirspeedFrame = { alpha: 0, beta: 0, Vt: 0, mach: 0, qBar: 0 };
    // Body frame == world frame (identity rot), no wind.
    computeAirspeedFrame({ x: 100, y: -10, z: 5 }, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0 }, 1.225, 340, frame);
    const Vt = Math.sqrt(100 * 100 + 10 * 10 + 5 * 5);
    expect(frame.Vt).toBeCloseTo(Vt, 9);
    expect(frame.alpha).toBeCloseTo(Math.atan2(10, 100), 9);
    expect(frame.beta).toBeCloseTo(Math.asin(5 / Vt), 9);
  });
});
