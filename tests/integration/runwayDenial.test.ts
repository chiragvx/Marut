/**
 * tests/integration/runwayDenial.test.ts — W7 in the real World: the SAAW glides 100 km from 9 km;
 * on the high-altitude mission the route moves on past the LAR, the runway aim points load as the
 * designated point, four SAAWs released in turn go to the four aim points, both Shahbaz runways
 * close and the mission ends in success. The low-level route reports early/late against its TOT.
 */
import { describe, expect, it, test } from 'vitest';
import { createProjectilePool, initProjectile, isaDensityKgM3, stepProjectile } from '../../src/combat';
import { WEAPONS } from '../../src/catalog';
import type { CombatEnvironment } from '../../src/contracts/combat';
import {
  HUD_BLOCK_START,
  HUD_EXT_BASE,
  SNAPSHOT_FLOATS,
  STORE_IDS,
  SnapshotHud,
  SnapshotHudExt,
  WarningBit,
  type EntityState,
  type HeightSampler,
  type Mission,
  type PilotInputs,
  type SimEvent,
} from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { Quat } from '../../src/math';

const FLAT: HeightSampler = { seed: 0, heightAt: () => 200, normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o) };
const ENV: CombatEnvironment = { airDensityKgM3: 1.225, windWorldMps: { x: 0, y: 0, z: 0 }, gravityMps2: 9.80665, densityAtAltitude: isaDensityKgM3 };

describe('SAAW', () => {
  it('glides onto coordinates 100 km out from 9 km', () => {
    const m: EntityState = {
      id: 9, kind: 'missile', team: 0, pos: { x: 0, y: 9000, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: -2, z: -250 },
      omega: { x: 0, y: 0, z: 0 }, alive: true, hp: 100, fuelKg: 0, elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0, afterburnerOn: false, flags: 0,
    };
    const slot = createProjectilePool(1)[0]!;
    initProjectile(slot, { kind: 'guided_bomb', ownerId: 1, team: 0, posWorld: m.pos, rotWorld: m.rot, velWorld: m.vel, profile: WEAPONS['saaw']!, targetPoint: { x: 0, y: 200, z: -100000 } }, 0);
    let impact: { x: number; z: number } | undefined;
    for (let t = 0; t < 700 && !impact; t += 1 / 60) {
      const r = stepProjectile(m, slot, [], FLAT, ENV, 1 / 60, m);
      if (r.outcome === 'terrain_impact') impact = r.impactPos!;
      else if (r.outcome !== 'flying') break;
    }
    expect(impact).toBeDefined();
    expect(Math.hypot(impact!.x, impact!.z + 100000)).toBeLessThan(15);
  });
});

const inputs = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.8, afterburner: false, brakes: 0, gearDown: false,
  airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...over,
});

/** A World on `mission` whose player is flown straight and level by hand (teleported each tick). */
function harness(mission: Mission, pos: { x: number; y: number; z: number }, headingRad: number, speed: number) {
  const world = createWorld(buildWorldDependencies(mission));
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const snap = new Float64Array(SNAPSHOT_FLOATS);
  const events: SimEvent[] = [];
  const drained: SimEvent[] = [];
  const h = { heading: headingRad };
  const step = (inp: PilotInputs = inputs()): void => {
    const p = world.getEntityState(id)!;
    p.pos.x = pos.x; p.pos.y = pos.y; p.pos.z = pos.z;
    Quat.fromYawPitchRoll(h.heading, 0, 0, p.rot);
    p.vel.x = Math.sin(h.heading) * speed; p.vel.y = 0; p.vel.z = -Math.cos(h.heading) * speed;
    pos.x += p.vel.x / 120; pos.z += p.vel.z / 120;
    world.setPlayerInput(id, inp);
    world.stepOnce();
    const n = world.drainEvents(drained);
    events.push(...drained.slice(0, n));
  };
  const hud = (f: number): number => (world.writeSnapshot(snap), snap[HUD_BLOCK_START + f]!);
  const ext = (f: number): number => (world.writeSnapshot(snap), snap[HUD_BLOCK_START + HUD_EXT_BASE + f]!);
  return { world, step, hud, ext, events, h, pos };
}

describe('in the World', () => {
  test('high altitude: past the LAR the aim points load, four SAAWs close both Shahbaz runways', () => {
    const base = resolveBuiltinMission('border-highalt');
    const mission: Mission = { ...base, groundGroups: [], playerStart: { ...base.playerStart, pos: { x: 14000, y: 9000, z: 4500 } } };
    const aims = base.route!.find((w) => w.target)!.aimPoints!;
    const toLar = Math.atan2(10000 - 14000, -(6000 - 4500));
    const t = harness(mission, { x: 14000, y: 9000, z: 4500 }, toLar, 240);
    t.step();
    expect(t.ext(SnapshotHudExt.ROUTE_INDEX)).toBe(0);
    expect(t.ext(SnapshotHudExt.TOT_INDEX)).toBe(0);
    for (let k = 0; k < 120 * 60 && t.ext(SnapshotHudExt.ROUTE_INDEX) === 0; k++) t.step();
    expect(t.ext(SnapshotHudExt.ROUTE_INDEX)).toBe(1);
    t.step();
    expect(t.hud(SnapshotHud.SPI_VALID)).toBe(1);
    expect(Math.hypot(t.hud(SnapshotHud.SPI_X) - aims[0]!.x, t.hud(SnapshotHud.SPI_Z) - aims[0]!.z)).toBeLessThan(1);
    // Tab to the SAAW, then four presses of the release button.
    for (let k = 0; k < 8 && t.hud(SnapshotHud.SELECTED_STORE) !== STORE_IDS.indexOf('saaw'); k++) { t.step(inputs({ cycleWeapon: true })); t.step(); }
    expect(t.hud(SnapshotHud.SELECTED_STORE)).toBe(STORE_IDS.indexOf('saaw'));
    for (let k = 0; k < 4; k++) {
      t.step(inputs({ launch: true }));
      for (let j = 0; j < 30; j++) t.step();
    }
    expect(t.events.filter((e) => e.type === 'missileLaunch' && e.weapon === 'guided_bomb').length).toBe(4);
    // Home, and wait for the bombs.
    t.h.heading = Math.atan2(30500 - 10000, -(-11000 - 6000));
    for (let k = 0; k < 120 * 400 && !t.events.some((e) => e.type === 'missionEnded'); k++) t.step();
    const craters = t.events.filter((e): e is Extract<SimEvent, { type: 'runwayCrater' }> => e.type === 'runwayCrater');
    for (const a of aims) expect(craters.some((c) => Math.hypot(c.pos.x - a.x, c.pos.z - a.z) < 10)).toBe(true);
    expect(t.events.filter((e) => e.type === 'runwayClosed').length).toBe(2);
    const ended = t.events.find((e): e is Extract<SimEvent, { type: 'missionEnded' }> => e.type === 'missionEnded');
    expect(ended?.outcome).toBe('success');
  });

  test('low level: the route counts down to its TOT, and no ground-collision warning at 100 m over the plain', () => {
    const base = resolveBuiltinMission('border-lowlevel');
    const mission: Mission = { ...base, groundGroups: [] };
    const start = base.playerStart.pos!;
    const w0 = base.route![0]!;
    const t = harness(mission, { x: start.x, y: 290, z: start.z }, Math.atan2(w0.pos.x - start.x, -(w0.pos.z - start.z)), 230);
    let warned = false;
    for (let k = 0; k < 120 * 30; k++) {
      t.step();
      if (t.hud(SnapshotHud.WARNING_BITS) & WarningBit.TerrainPullUp) warned = true;
    }
    expect(warned).toBe(false);
    expect(t.ext(SnapshotHudExt.ROUTE_INDEX)).toBe(0);
    // TOT at the target (route[2]): planned 280 s; at 230 m/s straight down the route it is about on time.
    expect(t.ext(SnapshotHudExt.TOT_INDEX)).toBe(2);
    expect(Math.abs(t.ext(SnapshotHudExt.TOT_DELTA_SEC))).toBeLessThan(30);
    expect(t.ext(SnapshotHudExt.TOT_GS_MPS)).toBeGreaterThan(200);
  });
});
