/**
 * tests/integration/c17Stol.test.ts — the C-17's thrust and short-field (STOL) performance, flown
 * headlessly against published figures (docs/spec/c17-data.md section 12 has the sources, the
 * confidence of each number and the comparison table this prints).
 *
 * The harness flies the flight model (stepAircraft, 60 Hz) on a flat runway at a field elevation
 * and ISA deviation, with a simple autopilot standing in for the pilot:
 *   take-off: brakes held while the engines spool to TOGA, release, rotate at VR to a target pitch
 *     attitude (the FCS ground-rotation law sets the rate), hold it; measured: ground roll to
 *     lift-off (main wheels unloaded) and distance to 50 ft (main wheels 15.24 m up).
 *   landing: established on a glidepath (3 or 5 deg) to an aim point, flaps FULL, gear down; the
 *     stick holds the approach speed, the throttle flies the path (the powered-lift technique:
 *     thrust moves the flight path at once through the blown flaps); at the flare height the
 *     throttles close and the stick arrests the sink; at touchdown full reverse, maximum braking,
 *     lift dump (automatic). Measured: distance from 50 ft to the stop, ground roll, touchdown
 *     speed and sink rate.
 * Distances are along the runway (world -z). All speeds IAS (= EAS here) unless marked TAS.
 */
import { describe, expect, test } from 'vitest';
import { c17Definition as def } from '../../src/aircraft/c17Definition';
import type { Environment } from '../../src/contracts/flight';
import { EntityFlag, type AircraftTelemetry, type EntityState, type PilotInputs } from '../../src/contracts/core';
import { isaAtmosphereInto } from '../../src/core/atmosphere';
import { Quat } from '../../src/math';
import { computeTelemetry, resetFcsTrimState, stepAircraft } from '../../src/physics';
import { aircraftMassKg } from '../../src/physics/integrator';
import { totalThrustAvailableN } from '../../src/physics/engines';
import { configuredClMax, makeFullHealthDamageState } from '../../tools/lib/trimSolver';

const DEG = Math.PI / 180;
const DT = 1 / 60;
const KT = 0.514444;
const FT = 0.3048;
const G = 9.80665;
const H50 = 50 * FT;
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

interface Field {
  elevM: number;
  isaDevK: number;
}
const SEA_LEVEL: Field = { elevM: 0, isaDevK: 0 };
/** Ngari Gunsa / Fukche class: 4,270 m, ISA+15 (a mild afternoon there; docs/spec/himalaya-theatre.md 4.2). */
const HIGH_FIELD: Field = { elevM: 4270, isaDevK: 15 };

const isa = { airDensityKgM3: 0, soundSpeedMps: 0 };
function envAt(f: Field, altM: number): Environment {
  isaAtmosphereInto(altM, isa, f.isaDevK);
  return {
    airDensityKgM3: isa.airDensityKgM3,
    soundSpeedMps: isa.soundSpeedMps,
    windWorldMps: { x: 0, y: 0, z: 0 },
    gravityMps2: G,
    groundElevationM: f.elevM,
    groundNormalWorld: { x: 0, y: 1, z: 0 },
    isaDeviationK: f.isaDevK,
  } as Environment;
}

/** Fuel up to the ER tanks' capacity, the rest of the mass as cargo (loaded to the CG). */
function loadFor(massKg: number): { fuelKg: number; cargoKg: number } {
  const useful = massKg - def.emptyMassKg;
  const fuelKg = Math.min(def.maxFuelKg, useful);
  return { fuelKg, cargoKg: useful - fuelKg };
}

/** A load with a given cargo (payload) and the rest of the mass as fuel. */
function loadWithCargo(massKg: number, cargoKg: number): { fuelKg: number; cargoKg: number } {
  return { fuelKg: massKg - def.emptyMassKg - cargoKg, cargoKg };
}

function baseState(load: { fuelKg: number; cargoKg: number }, posY: number, pitchDeg: number, tasMps: number): EntityState {
  const rot = { x: 0, y: 0, z: 0, w: 1 };
  Quat.fromYawPitchRoll(0, pitchDeg * DEG, 0, rot);
  return {
    id: 0, kind: 'aircraft', team: 0, pos: { x: 0, y: posY, z: 0 }, rot, vel: { x: 0, y: 0, z: -tasMps }, omega: { x: 0, y: 0, z: 0 },
    alive: true, hp: 100, fuelKg: load.fuelKg, elevonL: 0, elevonR: 0, rudder: 0, gearPos: 1, throttle: 0, afterburnerOn: false, flags: 0,
    ...(load.cargoKg > 0 ? { cargoMassKg: load.cargoKg, cargoCgBodyX: 0 } : {}),
  };
}

function inputs(over: Partial<PilotInputs> = {}): PilotInputs {
  return {
    pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 0, gearDown: true, airbrake: false,
    trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, nwsEnabled: true, ...over,
  };
}

const lowestGearY = Math.min(...def.gear.map((g) => g.posBodyM.y));
const mainGear = def.gear.find((g) => g.id === 'mainLeft')!.posBodyM;
const scratchW = { x: 0, y: 0, z: 0 };
/** Height of the main wheels above the runway, m. */
function mainWheelHeight(s: EntityState, f: Field): number {
  Quat.rotate(s.rot, mainGear, scratchW);
  return s.pos.y + scratchW.y - f.elevM;
}

type Control = (t: number, s: EntityState, i: PilotInputs, tel: AircraftTelemetry) => boolean | void;

/** Flies from `s0` until `control` returns true (or `maxSec`). Returns the final state and time. */
function fly(s0: EntityState, f: Field, i: PilotInputs, maxSec: number, control: Control): { s: EntityState; t: number } {
  resetFcsTrimState(0);
  let s = structuredClone(s0);
  let o = structuredClone(s0);
  const dmg = makeFullHealthDamageState();
  const tel = {} as AircraftTelemetry;
  const n = Math.round(maxSec / DT);
  let k = 0;
  for (; k < n; k++) {
    const env = envAt(f, s.pos.y);
    computeTelemetry(s, def, env, dmg, tel);
    if (control(k * DT, s, i, tel) === true) break;
    stepAircraft(s, dmg, i, env, def, DT, o);
    [s, o] = [o, s];
  }
  return { s, t: k * DT };
}

/** Power-off 1 g stall speed (EAS, m/s) at a flap detent, from the model's own configured CLmax. */
function stallEas(massKg: number, detent: number): number {
  return Math.sqrt((2 * massKg * G) / (1.225 * def.wingAreaM2 * configuredClMax(def, detent)));
}

// ---------------------------------------------------------------------------------------------
// Take-off
// ---------------------------------------------------------------------------------------------

export interface TakeoffResult {
  massKg: number;
  vrKias: number;
  liftoffKias: number;
  groundRollM: number;
  to50ftM: number;
  /** Mean climb rate over 10 s after passing 50 ft (gear up at 50 ft), m/s. */
  climbMps: number;
}

/**
 * A static take-off: brakes held at TOGA until the engines reach 95% N1 (or the jet starts to
 * creep), released, rotated at VR = vrFactor x the power-off stall speed in the take-off flap to
 * `pitchDeg`, gear up passing 50 ft.
 */
function takeoff(massKg: number, f: Field, detent = 2, vrFactor = 1.05, pitchDeg = 10, load = loadFor(massKg)): TakeoffResult {
  const s0 = baseState(load, f.elevM - lowestGearY, 0, 0);
  s0.flapDetent = detent;
  s0.flapPos = detent;
  s0.slatPos = detent > 0 ? 1 : 0;
  // Let it settle on its gear first (idle, brakes on).
  const settled = fly(s0, f, inputs({ brakes: 1, flapLever: detent }), 3, () => false).s;
  settled.pos.z = 0;
  settled.vel.z = 0;
  const vr = vrFactor * stallEas(massKg, detent);
  const i = inputs({ throttle: 1, brakes: 1, flapLever: detent });
  let released = false;
  let rotating = false;
  let airborne = false;
  let liftoffZ = NaN;
  let liftoffIas = NaN;
  let z50 = NaN;
  let t50 = NaN;
  let y50 = NaN;
  let climb = NaN;
  fly(settled, f, i, 150, (t, s, inp, tel) => {
    if (!released && (s.engines!.every((e) => e.n1 >= 0.95) || Math.hypot(s.vel.x, s.vel.z) > 0.3)) {
      released = true;
      inp.brakes = 0;
    }
    if (released && !rotating && tel.iasMps >= vr) rotating = true;
    if (rotating) {
      // A positive rotation: full aft stick (the FCS sets the ~3 deg/s rate) to within 2 deg of
      // the target attitude, then hold it (stick from the pitch error, damped by the pitch rate).
      const err = pitchDeg - tel.pitchRad / DEG;
      inp.pitch = err > 2 ? 1 : clamp(0.25 * err - 0.3 * (s.omega.z / DEG) + 0.3, -1, 1);
    }
    const onGround = (s.flags & EntityFlag.OnGround) !== 0;
    if (released && !airborne && !onGround && mainWheelHeight(s, f) > 0.3) {
      airborne = true;
      liftoffZ = -s.pos.z;
      liftoffIas = tel.iasMps;
    }
    if (airborne && Number.isNaN(z50) && mainWheelHeight(s, f) >= H50) {
      z50 = -s.pos.z;
      t50 = t;
      y50 = s.pos.y;
      inp.gearDown = false;
    }
    if (!Number.isNaN(t50) && t >= t50 + 10) {
      climb = (s.pos.y - y50) / (t - t50);
      return true;
    }
    return false;
  });
  return { massKg, vrKias: vr / KT, liftoffKias: liftoffIas / KT, groundRollM: liftoffZ, to50ftM: z50, climbMps: climb };
}

// ---------------------------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------------------------

export interface LandingResult {
  massKg: number;
  vappKias: number;
  gsDeg: number;
  /** From the 50 ft crossing to the stop, m. */
  from50ftM: number;
  /** Touchdown to stop, m. */
  groundRollM: number;
  /** 50 ft to touchdown, m. */
  airM: number;
  tdKias: number;
  tdKtas: number;
  tdSinkFpm: number;
  approachThrottle: number;
  /** Mean deceleration on the roll, g. */
  decelG: number;
}

export interface LandingOptions {
  gsDeg: number;
  vappKias: number;
  /** Main-wheel height at which the throttles close and the flare starts, m. */
  flareM: number;
  reverse: boolean;
  brakes: number;
  load?: { fuelKg: number; cargoKg: number };
}

/**
 * An approach and landing. The aim point is at runway distance 0 (z = 0); the 50 ft point lies
 * 15.24 m / tan(gs) before it. Starts 3.5 km out on the path at the approach speed, FULL flaps.
 */
function landing(massKg: number, f: Field, o: LandingOptions): LandingResult {
  const load = o.load ?? loadFor(massKg);
  const gs = o.gsDeg * DEG;
  const startDist = 3500;
  const env0 = envAt(f, f.elevM);
  const tas0 = (o.vappKias * KT) / Math.sqrt(env0.airDensityKgM3 / 1.225);
  const pathH = (dist: number): number => dist * Math.tan(gs);
  const s0 = baseState(load, f.elevM - lowestGearY + pathH(startDist), 2, tas0);
  s0.vel.y = -tas0 * Math.sin(gs);
  s0.vel.z = -tas0 * Math.cos(gs);
  s0.pos.z = startDist;
  s0.flapDetent = 4;
  s0.flapPos = 4;
  s0.slatPos = 1;
  s0.throttle = 0.4;
  const i = inputs({ throttle: 0.4, flapLever: 4 });
  const vapp = o.vappKias * KT;
  let thrI = 0.4;
  let phase: 'approach' | 'flare' | 'roll' = 'approach';
  let z50 = NaN;
  let zTd = NaN;
  let tTd = NaN;
  let tdIas = NaN;
  let tdTas = NaN;
  let tdSink = NaN;
  let thrSum = 0;
  let thrN = 0;
  let zStop = NaN;
  let tStop = NaN;
  let vTd = NaN;
  fly(s0, f, i, 200, (t, s, inp, tel) => {
    const hWheel = mainWheelHeight(s, f);
    const dist = s.pos.z; // ahead of the aim point
    const onGround = (s.flags & EntityFlag.OnGround) !== 0;
    if (Number.isNaN(z50) && hWheel <= H50) z50 = -s.pos.z;
    if (phase === 'approach') {
      // Stick flies the path (the FCS is pitch-rate command / flight-path hold: stick ~ a change
      // of flight-path angle), aiming at the path plus a height correction.
      const gamma = Math.asin(clamp(tel.vspeedMps / Math.max(1, tel.tasMps), -1, 1));
      const gammaCmd = -gs + clamp(0.004 * (pathH(dist) - hWheel), -2 * DEG, 2 * DEG);
      inp.pitch = clamp((0.25 * (gammaCmd - gamma)) / DEG - 0.04 * (s.omega.z / DEG), -1, 1);
      // Throttle holds the speed (auto-throttle style PI).
      const e = vapp - tel.iasMps;
      thrI = clamp(thrI + DT * 0.015 * e, 0, 1);
      inp.throttle = clamp(thrI + 0.08 * e, 0, 1);
      if (dist < 1500 && dist > 300) {
        thrSum += inp.throttle;
        thrN++;
      }
      if (hWheel <= o.flareM) phase = 'flare';
    }
    if (phase === 'flare') {
      // Power stays on through the flare (it holds the blown lift) and comes off just before the
      // wheels touch; the stick arrests the sink to ~1.5 m/s (300 ft/min): no float.
      inp.throttle = hWheel > 1.5 ? thrI : 0;
      const vsT = -Math.max(1.5, 0.4 * hWheel);
      inp.pitch = clamp(0.25 * (vsT - tel.vspeedMps) - 0.1 * (s.omega.z / DEG), -1, 1);
      if (onGround) {
        phase = 'roll';
        zTd = -s.pos.z;
        tTd = t;
        tdIas = tel.iasMps;
        tdTas = tel.tasMps;
        tdSink = -s.vel.y;
        vTd = Math.hypot(s.vel.x, s.vel.z);
      }
    }
    if (phase === 'roll') {
      inp.throttle = 0;
      inp.reverseThrust = o.reverse && t > tTd + 0.5;
      inp.brakes = t > tTd + 1 ? o.brakes : 0;
      // Fly the nose down onto the runway, then hold it there.
      inp.pitch = -0.3;
      const gsMps = Math.hypot(s.vel.x, s.vel.z);
      // Stop, or (reversers on) the moment the jet stops moving forward.
      if (gsMps < 0.5 || s.vel.z > 0) {
        zStop = -s.pos.z;
        tStop = t;
        return true;
      }
    }
    return false;
  });
  return {
    massKg: aircraftMassKg(s0, def),
    vappKias: o.vappKias,
    gsDeg: o.gsDeg,
    from50ftM: zStop - z50,
    groundRollM: zStop - zTd,
    airM: zTd - z50,
    tdKias: tdIas / KT,
    tdKtas: tdTas / KT,
    tdSinkFpm: (tdSink / FT) * 60,
    approachThrottle: thrSum / Math.max(1, thrN),
    decelG: vTd / (tStop - tTd) / G,
  };
}

/** Approach speed for a mass: the published 115 KIAS taken at 160 t (pack 5.2), scaled with sqrt(W). */
function vappFor(massKg: number): number {
  return 115 * Math.sqrt(massKg / 160000);
}

// ---------------------------------------------------------------------------------------------
// Reverse thrust: deceleration and backing
// ---------------------------------------------------------------------------------------------

/** Full reverse from rest, brakes off, on the flat: the backward acceleration over the first 2 m/s. */
function backing(massKg: number, f: Field): { accelMps2: number; maxSlopePct: number; revThrustKN: number } {
  const s0 = baseState(loadFor(massKg), f.elevM - lowestGearY, 0, 0);
  const settled = fly(s0, f, inputs({ brakes: 1 }), 3, () => false).s;
  settled.vel.x = 0;
  settled.vel.z = 0;
  let tStart = NaN;
  let revN = 0;
  const r = fly(settled, f, inputs({ reverseThrust: true }), 60, (t, s) => {
    if (Number.isNaN(tStart) && s.engines!.every((e) => e.reverserPos >= 1 && e.n1 > 0.95)) {
      tStart = t;
      revN = -s.engines!.reduce((a, e) => a + e.thrustN, 0);
      // Start the timing from rest at full reverse power.
      s.vel.x = 0;
      s.vel.z = 0;
    }
    if (!Number.isNaN(tStart) && s.vel.z >= 2) return true;
    return false;
  });
  const a = r.s.vel.z / (r.t - tStart);
  // On a slope of angle th: m a = F_rev - m g sin th - mu_r N, and on the flat m a0 = F_rev - mu_r m g:
  // so the steepest slope it can still back up (a = 0) has sin th ~ a0 / g.
  return { accelMps2: a, maxSlopePct: (a / G) * 100, revThrustKN: revN / 1000 };
}

/** Reverse alone (no brakes) from 120 KIAS on the roll: the deceleration it gives, g. */
function reverseOnlyDecel(massKg: number): number {
  const r = landing(massKg, SEA_LEVEL, { gsDeg: 3, vappKias: vappFor(massKg), flareM: 9, reverse: true, brakes: 0 });
  return r.decelG;
}

// ---------------------------------------------------------------------------------------------

const fmt = (x: number, d = 0): string => (Number.isFinite(x) ? x.toFixed(d) : '-');

describe('C-17 thrust and STOL performance vs published figures', () => {
  test('engine model: static thrust, lapse with speed and altitude, T/W at MTOW', () => {
    const aSl = 340.29;
    const perEng = (kt: number, alt = 0, dev = 0): number => totalThrustAvailableN(def, (kt * KT) / aSl, alt, dev) / def.engines!.length / 1000;
    const rows = [0, 60, 120, 160].map((kt) => `  ${kt} kt: ${perEng(kt).toFixed(1)} kN/engine (${((perEng(kt) / perEng(0)) * 100).toFixed(0)}%), total ${(perEng(kt) * 4).toFixed(0)} kN`);
    const high = perEng(0, 4270, 15);
    const tw = (4 * perEng(0) * 1000) / (def.maxTakeoffMassKg! * G);
    console.log(`thrust SL ISA:\n${rows.join('\n')}\n  4,270 m ISA+15 static: ${high.toFixed(1)} kN/engine (${((high / perEng(0)) * 100).toFixed(0)}% of SLS)\n  T/W at MTOW ${tw.toFixed(3)}`);
    // 40,440 lbf = 179.9 kN [P] USAF fact sheet / Boeing.
    expect(perEng(0)).toBeCloseTo(179.9, 1);
    expect(tw).toBeGreaterThan(0.27);
    expect(tw).toBeLessThan(0.285);
    // High-bypass lapse: ~90-94% at 60 kt, ~80-86% at 120 kt (Bartel & Young; typical BPR-6 decks).
    expect(perEng(60) / perEng(0)).toBeGreaterThan(0.88);
    expect(perEng(60) / perEng(0)).toBeLessThan(0.95);
    expect(perEng(120) / perEng(0)).toBeGreaterThan(0.78);
    expect(perEng(120) / perEng(0)).toBeLessThan(0.87);
  });

  test('take-off: ground roll and distance over 50 ft at MTOW, 200 t, 150 t, and hot-and-high', () => {
    const cases: [string, number, Field, number, number][] = [
      ['MTOW 265 t SL', def.maxTakeoffMassKg!, SEA_LEVEL, 2, 1.05],
      ['395 klb 179 t SL', 179170, SEA_LEVEL, 2, 1.05],
      ['200 t SL', 200000, SEA_LEVEL, 2, 1.05],
      ['150 t SL', 150000, SEA_LEVEL, 2, 1.05],
      ['150 t SL, min run: 3/4, VR 0.85 Vs', 150000, SEA_LEVEL, 3, 0.85],
      ['160 t 4,270 m ISA+15', 160000, HIGH_FIELD, 2, 1.05],
    ];
    const out = cases.map(([name, m, f, detent, vrF]) => ({ name, r: takeoff(m, f, detent, vrF) }));
    console.log(
      'take-off (TOGA, brakes released at 95% N1):\n' +
        out.map(({ name, r }) => `  ${name.padEnd(32)} VR ${fmt(r.vrKias)} kt, lift-off ${fmt(r.liftoffKias)} KIAS, roll ${fmt(r.groundRollM)} m (${fmt(r.groundRollM / FT)} ft), 50 ft at ${fmt(r.to50ftM)} m (${fmt(r.to50ftM / FT)} ft), climb ${fmt(r.climbMps, 1)} m/s (${fmt((r.climbMps / FT) * 60)} fpm)`).join('\n')
    );
    const [mtow, m179, , m150, m150stol, high] = out.map((o) => o.r);
    // MTOW: Boeing take-off field length 7,740 ft (2,359 m) [S]; Jane's run 8,200 ft (2,499 m) [S].
    expect(mtow!.to50ftM).toBeGreaterThan(2359 * 0.85);
    expect(mtow!.to50ftM).toBeLessThan(2499 * 1.1);
    // 395,000 lb: run 3,000 ft (914 m) [S] Jane's.
    expect(m179!.groundRollM).toBeGreaterThan(914 * 0.8);
    expect(m179!.groundRollM).toBeLessThan(914 * 1.2);
    // Light, minimum run (flaps 3/4, early rotation): the FAI STOL-class record (take-off and landing
    // within 500 m, 20 t payload [P] FAI 1540 / "< 1,400 ft" [S] AVN) at an unknown weight. The model
    // is rotation-limited here (the nose will not come up much below ~110 kt): ~560 m. A regression
    // band, not a match (docs/spec/c17-data.md 12.3).
    expect(m150stol!.groundRollM).toBeGreaterThan(450);
    expect(m150stol!.groundRollM).toBeLessThan(650);
    expect(m150!.groundRollM).toBeLessThan(m179!.groundRollM);
    // Hot and high: 160 t at 4,270 m, ISA+15 needs much more than at sea level, but still fits Ngari's 4.5 km.
    expect(high!.groundRollM).toBeGreaterThan(m150!.groundRollM * 1.5);
    expect(high!.to50ftM).toBeLessThan(4500);
    for (const { r } of out) expect(r.climbMps).toBeGreaterThan(3);
  }, 120000);

  test('landing: 50 ft to stop and ground roll at max landing weight, the 160,000 lb payload case, STOL weights, hot-and-high', () => {
    const payload160klb = 72575;
    const cases: [string, number, Field, LandingOptions][] = [
      ['227.7 t (max full-flap) 3 deg', 227749, SEA_LEVEL, { gsDeg: 3, vappKias: vappFor(227749), flareM: 9, reverse: true, brakes: 1 }],
      ['210 t 160 klb payload 3 deg', 210000, SEA_LEVEL, { gsDeg: 3, vappKias: vappFor(210000), flareM: 9, reverse: true, brakes: 1, load: loadWithCargo(210000, payload160klb) }],
      ['210 t 160 klb payload 5 deg', 210000, SEA_LEVEL, { gsDeg: 5, vappKias: vappFor(210000), flareM: 15, reverse: true, brakes: 1, load: loadWithCargo(210000, payload160klb) }],
      ['160 t 115 kt 5 deg', 160000, SEA_LEVEL, { gsDeg: 5, vappKias: 115, flareM: 15, reverse: true, brakes: 1 }],
      ['145 t (display) 5 deg', 145000, SEA_LEVEL, { gsDeg: 5, vappKias: vappFor(145000), flareM: 15, reverse: true, brakes: 1 }],
      ['154 t 4,270 m ISA+15 3.5 deg', 154200, HIGH_FIELD, { gsDeg: 3.5, vappKias: vappFor(154200), flareM: 10, reverse: true, brakes: 1 }],
      ['210 t no reverse 3 deg', 210000, SEA_LEVEL, { gsDeg: 3, vappKias: vappFor(210000), flareM: 9, reverse: false, brakes: 1, load: loadWithCargo(210000, payload160klb) }],
    ];
    const out = cases.map(([name, m, f, o]) => ({ name, r: landing(m, f, o) }));
    console.log(
      'landing (FULL, idle at the flare, reverse + max brakes + lift dump):\n' +
        out.map(({ name, r }) => `  ${name.padEnd(30)} Vapp ${fmt(r.vappKias)} KIAS (thr ${fmt(r.approachThrottle, 2)}), TD ${fmt(r.tdKias)} KIAS/${fmt(r.tdKtas)} KTAS sink ${fmt(r.tdSinkFpm)} fpm, air ${fmt(r.airM)} m, roll ${fmt(r.groundRollM)} m (${fmt(r.groundRollM / FT)} ft), 50 ft->stop ${fmt(r.from50ftM)} m (${fmt(r.from50ftM / FT)} ft), decel ${fmt(r.decelG, 2)} g`).join('\n')
    );
    const [mlw, p160, p160steep, stol160, display, high, noRev] = out.map((o) => o.r);
    for (const { name, r } of out) {
      // Every touchdown is a landing, not an arrival: inside the 750 ft/min limit [U] FC3, on the speed.
      expect(r.tdSinkFpm, name).toBeLessThan(750);
      expect(r.tdSinkFpm, name).toBeGreaterThan(50);
      expect(Math.abs(r.tdKias - r.vappKias), name).toBeLessThan(15);
    }
    // Landing field length 3,000 ft (914 m) with 160,000 lb payload [S] Boeing: within 15%.
    expect(p160!.from50ftM).toBeGreaterThan(914 * 0.85);
    expect(p160!.from50ftM).toBeLessThan(914 * 1.15);
    // A steeper path shortens the air distance.
    expect(p160steep!.airM).toBeLessThan(p160!.airM);
    // Runways as short as 3,500 ft (1,067 m) [P] USAF: the max full-flap weight stops inside it from 50 ft.
    expect(mlw!.from50ftM).toBeLessThan(1067);
    // FAI STOL class: landing within 500 m (1,640 ft) at a light weight [P]/[S].
    expect(stol160!.groundRollM).toBeLessThan(500);
    expect(display!.groundRollM).toBeLessThan(stol160!.groundRollM);
    // Hot and high: longer, by the TAS ratio squared less what the (weight-scaled) brakes recover.
    expect(high!.groundRollM).toBeGreaterThan(stol160!.groundRollM * 1.2);
    // Reversers are worth something (theatre study: ~15-20% shorter roll with them).
    expect(noRev!.groundRollM).toBeGreaterThan(p160!.groundRollM * 1.08);
  }, 180000);

  test('reverse thrust: deceleration on the roll and backing up a slope at MTOW', () => {
    const back = backing(def.maxTakeoffMassKg!, SEA_LEVEL);
    const backLight = backing(160000, SEA_LEVEL);
    const revOnly = reverseOnlyDecel(160000);
    console.log(`reverse: static full reverse ${back.revThrustKN.toFixed(0)} kN total; backing from rest at MTOW ${back.accelMps2.toFixed(2)} m/s^2 -> steepest slope ${back.maxSlopePct.toFixed(1)}%; at 160 t ${backLight.accelMps2.toFixed(2)} m/s^2 (${backLight.maxSlopePct.toFixed(1)}%); reverse-only roll decel at 160 t ${revOnly.toFixed(2)} g`);
    // "Backs a fully loaded aircraft up a 2% slope" [P] USAF fact sheet / [S] LANG.
    expect(back.maxSlopePct).toBeGreaterThan(2);
    // ...but reverse is not a second set of engines: well short of forward thrust.
    expect(back.revThrustKN).toBeLessThan(0.55 * 4 * 179.9);
    expect(revOnly).toBeGreaterThan(0.1);
    expect(revOnly).toBeLessThan(0.3);
  }, 120000);
});
