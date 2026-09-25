/**
 * tests/integration/airbrake.test.ts — the airbrake, through the real World: the panels ramp out
 * and back in at their actuation rate, and while out they add enough drag to slow the jet clearly.
 */
import { describe, expect, test } from 'vitest';
import type { PilotInputs } from '../../src/contracts/core';
import { SIM_DT_SEC, EntityFlag } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { Quat } from '../../src/math';

function setup() {
  const base = resolveBuiltinMission('punjab-free');
  const mission = { ...base, weather: { windWorldMps: { x: 0, y: 0, z: 0 }, gustMps: 0, turbulence: 0 } };
  const world = createWorld(buildWorldDependencies(mission));
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const s = world.getEntityState(id)!;
  Quat.fromYawPitchRoll(Math.PI / 2, 0.03, 0, s.rot);
  s.pos.y = 2000;
  s.vel.x = 250;
  s.vel.y = 0;
  s.vel.z = 0;
  s.gearPos = 0;
  s.flags &= ~(EntityFlag.OnGround | EntityFlag.GearDownCommanded);
  const inputs: PilotInputs = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0.6, afterburner: false, brakes: 0, gearDown: false,
    airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false,
  };
  const run = (sec: number): void => {
    for (let t = 0; t < sec / SIM_DT_SEC; t++) {
      world.setPlayerInput(id, inputs);
      world.stepOnce();
    }
  };
  const speed = (): number => {
    const v = world.getEntityState(id)!.vel;
    return Math.hypot(v.x, v.y, v.z);
  };
  return { world, id, inputs, run, speed };
}

describe('airbrake', () => {
  test('panels ramp out over ~1.2 s and back in over ~1 s', () => {
    const { world, id, inputs, run } = setup();
    inputs.airbrake = true;
    run(0.6);
    const half = world.getEntityState(id)!.airbrakePos ?? 0;
    expect(half).toBeGreaterThan(0.35);
    expect(half).toBeLessThan(0.65);
    expect(world.getEntityState(id)!.flags & EntityFlag.AirbrakeOut).toBeTruthy();
    run(0.8);
    expect(world.getEntityState(id)!.airbrakePos).toBe(1);
    inputs.airbrake = false;
    run(1.1);
    expect(world.getEntityState(id)!.airbrakePos).toBe(0);
  });

  test('slows the jet clearly at 250 m/s (vs. clean, same throttle)', () => {
    const clean = setup();
    clean.run(10);
    const braked = setup();
    braked.inputs.airbrake = true;
    braked.run(10);
    // Measured: ~219 m/s clean vs ~190 m/s braked after 10 s.
    expect(clean.speed() - braked.speed()).toBeGreaterThan(20);
  });
});
