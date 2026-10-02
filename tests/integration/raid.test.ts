/**
 * tests/integration/raid.test.ts — W8 in the real World: an AI strike JF-17 runs in at low level
 * and bombs the Bhisiana fuel depot with its CCRP; a SEAD JF-17 fires MAR-1s at the Akash battery
 * from stand-off range; Akash and SPYDER shoot down a medium-altitude striker before it reaches the
 * base. (The player is parked far away, out of it.)
 */
import { describe, expect, test } from 'vitest';
import { EntityFlag, type Mission, type PilotInputs, type SimEvent } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { Quat } from '../../src/math';

const idle: PilotInputs = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0.8, afterburner: false, brakes: 0, gearDown: false,
  airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false,
};

function run(mission: Mission, maxSec: number, until: (events: readonly SimEvent[]) => boolean, watch?: (world: ReturnType<typeof createWorld>) => void) {
  const world = createWorld(buildWorldDependencies(mission));
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const events: SimEvent[] = [];
  const drained: SimEvent[] = [];
  for (let k = 0; k < maxSec * 120 && !until(events); k++) {
    // The player sits far away, high and out of the fight.
    const p = world.getEntityState(id)!;
    p.pos.x = 90000; p.pos.y = 9000; p.pos.z = -40000;
    Quat.fromYawPitchRoll(Math.PI / 2, 0, 0, p.rot);
    p.vel.x = 200; p.vel.y = 0; p.vel.z = 0;
    world.setPlayerInput(id, idle);
    world.stepOnce();
    const n = world.drainEvents(drained);
    events.push(...drained.slice(0, n));
    watch?.(world);
  }
  return { world, events };
}

describe('raid on Bhisiana', () => {
  test('a strike JF-17 runs in low and bombs the fuel depot', () => {
    const base = resolveBuiltinMission('border-defence');
    const strike = base.aiFlights.find((f) => f.id === 'strike')!;
    const mission: Mission = { ...base, groundGroups: [], objectives: [], aiFlights: [{ ...strike, count: 1 }] };
    let maxAgl = 0;
    let strikerId = -1;
    const { events } = run(
      mission,
      330,
      (ev) => ev.some((e) => e.type === 'groundKill' && e.typeId === 'fuel_tank'),
      (world) => {
        // Height above the ground on the run-in (after the first 20 s to settle), before the target.
        if (strikerId < 0) strikerId = [...(world as unknown as { hostileAircraftIds: Set<number> }).hostileAircraftIds][0] ?? -1;
        const s = strikerId >= 0 ? world.getEntityState(strikerId) : undefined;
        if (s && s.alive && world.simTimeSec > 20 && s.pos.x < 26000 && !(s.flags & EntityFlag.OnGround)) {
          const deps = (world as unknown as { deps: { sampler: { heightAt(x: number, z: number): number } } }).deps;
          maxAgl = Math.max(maxAgl, s.pos.y - deps.sampler.heightAt(s.pos.x, s.pos.z));
        }
      },
    );
    expect(events.filter((e) => e.type === 'missileLaunch' && e.weapon === 'bomb').length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === 'groundKill' && e.typeId === 'fuel_tank')).toBe(true);
    expect(maxAgl).toBeGreaterThan(0);
    expect(maxAgl).toBeLessThan(400);
  });

  test('a SEAD JF-17 fires MAR-1s at the Akash battery from stand-off range; the battery loses its radar or hides', () => {
    const base = resolveBuiltinMission('border-defence');
    const sead = base.aiFlights.find((f) => f.id === 'sead')!;
    const mission: Mission = {
      ...base,
      objectives: [],
      aiFlights: [{ ...sead, count: 1 }],
      groundGroups: base.groundGroups!.filter((g) => g.id === 'akash' || g.id === 'mrsam'),
    };
    let world: ReturnType<typeof createWorld> | undefined;
    const suppressed = (): number => (world as unknown as { deps: { combat: { siteSuppressedSec(id: string): number } } }).deps.combat.siteSuppressedSec('akash');
    const r = run(mission, 200, (ev) => ev.some((e) => e.type === 'groundKill' && e.groupId === 'akash') || (world !== undefined && suppressed() > 5), (w) => (world = w));
    const arms = r.events.filter((e) => e.type === 'missileLaunch' && e.weapon === 'arm');
    expect(arms.length).toBe(2);
    // The MR-SAM engaged the SEAD aircraft on its way in.
    expect(r.events.some((e) => e.type === 'missileLaunch' && e.weapon === 'radar_missile')).toBe(true);
    const radarKilled = r.events.some((e) => e.type === 'groundKill' && e.groupId === 'akash' && (e.typeId === 'radar-track' || e.typeId === 'radar-search'));
    expect(radarKilled || suppressed() > 5).toBe(true);
  });

  test('Akash and SPYDER shoot down a JF-17 bombing the base from medium altitude', () => {
    const base = resolveBuiltinMission('border-defence');
    const strike = base.aiFlights.find((f) => f.id === 'strike')!;
    const mission: Mission = {
      ...base,
      objectives: [],
      aiFlights: [{ ...strike, count: 1, startPos: { x: 2000, y: 4000, z: -2000 }, strike: { targets: strike.strike!.targets, ingressAltM: 4000 } }],
      groundGroups: base.groundGroups!.filter((g) => g.id === 'akash' || g.id === 'spyder'),
    };
    const { events } = run(mission, 200, (ev) => ev.some((e) => e.type === 'kill'));
    expect(events.some((e) => e.type === 'kill')).toBe(true);
    expect(events.some((e) => e.type === 'groundKill' && e.team === 0)).toBe(false);
  });
});
