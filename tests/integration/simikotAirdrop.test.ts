/**
 * tests/integration/simikotAirdrop.test.ts — "Simikot Lifeline", the C-17 airdrop mission at
 * Simikot: the mission loads with the jet in the air and the CDS rig aboard, the script runs its
 * phases (brief, letdown, run-in, grade, climb-out, end), a stick released on the computed release
 * point at 150 m and 140 kt lands on DZ Tango, one released far off is a miss and the mission goes
 * on (another pass), one released too low is wrecked, the fuel jettison takes fuel off and stops at
 * the minimum, and flares decoy the MANPADS' missiles at a reasonable rate.
 */
import { describe, expect, test } from 'vitest';
import {
  AirdropStateCode,
  HUD_AIRDROP_OFFSET,
  HUD_BLOCK_START,
  HUD_EXT_BASE,
  SIM_DT_SEC,
  SNAPSHOT_FLOATS,
  SnapshotHud,
  SnapshotHudAirdrop,
  WarningBit,
  type AirdropLandedEvent,
  type Mission,
  type PilotInputs,
  type SimEvent,
} from '../../src/contracts/core';
import { buildWorldDependencies, createWorld } from '../../src/core';
import { resolveBuiltinMission } from '../../src/core/missions';
import { missionLocked, MISSIONS, PLAYABLE_MISSIONS } from '../../src/core/missions/catalogue';
import { predictCdsDrop } from '../../src/core/airdrop';
import { c17Definition } from '../../src/aircraft/c17Definition';
import { createMissionScript } from '../../src/script';
import { DZ_GROUND_M, DZ_TANGO, RUN_IN_DEG, SimikotAirdropScript, gradeDrop, gradeSucceeds } from '../../src/script/missions/simikotAirdrop';
import type { ScriptFrame } from '../../src/script/director';
import type { AirportLayout } from '../../src/contracts/airport';
import { flareSeductionChance } from '../../src/combat/countermeasures';
import { ANZA_MK3 } from '../../src/catalog/weapons';

const KT = 0.514444;
const ID = 'himalaya-airdrop';

const baseInputs = (): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.85, afterburner: false, brakes: 0, gearDown: false, airbrake: false,
  trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, nwsEnabled: true,
});

/** A world on the mission, the player placed `backM` before the DZ on the run-in at `aglM`, `iasKt`. */
function runInWorld(backM: number, aglM: number, iasKt: number, opts: { lateralM?: number; calm?: boolean; groundGroups?: Mission['groundGroups']; rampOpen?: boolean } = {}) {
  const base = resolveBuiltinMission(ID);
  const hd = (RUN_IN_DEG * Math.PI) / 180;
  const tx = Math.sin(hd);
  const tz = -Math.cos(hd);
  const lat = opts.lateralM ?? 0;
  // TAS for the IAS at that height (ISA): EAS = TAS * sqrt(rho / rho0).
  const y = DZ_GROUND_M + aglM;
  const rho = 1.225 * Math.pow(1 - 2.25577e-5 * y, 4.2559);
  const tas = iasKt * KT * Math.sqrt(1.225 / rho);
  const mission: Mission = {
    ...base,
    // No MANPADS for the drop accuracy runs.
    groundGroups: opts.groundGroups ?? [],
    ...(opts.calm ? { weather: { windWorldMps: { x: 0, y: 0, z: 0 }, gustMps: 0, turbulence: 0 } } : {}),
    playerStart: {
      ...base.playerStart,
      pos: { x: DZ_TANGO.x - tx * backM - tz * lat, y, z: DZ_TANGO.z - tz * backM + tx * lat },
      headingRad: hd,
      speedMps: tas,
    },
  };
  const deps = buildWorldDependencies(mission);
  const world = createWorld(deps);
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  // Already rigged and open (the ramp takes 20 s to open).
  const st = world.getEntityState(id)!;
  if (opts.rampOpen) st.rampPos = 1;
  // Configured for the drop: slats out, flaps 3/4.
  st.flapDetent = 3;
  st.flapPos = 3;
  st.slatPos = 1;
  return { world, deps, mission, id };
}

/**
 * Flies the run-in with the ramp open and flaps 2: a speed hold on the throttle and a height hold on
 * the stick, releases when `release(state)` says so, and steps until the stick is down.
 */
function flyDrop(w: ReturnType<typeof runInWorld>, iasKt: number, release: (s: { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } }, t: number) => boolean, holdY: number) {
  const { world, id } = w;
  const events: SimEvent[] = new Array(4096);
  const landed: AirdropLandedEvent[] = [];
  let released = false;
  let releaseIas = 0;
  let throttle = 0.8;
  for (let i = 0; i < Math.round(150 / SIM_DT_SEC); i++) {
    const s = world.getEntityState(id);
    const tel = world.getTelemetry(id);
    if (!s || !s.alive || !tel) break;
    const inputs = baseInputs();
    inputs.rampOpen = true;
    inputs.flapLever = 3;
    // Speed: throttle on the IAS error; height: the stick on the height and climb-rate error.
    if (tel.iasMps > 10) throttle = Math.min(1, Math.max(0.05, throttle + (iasKt * KT - tel.iasMps) * 0.004));
    inputs.throttle = throttle;
    // After the release: climb away (the ground rises beyond the DZ).
    inputs.pitch = Math.max(-0.5, Math.min(0.5, ((released ? holdY + 400 : holdY) - s.pos.y) * 0.006 - s.vel.y * 0.04));
    const t = i * SIM_DT_SEC;
    if (!released && (s.rampPos ?? 0) >= 0.99 && release(s, t)) {
      inputs.launch = true;
      released = true;
      releaseIas = tel.iasMps;
    }
    world.setPlayerInput(id, inputs);
    world.stepOnce();
    const n = world.drainEvents(events);
    for (let k = 0; k < n; k++) if (events[k]!.type === 'airdropLanded') landed.push(events[k] as AirdropLandedEvent);
    if (released && landed.length >= 4) break;
  }
  const n = landed.length;
  const cx = landed.reduce((a, l) => a + l.pos.x, 0) / Math.max(1, n);
  const cz = landed.reduce((a, l) => a + l.pos.z, 0) / Math.max(1, n);
  return { landed, released, releaseIas, distM: Math.hypot(cx - DZ_TANGO.x, cz - DZ_TANGO.z), destroyed: landed.filter((l) => l.destroyed).length };
}

/** Release on the CARP: when a stick released now would land on the DZ (the mission's green light). */
function onCarp(wind: { x: number; y: number; z: number }) {
  return (s: { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } }): boolean => {
    const hit = predictCdsDrop(s.pos, s.vel, DZ_GROUND_M, wind);
    const gs = Math.hypot(s.vel.x, s.vel.z);
    return ((DZ_TANGO.x - hit.x) * s.vel.x + (DZ_TANGO.z - hit.z) * s.vel.z) / gs <= 0;
  };
}

function frame(over: Omit<Partial<ScriptFrame>, 'player'> & { player?: Partial<ScriptFrame['player']> } = {}): ScriptFrame {
  const { player, ...rest } = over;
  return {
    t: 0,
    player: { id: 1, x: 0, y: 7300, z: 93000, vx: 190, vy: 0, vz: 0, headingRad: 1.42, aglM: 5000, onGround: false, alive: true, ...player },
    hostiles: [],
    targetId: -1, lockState: 0, warningBits: 0, rwrCount: 0, spiValid: false, spiX: 0, spiZ: 0, dlz: 0,
    iasMps: 120, altMslM: player?.y ?? 7300, vsMps: 0, pitchRad: 0, rollRad: 0, gearPos: 0, gearDown: false, airbrake: false, afterburner: false,
    thrustFrac: 0.8, throttle: 0.8, weaponIdx: 0, radarMode: 0, cameraChanges: 0, radarRangeChanges: 0, trackCount: 0, radioBusy: false,
    fuelKg: 55000, fuelDumping: false, rampPos: 0, airdropState: AirdropStateCode.Safe, airdropLeft: 16, enginesRunning: 4,
    ...rest,
  };
}

describe('Simikot Lifeline (C-17 airdrop)', () => {
  test('is an open mission flown by the C-17 with the CDS rig', () => {
    expect(PLAYABLE_MISSIONS).toContain(ID);
    expect(missionLocked(ID)).toBe(false);
    const entry = MISSIONS.find((m) => m.id === ID)!;
    expect(entry.transport?.airdrop).toBe(true);
    const m = resolveBuiltinMission(ID);
    expect(m.playerStart.aircraftId).toBe('c-17');
    expect(m.playerStart.airdrop?.bundles).toBe(16);
    expect(createMissionScript(m)).toBeInstanceOf(SimikotAirdropScript);
  });

  test('DZ Tango is off the runway, flat-ish, and its height is the terrain', () => {
    const m = resolveBuiltinMission(ID);
    const deps = buildWorldDependencies(m);
    const g = deps.sampler.heightAt(DZ_TANGO.x, DZ_TANGO.z);
    expect(Math.abs(g - DZ_GROUND_M)).toBeLessThan(10);
    let lo = Infinity;
    let hi = -Infinity;
    for (let a = -150; a <= 150; a += 50) for (let b = -150; b <= 150; b += 50) {
      const h = deps.sampler.heightAt(DZ_TANGO.x + a, DZ_TANGO.z + b);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    expect(hi - lo).toBeLessThan(60);
    const simikot = (m.world.airports as readonly AirportLayout[]).find((a) => a.id === 'simikot')!;
    expect(Math.hypot(simikot.referenceWorldX - DZ_TANGO.x, simikot.referenceWorldZ - DZ_TANGO.z)).toBeGreaterThan(2000);
  });

  test('loads in the air, heavy, with 16 bundles and the ramp closed', () => {
    const m = resolveBuiltinMission(ID);
    const deps = buildWorldDependencies(m);
    const world = createWorld(deps);
    world.loadMission(m);
    const id = world.getPlayerEntityId();
    for (let i = 0; i < Math.round(3 / SIM_DT_SEC); i++) {
      world.setPlayerInput(id, baseInputs());
      world.stepOnce();
    }
    const s = world.getEntityState(id)!;
    expect(s.alive).toBe(true);
    expect(s.pos.y - deps.sampler.heightAt(s.pos.x, s.pos.z)).toBeGreaterThan(2000);
    expect(s.cargoMassKg).toBe(16000);
    const snap = new Float64Array(SNAPSHOT_FLOATS);
    world.writeSnapshot(snap);
    const ad = HUD_BLOCK_START + HUD_EXT_BASE + HUD_AIRDROP_OFFSET;
    expect(snap[ad + SnapshotHudAirdrop.LEFT]).toBe(16);
    expect(snap[ad + SnapshotHudAirdrop.STATE]).toBe(AirdropStateCode.Safe);
  });

  test('the script runs: brief, letdown, run-in, a good stick, climb-out, the end', () => {
    const s = new SimikotAirdropScript({ x: 3, y: 0, z: -2 });
    s.update(frame({ t: 3 }));
    const brief = s.drain();
    expect(brief.some((tx) => tx.clips.includes('ad_brief'))).toBe(true);
    expect(brief.some((tx) => tx.clips.includes('ad_dump'))).toBe(true);
    expect(s.objective()?.step).toBe(1);
    expect(s.atmosphere().weather?.deckBaseM).toBe(5000);
    expect(s.atmosphere().markers?.lamps.length).toBeGreaterThan(5);
    // Near LETDOWN: the letdown call.
    s.update(frame({ t: 300, player: { x: 70000, y: 6500, z: 85000 } }));
    expect(s.currentPhase()).toBe('letdown');
    expect(s.drain().some((tx) => tx.clips.includes('ad_letdown'))).toBe(true);
    // Under the cloud at the IP: the run-in.
    s.update(frame({ t: 400, player: { x: 71000, y: 4600, z: 71800, vx: -73.7, vz: -51.6, headingRad: (305 * Math.PI) / 180 } }));
    expect(s.currentPhase()).toBe('runin');
    expect(s.drain().some((tx) => tx.clips.includes('ad_ip'))).toBe(true);
    // A stick of four lands ~85 m from the T.
    s.event({ type: 'airdropRelease', entityId: 1, stickId: 1, count: 4, pos: { x: 0, y: 0, z: 0 }, iasMps: 140 * KT, aglM: 150, reserve: false }, 1);
    expect(s.currentPhase()).toBe('egress');
    for (let i = 0; i < 4; i++) s.event({ type: 'airdropLanded', entityId: 1, stickId: 1, index: i, count: 4, pos: { x: DZ_TANGO.x + 80 + i * 3, y: DZ_GROUND_M, z: DZ_TANGO.z }, impactMps: 9, destroyed: false }, 1);
    expect(s.drops()[0]!.grade).toBe('good');
    expect(s.drain().some((tx) => tx.clips.includes('ad_drop_good'))).toBe(true);
    // Climbed out: done; then clear of the area: the end.
    s.update(frame({ t: 460, player: { x: 60000, y: 6200, z: 64000 } }));
    expect(s.currentPhase()).toBe('done');
    expect(s.outcome()).toBeUndefined();
    s.update(frame({ t: 600, player: { x: 30000, y: 7000, z: 60000 } }));
    s.update(frame({ t: 620, player: { x: 29000, y: 7000, z: 60000 } }));
    expect(s.outcome()).toBe('success');
    expect(s.results().tiles[0]!.value).toMatch(/^Good/);
  });

  test('grades: bands and wrecked loads', () => {
    expect(gradeDrop(30, 0, 4)).toBe('excellent');
    expect(gradeDrop(120, 0, 4)).toBe('good');
    expect(gradeDrop(250, 1, 4)).toBe('acceptable');
    expect(gradeDrop(400, 0, 4)).toBe('miss');
    expect(gradeDrop(20, 3, 4)).toBe('destroyed');
    expect(gradeSucceeds('acceptable')).toBe(true);
    expect(gradeSucceeds('miss')).toBe(false);
  });

  test('a stick released on the CARP at 150 m and 140 kt lands on the DZ', () => {
    const w = runInWorld(2400, 150, 140);
    const wind = w.mission.weather.windWorldMps;
    const r = flyDrop(w, 140, onCarp(wind), DZ_GROUND_M + 150);
    expect(r.released).toBe(true);
    expect(r.landed.length).toBe(4);
    expect(r.destroyed).toBe(0);
    expect(r.releaseIas / KT).toBeGreaterThan(125);
    expect(r.releaseIas / KT).toBeLessThan(155);
    const grade = gradeDrop(r.distM, r.destroyed, r.landed.length);
    expect(['excellent', 'good']).toContain(grade);
  });

  test('a stick released far short is a miss, and the mission goes on', () => {
    const w = runInWorld(2400, 150, 140);
    // Released 1.2 km before the CARP (as soon as the ramp is open).
    const r = flyDrop(w, 140, () => true, DZ_GROUND_M + 150);
    expect(r.landed.length).toBe(4);
    expect(gradeDrop(r.distM, r.destroyed, 4)).toBe('miss');
    // The script calls the miss and sends the jet round for another pass; nothing ends.
    const s = new SimikotAirdropScript(w.mission.weather.windWorldMps);
    s.update(frame({ t: 400, player: { x: 71000, y: 4600, z: 71800, vx: -73.7, vz: -51.6, headingRad: (305 * Math.PI) / 180 } }));
    s.event({ type: 'airdropRelease', entityId: 1, stickId: 1, count: 4, pos: { x: 0, y: 0, z: 0 }, iasMps: r.releaseIas, aglM: 150, reserve: false }, 1);
    for (const l of r.landed) s.event({ ...l, entityId: 1 }, 1);
    expect(s.drops()[0]!.grade).toBe('miss');
    expect(s.drain().some((tx) => tx.clips.includes('ad_drop_miss') && tx.clips.includes('ad_come_around'))).toBe(true);
    expect(s.currentPhase()).toBe('reattack');
    expect(s.outcome()).toBeUndefined();
    // The world still has 12 bundles and the jet flying: another pass is possible.
    const snap = new Float64Array(SNAPSHOT_FLOATS);
    w.world.writeSnapshot(snap);
    expect(snap[HUD_BLOCK_START + HUD_EXT_BASE + HUD_AIRDROP_OFFSET + SnapshotHudAirdrop.LEFT]).toBe(12);
    expect(w.world.getEntityState(w.id)!.alive).toBe(true);
  });

  test('a stick released too low is wrecked', () => {
    // 60 m: the canopies are still filling when the bundles hit.
    const w = runInWorld(1200, 60, 140, { calm: true, rampOpen: true });
    const r = flyDrop(w, 140, onCarp({ x: 0, y: 0, z: 0 }), DZ_GROUND_M + 60);
    expect(r.landed.length).toBe(4);
    expect(r.destroyed).toBeGreaterThanOrEqual(3);
    expect(gradeDrop(r.distM, r.destroyed, 4)).toBe('destroyed');
  });

  test('the fuel jettison takes fuel off and stops at the minimum', () => {
    const m = resolveBuiltinMission(ID);
    const world = createWorld(buildWorldDependencies(m));
    world.loadMission(m);
    const id = world.getPlayerEntityId();
    const f0 = world.getEntityState(id)!.fuelKg;
    // A minute of jettison (and the engines' own burn).
    for (let i = 0; i < Math.round(60 / SIM_DT_SEC); i++) {
      world.setPlayerInput(id, { ...baseInputs(), fuelDump: true });
      world.stepOnce();
    }
    const f1 = world.getEntityState(id)!.fuelKg;
    const rate = c17Definition.fuelDump!.rateKgS;
    expect(f0 - f1).toBeGreaterThan(rate * 60 * 0.95);
    // Without it, the burn alone is far less.
    const world2 = createWorld(buildWorldDependencies(m));
    world2.loadMission(m);
    const id2 = world2.getPlayerEntityId();
    for (let i = 0; i < Math.round(60 / SIM_DT_SEC); i++) {
      world2.setPlayerInput(id2, baseInputs());
      world2.stepOnce();
    }
    expect(f0 - world2.getEntityState(id2)!.fuelKg).toBeLessThan((f0 - f1) / 3);
    // It stops at the minimum.
    const s = world.getEntityState(id)!;
    s.fuelKg = c17Definition.fuelDump!.minFuelKg + 100;
    for (let i = 0; i < Math.round(10 / SIM_DT_SEC); i++) {
      world.setPlayerInput(id, { ...baseInputs(), fuelDump: true });
      world.stepOnce();
    }
    expect(world.getEntityState(id)!.fuelKg).toBeGreaterThan(c17Definition.fuelDump!.minFuelKg - 200);
  });

  test('flares decoy the MANPADS missile at a reasonable rate', () => {
    const res = ANZA_MK3.ir?.flareResistance;
    expect(res).toBeDefined();
    const jet = { x: 0, y: 4200, z: 0 };
    const vel = { x: 0, y: 0, z: -90 };
    // One flare against a missile from the beam and from behind (the climb-out); a press drops two.
    const beam = flareSeductionChance(res, { x: 2000, y: 3700, z: 0 }, jet, vel, false);
    const tail = flareSeductionChance(res, { x: 0, y: 3700, z: 2000 }, jet, vel, false);
    const press = (p: number, presses: number): number => 1 - Math.pow(1 - p, 2 * presses);
    // One press: a coin toss or better; two presses (the call says 'flares, flares'): most missiles.
    expect(press(beam, 1)).toBeGreaterThan(0.6);
    expect(press(tail, 1)).toBeGreaterThan(0.45);
    expect(press(tail, 2)).toBeGreaterThan(0.75);
    // Not a sure thing.
    expect(press(beam, 1)).toBeLessThan(0.95);
  });

  test('the MANPADS on the Hilsa side engage a jet at the DZ: launch warning, and a hit is not a kill', () => {
    // The jet just past the DZ on the run-in, 150 m up: inside the teams' reach, seen past the shoulder.
    const m = resolveBuiltinMission(ID);
    const w = runInWorld(-200, 250, 140, { groundGroups: m.groundGroups });
    const { world, id } = w;
    const snap = new Float64Array(SNAPSHOT_FLOATS);
    const events: SimEvent[] = new Array(4096);
    let launches = 0;
    let warned = false;
    let firstHitAlive: boolean | undefined;
    let enginesAfterHit = 4;
    for (let i = 0; i < Math.round(40 / SIM_DT_SEC) && firstHitAlive === undefined; i++) {
      const s = world.getEntityState(id)!;
      const inputs = { ...baseInputs(), flapLever: 3, throttle: 0.7 };
      inputs.pitch = Math.max(-0.5, Math.min(0.5, (DZ_GROUND_M + 350 - s.pos.y) * 0.01 - s.vel.y * 0.05));
      world.setPlayerInput(id, inputs);
      world.stepOnce();
      const n = world.drainEvents(events);
      for (let k = 0; k < n; k++) {
        const e = events[k]!;
        if (e.type === 'missileLaunch') launches++;
        if (e.type === 'hit' && e.targetId === id) {
          const after = world.getEntityState(id)!;
          firstHitAlive = after.alive;
          enginesAfterHit = (after.engines ?? []).filter((x) => !x.failed).length;
        }
      }
      if (i % 12 === 0) {
        world.writeSnapshot(snap);
        if (((snap[HUD_BLOCK_START + SnapshotHud.WARNING_BITS] ?? 0) & WarningBit.MissileLaunch) !== 0) warned = true;
      }
    }
    expect(launches).toBeGreaterThan(0);
    expect(warned).toBe(true);
    // No flares, no climb: a missile gets through, and the jet survives it on three engines.
    expect(firstHitAlive).toBe(true);
    expect(enginesAfterHit).toBe(3);
  });
});

