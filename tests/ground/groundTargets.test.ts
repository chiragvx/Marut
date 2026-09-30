/**
 * tests/ground/groundTargets.test.ts — the ground damage model: box hit tests, blast by scaled
 * distance against each armour class, gun rounds, events; and in the real World: strafing a truck
 * destroys it (credited to the player) and completes a destroy_group objective; airbase structures
 * are targets.
 */
import { describe, expect, it, test } from 'vitest';
import { GroundTargetSet, distanceToBox, segmentBoxEntry, placeGroundGroups } from '../../src/ground';
import { GROUND_UNIT_TYPES, SITE_TEMPLATES } from '../../src/catalog';
import { GROUND_TYPE_IDS, TargetStateCode, type ArmorClass } from '../../src/contracts/ground';
import type { HeightSampler, Mission, PilotInputs, SimEvent } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { Quat } from '../../src/math';

function oneTarget(armor: ArmorClass, toughness = 1, headingRad = 0) {
  const set = new GroundTargetSet();
  const tg = set.add({ entityId: 5, targetId: 't', typeId: 'x', groupId: 'g', team: 1, armor, toughness, burnSec: 30, pos: { x: 0, y: 1.5, z: 0 }, headingRad, half: { x: 4, y: 1.5, z: 1.25 } });
  return { set, tg };
}

describe('boxes', () => {
  it('a segment enters the box where expected, respecting its heading', () => {
    const { tg } = oneTarget('soft', 1, Math.PI / 2); // facing east: length along x
    // Heading 90 deg (east): the 8 m length runs along world x, the 2.5 m width along z.
    expect(segmentBoxEntry({ x: -10, y: 1, z: 0 }, { x: 10, y: 1, z: 0 }, tg)).toBeCloseTo(6 / 20, 5);
    expect(segmentBoxEntry({ x: 0, y: 1, z: -10 }, { x: 0, y: 1, z: 10 }, tg)).toBeCloseTo(8.75 / 20, 5);
    expect(segmentBoxEntry({ x: -10, y: 5, z: 0 }, { x: 10, y: 5, z: 0 }, tg)).toBe(-1);
    expect(distanceToBox({ x: 0, y: 1, z: 5.25 }, tg)).toBeCloseTo(4, 5);
    expect(distanceToBox({ x: 1, y: 1, z: 0 }, tg)).toBe(0);
  });
});

describe('blast', () => {
  // A 250 kg-class charge (cube root ~6.3): soft kill out to ~57 m, light ~31 m, armour ~14 m, hardened ~4 m.
  const w = { explosiveKg: 250 };
  // Off the truck's side (heading 0 = north: its width runs east-west).
  const at = (d: number) => ({ x: 1.25 + d, y: 1.5, z: 0 });

  it('destroys soft targets far further out than armoured ones', () => {
    const r: Record<string, number> = {};
    for (const armor of ['soft', 'light', 'armored', 'hardened'] as const) {
      // Largest distance that still destroys it outright.
      let d = 0;
      for (let x = 0; x < 200; x += 1) {
        const { set, tg } = oneTarget(armor);
        set.blast(at(x), w, 1, []);
        if (tg.state === TargetStateCode.Destroyed) d = x;
      }
      r[armor] = d;
    }
    expect(r.soft).toBeGreaterThan(50);
    expect(r.light).toBeGreaterThan(25);
    expect(r.light).toBeLessThan(r.soft!);
    expect(r.armored).toBeLessThan(r.light!);
    expect(r.hardened).toBeLessThan(6);
  });

  it('hardened targets need a direct hit, or a penetrator', () => {
    const a = oneTarget('hardened');
    a.set.blast(at(8), w, 1, []);
    expect(a.tg.state).not.toBe(TargetStateCode.Destroyed);
    const b = oneTarget('hardened');
    b.set.blast(at(8), { explosiveKg: 250, penetrator: true }, 1, []);
    expect(b.tg.state).toBe(TargetStateCode.Destroyed);
  });

  it('damage beyond the kill radius accumulates; the kill is credited and reported once', () => {
    const { set, tg } = oneTarget('soft');
    const ev: SimEvent[] = [];
    set.blast(at(80), w, 7, ev); // ~1.4x kill distance: partial damage
    expect(tg.hp).toBeGreaterThan(0);
    expect(tg.hp).toBeLessThan(1);
    for (let i = 0; i < 5; i++) set.blast(at(80), w, 7, ev);
    expect(tg.state).toBe(TargetStateCode.Destroyed);
    const kills = ev.filter((e) => e.type === 'groundKill');
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({ entityId: 5, sourceId: 7, groupId: 'g', burnSec: 30 });
    expect(tg.burnLeftSec).toBe(30);
    set.step(10);
    expect(tg.burnLeftSec).toBe(20);
  });
});

describe('guns', () => {
  it('a burst kills a truck, scratches a tank, does nothing to a bunker', () => {
    const rounds = (armor: ArmorClass): number => {
      const { set, tg } = oneTarget(armor);
      let n = 0;
      while (tg.state !== TargetStateCode.Destroyed && n < 1000) {
        set.gunHit(tg.key, 1, []);
        n++;
      }
      return n;
    };
    expect(rounds('soft')).toBeLessThanOrEqual(20);
    expect(rounds('light')).toBeGreaterThan(rounds('soft'));
    expect(rounds('armored')).toBeGreaterThan(200);
    expect(rounds('hardened')).toBe(1000);
  });
});

describe('catalogue', () => {
  it('every unit type has a snapshot code and every template uses known types', () => {
    for (const id of Object.keys(GROUND_UNIT_TYPES)) expect(GROUND_TYPE_IDS.indexOf(id), id).toBeGreaterThan(0);
    for (const tpl of Object.values(SITE_TEMPLATES)) for (const u of tpl.units) expect(GROUND_UNIT_TYPES[u.type], `${tpl.id}: ${u.type}`).toBeDefined();
  });
  it('places a template round its origin, rotated by its heading, on the terrain', () => {
    const flat: HeightSampler = { seed: 0, heightAt: () => 250, normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o) };
    const units = placeGroundGroups([{ id: 'c', team: 1, template: 'convoy-supply', pos: { x: 1000, z: 2000 }, headingRad: Math.PI / 2 }], flat);
    expect(units).toHaveLength(SITE_TEMPLATES['convoy-supply']!.units.length);
    // Heading east: the column trails back to the west (dx negative -> smaller x), z unchanged.
    expect(units[0]).toMatchObject({ x: 1000, z: 2000, groundY: 250 });
    expect(units[1]!.x).toBeCloseTo(960, 6);
    expect(units[1]!.z).toBeCloseTo(2000, 6);
  });
});

const inputs = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.8, afterburner: false, brakes: 0, gearDown: false,
  airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...over,
});

describe('in the World', () => {
  test('strafing a truck destroys it, credits the player, and completes destroy_group', () => {
    const base = resolveBuiltinMission('border-free');
    const mission: Mission = {
      ...base,
      aiFlights: [],
      playerStart: { pos: { x: 0, y: 3000, z: 0 }, headingRad: 0, speedMps: 200 },
      groundGroups: [{ id: 'trucks', team: 1, units: [{ type: 'truck-cargo', dx: 0, dz: 0 }], pos: { x: 0, z: -5000 }, headingRad: 0 }],
      objectives: [{ id: 'o', kind: 'destroy_group', description: 'Destroy the truck', params: { group: 'trucks' } }],
    };
    const deps = buildWorldDependencies(mission);
    const world = createWorld(deps);
    world.loadMission(mission);
    const id = world.getPlayerEntityId();
    const tx = 0, tz = -5000, ty = deps.sampler.heightAt(tx, tz) + 1.5;
    const events: SimEvent[] = [];
    const drained: SimEvent[] = [];
    for (let t = 0; t < 240; t++) {
      // Dive at the truck from 500 m out, 20 deg down, nose on it (teleported each tick).
      const p = world.getEntityState(id)!;
      const pitch = (-20 * Math.PI) / 180;
      p.pos.x = tx; p.pos.y = ty + 500 * Math.sin(-pitch); p.pos.z = tz + 500 * Math.cos(pitch);
      Quat.fromYawPitchRoll(0, pitch, 0, p.rot);
      // Flying down the dive line (bullets inherit the jet's velocity).
      p.vel.x = 0; p.vel.y = 200 * Math.sin(pitch); p.vel.z = -200 * Math.cos(pitch);
      world.setPlayerInput(id, inputs({ trigger: true }));
      world.stepOnce();
      const n = world.drainEvents(drained);
      events.push(...drained.slice(0, n));
      if (events.some((e) => e.type === 'missionEnded')) break;
    }
    const kill = events.find((e) => e.type === 'groundKill');
    expect(kill).toMatchObject({ typeId: 'truck-cargo', groupId: 'trucks', sourceId: id });
    expect(events.some((e) => e.type === 'groundImpact')).toBe(true);
    expect(events.find((e) => e.type === 'missionEnded')).toMatchObject({ outcome: 'success' });
  });

  test('airbase structures are targets: a blast on PAF Shahbaz fuel tanks sets them burning', () => {
    const mission = resolveBuiltinMission('border-intercept');
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const set = (world as unknown as { ground: GroundTargetSet }).ground;
    const tanks = set.targets.filter((t) => t.targetId.startsWith('pafb-shahbaz:') && t.typeId === 'fuel_tank');
    expect(tanks.length).toBeGreaterThan(0);
    const ev: SimEvent[] = [];
    set.blast(tanks[0]!.pos, { explosiveKg: 250 }, 3, ev);
    expect(ev.some((e) => e.type === 'targetState' && e.targetId === tanks[0]!.targetId && e.state === TargetStateCode.Destroyed)).toBe(true);
    expect(set.count((t) => t.targetId.startsWith('bhisiana-afs:')).total).toBeGreaterThan(30);
  });
});
