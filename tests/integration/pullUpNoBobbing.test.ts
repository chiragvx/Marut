/**
 * tests/integration/pullUpNoBobbing.test.ts — regression for the play-test report "bobbing under
 * 200 kt pulling hard on the pitch". Flies the real World (free-flight mission, so its gusts and
 * turbulence are on -- the oscillation only appeared with a disturbance present) and holds a
 * keyboard-style full pull at low speed, asserting the pitch rate settles instead of cycling and
 * alpha stays near the FBW limit. Before the fix, pitch rate reversed 30-40 times in the 10 s pull
 * (alpha cycling ~17.5-21deg every ~0.45 s, elevons slamming across their travel).
 */
import { describe, expect, test } from 'vitest';
import type { PilotInputs } from '../../src/contracts/core';
import { SIM_DT_SEC, EntityFlag } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { fcsLimits } from '../../src/aircraft/tejasGeometry';
import { Quat } from '../../src/math';

/** Local extrema of `series` whose swing exceeds `prominence` (a simple oscillation count). */
function countReversals(series: readonly number[], prominence: number): number {
  let n = 0;
  let dir = 0;
  let pivot = series[0] ?? 0;
  for (const x of series) {
    if (dir >= 0 && x < pivot - prominence) {
      if (dir > 0) n++;
      dir = -1;
      pivot = x;
    } else if (dir <= 0 && x > pivot + prominence) {
      if (dir < 0) n++;
      dir = 1;
      pivot = x;
    } else if ((dir >= 0 && x > pivot) || (dir < 0 && x < pivot)) {
      pivot = x;
    }
  }
  return n;
}

function flyHardPull(speedMps: number, altitudeM: number): { reversals: number; peakAlphaRad: number } {
  const mission = resolveBuiltinMission('free-flight');
  const world = createWorld(buildWorldDependencies(mission));
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const s = world.getEntityState(id)!;
  Quat.fromYawPitchRoll(Math.PI / 2, 0, 0, s.rot);
  s.pos.y = altitudeM;
  s.vel.x = speedMps;
  s.vel.y = 0;
  s.vel.z = 0;
  s.gearPos = 0;
  s.flags &= ~EntityFlag.OnGround;

  const inputs: PilotInputs = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0.9, afterburner: false, brakes: 0, gearDown: false,
    airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false,
  };
  const pitchRates: number[] = [];
  let peakAlphaRad = -Infinity;
  for (let tick = 0; tick < 14 / SIM_DT_SEC; tick++) {
    const t = tick * SIM_DT_SEC;
    // Keyboard ramp (playerPilot.ts KEYBOARD_AXIS_RAMP_RATE_PER_SEC = 2.5) from t=4s, held.
    inputs.pitch = t < 4 ? 0 : Math.min(1, (t - 4) * 2.5);
    world.setPlayerInput(id, inputs);
    world.stepOnce();
    if (t >= 4) {
      pitchRates.push(world.getEntityState(id)!.omega.z);
      peakAlphaRad = Math.max(peakAlphaRad, world.getTelemetry(id)!.alphaRad);
    }
  }
  return { reversals: countReversals(pitchRates, 1 / 57.2958), peakAlphaRad };
}

describe('hard pull-up at low speed does not bob', () => {
  for (const [speedMps, altitudeM] of [[70, 1500], [85, 500], [100, 1500]] as const) {
    test(`${speedMps} m/s at ${altitudeM} m: pitch rate settles, alpha stays near the limit`, () => {
      const r = flyHardPull(speedMps, altitudeM);
      expect(r.reversals).toBeLessThanOrEqual(3);
      expect(r.peakAlphaRad).toBeLessThan(fcsLimits.maxAlphaRad + 3 / 57.2958);
    }, 60000);
  }
});
