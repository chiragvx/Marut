/**
 * tests/integration/rollResponse.test.ts — regression for the play-test reports on keyboard roll:
 * first "very aggressive" (300 deg/s demand, snapping on and stopping dead), then, after a smoothing
 * pass, "the input takes time to take effect" and it carried on rolling after release. Flies the
 * real World with playerPilot.ts's hold-time roll command: the roll must start at once, gently,
 * build the longer the key is held, and stop close to where the key was released without
 * rolling back.
 */
import { describe, expect, test } from 'vitest';
import type { PilotInputs } from '../../src/contracts/core';
import { SIM_DT_SEC, EntityFlag } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { Quat } from '../../src/math';
import { keyboardRollCommand } from '../../src/input/playerPilot';

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
  let hold = 0;
  let bank = 0;
  let bankAtRelease = 0;
  const t0 = 2;
  for (let tick = 0; tick < (t0 + holdSec + 2.5) / SIM_DT_SEC; tick++) {
    const t = tick * SIM_DT_SEC;
    const held = t >= t0 && t < t0 + holdSec;
    hold = held ? hold + SIM_DT_SEC : 0;
    inputs.roll = keyboardRollCommand(hold);
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

describe('keyboard roll: instant, builds with hold time, stops where released', () => {
  for (const speedMps of [150, 250]) {
    test(`${speedMps} m/s`, () => {
      const r = flyKeyboardRoll(speedMps, 1.5);
      const at = (sec: number): number => r.rates[Math.round(sec / SIM_DT_SEC)]!;
      const peak = Math.max(...r.rates);
      // Rolling within a tenth of a second, gently.
      expect(at(0.1)).toBeGreaterThan(15 * DEG);
      expect(at(0.1)).toBeLessThan(40 * DEG);
      // Builds with hold time to a controllable top rate.
      expect(at(0.5)).toBeLessThan(0.35 * peak);
      expect(at(1.0)).toBeGreaterThan(2 * at(0.5));
      expect(peak).toBeGreaterThan(150 * DEG);
      expect(peak).toBeLessThan(230 * DEG);
      // Stops promptly after release (no coasting on), and barely rolls back.
      expect(r.bankFinal - r.bankAtRelease).toBeLessThan(30 * DEG);
      const after = r.rates.slice(Math.round(1.5 / SIM_DT_SEC));
      expect(Math.min(...after)).toBeGreaterThan(-6 * DEG);
      const maxBank = r.rates.reduce((acc, p) => ({ bank: acc.bank + p * SIM_DT_SEC, max: Math.max(acc.max, acc.bank + p * SIM_DT_SEC) }), { bank: 0, max: 0 }).max;
      expect(maxBank - r.bankFinal).toBeLessThan(3 * DEG);
    }, 60000);
  }
});
