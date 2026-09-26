/**
 * The player's autopilot, flown headless through the real World and flight model: it holds and
 * captures heading, altitude, vertical speed and airspeed, and disconnects when the pilot takes over.
 */
import { describe, expect, test } from 'vitest';
import { createWorld } from '../../src/core/world';
import { buildWorldDependencies } from '../../src/core/index';
import { resolveBuiltinMission } from '../../src/core/missions/index';
import { EntityFlag, SIM_DT_SEC, type PilotInputs } from '../../src/contracts/core';
import { Quat } from '../../src/math';

const DEG = Math.PI / 180;
const wrapDeg = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180;

function airborne(altM = 4000, speedMps = 200, hdgRad = Math.PI / 2) {
  const mission = resolveBuiltinMission('punjab-free');
  const world = createWorld(buildWorldDependencies(mission));
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const s = world.getEntityState(id)!;
  Quat.fromYawPitchRoll(hdgRad, 0.03, 0, s.rot);
  s.pos.x = 20000;
  s.pos.z = 20000;
  s.pos.y = altM;
  s.vel.x = Math.sin(hdgRad) * speedMps;
  s.vel.y = 0;
  s.vel.z = -Math.cos(hdgRad) * speedMps;
  s.gearPos = 0;
  s.flags = s.flags & ~EntityFlag.OnGround & ~EntityFlag.GearDownCommanded;
  const inputs: PilotInputs = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0.75, afterburner: false, brakes: 0, gearDown: false,
    airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false,
  };
  world.setPlayerInput(id, inputs);
  const run = (sec: number, each?: () => void): void => {
    for (let k = 0; k < sec / SIM_DT_SEC; k++) {
      world.stepOnce();
      each?.();
    }
  };
  run(1);
  return { world, id, inputs, run, t: () => world.getTelemetry(id)! };
}

describe('autopilot', () => {
  test('engages holding the current heading and altitude', () => {
    const { world, run, t } = airborne();
    const alt0 = t().altMslM;
    world.commandAutopilot({ type: 'toggleAp' });
    run(30);
    expect(Math.abs(t().altMslM - alt0)).toBeLessThan(30);
    expect(Math.abs(wrapDeg(t().headingRad / DEG - 90))).toBeLessThan(2);
    expect(Math.abs(t().rollRad)).toBeLessThan(3 * DEG);
  });

  test('turns onto a new heading at no more than 25 deg of bank, without overshoot', () => {
    const { world, run, t } = airborne();
    world.commandAutopilot({ type: 'toggleAp' });
    world.commandAutopilot({ type: 'adjust', target: 'hdg', delta: 90 * DEG });
    let maxBank = 0;
    let overshoot = 0;
    run(90, () => {
      maxBank = Math.max(maxBank, Math.abs(t().rollRad));
      overshoot = Math.max(overshoot, wrapDeg(t().headingRad / DEG - 180));
    });
    expect(Math.abs(wrapDeg(t().headingRad / DEG - 180))).toBeLessThan(1.5);
    expect(maxBank).toBeLessThan(27 * DEG);
    expect(overshoot).toBeLessThan(3);
  });

  test('climbs to a new altitude at the selected rate and levels off', () => {
    const { world, run, t } = airborne(3000);
    world.commandAutopilot({ type: 'toggleAp' });
    world.commandAutopilot({ type: 'toggleAt' });
    world.commandAutopilot({ type: 'adjust', target: 'alt', delta: 1000 });
    let maxVs = 0;
    let peak = 0;
    run(150, () => {
      maxVs = Math.max(maxVs, t().vspeedMps);
      peak = Math.max(peak, t().altMslM);
    });
    const target = Math.round(3000 / 100) * 100 + 1000;
    expect(Math.abs(t().altMslM - target)).toBeLessThan(25);
    expect(peak - target).toBeLessThan(40);
    expect(maxVs).toBeGreaterThan(8);
    expect(maxVs).toBeLessThan(13);
  });

  test('VS mode holds a descent rate, then captures the altitude bug', () => {
    const { world, run, t } = airborne(4000);
    world.commandAutopilot({ type: 'toggleAp' });
    world.commandAutopilot({ type: 'toggleAt' });
    world.commandAutopilot({ type: 'adjust', target: 'alt', delta: -800 });
    world.commandAutopilot({ type: 'adjust', target: 'vs', delta: -15 });
    run(20);
    expect(t().vspeedMps).toBeGreaterThan(-17);
    expect(t().vspeedMps).toBeLessThan(-12);
    run(120);
    expect(Math.abs(t().altMslM - 3200)).toBeLessThan(25);
    expect(Math.abs(t().vspeedMps)).toBeLessThan(1.5);
  });

  test('autothrottle holds a new speed', () => {
    const { world, run, t } = airborne(4000, 200);
    world.commandAutopilot({ type: 'toggleAp' });
    world.commandAutopilot({ type: 'toggleAt' });
    const ias0 = Math.round(t().iasMps);
    world.commandAutopilot({ type: 'adjust', target: 'spd', delta: -30 });
    run(120);
    expect(Math.abs(t().iasMps - (ias0 - 30))).toBeLessThan(4);
  });

  test('stick input disconnects the AP; throttle movement disconnects the A/T', () => {
    const { world, id, inputs, run } = airborne();
    world.commandAutopilot({ type: 'toggleAp' });
    world.commandAutopilot({ type: 'toggleAt' });
    run(2);
    world.setPlayerInput(id, { ...inputs, roll: 0.8 });
    run(0.1);
    world.setPlayerInput(id, { ...inputs, throttleActive: true });
    run(0.1);
    const ap = (world as unknown as { ap: { engaged: boolean; autothrottle: boolean } }).ap;
    expect(ap.engaged).toBe(false);
    expect(ap.autothrottle).toBe(false);
  });

  test.each([
    [1000, 130],
    [10000, 260],
  ])('stable at %i m, %i m/s: turn and climb together without oscillating', (alt, spd) => {
    const { world, run, t } = airborne(alt, spd);
    world.commandAutopilot({ type: 'toggleAp' });
    world.commandAutopilot({ type: 'toggleAt' });
    world.commandAutopilot({ type: 'adjust', target: 'hdg', delta: -120 * DEG });
    world.commandAutopilot({ type: 'adjust', target: 'alt', delta: 600 });
    run(150);
    // Settled: level, wings level, on heading and altitude, and staying there.
    const a = t().altMslM;
    let drift = 0;
    let maxG = 0;
    let minG = 9;
    run(20, () => {
      drift = Math.max(drift, Math.abs(t().altMslM - a));
      maxG = Math.max(maxG, t().gLoad);
      minG = Math.min(minG, t().gLoad);
    });
    expect(Math.abs(wrapDeg(t().headingRad / DEG - (90 - 120)))).toBeLessThan(1.5);
    expect(Math.abs(t().altMslM - (Math.round(alt / 100) * 100 + 600))).toBeLessThan(25);
    expect(drift).toBeLessThan(10);
    expect(maxG - minG).toBeLessThan(0.1);
  });

  test('cannot engage on the ground', () => {
    const mission = resolveBuiltinMission('punjab-free');
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    world.stepOnce();
    world.commandAutopilot({ type: 'toggleAp' });
    const ap = (world as unknown as { ap: { engaged: boolean } }).ap;
    expect(ap.engaged).toBe(false);
  });
});
