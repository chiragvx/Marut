/**
 * tests/integration/bombing.test.ts — air-to-ground in the real World: a CCIP drop on the pipper
 * kills a truck; a dive-toss (designate in the dive, pull up holding release) puts the bomb on the
 * designated point; rockets ripple while the button is held; nothing leaves the aircraft on the
 * ground. The jet is flown on a scripted path (teleported each tick).
 */
import { describe, expect, test } from 'vitest';
import { HUD_BLOCK_START, SNAPSHOT_FLOATS, SnapshotHud, AgModeCode, type Mission, type PilotInputs, type SimEvent } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { Quat } from '../../src/math';

const inputs = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.8, afterburner: false, brakes: 0, gearDown: false,
  airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...over,
});

const TARGET = { x: 0, z: -6000 };

function setup(loadoutId: string, airborne = true) {
  const base = resolveBuiltinMission('border-free');
  const mission: Mission = {
    ...base,
    aiFlights: [],
    playerStart: airborne ? { pos: { x: 0, y: 1000, z: 0 }, headingRad: 0, speedMps: 230, loadoutId } : { ...base.playerStart, loadoutId },
    groundGroups: [{ id: 'trucks', team: 1, units: [{ type: 'truck-cargo', dx: 0, dz: 0 }], pos: TARGET, headingRad: 0 }],
    objectives: [{ id: 'o', kind: 'destroy_group', description: '', params: { group: 'trucks' } }],
  };
  const deps = buildWorldDependencies(mission);
  const world = createWorld(deps);
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const groundY = deps.sampler.heightAt(TARGET.x, TARGET.z);
  const snap = new Float64Array(SNAPSHOT_FLOATS);
  const events: SimEvent[] = [];
  const drained: SimEvent[] = [];
  const hud = (f: number): number => {
    world.writeSnapshot(snap);
    return snap[HUD_BLOCK_START + f]!;
  };
  const step = (inp: PilotInputs): void => {
    world.setPlayerInput(id, inp);
    world.stepOnce();
    const n = world.drainEvents(drained);
    events.push(...drained.slice(0, n));
  };
  /** Places the jet: heading north, `pitchRad`, `speed`. */
  const fly = (pos: { x: number; y: number; z: number }, pitchRad: number, speed: number): void => {
    const p = world.getEntityState(id)!;
    p.pos.x = pos.x; p.pos.y = pos.y; p.pos.z = pos.z;
    Quat.fromYawPitchRoll(0, pitchRad, 0, p.rot);
    p.vel.x = 0; p.vel.y = Math.sin(pitchRad) * speed; p.vel.z = -Math.cos(pitchRad) * speed;
  };
  const select = (n: number): void => {
    for (let k = 0; k < n; k++) {
      step(inputs({ cycleWeapon: true }));
      step(inputs());
    }
  };
  return { world, id, groundY, events, hud, step, fly, select };
}

const DT = 1 / 120;

describe('bombing', () => {
  test('CCIP: release with the pipper on the truck, and it is destroyed', () => {
    const s = setup('strike');
    s.select(2); // gun -> ASRAAM -> HSLD-250
    expect(s.hud(SnapshotHud.AG_MODE)).toBe(AgModeCode.Ccip);
    const alt = s.groundY + 700;
    const pos = { x: 0, y: alt, z: 0 };
    let released = false;
    for (let t = 0; t < 120 * 60 && !s.events.some((e) => e.type === 'groundKill'); t++) {
      s.fly(pos, 0, 230);
      pos.z -= 230 * DT;
      const ccipZ = s.hud(SnapshotHud.CCIP_Z);
      const pickle = !released && s.hud(SnapshotHud.AG_MODE) === AgModeCode.Ccip && Math.abs(ccipZ - TARGET.z) < 8;
      s.step(inputs({ launch: pickle }));
      if (pickle) released = true;
    }
    expect(released).toBe(true);
    expect(s.events.filter((e) => e.type === 'missileLaunch' && e.weapon === 'bomb')).toHaveLength(1);
    expect(s.events.find((e) => e.type === 'groundKill')).toMatchObject({ typeId: 'truck-cargo', sourceId: s.id });
    expect(s.events.some((e) => e.type === 'groundImpact' && e.explosiveKg === 110)).toBe(true);
  });

  test('CCRP dive-toss: designate in a 30 deg dive, pull up holding release: the bomb finds the point', () => {
    const s = setup('strike');
    s.select(3); // -> HSLD-450
    const pitch0 = (-30 * Math.PI) / 180;
    // A dive aimed 400 m beyond the truck: the pipper (short of the dive line by the bomb's fall)
    // creeps up the line and crosses the truck.
    const pos = { x: 0, y: s.groundY + 1500, z: TARGET.z - 400 + 1500 / Math.tan(-pitch0) };
    let designated = false;
    let pitch = pitch0;
    let released = false;
    for (let t = 0; t < 120 * 60 && !s.events.some((e) => e.type === 'groundKill'); t++) {
      const hold = designated && !released;
      s.fly(pos, pitch, 240);
      pos.y += Math.sin(pitch) * 240 * DT;
      pos.z -= Math.cos(pitch) * 240 * DT;
      const ccipZ = s.hud(SnapshotHud.CCIP_Z);
      const designate = !designated && Math.abs(ccipZ - TARGET.z) < 10;
      s.step(inputs({ cycleTarget: designate, launch: hold }));
      if (designate) designated = true;
      // After designating: pull up at ~4 deg/s towards 15 deg nose-up.
      if (designated) pitch = Math.min((15 * Math.PI) / 180, pitch + (4 * Math.PI) / 180 * DT);
      if (!released && s.events.some((e) => e.type === 'missileLaunch' && e.weapon === 'bomb')) released = true;
    }
    expect(designated).toBe(true);
    expect(released).toBe(true);
    expect(s.hud(SnapshotHud.SPI_VALID)).toBe(1);
    expect(Math.hypot(s.hud(SnapshotHud.SPI_X) - TARGET.x, s.hud(SnapshotHud.SPI_Z) - TARGET.z)).toBeLessThan(20);
    const impact = s.events.find((e) => e.type === 'groundImpact' && e.explosiveKg === 200) as { pos: { x: number; z: number } } | undefined;
    expect(impact).toBeDefined();
    expect(Math.hypot(impact!.pos.x - TARGET.x, impact!.pos.z - TARGET.z)).toBeLessThan(40);
    expect(s.events.find((e) => e.type === 'groundKill')).toMatchObject({ typeId: 'truck-cargo' });
  });

  test('rockets ripple while the release button is held, alternating pods', () => {
    const s = setup('cas');
    s.select(2); // gun -> ASRAAM -> rockets
    expect(s.hud(SnapshotHud.SELECTED_COUNT)).toBe(40);
    const pos = { x: 0, y: s.groundY + 800, z: TARGET.z + 2000 };
    for (let t = 0; t < 60; t++) {
      s.fly(pos, (-20 * Math.PI) / 180, 220);
      s.step(inputs({ launch: true }));
    }
    const rockets = s.events.filter((e) => e.type === 'missileLaunch' && e.weapon === 'rocket').length;
    expect(rockets).toBeGreaterThanOrEqual(7);
    expect(rockets).toBeLessThanOrEqual(10);
    expect(s.hud(SnapshotHud.SELECTED_COUNT)).toBe(40 - rockets);
  });

  test('weight on wheels: no bomb or missile leaves the aircraft on the ground', () => {
    const s = setup('strike', false);
    s.select(2);
    for (let t = 0; t < 30; t++) s.step(inputs({ launch: t % 4 < 2, brakes: 1 }));
    expect(s.events.some((e) => e.type === 'missileLaunch')).toBe(false);
  });
});
