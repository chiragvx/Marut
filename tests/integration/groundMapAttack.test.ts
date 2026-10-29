/**
 * tests/integration/groundMapAttack.test.ts — a level CCRP attack in the real World with no dive:
 * with bombs selected the radar maps the targets ahead (the snapshot's ground-map list), the target
 * key designates them in turn (not the pipper, which is far below the HUD in level flight), and
 * holding release drops the bomb at the release point onto the designated truck.
 */
import { describe, expect, test } from 'vitest';
import {
  AgCueCode,
  AgModeCode,
  GroundMapKind,
  HUD_BLOCK_START,
  HUD_EXT_BASE,
  SNAPSHOT_FLOATS,
  SNAPSHOT_GROUND_STRIDE,
  SnapshotGround,
  SnapshotGroundFlag,
  SnapshotHud,
  SnapshotHudExt,
  type Mission,
  type PilotInputs,
  type SimEvent,
} from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { Quat } from '../../src/math';

const inputs = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.8, afterburner: false, brakes: 0, gearDown: false,
  airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...over,
});

const NEAR = { x: 10, z: -14000 };
const FAR = { x: -40, z: -17000 };
const DT = 1 / 120;

function setup() {
  const base = resolveBuiltinMission('border-free');
  const mission: Mission = {
    ...base,
    aiFlights: [],
    route: [],
    playerStart: { pos: { x: 0, y: 1500, z: 0 }, headingRad: 0, speedMps: 230, loadoutId: 'strike' },
    groundGroups: [
      { id: 'near', team: 1, units: [{ type: 'truck-cargo', dx: 0, dz: 0 }], pos: NEAR, headingRad: 0 },
      { id: 'far', team: 1, units: [{ type: 'apc', dx: 0, dz: 0 }], pos: FAR, headingRad: 0 },
    ],
    objectives: [{ id: 'o', kind: 'destroy_group', description: '', params: { group: 'near' } }],
  };
  const deps = buildWorldDependencies(mission);
  const world = createWorld(deps);
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const snap = new Float64Array(SNAPSHOT_FLOATS);
  const events: SimEvent[] = [];
  const drained: SimEvent[] = [];
  const read = (): Float64Array => {
    world.writeSnapshot(snap);
    return snap;
  };
  const hud = (f: number): number => read()[HUD_BLOCK_START + f]!;
  const ground = () => {
    const s = read();
    const o = HUD_BLOCK_START + HUD_EXT_BASE;
    const n = s[o + SnapshotHudExt.GROUND_COUNT]!;
    return Array.from({ length: n }, (_, k) => {
      const e = o + SnapshotHudExt.GROUND_BASE + k * SNAPSHOT_GROUND_STRIDE;
      return { x: s[e + SnapshotGround.X]!, z: s[e + SnapshotGround.Z]!, kind: s[e + SnapshotGround.KIND]!, designated: (s[e + SnapshotGround.FLAGS]! & SnapshotGroundFlag.Designated) !== 0 };
    });
  };
  const step = (inp: PilotInputs): void => {
    world.setPlayerInput(id, inp);
    world.stepOnce();
    const n = world.drainEvents(drained);
    events.push(...drained.slice(0, n));
  };
  const pos = { x: 0, y: deps.sampler.heightAt(NEAR.x, NEAR.z) + 1500, z: 0 };
  /** Level, heading north at 230 m/s (teleported each tick). */
  const fly = (): void => {
    const p = world.getEntityState(id)!;
    p.pos.x = pos.x; p.pos.y = pos.y; p.pos.z = pos.z;
    Quat.fromYawPitchRoll(0, 0, 0, p.rot);
    p.vel.x = 0; p.vel.y = 0; p.vel.z = -230;
    pos.z -= 230 * DT;
  };
  const tick = (inp: PilotInputs = inputs()): void => {
    fly();
    step(inp);
  };
  const cue = (): number => read()[HUD_BLOCK_START + HUD_EXT_BASE + SnapshotHudExt.AG_CUE]!;
  return { world, id, events, hud, ground, tick, cue, pos };
}

describe('ground-map attack', () => {
  test('the radar maps the targets ahead once bombs are selected', () => {
    const s = setup();
    s.tick();
    expect(s.ground()).toHaveLength(0); // the gun: the air picture
    for (let i = 0; i < 4; i++) s.tick(inputs({ cycleWeapon: i % 2 === 0 })); // gun -> ASRAAM -> HSLD-250
    const g = s.ground();
    expect(g).toHaveLength(2);
    // Nearest first, with what they are.
    expect(g[0]).toMatchObject({ kind: GroundMapKind.Vehicle, designated: false });
    expect(g[1]).toMatchObject({ kind: GroundMapKind.Armor });
    expect(Math.hypot(g[0]!.x - NEAR.x, g[0]!.z - NEAR.z)).toBeLessThan(5);
  });

  test('level flight: T designates the mapped targets in turn (not the pipper), holding release drops on the truck', () => {
    const s = setup();
    for (let i = 0; i < 4; i++) s.tick(inputs({ cycleWeapon: i % 2 === 0 }));
    for (let i = 0; i < 130; i++) s.tick();
    // The pipper is far below the HUD (and short of the targets): T takes the map's nearest target.
    s.tick(inputs({ cycleTarget: true }));
    s.tick();
    expect(s.hud(SnapshotHud.AG_MODE)).toBe(AgModeCode.Ccrp);
    expect(Math.hypot(s.hud(SnapshotHud.SPI_X) - NEAR.x, s.hud(SnapshotHud.SPI_Z) - NEAR.z)).toBeLessThan(5);
    expect(s.ground()[0]!.designated).toBe(true);
    // Again: the next one; and again: back round to the first.
    s.tick(inputs({ cycleTarget: true }));
    s.tick();
    expect(Math.hypot(s.hud(SnapshotHud.SPI_X) - FAR.x, s.hud(SnapshotHud.SPI_Z) - FAR.z)).toBeLessThan(5);
    s.tick(inputs({ cycleTarget: true }));
    s.tick();
    expect(Math.hypot(s.hud(SnapshotHud.SPI_X) - NEAR.x, s.hud(SnapshotHud.SPI_Z) - NEAR.z)).toBeLessThan(5);
    // Hold release all the way in: the computer drops it at the release point.
    for (let t = 0; t < 120 * 90 && !s.events.some((e) => e.type === 'groundKill'); t++) s.tick(inputs({ launch: true }));
    expect(s.events.filter((e) => e.type === 'missileLaunch' && e.weapon === 'bomb')).toHaveLength(1);
    const impact = s.events.find((e) => e.type === 'groundImpact' && e.explosiveKg > 0) as { pos: { x: number; z: number } } | undefined;
    expect(impact).toBeDefined();
    expect(Math.hypot(impact!.pos.x - NEAR.x, impact!.pos.z - NEAR.z)).toBeLessThan(30);
    expect(s.events.find((e) => e.type === 'groundKill')).toMatchObject({ typeId: 'truck-cargo', sourceId: s.id });
  });

  test('the release cue walks the pilot through it: select target, hold release, the count, bomb away', () => {
    const s = setup();
    for (let i = 0; i < 4; i++) s.tick(inputs({ cycleWeapon: i % 2 === 0 }));
    for (let i = 0; i < 10; i++) s.tick();
    // Level, nothing designated, the pipper far below the HUD.
    expect(s.cue()).toBe(AgCueCode.Designate);
    s.tick(inputs({ cycleTarget: true }));
    s.tick();
    expect(s.cue()).toBe(AgCueCode.Hold);
    // Off the track: steer (the truck is to the right).
    s.pos.x = -60;
    for (let i = 0; i < 10; i++) s.tick();
    expect(s.cue()).toBe(AgCueCode.Steer);
    expect(s.hud(SnapshotHud.AG_CROSS_M)).toBeGreaterThan(25);
    s.pos.x = 0;
    for (let i = 0; i < 10; i++) s.tick();
    expect(s.cue()).toBe(AgCueCode.Hold);
    // Hold: the count, the bomb goes, "away", then nothing (not "passed": it went).
    const seen: number[] = [];
    for (let t = 0; t < 120 * 60 && !s.events.some((e) => e.type === 'groundImpact' && e.explosiveKg > 0); t++) {
      s.tick(inputs({ launch: true }));
      const c = s.cue();
      if (seen[seen.length - 1] !== c) seen.push(c);
    }
    // (Hold until the held button reaches the sim; Release on the tick the bomb goes.)
    expect(seen).toEqual([AgCueCode.Hold, AgCueCode.Releasing, AgCueCode.Release, AgCueCode.Away, AgCueCode.None]);
  });

  test('a pass flown through without holding release is "passed"', () => {
    const s = setup();
    for (let i = 0; i < 4; i++) s.tick(inputs({ cycleWeapon: i % 2 === 0 }));
    s.tick(inputs({ cycleTarget: true }));
    let last = -1;
    for (let t = 0; t < 120 * 60 && last !== AgCueCode.Passed; t++) {
      s.tick();
      last = s.cue();
    }
    expect(last).toBe(AgCueCode.Passed);
    expect(s.events.some((e) => e.type === 'missileLaunch')).toBe(false);
  });
});
