/**
 * tests/integration/sead.test.ts — the Rudram-1 anti-radiation missile: it reaches a point 100 km
 * out from 9 km up (pre-briefed coordinates); in the real World, T picks the LY-80 battery's radar,
 * the seeker locks while it transmits, the missile flies 70 km and the battery is suppressed (it
 * shut its radars down, or lost one to the missile).
 */
import { describe, expect, it, test } from 'vitest';
import { createProjectilePool, initProjectile, isaDensityKgM3, stepProjectile } from '../../src/combat';
import { WEAPONS } from '../../src/catalog';
import type { CombatEnvironment } from '../../src/contracts/combat';
import { HUD_BLOCK_START, LockStateCode, SNAPSHOT_FLOATS, SnapshotHud, type EntityState, type HeightSampler, type Mission, type PilotInputs, type SimEvent } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { Quat } from '../../src/math';

const FLAT: HeightSampler = { seed: 0, heightAt: () => 200, normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o) };
const ENV: CombatEnvironment = { airDensityKgM3: 1.225, windWorldMps: { x: 0, y: 0, z: 0 }, gravityMps2: 9.80665, densityAtAltitude: isaDensityKgM3 };

describe('Rudram-1', () => {
  it('reaches pre-briefed coordinates 100 km out from 9 km up', () => {
    const p = WEAPONS['rudram-1']!;
    const m: EntityState = {
      id: 9, kind: 'missile', team: 0, pos: { x: 0, y: 9000, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: 0, z: -270 },
      omega: { x: 0, y: 0, z: 0 }, alive: true, hp: 100, fuelKg: 0, elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0, afterburnerOn: false, flags: 0,
    };
    const slot = createProjectilePool(1)[0]!;
    initProjectile(slot, { kind: 'arm', ownerId: 1, team: 0, posWorld: m.pos, rotWorld: m.rot, velWorld: m.vel, profile: p, targetPoint: { x: 0, y: 200, z: -100000 } }, 0);
    let impact: { x: number; z: number } | undefined;
    for (let t = 0; t < 300 && !impact; t += 1 / 60) {
      const r = stepProjectile(m, slot, [], FLAT, ENV, 1 / 60, m);
      if (r.outcome === 'terrain_impact') impact = r.impactPos!;
      else if (r.outcome !== 'flying') break;
    }
    expect(impact).toBeDefined();
    expect(Math.hypot(impact!.x, impact!.z + 100000)).toBeLessThan(40);
  });
});

const inputs = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.8, afterburner: false, brakes: 0, gearDown: false,
  airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...over,
});

describe('in the World', () => {
  test('T picks the LY-80 radar, the Rudram locks and flies 70 km, and the battery is suppressed', () => {
    const base = resolveBuiltinMission('border-sead');
    const mission: Mission = {
      ...base,
      playerStart: { pos: { x: 0, y: 9000, z: 70000 }, headingRad: 0, speedMps: 250, loadoutId: 'sead' },
      groundGroups: [{ id: 'ly80', team: 1, template: 'sam-mr-battery', pos: { x: 0, z: 0 }, headingRad: 0 }],
    };
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const id = world.getPlayerEntityId();
    const snap = new Float64Array(SNAPSHOT_FLOATS);
    const hud = (f: number): number => (world.writeSnapshot(snap), snap[HUD_BLOCK_START + f]!);
    const events: SimEvent[] = [];
    const drained: SimEvent[] = [];
    const pos = { x: 0, y: 9000, z: 70000 };
    let heading = 0;
    const step = (inp: PilotInputs): void => {
      const p = world.getEntityState(id)!;
      p.pos.x = pos.x; p.pos.y = pos.y; p.pos.z = pos.z;
      Quat.fromYawPitchRoll(heading, 0, 0, p.rot);
      p.vel.x = Math.sin(heading) * 250; p.vel.y = 0; p.vel.z = -Math.cos(heading) * 250;
      pos.x += p.vel.x / 120; pos.z += p.vel.z / 120;
      world.setPlayerInput(id, inp);
      world.stepOnce();
      const n = world.drainEvents(drained);
      events.push(...drained.slice(0, n));
    };
    for (let k = 0; k < 3; k++) { step(inputs({ cycleWeapon: true })); step(inputs()); } // -> Rudram
    for (let t = 0; t < 120 * 3; t++) step(inputs()); // the battery's search radar comes on
    step(inputs({ cycleTarget: true }));
    step(inputs());
    expect(hud(SnapshotHud.TARGET_ID)).toBeGreaterThanOrEqual(0);
    for (let t = 0; t < 120 * 3 && hud(SnapshotHud.LOCK_STATE) !== LockStateCode.locked; t++) step(inputs());
    expect(hud(SnapshotHud.LOCK_STATE)).toBe(LockStateCode.locked);
    step(inputs({ launch: true }));
    step(inputs());
    expect(events.some((e) => e.type === 'missileLaunch' && e.weapon === 'arm')).toBe(true);
    // Turn away (out of the battery's reach) and wait for the missile.
    heading = Math.PI;
    const combat = (world as unknown as { deps: { combat: { siteSuppressedSec(id: string): number } } }).deps.combat;
    for (let t = 0; t < 120 * 200; t++) {
      step(inputs());
      if (events.some((e) => e.type === 'groundKill') || combat.siteSuppressedSec('ly80') > 5) break;
    }
    const killedRadar = events.some((e) => e.type === 'groundKill' && (e.typeId === 'radar-search' || e.typeId === 'radar-track'));
    expect(killedRadar || combat.siteSuppressedSec('ly80') > 5).toBe(true);
  });
});
