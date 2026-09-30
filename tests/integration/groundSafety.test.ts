/**
 * tests/integration/groundSafety.test.ts — regression for the play-test report "the aircraft
 * body impact on the ground should crash; you can retract the gear on the ground; it phases
 * through the ground; it flips over frequently". Flies the real World on the Hansa runway:
 * - the gear stays locked down while there is weight on the wheels (retracts once airborne);
 * - the airframe touching the ground (belly, wing tip) is a crash, not a sink into the ground;
 * - a landing with drift and bank, and a fast neutral-stick ground roll, stay upright (the tyre
 *   side force follows wheel load and the nose wheel castors at speed: before, the jet
 *   ground-looped and rolled over at ~68 m/s with no input at all);
 * - a nose-high touchdown with back stick does not scrape the tail (ground-law protection).
 */
import { describe, expect, test } from 'vitest';
import { EntityFlag, SIM_DT_SEC, type PilotInputs } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld } from '../../src/core';
import { freeFlightMission } from '../../src/core/missions/catalogue';
import { Quat } from '../../src/math';

const D = Math.PI / 180;
const calm = { windWorldMps: { x: 0, y: 0, z: 0 }, gustMps: 0, turbulence: 0 };

interface Start {
  speed: number;
  /** Airborne start: height of the wheels above the runway, sink, attitude, sideways drift. */
  air?: { h: number; sink: number; pitchDeg: number; bankDeg: number; drift: number };
  gearDown?: boolean;
  /** A small upset on the ground: sideways slip, m/s, and yaw rate, deg/s (a gust or a bump). */
  kick?: { slip: number; yawRateDeg: number };
}

interface Run {
  alive: boolean;
  maxBankDeg: number;
  /** Largest bank with a wheel on the ground. */
  maxGroundBankDeg: number;
  maxPitchOnGroundDeg: number;
  gearPosMin: number;
  headingChangeDeg: number;
  lowestAglM: number;
}

function fly(start: Start, secs: number, control: (t: number, i: PilotInputs, onGround: boolean) => void): Run {
  const mission = { ...freeFlightMission('hansa', 'runway'), weather: calm };
  const deps = buildWorldDependencies(mission);
  const world = createWorld(deps);
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const s = world.getEntityState(id)!;
  const f = { x: 0, y: 0, z: 0 };
  Quat.rotate(s.rot, { x: 1, y: 0, z: 0 }, f);
  const yaw = Math.atan2(f.x, f.z);
  const fwd = { x: Math.sin(yaw), z: Math.cos(yaw) };
  const lat = { x: fwd.z, z: -fwd.x };
  const ground = deps.sampler.heightAt(s.pos.x, s.pos.z);
  const inputs: PilotInputs = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0.1, afterburner: false, brakes: 0, gearDown: start.gearDown ?? true, airbrake: false,
    trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, nwsEnabled: true,
  };
  if (start.air) {
    const a = start.air;
    Quat.fromYawPitchRoll(yaw, a.pitchDeg * D, a.bankDeg * D, s.rot);
    s.pos.y = ground + 1.7 + a.h;
    s.vel.x = fwd.x * start.speed + lat.x * a.drift;
    s.vel.z = fwd.z * start.speed + lat.z * a.drift;
    s.vel.y = -a.sink;
    s.flags &= ~EntityFlag.OnGround;
    s.gearPos = inputs.gearDown ? 1 : 0;
  } else {
    s.vel.x = fwd.x * start.speed + lat.x * (start.kick?.slip ?? 0);
    s.vel.z = fwd.z * start.speed + lat.z * (start.kick?.slip ?? 0);
    s.omega.y = (start.kick?.yawRateDeg ?? 0) * D;
  }
  const r: Run = { alive: true, maxBankDeg: 0, maxGroundBankDeg: 0, maxPitchOnGroundDeg: -90, gearPosMin: 1, headingChangeDeg: 0, lowestAglM: Infinity };
  const up = { x: 0, y: 0, z: 0 };
  const fw = { x: 0, y: 0, z: 0 };
  for (let k = 0; k < secs / SIM_DT_SEC; k++) {
    const st0 = world.getEntityState(id)!;
    control(k * SIM_DT_SEC, inputs, (st0.flags & EntityFlag.OnGround) !== 0);
    world.setPlayerInput(id, inputs);
    world.stepOnce();
    const st = world.getEntityState(id)!;
    if (!st.alive) {
      r.alive = false;
      break;
    }
    Quat.rotate(st.rot, { x: 0, y: 0, z: 1 }, up);
    Quat.rotate(st.rot, { x: 1, y: 0, z: 0 }, fw);
    r.maxBankDeg = Math.max(r.maxBankDeg, Math.abs(Math.asin(Math.max(-1, Math.min(1, up.y)))) / D);
    if (st.flags & EntityFlag.OnGround) r.maxGroundBankDeg = Math.max(r.maxGroundBankDeg, Math.abs(Math.asin(Math.max(-1, Math.min(1, up.y)))) / D);
    if (st.flags & EntityFlag.OnGround) r.maxPitchOnGroundDeg = Math.max(r.maxPitchOnGroundDeg, Math.asin(fw.y) / D);
    r.gearPosMin = Math.min(r.gearPosMin, st.gearPos);
    r.headingChangeDeg = Math.max(r.headingChangeDeg, Math.abs(Math.atan2(Math.sin(Math.atan2(fw.x, fw.z) - yaw), Math.cos(Math.atan2(fw.x, fw.z) - yaw))) / D);
    r.lowestAglM = Math.min(r.lowestAglM, st.pos.y - deps.sampler.heightAt(st.pos.x, st.pos.z));
  }
  return r;
}

describe('ground safety', () => {
  test('the gear lever cannot retract the gear with weight on the wheels', () => {
    const r = fly({ speed: 0 }, 3, (t, i) => {
      i.gearDown = false;
    });
    expect(r.alive).toBe(true);
    expect(r.gearPosMin).toBe(1);
  });

  test('a lever raised on the take-off run retracts the gear once airborne', () => {
    let airborneGearPos = 1;
    let wasAirborne = false;
    const r = fly({ speed: 0 }, 30, (t, i, onGround) => {
      i.throttle = 1;
      i.afterburner = true;
      i.gearDown = false;
      i.pitch = t > 8 ? 0.6 : 0;
      if (!onGround && t > 8) wasAirborne = true;
    });
    void airborneGearPos;
    expect(r.alive).toBe(true);
    expect(wasAirborne).toBe(true);
    expect(r.gearPosMin).toBeLessThan(0.05);
  }, 60000);

  test('a gear-up landing is a crash at belly contact, not a sink into the ground', () => {
    const r = fly({ speed: 70, gearDown: false, air: { h: 0.4, sink: 1.5, pitchDeg: 7, bankDeg: 0, drift: 0 } }, 5, () => {});
    expect(r.alive).toBe(false);
    // The reference point is ~0.7 m above the belly: it never gets anywhere near the ground.
    expect(r.lowestAglM).toBeGreaterThan(0.3);
  });

  test('a wing tip hitting the runway (landing banked ~35 deg) is a crash', () => {
    const r = fly({ speed: 70, air: { h: 0.3, sink: 2, pitchDeg: 8, bankDeg: 35, drift: 0 } }, 3, () => {});
    expect(r.alive).toBe(false);
  });

  test('a drifting, banked landing stays upright', () => {
    for (const [drift, bank] of [[6, 0], [4, 5], [2, 10]] as const) {
      const r = fly({ speed: 70, air: { h: 0.3, sink: 2, pitchDeg: 8, bankDeg: bank, drift } }, 8, () => {});
      expect(r.alive, `drift ${drift} bank ${bank}`).toBe(true);
      // It leans on the downwind gear (6 m/s of drift is a ~5 deg crab left in at touchdown), well
      // short of the ~28 deg at which a wing tip meets the runway.
      expect(r.maxGroundBankDeg, `drift ${drift} bank ${bank}`).toBeLessThan(18);
    }
  }, 60000);

  test('a fast ground roll with the stick centred tracks straight and stays level (no ground loop)', () => {
    // Upset by 2 m/s of sideways slip and a 3 deg/s yaw kick. Before the tyre fix this ground-looped
    // (68 deg off heading) and rolled the jet onto its side.
    const r = fly({ speed: 68, kick: { slip: 2, yawRateDeg: 3 } }, 12, (t, i) => {
      i.throttle = 0.6;
    });
    expect(r.alive).toBe(true);
    expect(r.maxBankDeg).toBeLessThan(3);
    expect(r.headingChangeDeg).toBeLessThan(6);
  }, 60000);

  test('back stick after a nose-high touchdown does not scrape the tail', () => {
    for (const pitchDeg of [10, 12, 13]) {
      const r = fly({ speed: 62, air: { h: 0.2, sink: 1.5, pitchDeg, bankDeg: 0, drift: 0 } }, 6, (t, i) => {
        i.pitch = 0.5;
      });
      expect(r.alive, `${pitchDeg} deg`).toBe(true);
      expect(r.maxPitchOnGroundDeg).toBeLessThan(14);
    }
  }, 60000);
});
