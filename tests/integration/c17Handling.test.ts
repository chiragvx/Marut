/**
 * tests/integration/c17Handling.test.ts — the C-17's handling, flown: roll rate and time to 45 deg
 * of bank, pitch-rate response, the load factor it can pull at typical speeds, sustained level
 * turns at 250 KIAS low down, hands-off stability, and its CG for empty/typical/maximum loads.
 *
 * Targets [E] for a heavy FBW transport the C-17's size (docs/spec/c17-data.md 4.2-4.3): a 20 deg/s
 * roll-rate command, +2.5 g clean, comfortable 45-60 deg banked turns, display flying near 2.25 g.
 * The pitch-rate ceiling must never be what stops a turn: the g limit (fast) or the alpha limiter
 * (slow, heavy) must be. Before the fix a flat 6 deg/s pitch-rate cap held a 200 t C-17 to ~1.7 g
 * at 250 KIAS and it lost ~1,000 m in a 60 deg banked turn it should hold.
 */
import { describe, expect, test } from 'vitest';
import { c17Definition as def } from '../../src/aircraft/c17Definition';
import { cgMacFraction } from '../../src/aircraft/massModel';
import { type AircraftTelemetry, type EntityState, type PilotInputs } from '../../src/contracts/core';
import { Quat } from '../../src/math';
import { computeTelemetry, resetFcsTrimState, stepAircraft } from '../../src/physics';
import { aircraftMassKg, massModelInertia } from '../../src/physics/integrator';
import { buildWorldDependencies, createWorld } from '../../src/core';
import { freeFlightMission } from '../../src/core/missions/catalogue';
import { TRANSPORT_PRESETS, withTransportLoad } from '../../src/ui/transportLoad';
import { buildTrimEnvironment, makeFullHealthDamageState } from '../../tools/lib/trimSolver';

const DEG = Math.PI / 180;
const DT = 1 / 60;
const KT = 0.514444;
const clamp1 = (x: number): number => Math.max(-1, Math.min(1, x));

function airborne(massKg: number, altM: number, tasMps: number, cargoKg = 0): EntityState {
  const rot = { x: 0, y: 0, z: 0, w: 1 };
  Quat.fromYawPitchRoll(0, 3 * DEG, 0, rot);
  return {
    id: 0, kind: 'aircraft', team: 0, pos: { x: 0, y: altM, z: 0 }, rot, vel: { x: 0, y: 0, z: -tasMps }, omega: { x: 0, y: 0, z: 0 },
    alive: true, hp: 100, fuelKg: massKg - def.emptyMassKg - cargoKg, elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0.4,
    afterburnerOn: false, flags: 0, flapDetent: 0, flapPos: 0, slatPos: 0, ...(cargoKg > 0 ? { cargoMassKg: cargoKg, cargoCgBodyX: 0 } : {}),
  };
}

function inputs(throttle: number): PilotInputs {
  return { pitch: 0, roll: 0, yaw: 0, throttle, afterburner: false, brakes: 0, gearDown: false, airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, nwsEnabled: true };
}

type Control = (t: number, s: EntityState, i: PilotInputs, tel: AircraftTelemetry) => void;
type Watch = (t: number, s: EntityState, tel: AircraftTelemetry) => void;

/** Flies `seconds` at 60 Hz from a copy of `s0`; `control` sets the inputs, `watch` sees each tick. */
function fly(s0: EntityState, seconds: number, i: PilotInputs, control: Control, watch?: Watch): EntityState {
  resetFcsTrimState(0);
  let s = structuredClone(s0);
  let o = structuredClone(s0);
  const dmg = makeFullHealthDamageState();
  const tel = {} as AircraftTelemetry;
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    const env = buildTrimEnvironment(s.pos.y);
    computeTelemetry(s, def, env as never, dmg, tel);
    control(k * DT, s, i, tel);
    stepAircraft(s, dmg, i, env as never, def, DT, o);
    [s, o] = [o, s];
    computeTelemetry(s, def, buildTrimEnvironment(s.pos.y) as never, dmg, tel);
    watch?.((k + 1) * DT, s, tel);
  }
  return s;
}

/** Level, wings-level trim at `kias` (stick holds height, throttle the speed), stick eased to centre. */
function trimmed(massKg: number, altM: number, kias: number, cargoKg = 0): EntityState {
  const tas = (kias * KT) / Math.sqrt(buildTrimEnvironment(altM).airDensityKgM3 / 1.225);
  const i = inputs(0.4);
  let thrI = 0.4;
  const s = fly(airborne(massKg, altM, tas, cargoKg), 60, i, (t, st, inp, tel) => {
    inp.pitch = (t < 50 ? 1 : (60 - t) / 10) * clamp1(0.02 * (altM - st.pos.y) - 0.05 * tel.vspeedMps);
    const e = kias * KT - tel.iasMps;
    thrI = Math.max(0, Math.min(1, thrI + DT * 0.004 * e));
    inp.throttle = Math.max(0, Math.min(1, thrI + 0.02 * e));
  });
  s.throttle = i.throttle;
  return s;
}

/** Full roll stick from trim: peak roll rate (deg/s) and time to 45 deg of bank (s). */
function rollIn(s0: EntityState): { pDeg: number; t45: number } {
  let p = 0;
  let t45 = Infinity;
  fly(s0, 6, inputs(s0.throttle), (_t, _s, i) => (i.roll = 1), (t, s, tel) => {
    p = Math.max(p, s.omega.x / DEG);
    if (t45 === Infinity && tel.rollRad > 45 * DEG) t45 = t;
  });
  return { pDeg: p, t45 };
}

/** Rolls to `bankDeg`, then full aft stick at t = 5 s: peak g, time from the pull to 2 g, peak alpha. */
function bankAndPull(s0: EntityState, bankDeg: number): { g: number; t2g: number; alphaDeg: number; stalled: boolean } {
  let g = 0;
  let t2g = Infinity;
  let alpha = 0;
  let stalled = false;
  fly(s0, 12, inputs(s0.throttle), (t, s, i, tel) => {
    i.roll = clamp1(0.08 * (bankDeg - tel.rollRad / DEG) - 0.03 * (s.omega.x / DEG));
    i.pitch = t >= 5 ? 1 : 0;
  }, (t, _s, tel) => {
    if (t < 5) return;
    g = Math.max(g, tel.gLoad);
    alpha = Math.max(alpha, tel.alphaRad / DEG);
    stalled ||= tel.stalled;
    if (t2g === Infinity && tel.gLoad >= 2) t2g = t - 5;
  });
  return { g, t2g, alphaDeg: alpha, stalled };
}

/** A level turn at `bankDeg` for 60 s: stick holds height, throttle holds `kias`. Means over the last 20 s. */
function levelTurn(s0: EntityState, kias: number, bankDeg: number): { g: number; throttle: number; altErr: number; iasErr: number; turnDegS: number } {
  let pI = 0;
  let thI = s0.throttle;
  let n = 0;
  let g = 0;
  let thr = 0;
  let altErr = 0;
  let iasErr = 0;
  let yawRate = 0;
  fly(s0, 60, inputs(s0.throttle), (_t, s, i, tel) => {
    i.roll = clamp1(0.08 * (bankDeg - tel.rollRad / DEG) - 0.03 * (s.omega.x / DEG));
    const e = 0.01 * (s0.pos.y - s.pos.y) - 0.05 * tel.vspeedMps;
    pI = clamp1(pI + DT * 0.3 * e);
    i.pitch = clamp1(pI + 2 * e);
    const ev = kias * KT - tel.iasMps;
    thI = Math.max(0, Math.min(1, thI + DT * 0.004 * ev));
    i.throttle = Math.max(0, Math.min(1, thI + 0.02 * ev));
  }, (t, s, tel) => {
    if (t <= 40) return;
    n++;
    g += tel.gLoad;
    thr += s.throttle;
    altErr = Math.max(altErr, Math.abs(s.pos.y - s0.pos.y));
    iasErr = Math.max(iasErr, Math.abs(tel.iasMps / KT - kias));
    // World-frame turn rate (heading change), from the world-y angular velocity.
    yawRate += Math.abs(worldYawRate(s));
  });
  return { g: g / n, throttle: thr / n, altErr, iasErr, turnDegS: yawRate / n / DEG };
}

/** Rate of change of heading, rad/s: the world-vertical component of the body rates. */
function worldYawRate(s: EntityState): number {
  const w = { x: 0, y: 0, z: 0 };
  Quat.rotate(s.rot, s.omega, w);
  return w.y;
}

describe('C-17 handling', () => {
  // 200 t (72 t of fuel, no cargo), 500 m, 250 KIAS: a typical low-level tactical case.
  const typical = trimmed(200000, 500, 250);

  test('roll: ~20 deg/s at full stick, 45 deg of bank in under 3.2 s', () => {
    const r = rollIn(typical);
    console.log(`roll 200 t 250 KIAS: peak ${r.pDeg.toFixed(1)} deg/s, 45 deg bank in ${r.t45.toFixed(2)} s`);
    expect(r.pDeg).toBeGreaterThan(18);
    expect(r.pDeg).toBeLessThan(21.5);
    expect(r.t45).toBeLessThan(3.2);
    // Heavy (MTOW with cargo): the same command, a little slower to build.
    const heavy = rollIn(trimmed(265000, 500, 250, 50000));
    expect(heavy.pDeg).toBeGreaterThan(17);
    expect(heavy.t45).toBeLessThan(3.5);
  }, 60000);

  test('pitch: a full pull reaches the 2.5 g limit at 300 KIAS without passing it, 2 g within 2 s', () => {
    const r = bankAndPull(trimmed(200000, 500, 300), 60);
    console.log(`pull 200 t 300 KIAS 60 deg bank: max ${r.g.toFixed(2)} g, 2 g after ${r.t2g.toFixed(2)} s, alpha ${r.alphaDeg.toFixed(1)} deg`);
    expect(r.g).toBeGreaterThan(2.4);
    expect(r.g).toBeLessThan(2.6);
    expect(r.t2g).toBeLessThan(2);
    expect(r.stalled).toBe(false);
  }, 60000);

  test('pitch rate: a wings-level pull at 250 KIAS rotates at more than the old 6 deg/s ceiling', () => {
    let q = 0;
    fly(typical, 3, inputs(typical.throttle), (_t, _s, i) => (i.pitch = 1), (_t, s) => (q = Math.max(q, s.omega.z / DEG)));
    console.log(`wings-level pull 200 t 250 KIAS: peak pitch rate ${q.toFixed(1)} deg/s`);
    expect(q).toBeGreaterThan(6);
    expect(q).toBeLessThan(10);
  }, 60000);

  test('achievable g at 250 KIAS: alpha-limited above 2.15 g at 200 t, the full 2.5 g light', () => {
    const mid = bankAndPull(typical, 60);
    const light = bankAndPull(trimmed(145000, 500, 250), 60);
    console.log(`pull 250 KIAS 60 deg bank: 200 t ${mid.g.toFixed(2)} g (alpha ${mid.alphaDeg.toFixed(1)}), 145 t ${light.g.toFixed(2)} g`);
    expect(mid.g).toBeGreaterThan(2.15);
    expect(mid.stalled).toBe(false);
    expect(light.g).toBeGreaterThan(2.4);
    expect(light.g).toBeLessThan(2.6);
  }, 60000);

  test('sustained level turns at 250 KIAS, 500 m: 45 deg easily, 60 deg (2 g) held', () => {
    const t45 = levelTurn(typical, 250, 45);
    const t60 = levelTurn(typical, 250, 60);
    console.log(`level turn 200 t 250 KIAS: 45 deg ${t45.g.toFixed(2)} g thr ${t45.throttle.toFixed(2)} alt err ${t45.altErr.toFixed(0)} m ${t45.turnDegS.toFixed(1)} deg/s; 60 deg ${t60.g.toFixed(2)} g thr ${t60.throttle.toFixed(2)} alt err ${t60.altErr.toFixed(0)} m ias err ${t60.iasErr.toFixed(0)} kt ${t60.turnDegS.toFixed(1)} deg/s`);
    expect(t45.altErr).toBeLessThan(20);
    expect(t45.throttle).toBeLessThan(0.6);
    expect(t45.turnDegS).toBeGreaterThan(4);
    expect(t60.altErr).toBeLessThan(60);
    expect(t60.iasErr).toBeLessThan(20);
    expect(t60.g).toBeGreaterThan(1.85);
    expect(t60.turnDegS).toBeGreaterThan(6.3);
    // Light (display weight): the 60 deg turn with power in hand.
    const light = levelTurn(trimmed(145000, 500, 250), 250, 60);
    expect(light.altErr).toBeLessThan(25);
    expect(light.throttle).toBeLessThan(0.9);
  }, 120000);

  test('hands-off: trimmed level flight stays put for 30 s', () => {
    let maxBank = 0;
    let th0 = NaN;
    let dTheta = 0;
    const s = fly(typical, 30, inputs(typical.throttle), () => undefined, (_t, _s, tel) => {
      maxBank = Math.max(maxBank, Math.abs(tel.rollRad));
      if (Number.isNaN(th0)) th0 = tel.pitchRad;
      dTheta = Math.max(dTheta, Math.abs(tel.pitchRad - th0));
    });
    console.log(`hands-off 30 s: height ${(s.pos.y - typical.pos.y).toFixed(1)} m, pitch drift ${(dTheta / DEG).toFixed(2)} deg, bank ${(maxBank / DEG).toFixed(2)} deg`);
    expect(Math.abs(s.pos.y - typical.pos.y)).toBeLessThan(40);
    expect(dTheta).toBeLessThan(2 * DEG);
    expect(maxBank).toBeLessThan(1 * DEG);
  }, 60000);

  test('CG within the 20-40% MAC envelope empty, typical and at maximum load', () => {
    const [lo, hi] = def.massModel!.cgRangeMac!;
    const cases: [string, number, number][] = [
      ['empty', 0, 0],
      ['typical', 72000, 0],
      ['full fuel', def.maxFuelKg, 0],
      ['max payload', def.maxTakeoffMassKg - def.emptyMassKg - def.massModel!.maxCargoKg, def.massModel!.maxCargoKg],
      ['MTOW full fuel', def.maxFuelKg, def.maxTakeoffMassKg - def.emptyMassKg - def.maxFuelKg],
    ];
    for (const [name, fuel, cargo] of cases) {
      const cg = cgMacFraction(def, fuel, cargo)!;
      expect(cg, name).toBeGreaterThanOrEqual(lo);
      expect(cg, name).toBeLessThanOrEqual(hi);
    }
  });

  test('the chosen load reaches the sim: mass, CG and inertia follow fuel and cargo', () => {
    const calm = { windWorldMps: { x: 0, y: 0, z: 0 }, gustMps: 0, turbulence: 0 };
    const spawn = (presetId: string): EntityState => {
      const p = TRANSPORT_PRESETS.find((x) => x.id === presetId)!;
      const mission = { ...withTransportLoad(freeFlightMission('bathinda', 'runway', 'c-17'), p), weather: calm };
      const world = createWorld(buildWorldDependencies(mission));
      world.loadMission(mission);
      const id = world.getPlayerEntityId();
      world.stepOnce();
      return world.getEntityState(id)! as EntityState;
    };
    const light = spawn('display');
    const heavy = spawn('max');
    expect(light.fuelKg).toBeCloseTo(def.maxFuelKg * 0.15, -2);
    expect(light.cargoMassKg ?? 0).toBe(0);
    expect(heavy.cargoMassKg).toBe(def.massModel!.maxCargoKg);
    expect(aircraftMassKg(heavy, def)).toBeGreaterThan(260000);
    expect(aircraftMassKg(light, def)).toBeLessThan(150000);
    const iL = massModelInertia(light, def, { xx: 0, yy: 0, zz: 0, xy: 0, xz: 0, yz: 0 });
    const iH = massModelInertia(heavy, def, { xx: 0, yy: 0, zz: 0, xy: 0, xz: 0, yz: 0 });
    expect(iH.xx).toBeGreaterThan(iL.xx * 1.2);
    expect(iH.zz).toBeGreaterThan(iL.zz * 1.3);
    expect(cgMacFraction(def, heavy.fuelKg, heavy.cargoMassKg)).not.toBeCloseTo(cgMacFraction(def, light.fuelKg, 0)!, 3);
  }, 60000);
});
