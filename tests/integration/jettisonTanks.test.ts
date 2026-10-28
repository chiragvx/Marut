/**
 * tests/integration/jettisonTanks.test.ts — J in the real World: the drop tanks leave their pylons
 * as falling effect entities (starting under the pylon, moving with the aircraft), fall away
 * below and behind it, land with a 'storeImpact', and are removed. Same seed, same fall.
 */
import { describe, expect, test } from 'vitest';
import type { EntityState, PilotInputs, SimEvent, StoreImpactEvent } from '../../src/contracts/core';
import { EntityFlag } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { Quat } from '../../src/math';

type Pool = { liveCount: number; liveAt(i: number): EntityState };

function effects(world: unknown): EntityState[] {
  const pool = (world as { pool: Pool }).pool;
  const out: EntityState[] = [];
  for (let i = 0; i < pool.liveCount; i++) {
    const s = pool.liveAt(i);
    if (s.kind === 'effect') out.push(s);
  }
  return out;
}

function run(): { firstPos: { x: number; y: number }[]; impacts: StoreImpactEvent[]; tanksAfter: number; effectsAtEnd: number; maxBelowJetM: number } {
  const mission = resolveBuiltinMission('free-flight');
  const world = createWorld(buildWorldDependencies(mission));
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const jet = world.getEntityState(id)!;
  expect(jet.dropTankCount ?? 0).toBeGreaterThan(0);
  Quat.fromYawPitchRoll(Math.PI / 2, 0, 0, jet.rot);
  jet.pos.y = 1500;
  jet.vel.x = 200;
  jet.vel.y = 0;
  jet.vel.z = 0;
  jet.gearPos = 0;
  jet.flags &= ~EntityFlag.OnGround;
  const inputs: PilotInputs = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0.8, afterburner: false, brakes: 0, gearDown: false,
    airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, jettisonTanks: false,
  };
  world.setPlayerInput(id, inputs);
  for (let i = 0; i < 60; i++) world.stepOnce();
  const events: SimEvent[] = [];
  world.drainEvents(events);
  world.setPlayerInput(id, { ...inputs, jettisonTanks: true });
  world.stepOnce();
  world.setPlayerInput(id, inputs);
  const dropped = effects(world);
  const firstPos = dropped.map((s) => ({ x: s.pos.x - jet.pos.x, y: s.pos.y - jet.pos.y }));
  const impacts: StoreImpactEvent[] = [];
  let maxBelowJetM = 0;
  for (let i = 0; i < 60 * 120 && impacts.length < dropped.length; i++) {
    world.stepOnce();
    for (const s of effects(world)) maxBelowJetM = Math.max(maxBelowJetM, jet.pos.y - s.pos.y);
    events.length = 0;
    world.drainEvents(events);
    for (const ev of events) if (ev.type === 'storeImpact') impacts.push(ev);
  }
  return { firstPos, impacts, tanksAfter: jet.dropTankCount ?? 0, effectsAtEnd: effects(world).length, maxBelowJetM };
}

describe('jettisoned drop tanks', () => {
  test('fall from the pylons, land, and are removed', () => {
    const r = run();
    expect(r.tanksAfter).toBe(0);
    expect(r.firstPos.length).toBeGreaterThan(0);
    // Released at the pylons: within a few metres of the jet, below its centre.
    for (const p of r.firstPos) {
      expect(Math.abs(p.x)).toBeLessThan(4);
      expect(p.y).toBeLessThan(0);
      expect(p.y).toBeGreaterThan(-2);
    }
    expect(r.impacts.length).toBe(r.firstPos.length);
    for (const ev of r.impacts) {
      expect(ev.fuelKg).toBeGreaterThan(0);
      expect(ev.speedMps).toBeGreaterThan(20);
    }
    expect(r.maxBelowJetM).toBeGreaterThan(500);
    expect(r.effectsAtEnd).toBe(0);
  });

  test('is reproducible', () => {
    const a = run();
    const b = run();
    expect(b.impacts.map((e) => [e.pos.x, e.pos.z])).toEqual(a.impacts.map((e) => [e.pos.x, e.pos.z]));
  });
});
