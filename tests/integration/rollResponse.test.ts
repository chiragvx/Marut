/**
 * tests/integration/rollResponse.test.ts — regression for the play-test report "the roll of the
 * jet is very aggressive". Flies the real World with a keyboard-style roll (playerPilot.ts ramp and
 * response curve): full roll must build in smoothly to a controllable rate, and on release the jet
 * must ease to a stop near the bank the pilot let go at, without snapping back.
 * Before the fix: 250-270 deg/s after 0.7 s, rate falling to zero along a straight line.
 */
import { describe, expect, test } from 'vitest';
import type { PilotInputs } from '../../src/contracts/core';
import { SIM_DT_SEC, EntityFlag } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { Quat } from '../../src/math';
import { keyboardResponse, KEYBOARD_ROLL_RAMP_RATE_PER_SEC, KEYBOARD_AXIS_CENTER_RATE_PER_SEC } from '../../src/input/playerPilot';

const DEG = Math.PI / 180;

function flyKeyboardRoll(speedMps: number, holdSec: number): { rates: number[]; bankAtRelease: number; bankFinal: number } {
  const mission = resolveBuiltinMission('free-flight');
  const world = createWorld(buildWorldDependencies(mission));
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const s = world.getEntityState(id)!;
  Quat.fromYawPitchRoll(Math.PI / 2, 0, 0, s.rot);
  s.pos.y = 3000;
  s.vel.x = speedMps;
  s.vel.y = 0;
  s.vel.z = 0;
  s.gearPos = 0;
  s.flags &= ~EntityFlag.OnGround;

  const inputs: PilotInputs = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0.85, afterburner: false, brakes: 0, gearDown: false,
    airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false,
  };
  const rates: number[] = [];
  let axis = 0;
  let bank = 0;
  let bankAtRelease = 0;
  const t0 = 2;
  for (let tick = 0; tick < (t0 + holdSec + 2.5) / SIM_DT_SEC; tick++) {
    const t = tick * SIM_DT_SEC;
    const held = t >= t0 && t < t0 + holdSec;
    axis = held ? Math.min(1, axis + KEYBOARD_ROLL_RAMP_RATE_PER_SEC * SIM_DT_SEC) : Math.max(0, axis - KEYBOARD_AXIS_CENTER_RATE_PER_SEC * SIM_DT_SEC);
    inputs.roll = keyboardResponse(axis);
    world.setPlayerInput(id, inputs);
    world.stepOnce();
    if (t < t0) continue;
    const p = world.getEntityState(id)!.omega.x;
    rates.push(p);
    bank += p * SIM_DT_SEC;
    if (held) bankAtRelease = bank;
  }
  return { rates, bankAtRelease, bankFinal: bank };
}

describe('keyboard roll is smooth and controllable', () => {
  for (const speedMps of [150, 250]) {
    test(`${speedMps} m/s: builds in smoothly, tops out near 200 deg/s, stops near the release bank`, () => {
      const r = flyKeyboardRoll(speedMps, 1.5);
      const at = (sec: number): number => Math.abs(r.rates[Math.round(sec / SIM_DT_SEC)]!);
      const peak = Math.max(...r.rates.map(Math.abs));
      expect(peak).toBeLessThan(230 * DEG);
      expect(peak).toBeGreaterThan(150 * DEG);
      // Soft onset: well under half the peak rate 0.4 s into the roll.
      expect(at(0.4)).toBeLessThan(0.35 * peak);
      // Eases to a stop: modest carry-on past the release bank, no snap back the other way.
      const carry = Math.abs(r.bankFinal - r.bankAtRelease);
      expect(carry).toBeLessThan(65 * DEG);
      expect(carry).toBeGreaterThan(20 * DEG);
      const after = r.rates.slice(Math.round(1.5 / SIM_DT_SEC));
      const dir = Math.sign(r.bankFinal);
      expect(Math.min(...after.map((p) => p * dir))).toBeGreaterThan(-3 * DEG);
    }, 60000);
  }
});
