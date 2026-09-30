/**
 * tests/combat/countermeasures.test.ts — flare/chaff programs, decoy flight, seduction odds, and in
 * the real World: the player's keys release decoys, and an AI with a missile inbound dispenses.
 */
import { describe, expect, it, test } from 'vitest';
import {
  CHAFF_LIFE_SEC,
  FLARE_LIFE_SEC,
  chaffSeductionChance,
  countermeasureRelease,
  createDecoyPool,
  createWeaponsState,
  flareSeductionChance,
  launchDecoy,
  stepDecoy,
} from '../../src/combat';
import { WEAPONS } from '../../src/catalog';
import {
  EntityKindCode,
  HUD_BLOCK_START,
  SNAPSHOT_FLOATS,
  SnapshotEntity,
  SnapshotHeader,
  SnapshotHud,
  entityFieldOffset,
  type PilotInputs,
  type SimEvent,
} from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';

describe('release programs', () => {
  it('a press releases a pair; holding repeats every 0.6 s; counts run out', () => {
    const s = createWeaponsState({ stations: [], countermeasures: { chaff: 5, flares: 30 } }, 1);
    const out = { flares: 0, chaff: 0 };
    const dt = 1 / 120;
    let flares = 0, chaff = 0;
    for (let t = 0; t < 1.3 / dt; t++) {
      countermeasureRelease(s, true, true, dt, out);
      flares += out.flares;
      chaff += out.chaff;
    }
    expect(flares).toBe(6); // t = 0, 0.6, 1.2 s
    expect(chaff).toBe(5); // 2 + 2 + the last one
    expect(s.flares).toBe(24);
    expect(s.chaff).toBe(0);
    countermeasureRelease(s, false, false, dt, out);
    countermeasureRelease(s, true, false, dt, out);
    expect(out.flares).toBe(2);
  });
});

describe('decoy flight', () => {
  it('a flare falls and burns out; chaff all but stops in the air', () => {
    const [flare, chaff] = createDecoyPool(2) as [ReturnType<typeof createDecoyPool>[0], ReturnType<typeof createDecoyPool>[0]];
    const pos = { x: 0, y: 3000, z: 0 }, vel = { x: 250, y: 0, z: 0 }, right = { x: 0, y: 0, z: 1 };
    launchDecoy(flare, 1, 'flare', 7, pos, vel, right, 1);
    launchDecoy(chaff, 2, 'chaff', 7, pos, vel, right, -1);
    const dt = 1 / 120;
    for (let t = 0; t < 1 / dt; t++) {
      stepDecoy(flare, dt);
      stepDecoy(chaff, dt);
    }
    expect(Math.hypot(chaff.vel.x, chaff.vel.z)).toBeLessThan(5);
    expect(flare.vel.x).toBeGreaterThan(20); // still carrying some of the jet's speed
    expect(flare.pos.y).toBeLessThan(3000);
    let alive = true;
    for (let t = 1; t < FLARE_LIFE_SEC + 0.1; t += dt) alive = stepDecoy(flare, dt) && alive;
    expect(alive).toBe(false);
    expect(CHAFF_LIFE_SEC).toBeGreaterThan(FLARE_LIFE_SEC);
  });
});

describe('seduction odds', () => {
  const tgt = { x: 0, y: 5000, z: 0 };
  const vel = { x: 250, y: 0, z: 0 };
  const ahead = { x: 3000, y: 5000, z: 0 };
  const behind = { x: -3000, y: 5000, z: 0 };
  const beam = { x: 0, y: 5000, z: 3000 };

  it('imaging IR seekers resist flares far better than older ones', () => {
    const p = (id: string) => flareSeductionChance(WEAPONS[id]!.ir?.flareResistance, ahead, tgt, vel, false);
    expect(p('python-5')).toBeLessThan(p('asraam'));
    expect(p('asraam')).toBeLessThan(p('aim-9m'));
    expect(p('aim-9m')).toBeLessThan(p('pl-5e'));
  });
  it('flares work better against a head-on shot than a tail shot, and worse with the afterburner lit', () => {
    const r = WEAPONS['pl-5e']!.ir?.flareResistance;
    expect(flareSeductionChance(r, ahead, tgt, vel, false)).toBeGreaterThan(flareSeductionChance(r, behind, tgt, vel, false));
    expect(flareSeductionChance(r, ahead, tgt, vel, true)).toBeLessThan(flareSeductionChance(r, ahead, tgt, vel, false));
  });
  it('chaff mostly works when beaming (in the Doppler notch)', () => {
    const r = WEAPONS['sd-10a']!.radar?.chaffResistance;
    expect(chaffSeductionChance(r, beam, tgt, vel)).toBeGreaterThan(3 * chaffSeductionChance(r, ahead, tgt, vel));
  });
});

const inputs = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.8, afterburner: false, brakes: 0, gearDown: false,
  airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...over,
});

describe('in the World', () => {
  test('the flare key releases a pair (events + HUD count); an AI with a missile inbound dispenses', () => {
    // Airborne (a missile fired on the runway falls straight onto it).
    const mission = { ...resolveBuiltinMission('dogfight-1v1'), playerStart: { pos: { x: 0, y: 3000, z: 0 }, headingRad: 0, speedMps: 220 } };
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const id = world.getPlayerEntityId();
    const snap = new Float64Array(SNAPSHOT_FLOATS);
    const drained: SimEvent[] = [];
    const events: SimEvent[] = [];
    const step = (inp: PilotInputs): void => {
      world.setPlayerInput(id, inp);
      world.stepOnce();
      const n = world.drainEvents(drained);
      events.push(...drained.slice(0, n));
    };
    step(inputs());
    world.writeSnapshot(snap);
    const flaresBefore = snap[HUD_BLOCK_START + SnapshotHud.FLARES]!;
    expect(flaresBefore).toBe(30);
    step(inputs({ dispenseFlare: true }));
    step(inputs());
    world.writeSnapshot(snap);
    expect(snap[HUD_BLOCK_START + SnapshotHud.FLARES]).toBe(flaresBefore - 2);
    expect(events.filter((e) => e.type === 'countermeasure' && e.entityId === id && e.kind === 'flare')).toHaveLength(2);

    // Hold the bandit 5 km dead ahead, nose-on, and fire the Astra at it: it should notice the
    // missile and start dispensing.
    let bandit = -1;
    for (let i = 0; i < snap[SnapshotHeader.ENTITY_COUNT_OFFSET]!; i++) {
      if (snap[entityFieldOffset(i, SnapshotEntity.KIND)] === EntityKindCode.aircraft && snap[entityFieldOffset(i, SnapshotEntity.ID)] !== id) bandit = snap[entityFieldOffset(i, SnapshotEntity.ID)]!;
    }
    let fired = false;
    for (let t = 0; t < 120 * 30; t++) {
      const p = world.getEntityState(id)!;
      const b = world.getEntityState(bandit)!;
      const q = p.rot;
      const fx = 1 - 2 * (q.y * q.y + q.z * q.z), fy = 2 * (q.x * q.y + q.w * q.z), fz = 2 * (q.x * q.z - q.w * q.y);
      b.pos.x = p.pos.x + fx * 5000; b.pos.y = p.pos.y + 300; b.pos.z = p.pos.z + fz * 5000;
      b.vel.x = -fx * 220; b.vel.y = -fy * 220; b.vel.z = -fz * 220;
      b.rot.x = -q.z; b.rot.y = q.w; b.rot.z = q.x; b.rot.w = -q.y; // player's attitude turned 180 deg
      step(inputs({ cycleTarget: !fired && t % 120 === 1, cycleWeapon: t === 3 || t === 6, launch: !fired && t > 10 && t % 20 === 0 }));
      if (!fired && events.some((e) => e.type === 'missileLaunch' && e.shooterId === id)) fired = true;
      if (events.some((e) => e.type === 'countermeasure' && e.entityId === bandit)) break;
    }
    expect(fired).toBe(true);
    expect(events.some((e) => e.type === 'countermeasure' && e.entityId === bandit)).toBe(true);
  });
});
