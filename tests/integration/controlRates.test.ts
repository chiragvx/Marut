/**
 * tests/integration/controlRates.test.ts — the Settings "Roll rate / Pitch rate / Yaw rate"
 * sliders (PilotInputs.rollRateScale etc.), flown through the real World: each scales its axis,
 * pitch still stops at the g limit, and missing values mean the standard response.
 */
import { describe, expect, test } from 'vitest';
import type { PilotInputs } from '../../src/contracts/core';
import { SIM_DT_SEC, EntityFlag } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { fcsLimits } from '../../src/aircraft/tejasGeometry';
import { Quat } from '../../src/math';
import { clampControlRate } from '../../src/input/playerPilot';

const DEG = Math.PI / 180;

/** Flies level at `speed` (default 200 m/s), 3000 m, applying `stick` for `holdSec`; returns the peak |body rate| on `axis` and the peak load factor. */
function fly(stick: Partial<Pick<PilotInputs, 'pitch' | 'roll' | 'yaw'>>, scales: Partial<Pick<PilotInputs, 'pitchRateScale' | 'rollRateScale' | 'yawRateScale'>>, holdSec: number, speed = 200): { p: number; r: number; g: number } {
  const mission = resolveBuiltinMission('free-flight');
  const world = createWorld(buildWorldDependencies(mission));
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const s = world.getEntityState(id)!;
  Quat.fromYawPitchRoll(Math.PI / 2, 0, 0, s.rot);
  s.pos.y = 3000;
  s.vel.x = speed;
  s.vel.y = 0;
  s.vel.z = 0;
  s.gearPos = 0;
  s.flags &= ~EntityFlag.OnGround;
  const inputs: PilotInputs = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0.9, afterburner: false, brakes: 0, gearDown: false,
    airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...scales,
  };
  let p = 0;
  let r = 0;
  let g = 0;
  for (let tick = 0; tick < (1 + holdSec) / SIM_DT_SEC; tick++) {
    const t = tick * SIM_DT_SEC;
    Object.assign(inputs, t >= 1 ? stick : { pitch: 0, roll: 0, yaw: 0 });
    world.setPlayerInput(id, inputs);
    world.stepOnce();
    if (t < 1) continue;
    const st = world.getEntityState(id)!;
    p = Math.max(p, Math.abs(st.omega.x));
    r = Math.max(r, Math.abs(st.omega.y));
    g = Math.max(g, world.getTelemetry(id)!.gLoad);
  }
  return { p, r, g };
}

describe('control-rate settings', () => {
  test('roll rate scales the full-stick roll rate', () => {
    const std = fly({ roll: 1 }, {}, 1.5).p;
    const slow = fly({ roll: 1 }, { rollRateScale: 0.5 }, 1.5).p;
    const fast = fly({ roll: 1 }, { rollRateScale: 1.5 }, 1.5).p;
    expect(std).toBeGreaterThan(170 * DEG);
    expect(slow / std).toBeGreaterThan(0.4);
    expect(slow / std).toBeLessThan(0.6);
    expect(fast / std).toBeGreaterThan(1.25);
  }, 60000);

  test('pitch rate scales the g a part-stick pull commands, a full pull unchanged', () => {
    // A light pull (30% stick, ~3 g), inside the AoA-limited envelope at this speed.
    const pull = (scale: number): number => fly({ pitch: 0.3 }, { pitchRateScale: scale }, 3).g;
    const std = pull(1);
    expect(pull(0.5)).toBeLessThan(std - 0.6);
    expect(pull(1.5)).toBeGreaterThan(std + 0.6);
    // A full pull at 300 m/s is the standard one at 150%: same peak g (no faster g onset).
    const fullStd = fly({ pitch: 1 }, {}, 3, 300).g;
    const fullFast = fly({ pitch: 1 }, { pitchRateScale: 1.5 }, 3, 300).g;
    expect(fullFast).toBeGreaterThan(fcsLimits.maxGLoadPos - 1);
    expect(Math.abs(fullFast - fullStd)).toBeLessThan(0.05);
  }, 60000);

  test('yaw rate scales the rudder response', () => {
    const std = fly({ yaw: 0.5 }, {}, 1).r;
    expect(fly({ yaw: 0.5 }, { yawRateScale: 0.5 }, 1).r).toBeLessThan(0.7 * std);
    expect(fly({ yaw: 0.5 }, { yawRateScale: 1.5 }, 1).r).toBeGreaterThan(1.2 * std);
  }, 60000);

  test('the settings are held to 50-150%', () => {
    expect(clampControlRate(0.1)).toBe(0.5);
    expect(clampControlRate(3)).toBe(1.5);
    expect(clampControlRate(Number.NaN)).toBe(1);
    expect(clampControlRate(1.2)).toBe(1.2);
  });
});
