/**
 * tests/integration/c17Performance.test.ts — the C-17A (src/aircraft/c17Data.ts) against its
 * performance targets (tools/lib/perfTargets.ts C17_PERFORMANCE_TARGETS, from
 * docs/spec/c17-data.md section 10) and flown checks the target kinds cannot express: engine-out
 * controllability, the FCS protections (alpha, pitch attitude, bank), the 3-degree approach on
 * the blown flaps, flap timing and placards, reversers, the hot-day thrust loss, cargo, and that
 * none of the transport inputs reach the fighters.
 */
import { describe, expect, test } from 'vitest';
import { tejasDefinition } from '../../src/aircraft';
import { c17Definition as def } from '../../src/aircraft/c17Definition';
import { isaAtmosphereInto } from '../../src/core/atmosphere';
import type { AircraftDefinition } from '../../src/contracts/aircraft';
import type { AircraftTelemetry, EntityState, PilotInputs } from '../../src/contracts/core';
import { TransportWarning } from '../../src/contracts/core';
import { Quat } from '../../src/math';
import { computeTelemetry, loadCargo, releaseCargo, resetFcsTrimState, stepAircraft } from '../../src/physics';
import { aircraftMassKg } from '../../src/physics/integrator';
import { configuredStallAlphaRad } from '../../src/physics/highLift';
import { hotDayThrustFactor } from '../../src/physics/engines';
import { buildTrimEnvironment, checkPerformanceTarget, makeFullHealthDamageState } from '../../tools/lib/trimSolver';
import { C17_PERFORMANCE_TARGETS } from '../../tools/lib/perfTargets';
import { formatPerformanceTable } from '../../tools/lib/table';

const DEG = Math.PI / 180;
const DT = 1 / 60;

/** A C-17 in level flight heading north (-z) at `tasMps`, `massKg` (fuel makes up the mass). */
function airborne(massKg: number, altM: number, tasMps: number, flap: number, pitchDeg: number, throttle: number): EntityState {
  const rot = { x: 0, y: 0, z: 0, w: 1 };
  Quat.fromYawPitchRoll(0, pitchDeg * DEG, 0, rot);
  return {
    id: 0, kind: 'aircraft', team: 0, pos: { x: 0, y: altM, z: 0 }, rot, vel: { x: 0, y: 0, z: -tasMps }, omega: { x: 0, y: 0, z: 0 },
    alive: true, hp: 100, fuelKg: massKg - def.emptyMassKg, elevonL: 0, elevonR: 0, rudder: 0, gearPos: flap >= 3 ? 1 : 0, throttle,
    afterburnerOn: false, flags: 0, flapDetent: flap, flapPos: flap, slatPos: flap > 0 ? 1 : 0,
  };
}

function inputs(over: Partial<PilotInputs> = {}): PilotInputs {
  return {
    pitch: 0, roll: 0, yaw: 0, throttle: 0.5, afterburner: false, brakes: 0, gearDown: false, airbrake: false,
    trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, nwsEnabled: true, ...over,
  };
}

type Control = (t: number, s: EntityState, i: PilotInputs, tel: AircraftTelemetry) => void;

/** Flies `seconds` of 60 Hz steps; `control` sets the inputs from the last telemetry; `watch` sees every tick. */
function fly(s0: EntityState, seconds: number, i: PilotInputs, control: Control, watch?: (s: EntityState, tel: AircraftTelemetry) => void, d: AircraftDefinition = def): EntityState {
  resetFcsTrimState(0);
  let s = s0;
  let o: EntityState = structuredClone(s0);
  const dmg = makeFullHealthDamageState();
  const tel = {} as AircraftTelemetry;
  const n = Math.round(seconds / DT);
  for (let k = 0; k < n; k++) {
    const env = buildTrimEnvironment(s.pos.y);
    computeTelemetry(s, d, env as never, dmg, tel);
    control(k * DT, s, i, tel);
    stepAircraft(s, dmg, i, env as never, d, DT, o);
    [s, o] = [o, s];
    watch?.(s, tel);
  }
  computeTelemetry(s, d, buildTrimEnvironment(s.pos.y) as never, dmg, tel);
  watch?.(s, tel);
  return s;
}

/** Pitch for airspeed (stick from the IAS error), as a pilot or the climb harness flies it. */
function holdIas(i: PilotInputs, tel: AircraftTelemetry, iasMps: number): void {
  i.pitch = Math.max(-1, Math.min(1, 0.05 * (tel.iasMps - iasMps) + 0.3 * tel.vspeedMps * 0));
}

describe('C-17A flight data', () => {
  test(
    'meets its performance targets',
    () => {
      const results = C17_PERFORMANCE_TARGETS.map((t) => checkPerformanceTarget(stepAircraft, def, t));
      console.log(`\n${formatPerformanceTable(results)}`);
      const failing = results.filter((r) => !r.passed);
      expect(failing, `\n${formatPerformanceTable(results)}\n\nFailing: ${failing.map((r) => r.target.id).join(', ')}`).toEqual([]);
    },
    180000
  );

  /** Engine 1 (left outboard) fails at t = 5 s in a 200 t, flaps 1/2, TOGA climb-out at ~150 KIAS. */
  function engineOut(levelWings: boolean) {
    const i = inputs({ throttle: 1, flapLever: 2 });
    let maxBank = 0;
    let maxBeta = 0;
    let hdg0: number | undefined;
    let maxHdgDev = 0;
    let maxRollStick = 0;
    let vsSum = 0;
    let vsN = 0;
    let time = 0;
    const s = fly(airborne(200000, 1000, 80, 2, 5, 1), 60, i, (t, st, inp, tel) => {
      time = t;
      holdIas(inp, tel, 77);
      if (levelWings) {
        // A pilot's gentle wings-level correction: 0.03 stick per degree of bank.
        inp.roll = Math.max(-1, Math.min(1, (-0.03 * tel.rollRad) / DEG));
        if (t >= 5) maxRollStick = Math.max(maxRollStick, Math.abs(inp.roll));
      }
      if (t >= 5 && st.engines) st.engines[0]!.failed = true;
    }, (st, tel) => {
      if (!st.engines?.[0]?.failed) return;
      hdg0 ??= tel.headingRad;
      maxBank = Math.max(maxBank, Math.abs(tel.rollRad));
      maxBeta = Math.max(maxBeta, Math.abs(tel.betaRad));
      const dh = tel.headingRad - hdg0;
      maxHdgDev = Math.max(maxHdgDev, Math.abs(Math.atan2(Math.sin(dh), Math.cos(dh))));
      if (time > 30) {
        vsSum += tel.vspeedMps;
        vsN++;
      }
    });
    return { s, maxBank, maxBeta, maxHdgDev, maxRollStick, climbMps: vsSum / vsN };
  }

  test('an outboard engine failure at take-off thrust: hands-off the FCS holds it (rudder trims, bank held)', () => {
    const r = engineOut(false);
    console.log(`engine out, hands off: max bank ${(r.maxBank / DEG).toFixed(1)} deg, max beta ${(r.maxBeta / DEG).toFixed(1)} deg, heading drift ${(r.maxHdgDev / DEG).toFixed(1)} deg, rudder ${(r.s.rudder / DEG).toFixed(1)} deg, mean climb ${r.climbMps.toFixed(1)} m/s`);
    expect(r.maxBank).toBeLessThan(15 * DEG);
    expect(r.maxBeta).toBeLessThan(8 * DEG);
    // Engine 1 is on the left: the yaw is to the left, held with right (negative) rudder, inside its travel.
    expect(r.s.rudder).toBeLessThan(-2 * DEG);
    expect(r.s.rudder).toBeGreaterThan(-def.fcsLimits.maxRudderRad * 0.8);
    // Still climbing on three engines.
    expect(r.climbMps).toBeGreaterThan(2);
  }, 60000);

  test('an outboard engine failure: a gentle wings-level input holds the heading', () => {
    const r = engineOut(true);
    console.log(`engine out, wings levelled: max bank ${(r.maxBank / DEG).toFixed(1)} deg, heading drift ${(r.maxHdgDev / DEG).toFixed(1)} deg, max roll stick ${r.maxRollStick.toFixed(2)}`);
    expect(r.maxBank).toBeLessThan(10 * DEG);
    expect(r.maxHdgDev).toBeLessThan(20 * DEG);
    expect(r.maxRollStick).toBeLessThan(0.35);
  }, 60000);

  test('full aft stick: the alpha limiter holds below the stall and the pitch attitude stays near +25 deg', () => {
    let maxAlpha = 0;
    let maxPitch = 0;
    let stalled = false;
    let warned = false;
    fly(airborne(200000, 3000, 140, 0, 2, 0.6), 40, inputs({ throttle: 0.6 }), (t, _s, i) => {
      i.pitch = t > 2 ? 1 : 0;
    }, (_s, tel) => {
      maxAlpha = Math.max(maxAlpha, tel.alphaRad);
      maxPitch = Math.max(maxPitch, tel.pitchRad);
      stalled ||= tel.stalled;
      warned ||= tel.stallWarning ?? false;
    });
    // Idle, slats out, full flaps: the slowest case.
    let maxAlphaFlap = 0;
    fly(airborne(160000, 1000, 75, 4, 3, 0), 50, inputs({ throttle: 0, flapLever: 4, gearDown: true }), (t, _s, i) => {
      i.pitch = t > 2 ? 1 : 0;
    }, (_s, tel) => {
      maxAlphaFlap = Math.max(maxAlphaFlap, tel.alphaRad);
      stalled ||= tel.stalled;
    });
    console.log(`full pull: max alpha clean ${(maxAlpha / DEG).toFixed(1)}, flaps FULL idle ${(maxAlphaFlap / DEG).toFixed(1)}, max pitch ${(maxPitch / DEG).toFixed(1)} deg`);
    expect(stalled).toBe(false);
    expect(warned).toBe(true); // the shaker comes on before the limit
    expect(maxAlpha).toBeLessThan(configuredStallAlphaRad(def, 0.3, 0, 0, 0));
    expect(maxAlphaFlap).toBeLessThan(configuredStallAlphaRad(def, 0.2, 4, 0, 0));
    expect(maxPitch).toBeLessThan(29 * DEG);
  }, 60000);

  test('bank protection: full roll stops at the 70 deg limit', () => {
    let maxBank = 0;
    fly(airborne(200000, 3000, 140, 0, 2, 0.6), 15, inputs({ throttle: 0.6 }), (_t, _s, i) => {
      i.roll = 1;
    }, (_s, tel) => {
      maxBank = Math.max(maxBank, Math.abs(tel.rollRad));
    });
    expect(maxBank).toBeGreaterThan(65 * DEG);
    expect(maxBank).toBeLessThan(73 * DEG);
  }, 60000);

  test('a 3-degree approach on full flaps trims near the published 115 kt with part power', () => {
    // 160 t, FULL, gear down, ~115 KIAS; throttle flies the 3-degree path, stick holds the speed.
    let thrSum = 0;
    let alphaSum = 0;
    let n = 0;
    const i = inputs({ throttle: 0.5, flapLever: 4, gearDown: true });
    fly(airborne(160000, 1000, 61, 4, 3, 0.5), 90, i, (t, _s, inp, tel) => {
      holdIas(inp, tel, 59.2);
      const vsTarget = -tel.tasMps * Math.sin(3 * DEG);
      inp.throttle = Math.max(0, Math.min(1, inp.throttle + DT * 0.05 * (vsTarget - tel.vspeedMps)));
      if (t > 60) {
        thrSum += inp.throttle;
        alphaSum += tel.alphaRad;
        n++;
      }
    });
    const thr = thrSum / n;
    const alpha = alphaSum / n;
    console.log(`approach FULL 160 t 115 KIAS 3 deg: throttle ${thr.toFixed(2)}, alpha ${(alpha / DEG).toFixed(1)} deg`);
    expect(thr).toBeGreaterThan(0.15);
    expect(thr).toBeLessThan(0.85);
    expect(alpha).toBeLessThan(configuredStallAlphaRad(def, 0.2, 4, 0, 0) * 0.8);
  }, 60000);

  test('flaps take real time, and a flap overspeed is flagged', () => {
    let fullAt = -1;
    let overspeed = false;
    fly(airborne(200000, 2000, 120, 0, 2, 0.6), 40, inputs({ throttle: 0.6 }), (_t, _s, i) => {
      i.flapLever = 4;
    }, (s, tel) => {
      if (fullAt < 0 && (s.flapPos ?? 0) >= 4) fullAt = 1;
      if (((tel.limitWarnings ?? 0) & TransportWarning.FlapOverspeed) !== 0) overspeed = true;
    });
    // Slats (5 s) then three flap detents at 6 s each.
    let t = 0;
    let s = airborne(200000, 2000, 120, 0, 2, 0.6);
    s = fly(s, 15, inputs({ throttle: 0.6, flapLever: 4 }), () => undefined);
    t = s.flapPos ?? 0;
    expect(t).toBeLessThan(4);
    expect(fullAt).toBe(1);
    expect(overspeed).toBe(true);
  }, 60000);

  test('reversers: full reverse on the ground, idle reverse only in flight', () => {
    const ground = airborne(160000, -Math.min(...def.gear.map((g) => g.posBodyM.y)), 60, 4, 0, 0);
    ground.gearPos = 1;
    const sGround = fly(ground, 5, inputs({ throttle: 0, reverseThrust: true, flapLever: 4, gearDown: true, brakes: 1 }), () => undefined);
    const revGround = sGround.engines!.reduce((a, e) => a + e.thrustN, 0);
    expect(sGround.engines!.every((e) => e.reverserPos >= 1)).toBe(true);
    expect(revGround).toBeLessThan(-100e3);
    expect(sGround.spoilerPos ?? 0).toBeGreaterThan(0.9); // ground lift dump
    const sAir = fly(airborne(200000, 3000, 140, 0, 2, 0), 5, inputs({ throttle: 1, reverseThrust: true }), () => undefined);
    // In flight the levers are held at idle while the reversers are out (idle reverse).
    expect(sAir.engines!.every((e) => e.n1 < 0.5)).toBe(true);
  }, 60000);

  test('engines spool from flight idle to 95% N1 within 5 s (pack 10)', () => {
    let at95 = -1;
    let time = 0;
    fly(airborne(200000, 3000, 140, 0, 2, 0), 8, inputs({ throttle: 0 }), (t, _s, i) => {
      i.throttle = t >= 3 ? 1 : 0;
      time = t;
    }, (s) => {
      if (at95 < 0 && time >= 3 && s.engines!.every((e) => e.n1 >= 0.95)) at95 = time - 3;
    });
    expect(at95).toBeGreaterThan(1);
    expect(at95).toBeLessThan(5);
  }, 60000);

  test('a hot day: thin air and flat-rated thrust loss (ISA+30 at Leh)', () => {
    const std = { airDensityKgM3: 0, soundSpeedMps: 0 };
    const hot = { airDensityKgM3: 0, soundSpeedMps: 0 };
    isaAtmosphereInto(3256, std);
    isaAtmosphereInto(3256, hot, 30);
    expect(hot.airDensityKgM3 / std.airDensityKgM3).toBeCloseTo(266.99 / 296.99, 3);
    expect(hotDayThrustFactor(def, 10)).toBe(1); // flat-rated to ISA+15
    expect(hotDayThrustFactor(def, 30)).toBeCloseTo(1 - 0.0075 * 15, 6);
    expect(hotDayThrustFactor(tejasDefinition, 30)).toBe(1); // no hot-day model on the fighters
  });

  test('cargo: mass, and an airdrop through the open ramp', () => {
    const s = airborne(180000, 3000, 120, 0, 2, 0.5);
    const m0 = aircraftMassKg(s, def);
    loadCargo(s, def, 30000);
    expect(aircraftMassKg(s, def) - m0).toBeCloseTo(30000, 6);
    loadCargo(s, def, 1e6);
    expect(s.cargoMassKg).toBe(def.massModel!.maxCargoKg);
    loadCargo(s, def, 20000);
    expect(releaseCargo(s)).toBe(0); // ramp closed
    s.rampPos = 1;
    expect(releaseCargo(s, 5000)).toBe(5000);
    expect(s.cargoMassKg).toBe(15000);
  });

  test('the transport inputs never reach a fighter', () => {
    const tejasStart = (): EntityState => ({
      id: 0, kind: 'aircraft', team: 0, pos: { x: 0, y: 3000, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: 0, z: -200 },
      omega: { x: 0, y: 0, z: 0 }, alive: true, hp: 100, fuelKg: 2000, elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0.8,
      afterburnerOn: false, flags: 0,
    });
    const plain = fly(tejasStart(), 10, inputs({ throttle: 0.8 }), (t, _s, i) => (i.pitch = t > 2 ? 0.3 : 0), undefined, tejasDefinition);
    const withTransport = fly(tejasStart(), 10, inputs({ throttle: 0.8, flapLever: 4, reverseThrust: true, rampOpen: true }), (t, _s, i) => (i.pitch = t > 2 ? 0.3 : 0), undefined, tejasDefinition);
    expect(withTransport).toEqual(plain);
    expect(plain.engines).toBeUndefined();
    expect(plain.flapPos).toBeUndefined();
  }, 60000);
});
