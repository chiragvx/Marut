/**
 * tests/integration/c17Speedbrake.test.ts — the C-17's in-flight speedbrake (B: spoilers to
 * speedbrakeFrac of their travel) is felt: idle level-flight deceleration at 300 KIAS more than
 * doubles, the FCS holds the flight path rather than climbing the drag away, and the idle-reverse
 * tactical descent with speedbrakes reaches the published 15-18,000 ft/min (docs/spec/c17-data.md
 * 2.4 / 5.4). Play-testing found the first spoiler drag (dCD 0.025) "very weak".
 */
import { describe, expect, test } from 'vitest';
import { c17Definition as def } from '../../src/aircraft/c17Definition';
import type { AircraftTelemetry, EntityState, PilotInputs } from '../../src/contracts/core';
import { Quat } from '../../src/math';
import { computeTelemetry, resetFcsTrimState, stepAircraft } from '../../src/physics';
import { buildTrimEnvironment, makeFullHealthDamageState } from '../../tools/lib/trimSolver';

const DT = 1 / 60;
const KT = 0.514444;

/** A clean 200 t C-17 heading north at `kias`, `altM`, throttle idle. */
function airborne(altM: number, kias: number): EntityState {
  const rho = buildTrimEnvironment(altM).airDensityKgM3;
  const rot = { x: 0, y: 0, z: 0, w: 1 };
  Quat.fromYawPitchRoll(0, (2 * Math.PI) / 180, 0, rot);
  return {
    id: 0, kind: 'aircraft', team: 0, pos: { x: 0, y: altM, z: 0 }, rot, vel: { x: 0, y: 0, z: -kias * KT * Math.sqrt(1.225 / rho) }, omega: { x: 0, y: 0, z: 0 },
    alive: true, hp: 100, fuelKg: 200000 - def.emptyMassKg, elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0,
    afterburnerOn: false, flags: 0, flapDetent: 0, flapPos: 0, slatPos: 0,
  };
}

function inputs(over: Partial<PilotInputs>): PilotInputs {
  return {
    pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 0, gearDown: false, airbrake: false,
    trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, nwsEnabled: true, ...over,
  };
}

function fly(s0: EntityState, sec: number, i: PilotInputs, control: ((i: PilotInputs, tel: AircraftTelemetry) => void) | undefined, watch: (t: number, s: EntityState, tel: AircraftTelemetry) => void): void {
  resetFcsTrimState(0);
  let s = s0;
  let o = structuredClone(s0);
  const dmg = makeFullHealthDamageState();
  const tel = {} as AircraftTelemetry;
  for (let k = 0; k <= Math.round(sec / DT); k++) {
    const env = buildTrimEnvironment(s.pos.y);
    computeTelemetry(s, def, env as never, dmg, tel);
    control?.(i, tel);
    watch(k * DT, s, tel);
    stepAircraft(s, dmg, i, env as never, def, DT, o);
    [s, o] = [o, s];
  }
}

/** Stick-free idle at 300 KIAS, 3,000 m: knots per second lost over t = 2..12 s, height change, final spoiler position. */
function levelDecel(airbrake: boolean) {
  let ias0 = 0;
  let ias1 = 0;
  let alt0 = 0;
  let alt1 = 0;
  let spoiler = 0;
  fly(airborne(3000, 300), 12, inputs({ airbrake }), undefined, (t, s, tel) => {
    if (Math.abs(t - 2) < DT / 2) [ias0, alt0] = [tel.iasMps, s.pos.y];
    [ias1, alt1, spoiler] = [tel.iasMps, s.pos.y, s.spoilerPos ?? 0];
  });
  return { ktPerSec: (ias0 - ias1) / KT / 10, dAltM: alt1 - alt0, spoiler };
}

describe('C-17 speedbrake in flight', () => {
  test('idle level flight at 300 KIAS: speedbrakes out more than double the deceleration, path held', () => {
    const clean = levelDecel(false);
    const brake = levelDecel(true);
    expect(clean.spoiler).toBe(0);
    expect(brake.spoiler).toBeCloseTo(def.spoilers!.speedbrakeFrac, 5);
    // Before the fix: 1.05 -> 2.0 kt/s. Now ~2.7 kt/s.
    expect(brake.ktPerSec).toBeGreaterThan(2.4);
    expect(brake.ktPerSec).toBeGreaterThan(2.2 * clean.ktPerSec);
    // The FCS holds the flight path: the drag slows the jet instead of being traded for height.
    expect(Math.abs(brake.dAltM)).toBeLessThan(30);
  });

  test('tactical descent (idle reverse + speedbrakes, 320 KIAS): 15,000 ft/min +-20%', () => {
    let vs = 0;
    let n = 0;
    fly(airborne(9000, 320), 45, inputs({ airbrake: true, reverseThrust: true }), (i, tel) => {
      i.pitch = Math.max(-1, Math.min(1, 0.05 * (tel.iasMps - 320 * KT)));
    }, (t, _s, tel) => {
      if (t > 20) {
        vs += tel.vspeedMps;
        n++;
      }
    });
    const fpm = (-vs / n) * 196.85;
    expect(fpm).toBeGreaterThan(12000);
    expect(fpm).toBeLessThan(18000);
  }, 30000);
});
