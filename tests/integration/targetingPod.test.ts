/**
 * tests/integration/targetingPod.test.ts — the Litening pod and guided bombs in the real World:
 * the pod slews over the ground, point-tracks a truck and designates it (the SPI follows the pod);
 * a Griffin LGB released well short of the truck steers onto the laser spot (the pod lases for it
 * automatically) and kills it; a HAMMER released 20 km out from 3 km up flies to the pod's
 * coordinates. The jet is flown on a scripted straight path (teleported each tick).
 */
import { describe, expect, test } from 'vitest';
import { DlzCode, HUD_BLOCK_START, PodFlag, SNAPSHOT_FLOATS, SnapshotHud, type Mission, type PilotInputs, type SimEvent } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { Quat } from '../../src/math';

const inputs = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.8, afterburner: false, brakes: 0, gearDown: false,
  airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...over,
});

const TARGET = { x: 0, z: -12000 };
const DT = 1 / 120;

function setup(loadoutId: string, alt: number, startZ: number) {
  const base = resolveBuiltinMission('border-free');
  const mission: Mission = {
    ...base,
    aiFlights: [],
    playerStart: { pos: { x: 0, y: 1000, z: startZ }, headingRad: 0, speedMps: 230, loadoutId },
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
  const pos = { x: 0, y: groundY + alt, z: startZ };
  /** One tick of level flight north at 230 m/s with these inputs. */
  const step = (inp: PilotInputs): void => {
    const p = world.getEntityState(id)!;
    p.pos.x = pos.x; p.pos.y = pos.y; p.pos.z = pos.z;
    Quat.fromYawPitchRoll(0, 0, 0, p.rot);
    p.vel.x = 0; p.vel.y = 0; p.vel.z = -230;
    world.setPlayerInput(id, inp);
    world.stepOnce();
    pos.z -= 230 * DT;
    const n = world.drainEvents(drained);
    events.push(...drained.slice(0, n));
  };
  /** Slews the pod onto the truck (closed loop on the pod point), then presses track. */
  const podOnTarget = (): void => {
    for (let t = 0; t < 120 * 20; t++) {
      const px = hud(SnapshotHud.POD_X), pz = hud(SnapshotHud.POD_Z);
      const ex = TARGET.x - px, ez = TARGET.z - pz;
      if (Math.hypot(ex, ez) < 12) break;
      // Heading north: +x is right in the picture, further north (-z) is up.
      const range = Math.hypot(px - pos.x, pz - pos.z);
      step(inputs({ podSlewX: Math.max(-1, Math.min(1, ex / (range * 0.02))), podSlewY: Math.max(-1, Math.min(1, -ez / (range * 0.02))) }));
    }
    step(inputs({ podTrack: true }));
    step(inputs());
  };
  const select = (n: number): void => {
    for (let k = 0; k < n; k++) {
      step(inputs({ cycleWeapon: true }));
      step(inputs());
    }
  };
  return { world, id, groundY, events, hud, step, podOnTarget, select, pos };
}

describe('targeting pod', () => {
  test('slews onto a truck, point-tracks it and designates it', () => {
    const s = setup('precision', 3000, 0);
    s.step(inputs());
    expect(s.hud(SnapshotHud.POD_FLAGS) & PodFlag.Carried).toBeTruthy();
    s.podOnTarget();
    const f = s.hud(SnapshotHud.POD_FLAGS);
    expect(f & PodFlag.PointTrack).toBeTruthy();
    expect(f & PodFlag.Designating).toBeTruthy();
    expect(s.hud(SnapshotHud.SPI_VALID)).toBe(1);
    expect(Math.hypot(s.hud(SnapshotHud.SPI_X) - TARGET.x, s.hud(SnapshotHud.SPI_Z) - TARGET.z)).toBeLessThan(3);
    // Zoom cycles the field of view.
    const wide = s.hud(SnapshotHud.POD_FOV_DEG);
    s.step(inputs({ podZoom: true }));
    s.step(inputs());
    expect(s.hud(SnapshotHud.POD_FOV_DEG)).toBeLessThan(wide);
  });

  test('a Griffin LGB released 300 m short follows the laser spot onto the truck', () => {
    const s = setup('precision', 3000, 0);
    s.podOnTarget();
    s.select(3); // gun -> ASRAAM -> Astra -> Griffin
    let released = false;
    for (let t = 0; t < 120 * 90 && !s.events.some((e) => e.type === 'groundKill'); t++) {
      // Release when the bomb's own ballistic impact is still ~300 m short of the truck.
      const pickle = !released && s.hud(SnapshotHud.CCIP_Z) < TARGET.z + 300 && s.hud(SnapshotHud.CCIP_Z) > TARGET.z + 200;
      s.step(inputs({ launch: pickle }));
      if (pickle && s.events.some((e) => e.type === 'missileLaunch' && e.weapon === 'guided_bomb')) released = true;
    }
    expect(released).toBe(true);
    const impact = s.events.find((e) => e.type === 'groundImpact' && e.explosiveKg === 200) as { pos: { x: number; z: number } } | undefined;
    expect(impact).toBeDefined();
    expect(Math.hypot(impact!.pos.x - TARGET.x, impact!.pos.z - TARGET.z)).toBeLessThan(15);
    expect(s.events.find((e) => e.type === 'groundKill')).toMatchObject({ typeId: 'truck-cargo', sourceId: s.id });
  });

  test('a HAMMER released 20 km out from 3 km up flies to the designated coordinates', () => {
    const s = setup('standoff', 3000, TARGET.z + 20000);
    s.podOnTarget();
    s.select(3); // -> HAMMER
    expect(s.hud(SnapshotHud.DLZ)).toBe(DlzCode.InRange);
    s.step(inputs({ launch: true }));
    s.step(inputs());
    expect(s.events.some((e) => e.type === 'missileLaunch' && e.weapon === 'guided_bomb')).toBe(true);
    for (let t = 0; t < 120 * 150 && !s.events.some((e) => e.type === 'groundImpact' && e.explosiveKg === 125); t++) s.step(inputs());
    const impact = s.events.find((e) => e.type === 'groundImpact' && e.explosiveKg === 125) as { pos: { x: number; z: number } } | undefined;
    expect(impact).toBeDefined();
    expect(Math.hypot(impact!.pos.x - TARGET.x, impact!.pos.z - TARGET.z)).toBeLessThan(25);
    expect(s.events.some((e) => e.type === 'groundKill')).toBe(true);
  });
});
