/**
 * tests/combat/airDefence.test.ts — the air-defence network on synthetic ground (flat at 200 m, or
 * with a ridge): a LY-80 battery detects, locks and fires a two-missile salvo; terrain, the
 * low-altitude floor and clutter hide a target; an ambush site stays dark until the early-warning
 * network cues it; a silenced site stops guiding its missiles. Then in the real World: the battery
 * shoots at a jet flying at it, and the jet's RWR shows the LY-80 tracking, then guiding.
 */
import { describe, expect, it, test } from 'vitest';
import { AirDefenceNetwork, type AdSiteSpec, type AdUnitSpec } from '../../src/combat';
import { SITE_TEMPLATES } from '../../src/catalog';
import type { DetectableEntity, ProjectileSpawnRequest } from '../../src/contracts/combat';
import {
  HUD_BLOCK_START,
  RWR_BASE,
  RWR_SYMBOLS,
  SNAPSHOT_FLOATS,
  SNAPSHOT_RWR_STRIDE,
  SnapshotHud,
  SnapshotRwr,
  type HeightSampler,
  type Mission,
  type PilotInputs,
  type SimEvent,
} from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { Quat } from '../../src/math';

const flat: HeightSampler = { seed: 0, heightAt: () => 200, normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o) };
/** A 600 m ridge across x = 10 km. */
const ridge: HeightSampler = { seed: 0, heightAt: (x) => (Math.abs(x - 10000) < 300 ? 800 : 200), normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o) };

const LY80 = SITE_TEMPLATES['sam-mr-battery']!.airDefence!;

/** A LY-80 battery at the origin: search + track radars and two launchers (ids 1..4), team 1. */
function battery(emcon: 'active' | 'ambush' = 'active', withEw = false) {
  const sites: AdSiteSpec[] = [{ id: 'sam', team: 1, system: LY80, emcon }];
  const units: AdUnitSpec[] = [
    { entityId: 1, siteId: 'sam', typeId: 'radar-search' },
    { entityId: 2, siteId: 'sam', typeId: 'radar-track' },
    { entityId: 3, siteId: 'sam', typeId: 'sam-tel' },
    { entityId: 4, siteId: 'sam', typeId: 'sam-tel' },
  ];
  const ents: DetectableEntity[] = [1, 2, 3, 4].map((id) => ({ id, team: 1, kind: 'ground', pos: { x: 0, y: 200, z: id * 50 }, vel: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, alive: true }));
  if (withEw) {
    sites.push({ id: 'ew', team: 1, system: SITE_TEMPLATES['ew-site']!.airDefence!, emcon: 'active' });
    units.push({ entityId: 5, siteId: 'ew', typeId: 'radar-ew' });
    ents.push({ id: 5, team: 1, kind: 'ground', pos: { x: -20000, y: 200, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, alive: true });
  }
  return { net: new AirDefenceNetwork(sites, units, 7), ents };
}

function jet(x: number, y: number, vx = -250): DetectableEntity {
  return { id: 100, team: 0, kind: 'aircraft', pos: { x, y, z: 0 }, vel: { x: vx, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, alive: true, radarSignature: { noseOnRcsM2: 2, broadsideRcsM2: 6 } };
}

/** Runs `sec` of the network with the jet flying straight; returns the launch requests. */
function run(net: AirDefenceNetwork, ents: DetectableEntity[], j: DetectableEntity, sec: number, sampler = flat, destroyed = new Set<number>()): ProjectileSpawnRequest[] {
  const all: ProjectileSpawnRequest[] = [];
  const dt = 1 / 120;
  let nextId = 1000;
  for (let t = 0; t < sec; t += dt) {
    j.pos.x += j.vel.x * dt;
    const req: ProjectileSpawnRequest[] = [];
    net.step(t, dt, [...ents, j], (id) => destroyed.has(id), sampler, req, []);
    for (const r of req) net.missileLaunched(nextId++, r.ownerId, r.targetId!);
    all.push(...req);
  }
  return all;
}

describe('air-defence network', () => {
  it('a LY-80 battery locks a jet at 6 km altitude and fires a two-missile salvo, no more', () => {
    const { net, ents } = battery();
    const j = jet(36000, 6000);
    const shots = run(net, ents, j, 10);
    expect(shots).toHaveLength(2);
    expect(shots.every((r) => r.targetId === 100 && r.profile?.id === 'ly-80-msl')).toBe(true);
    expect(new Set(shots.map((r) => r.ownerId)).size).toBe(2); // both launchers
    expect(net.guiding(shots[0]!.ownerId, 100)).toBe(true);
    const states = net.emissions().map((e) => e.state).sort();
    expect(states).toEqual([0, 2]); // search radar searching, engagement radar guiding
  });

  it('nothing fires at a jet beyond the envelope, behind a ridge, or below the radar floor', () => {
    let b = battery();
    expect(run(b.net, b.ents, jet(80000, 6000, 0), 6)).toHaveLength(0);
    b = battery();
    expect(run(b.net, b.ents, jet(20000, 500, 0), 6, ridge)).toHaveLength(0);
    b = battery();
    expect(run(b.net, b.ents, jet(15000, 200 + 15, 0), 6)).toHaveLength(0);
    // Low (60 m) but in the open: clutter shrinks the reach; close in it does shoot.
    b = battery();
    expect(run(b.net, b.ents, jet(30000, 260, 0), 6)).toHaveLength(0);
    b = battery();
    expect(run(b.net, b.ents, jet(12000, 260, 0), 6).length).toBeGreaterThan(0);
  });

  it('an ambush site stays dark until the early-warning network sees the jet near its envelope', () => {
    const { net, ents } = battery('ambush', true);
    const j = jet(75000, 7000, -300);
    run(net, ents, j, 1);
    expect(net.emissions().some((e) => e.entityId === 1 || e.entityId === 2)).toBe(false);
    expect(net.emissions().some((e) => e.entityId === 5)).toBe(true); // EW radar transmits
    // Still dark at 60 km (outside 1.3 x its 40 km envelope)...
    run(net, ents, j, 45);
    expect(net.emissions().some((e) => e.entityId === 1 || e.entityId === 2)).toBe(false);
    // ...then cued, and it shoots once the jet is inside 40 km.
    const shots = run(net, ents, j, 80);
    expect(shots.length).toBeGreaterThan(0);
  });

  it('a silenced or blinded site stops guiding its missiles', () => {
    let b = battery();
    const shots = run(b.net, b.ents, jet(36000, 6000), 10);
    b.net.silence(1, 1e9);
    run(b.net, b.ents, jet(30000, 6000), 0.2);
    expect(b.net.guiding(shots[0]!.ownerId, 100)).toBe(false);
    b = battery();
    const s2 = run(b.net, b.ents, jet(36000, 6000), 10);
    run(b.net, b.ents, jet(30000, 6000), 0.2, flat, new Set([2])); // engagement radar destroyed
    expect(b.net.guiding(s2[0]!.ownerId, 100)).toBe(false);
  });
});

const inputs = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.8, afterburner: false, brakes: 0, gearDown: false,
  airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...over,
});

describe('in the World', () => {
  test('the battery engages a jet flying straight at it; the RWR shows L8 tracking then guiding', () => {
    const base = resolveBuiltinMission('border-free');
    const mission: Mission = {
      ...base,
      aiFlights: [],
      playerStart: { pos: { x: 0, y: 5000, z: 30000 }, headingRad: 0, speedMps: 250 },
      groundGroups: [{ id: 'sam', team: 1, template: 'sam-mr-battery', pos: { x: 0, z: 0 }, headingRad: 0 }],
      objectives: [{ id: 'o', kind: 'survive_time', description: '', params: { seconds: 9999 } }],
    };
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const id = world.getPlayerEntityId();
    const snap = new Float64Array(SNAPSHOT_FLOATS);
    const events: SimEvent[] = [];
    const drained: SimEvent[] = [];
    const pos = { x: 0, y: 5000, z: 30000 };
    const seen = new Set<string>();
    for (let t = 0; t < 120 * 90; t++) {
      const p = world.getEntityState(id);
      if (!p || !p.alive) break;
      p.pos.x = pos.x; p.pos.y = pos.y; p.pos.z = pos.z;
      Quat.fromYawPitchRoll(0, 0, 0, p.rot);
      p.vel.x = 0; p.vel.y = 0; p.vel.z = -250;
      pos.z -= 250 / 120;
      world.setPlayerInput(id, inputs());
      world.stepOnce();
      const n = world.drainEvents(drained);
      events.push(...drained.slice(0, n));
      if (t % 30 === 0) {
        world.writeSnapshot(snap);
        const nr = snap[HUD_BLOCK_START + SnapshotHud.RWR_COUNT]!;
        for (let k = 0; k < nr; k++) {
          const o = HUD_BLOCK_START + RWR_BASE + k * SNAPSHOT_RWR_STRIDE;
          seen.add(`${RWR_SYMBOLS[snap[o + SnapshotRwr.SYMBOL]!]}:${snap[o + SnapshotRwr.STATE]}`);
        }
      }
      if (events.some((e) => (e.type === 'hit' || e.type === 'crash') && (('targetId' in e && e.targetId === id) || ('entityId' in e && e.entityId === id)))) break;
    }
    expect(events.filter((e) => e.type === 'missileLaunch' && e.weapon === 'radar_missile').length).toBeGreaterThanOrEqual(1);
    expect(seen.has('L8:0') || seen.has('L8:1')).toBe(true);
    expect(seen.has('L8:2')).toBe(true);
    // A jet flying straight and level at a LY-80 without countermeasures gets hit.
    expect(events.some((e) => e.type === 'hit' && e.targetId === id)).toBe(true);
  });
});
