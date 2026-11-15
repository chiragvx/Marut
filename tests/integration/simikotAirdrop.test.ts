/**
 * tests/integration/simikotAirdrop.test.ts — "Simikot Lifeline", the C-17 airdrop on the runway at
 * Simikot: a clear morning, a single destination (the DZ) and a 3° glidepath up the Karnali gorge
 * on the HUD needles; the MANPADS pair at the foot of the ridge is hidden until it fires. A scripted
 * autopilot flies the whole mission from its start (glidepath, drop, climb-out through the notch
 * west of the strip) clear of the ground; the loadmaster runs the drop on the intercom and springs
 * the surprise as the first missile goes up, and the whole load (one stick of 16) lands on the
 * strip. Netra only checks in and closes; nobody on the ground talks. Also: the grade bands, an early release is a
 * miss and the mission goes on, a release too low wrecks the loads, the fuel jettison, flare rates,
 * and a MANPADS hit is not a kill.
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
  EntityFlag,
  EntityKind,
  STORE_IDS,
  type EntityId,
  type EntityState,
  type AirdropLandedEvent,
  type Mission,
  type PilotInputs,
  type SimEvent,
} from '../../src/contracts/core';
import { buildWorldDependencies, createWorld } from '../../src/core';
import { resolveBuiltinMission } from '../../src/core/missions';
import { missionLocked, MISSIONS, PLAYABLE_MISSIONS } from '../../src/core/missions/catalogue';
import { CDS, cdsRollOut, predictCdsDrop } from '../../src/core/airdrop';
import { Quat } from '../../src/math';
import { dropBeamAt, dropPathAltM, newDropBeamState } from '../../src/core/dropBeam';
import { c17Definition } from '../../src/aircraft/c17Definition';
import { createMissionScript } from '../../src/script';
import { DROP_KT, DZ, DZ_GROUND_M, LOADMASTER, RUN_IN_DEG, STICK, SimikotAirdropScript, TOO_FAST_KT, gradeDrop, gradeSucceeds } from '../../src/script/missions/simikotAirdrop';
import type { ScriptFrame } from '../../src/script/director';
import type { Transmission } from '../../src/script/radio';
import type { AirportLayout } from '../../src/contracts/airport';
import { flareSeductionChance } from '../../src/combat/countermeasures';
import { ANZA_MK3 } from '../../src/catalog/weapons';
import { buildSteerpoints, revealFiringGroup } from '../../src/hud/steerpoints';
import { terrainLineOfSight } from '../../src/combat/lineOfSight';
import { THREAT_POS } from '../../src/script/missions/simikotAirdrop';

const KT = 0.514444;
const ID = 'himalaya-airdrop';

const baseInputs = (): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.85, afterburner: false, brakes: 0, gearDown: false, airbrake: false,
  trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, nwsEnabled: true,
});

const wrap180 = (d: number): number => ((((d % 360) + 540) % 360) - 180);

/** A world on the mission, the player placed `backM` before the DZ on the run-in at `aglM` over the strip, `iasKt`. */
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
      pos: { x: DZ.x - tx * backM - tz * lat, y, z: DZ.z - tz * backM + tx * lat },
      headingRad: hd,
      speedMps: tas,
    },
  };
  const deps = buildWorldDependencies(mission);
  const world = createWorld(deps);
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const st = world.getEntityState(id)!;
  // Already open (the ramp takes 20 s to open).
  if (opts.rampOpen) st.rampPos = 1;
  // Configured for the drop: slats out, flaps 1/2.
  st.flapDetent = 2;
  st.flapPos = 2;
  st.slatPos = 1;
  return { world, deps, mission, id };
}

/** Level run-in at `holdY`, speed on the throttle; releases when `release` says so; steps until the stick is down. */
function flyDrop(w: ReturnType<typeof runInWorld>, iasKt: number, release: (s: { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } }) => boolean, holdY: number) {
  const { world, id } = w;
  const events: SimEvent[] = new Array(4096);
  const landed: AirdropLandedEvent[] = [];
  let released = false;
  let releaseIas = 0;
  let releasedTick = -1;
  let throttle = 0.8;
  for (let i = 0; i < Math.round(150 / SIM_DT_SEC); i++) {
    const s = world.getEntityState(id);
    const tel = world.getTelemetry(id);
    if (!s || !s.alive || !tel) {
      // The jet flew on into the hills after the release (the test flies it straight on): the loads still come down.
      if (!released) break;
      world.stepOnce();
      const n = world.drainEvents(events);
      for (let k = 0; k < n; k++) if (events[k]!.type === 'airdropLanded') landed.push(events[k] as AirdropLandedEvent);
      if (landed.length >= STICK) break;
      continue;
    }
    const inputs = baseInputs();
    inputs.rampOpen = true;
    inputs.flapLever = 2;
    if (tel.iasMps > 10) throttle = Math.min(1, Math.max(0.05, throttle + (iasKt * KT - tel.iasMps) * 0.004));
    inputs.throttle = released ? 1 : throttle;
    // Level through the roll-out (the stick takes ~4 s to leave), then climb away.
    const climbing = released && (i - releasedTick) * SIM_DT_SEC > 5;
    inputs.pitch = Math.max(-0.5, Math.min(0.5, ((climbing ? holdY + 300 : holdY) - s.pos.y) * 0.006 - s.vel.y * 0.04));
    if (!released && (s.rampPos ?? 0) >= 0.99 && release(s)) {
      inputs.launch = true;
      released = true;
      releaseIas = tel.iasMps;
      releasedTick = i;
    }
    world.setPlayerInput(id, inputs);
    world.stepOnce();
    const n = world.drainEvents(events);
    for (let k = 0; k < n; k++) if (events[k]!.type === 'airdropLanded') landed.push(events[k] as AirdropLandedEvent);
    if (released && landed.length >= STICK) break;
  }
  const n = landed.length;
  const cx = landed.reduce((a, l) => a + l.pos.x, 0) / Math.max(1, n);
  const cz = landed.reduce((a, l) => a + l.pos.z, 0) / Math.max(1, n);
  return { landed, released, releaseIas, distM: Math.hypot(cx - DZ.x, cz - DZ.z), destroyed: landed.filter((l) => l.destroyed).length };
}

/** Release on the CARP: when a stick released now would land on the DZ (the mission's green light). */
function onCarp(wind: { x: number; y: number; z: number }, earlyM = 0) {
  return (s: { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number } }): boolean => {
    const hit = predictCdsDrop(s.pos, s.vel, DZ_GROUND_M, wind, STICK);
    const gs = Math.hypot(s.vel.x, s.vel.z);
    return ((DZ.x - hit.x) * s.vel.x + (DZ.z - hit.z) * s.vel.z) / gs <= earlyM;
  };
}

function frame(over: Omit<Partial<ScriptFrame>, 'player'> & { player?: Partial<ScriptFrame['player']> } = {}): ScriptFrame {
  const { player, ...rest } = over;
  return {
    t: 0,
    player: { id: 1, x: 92025, y: 4750, z: 94595, vx: -66, vy: 0, vz: -66, headingRad: (315 * Math.PI) / 180, aglM: 2000, onGround: false, alive: true, ...player },
    hostiles: [],
    targetId: -1, lockState: 0, warningBits: 0, rwrCount: 0, spiValid: false, spiX: 0, spiZ: 0, dlz: 0,
    iasMps: 90, altMslM: player?.y ?? 4750, vsMps: 0, pitchRad: 0, rollRad: 0, gearPos: 0, gearDown: false, airbrake: false, afterburner: false,
    thrustFrac: 0.6, throttle: 0.6, weaponIdx: 0, radarMode: 0, cameraChanges: 0, radarRangeChanges: 0, trackCount: 0, radioBusy: false,
    fuelKg: 44000, fuelDumping: false, rampPos: 0, airdropState: AirdropStateCode.Safe, airdropLeft: 16, enginesRunning: 4,
    ...rest,
  };
}

/** A point `alongM` before the DZ on the run-in, on the glidepath. */
function onPath(alongM: number, crossM = 0) {
  const hd = (RUN_IN_DEG * Math.PI) / 180;
  const tx = Math.sin(hd), tz = -Math.cos(hd);
  const m = resolveBuiltinMission(ID);
  return { x: DZ.x - tx * alongM - tz * crossM, y: dropPathAltM(m.dropApproach!, alongM), z: DZ.z - tz * alongM + tx * crossM, vx: tx * 75, vz: tz * 75, headingRad: hd };
}

const THREAT_WORDS = /missile|manpads|sam\b|threat|shoulder|launch/i;

/**
 * Flies the mission from its start the way a careful pilot would: the glidepath on the needles' own
 * numbers (src/core/dropBeam.ts), 170 kt then flaps 3/4 and 140 kt, the ramp open inside 12 km,
 * release on the CARP; flares on each missile launch; then full power and a climbing left turn with
 * the valley (west through the notch, then up the Karnali). Feeds the script frames and events.
 */
function flyMission(opts: { flares: boolean; afterSec: number; untilEnd?: boolean }) {
  const m = resolveBuiltinMission(ID);
  const deps = buildWorldDependencies(m);
  const world = createWorld(deps);
  world.loadMission(m);
  const id = world.getPlayerEntityId();
  const script = createMissionScript(m) as SimikotAirdropScript;
  const a = m.dropApproach!;
  const beam = newDropBeamState();
  const events: SimEvent[] = new Array(4096);
  const snap = new Float64Array(SNAPSHOT_FLOATS);
  const said: Transmission[] = [];
  const landed: AirdropLandedEvent[] = [];
  const flareAt: number[] = [];
  let thr = 0.6;
  let releasedAt = -1;
  let release: { alongM: number; aglOverDz: number; iasKt: number } | undefined;
  let minAglApproach = Infinity;
  let minAglClimb = Infinity;
  let firstLaunch: { t: number; alongM: number; afterRelease: boolean; pos: { x: number; z: number }; jet: { x: number; z: number; headingRad: number } } | undefined;
  let launchesShortOfStrip = 0;
  let firstHit: { alive: boolean; engines: number } | undefined;
  let launches = 0;
  let hits = 0;
  let maxNeedles = 0;
  let firstLaunchCallAt = -1;
  let alive = true;
  let successAt = -1;
  const steps = Math.round(800 / SIM_DT_SEC);
  for (let i = 0; i < steps; i++) {
    const t = i * SIM_DT_SEC;
    const s = world.getEntityState(id)!;
    const tel = world.getTelemetry(id)!;
    if (!s.alive) {
      alive = false;
      break;
    }
    dropBeamAt(s.pos, a, beam);
    const released = releasedAt >= 0;
    const hdg = (tel.headingRad * 180) / Math.PI;
    const ias = tel.iasMps / KT;
    const inp = baseInputs();
    let wantHdg: number;
    if (!released) {
      wantHdg = RUN_IN_DEG - Math.max(-20, Math.min(20, beam.crossM * 0.02));
      const wantKt = beam.alongM > 20000 ? 200 : DROP_KT;
      inp.flapLever = beam.alongM > 20000 ? 1 : 2;
      inp.rampOpen = beam.alongM < 12000;
      thr = Math.min(1, Math.max(0.05, thr + (wantKt - ias) * KT * 0.004));
      const vsWant = Math.max(-12, Math.min(8, (beam.pathAltM - s.pos.y) * 0.08 - Math.hypot(s.vel.x, s.vel.z) * Math.tan((3 * Math.PI) / 180)));
      inp.pitch = Math.max(-0.5, Math.min(0.5, (vsWant - s.vel.y) * 0.05));
      const hit = predictCdsDrop(s.pos, s.vel, a.groundM, m.weather.windWorldMps, STICK);
      const gs = Math.hypot(s.vel.x, s.vel.z);
      const ahead = ((a.pos.x - hit.x) * s.vel.x + (a.pos.z - hit.z) * s.vel.z) / gs;
      if ((s.rampPos ?? 0) >= 0.99 && ahead <= 0 && beam.alongM < 4000) {
        inp.launch = true;
        releasedAt = t;
        release = { alongM: beam.alongM, aglOverDz: s.pos.y - DZ_GROUND_M, iasKt: ias };
      }
    } else {
      // West through the notch, then up the Karnali.
      wantHdg = s.pos.x - DZ.x > -1300 ? 262 : 293;
      inp.flapLever = 2;
      // The ramp stays open until the load is clear (the stick of 16 takes ~7 s to roll out).
      inp.rampOpen = t - releasedAt < 9;
      thr = 1;
      inp.pitch = Math.max(-0.3, Math.min(0.8, ((ias > 150 ? 10 : 0) - s.vel.y) * 0.06));
    }
    const bankLim = ((released ? 25 : 15) * Math.PI) / 180;
    const bankWant = Math.max(-bankLim, Math.min(bankLim, (wrap180(wantHdg - hdg) * Math.PI) / 180));
    inp.roll = Math.max(-1, Math.min(1, (bankWant - tel.rollRad) * 1.2));
    inp.throttle = thr;
    if (opts.flares) inp.dispenseFlare = flareAt.some((ft) => t >= ft && t < ft + 0.1);
    world.setPlayerInput(id, inp);
    world.stepOnce();
    const n = world.drainEvents(events);
    for (let k = 0; k < n; k++) {
      const e = events[k]!;
      if (e.type === 'missileLaunch') {
        launches++;
        flareAt.push(t + 0.6, t + 2);
        if (beam.alongM > 0) launchesShortOfStrip++;
        if (!firstLaunch) firstLaunch = { t, alongM: beam.alongM, afterRelease: releasedAt >= 0, pos: { x: e.pos?.x ?? NaN, z: e.pos?.z ?? NaN }, jet: { x: s.pos.x, z: s.pos.z, headingRad: tel.headingRad } };
      }
      if (e.type === 'hit' && e.targetId === id) {
        hits++;
        if (!firstHit) {
          const after = world.getEntityState(id)!;
          firstHit = { alive: after.alive, engines: (after.engines ?? []).filter((x) => !x.failed).length };
        }
      }
      if (e.type === 'airdropLanded') landed.push(e);
      script.event(e, id);
    }
    const agl = s.pos.y - deps.sampler.heightAt(s.pos.x, s.pos.z);
    if (!released) minAglApproach = Math.min(minAglApproach, agl);
    else minAglClimb = Math.min(minAglClimb, agl);
    // The script on the main thread's cadence (every 0.1 s), as main.ts feeds it.
    if (i % 12 === 0) {
      world.writeSnapshot(snap);
      const hud = (f: number): number => snap[HUD_BLOCK_START + f] ?? 0;
      if (!released && beam.alongM > 1000) maxNeedles = Math.max(maxNeedles, Math.abs(hud(SnapshotHud.ILS_LOC)) + Math.abs(hud(SnapshotHud.ILS_GS)) > 0 ? 1 : 0);
      const ad = HUD_EXT_BASE + HUD_AIRDROP_OFFSET;
      script.update(
        frame({
          t,
          player: { id, x: s.pos.x, y: s.pos.y, z: s.pos.z, vx: s.vel.x, vy: s.vel.y, vz: s.vel.z, headingRad: tel.headingRad, aglM: agl, onGround: false, alive: s.alive },
          warningBits: hud(SnapshotHud.WARNING_BITS),
          iasMps: tel.iasMps,
          altMslM: s.pos.y,
          fuelKg: s.fuelKg,
          rampPos: s.rampPos ?? 0,
          airdropState: hud(ad + SnapshotHudAirdrop.STATE),
          airdropLeft: hud(ad + SnapshotHudAirdrop.LEFT),
          enginesRunning: (s.engines ?? []).filter((x) => !x.failed).length || 4,
        })
      );
      for (const tx of script.drain()) {
        said.push(tx);
        if (firstLaunchCallAt < 0 && tx.clips.some((c) => c.startsWith('lm_launch_'))) firstLaunchCallAt = t;
      }
    }
    if (successAt < 0 && script.outcome() === 'success') {
      successAt = t;
      if (opts.untilEnd) break;
    }
    if (released && t - releasedAt > opts.afterSec) break;
  }
  return { m, script, said, landed, release, releasedAt, successAt, minAglApproach, minAglClimb, firstLaunch, firstLaunchCallAt, launches, launchesShortOfStrip, hits, firstHit, alive, maxNeedles, final: world.getEntityState(id)! };
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

  test('a clear morning: no cloud deck, no time acceleration', () => {
    const entry = MISSIONS.find((m) => m.id === ID)!;
    expect(entry.weather).toBe('clear');
    expect(entry.timeOfDayH).toBeGreaterThan(8);
    expect(entry.timeOfDayH).toBeLessThan(15);
    const atm = new SimikotAirdropScript().atmosphere();
    expect(atm.weather).toBeUndefined();
    expect(atm.timeRate ?? 0).toBe(0);
    expect(atm.markers?.lamps.length).toBeGreaterThan(5);
  });

  test('the DZ is the strip at Simikot, and navigation shows only the DZ', () => {
    const m = resolveBuiltinMission(ID);
    const deps = buildWorldDependencies(m);
    expect(Math.abs(deps.sampler.heightAt(DZ.x, DZ.z) - DZ_GROUND_M)).toBeLessThan(5);
    const simikot = (m.world.airports as readonly AirportLayout[]).find((a) => a.id === 'simikot')!;
    expect(Math.hypot(simikot.referenceWorldX - DZ.x, simikot.referenceWorldZ - DZ.z)).toBeLessThan(400);
    // One steerpoint: the DZ. No IP, no letdown point.
    expect(m.route?.map((w) => w.name)).toEqual(['DZ SIMIKOT']);
    expect(Math.hypot(m.route![0]!.pos.x - DZ.x, m.route![0]!.pos.z - DZ.z)).toBeLessThan(1);
    expect(m.dropApproach?.pos).toEqual({ x: DZ.x, z: DZ.z });
    // The script marks nothing of its own until the run-in (then the release point).
    const s = new SimikotAirdropScript(m.weather.windWorldMps, m.dropApproach);
    s.update(frame({ t: 3 }));
    expect(s.markers()).toEqual([]);
  });

  test('the MANPADS pair is at a forward post at the foot of the ridge north-west of the strip, and sees the climb-out', () => {
    const m = resolveBuiltinMission(ID);
    const deps = buildWorldDependencies(m);
    const h = (x: number, z: number): number => deps.sampler.heightAt(x, z);
    const g = (m.groundGroups ?? []).find((x) => x.id === 'manpads-ridge')!;
    expect(g.pos).toEqual(THREAT_POS);
    // North-west of the strip (an 8-point compass), 2-3 km out.
    const brg = (Math.atan2(g.pos.x - DZ.x, -(g.pos.z - DZ.z)) * 180) / Math.PI + 360;
    expect(brg % 360).toBeGreaterThan(292.5);
    expect(brg % 360).toBeLessThan(337.5);
    expect(Math.hypot(g.pos.x - DZ.x, g.pos.z - DZ.z)).toBeGreaterThan(2000);
    expect(Math.hypot(g.pos.x - DZ.x, g.pos.z - DZ.z)).toBeLessThan(3000);
    // Low on the slope: within ~100 m of the strip's height (the old ridge-top post was ~580 m
    // above it), the ridge climbing 700 m+ within 1.5 km behind it, the valley floor below in front.
    const site = h(g.pos.x, g.pos.z);
    expect(Math.abs(site - DZ_GROUND_M)).toBeLessThan(100);
    expect(h(g.pos.x, g.pos.z - 1500) - site).toBeGreaterThan(700);
    expect(site - h(g.pos.x, g.pos.z + 1000)).toBeGreaterThan(300);
    // Line of sight from the post to the climb-out (west through the notch, then ~293 up the
    // valley, climbing ~12 m/s): masked by the strip's edge for the first few seconds past the DZ,
    // then open for at least 30 s of it inside the missiles' 5 km.
    const eye = { x: g.pos.x, y: site + 2, z: g.pos.z };
    let x: number = DZ.x, z: number = DZ.z, y = DZ_GROUND_M + 150;
    let seenInRange = 0;
    for (let sec = 1; sec <= 60; sec++) {
      const hd = ((x - DZ.x > -1300 ? 262 : 293) * Math.PI) / 180;
      x += Math.sin(hd) * 110;
      z -= Math.cos(hd) * 110;
      y += 12;
      const r = Math.hypot(x - eye.x, y - eye.y, z - eye.z);
      if (r < 5000 && r > 400 && terrainLineOfSight(deps.sampler, eye, { x, y, z }, 0, 30, 80)) seenInRange++;
    }
    expect(seenInRange).toBeGreaterThanOrEqual(30);
    // Still holding fire short of the DZ line on every pass.
    expect(g.holdFireShortOf).toEqual({ x: DZ.x, z: DZ.z, headingRad: m.dropApproach!.courseRad });
    expect(g.hidden).toBe(true);
  });

  test('the threat is hidden until it fires: no steerpoint, mark or briefing line', () => {
    const m = resolveBuiltinMission(ID);
    const groups = m.groundGroups ?? [];
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.every((g) => g.hidden)).toBe(true);
    // The HUD's steerpoints from the ground groups (main.ts setupWorldView): none.
    expect(buildSteerpoints(groups, () => 3000)).toEqual([]);
    // Nothing in the briefing or the objectives.
    const entry = MISSIONS.find((x) => x.id === ID)!;
    expect(`${entry.objective} ${entry.situation}`).not.toMatch(THREAT_WORDS);
    expect(m.objectives.map((o) => o.description).join(' ')).not.toMatch(THREAT_WORDS);
    // Nor in what is said before the first launch.
    const s = new SimikotAirdropScript(m.weather.windWorldMps, m.dropApproach);
    s.update(frame({ t: 3 }));
    const brief = s.drain();
    // Netra's check-in only (the intro told the story); nobody on the ground talks.
    expect(brief.map((tx) => tx.clips)).toEqual([['ad_netra', 'ad_checkin']]);
    expect(brief[0]!.from).toBe('NETRA');
    for (const tx of brief) expect(tx.text).not.toMatch(THREAT_WORDS);
    expect(s.markers().some((p) => THREAT_WORDS.test(p.name))).toBe(false);
  });

  test('the glidepath (3°, track 315 up the gorge) is clear of the ground from the start to the DZ', () => {
    const m = resolveBuiltinMission(ID);
    const a = m.dropApproach!;
    const deps = buildWorldDependencies(m);
    expect(a.glideDeg).toBeLessThanOrEqual(3);
    const start = m.playerStart.pos!;
    const beam = dropBeamAt(start, a, newDropBeamState());
    // The jet starts on the beam, lined up, near the path.
    expect(beam.valid).toBe(true);
    expect(Math.abs(beam.crossM)).toBeLessThan(50);
    expect(Math.abs(beam.highM)).toBeLessThan(150);
    // Every point of the path, and 300 m either side, clears the ground (the last 500 m: the strip's shelf).
    const hd = a.courseRad;
    const fx = Math.sin(hd), fz = -Math.cos(hd), rx = Math.cos(hd), rz = Math.sin(hd);
    let worst = Infinity;
    for (let d = 500; d <= beam.alongM; d += 100) {
      for (let l = -300; l <= 300; l += 100) {
        const x = a.pos.x - fx * d + rx * l, z = a.pos.z - fz * d + rz * l;
        worst = Math.min(worst, dropPathAltM(a, d) - deps.sampler.heightAt(x, z));
      }
    }
    expect(worst).toBeGreaterThan(80);
  });

  test('loads in the air on the glidepath, with 16 bundles, the ramp closed and the needles live', () => {
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
    expect(s.pos.y - deps.sampler.heightAt(s.pos.x, s.pos.z)).toBeGreaterThan(1000);
    expect(s.cargoMassKg).toBe(16000);
    const snap = new Float64Array(SNAPSHOT_FLOATS);
    world.writeSnapshot(snap);
    const ad = HUD_BLOCK_START + HUD_EXT_BASE + HUD_AIRDROP_OFFSET;
    expect(snap[ad + SnapshotHudAirdrop.LEFT]).toBe(16);
    expect(snap[ad + SnapshotHudAirdrop.STATE]).toBe(AirdropStateCode.Safe);
    // The HUD's needles fly the drop beam.
    const loc = snap[HUD_BLOCK_START + SnapshotHud.ILS_LOC]!;
    const gs = snap[HUD_BLOCK_START + SnapshotHud.ILS_GS]!;
    expect(loc !== 0 || gs !== 0).toBe(true);
    expect(Math.abs(loc)).toBeLessThan(0.5);
  });

  test('the whole mission on autopilot: the glidepath and climb-out clear the ground, the surprise is sprung on the run-in, flares save the jet, the stick lands on the strip', () => {
    const r = flyMission({ flares: true, afterSec: 240, untilEnd: true });
    expect(r.alive).toBe(true);
    // Down the glidepath to the drop, never close to the ground; the climb-out through the notch too.
    expect(r.release).toBeDefined();
    expect(r.minAglApproach).toBeGreaterThan(100);
    expect(r.minAglClimb).toBeGreaterThan(100);
    expect(r.maxNeedles).toBe(1);
    // Released ~150 m over the strip at the drop speed.
    expect(r.release!.aglOverDz).toBeGreaterThan(110);
    expect(r.release!.aglOverDz).toBeLessThan(220);
    expect(Math.abs(r.release!.iasKt - DROP_KT)).toBeLessThan(15);
    // The stick: good or better.
    expect(r.landed.length).toBe(16);
    const g = r.script.drops()[0]!;
    expect(['excellent', 'good']).toContain(g.grade);
    // The missiles: none before the drop or short of the strip; the first goes up as the jet
    // crosses it on the climb-out, and the loadmaster calls it at once, from the side it is on.
    expect(r.firstLaunch).toBeDefined();
    expect(r.firstLaunch!.afterRelease).toBe(true);
    expect(r.firstLaunch!.alongM).toBeLessThan(0);
    expect(r.launchesShortOfStrip).toBe(0);
    // Hidden until then; the team that fired gets its threat marker.
    const groups = r.m.groundGroups ?? [];
    expect(buildSteerpoints(groups, () => 3000)).toEqual([]);
    const revealed = new Set<string>();
    const team = revealFiringGroup(groups, revealed, r.firstLaunch!.pos);
    expect(team).toBeDefined();
    const mark = buildSteerpoints([{ ...team!, hidden: false }], () => 3000);
    expect(mark.length).toBe(1);
    expect(mark[0]!.threat).toBe(true);
    expect(revealFiringGroup(groups, revealed, r.firstLaunch!.pos)).toBeUndefined();
    expect(r.firstLaunchCallAt).toBeGreaterThanOrEqual(r.firstLaunch!.t);
    expect(r.firstLaunchCallAt - r.firstLaunch!.t).toBeLessThan(2);
    const launchCall = r.said.find((tx) => tx.clips.some((c) => c.startsWith('lm_launch_')))!;
    expect(launchCall.from).toBe(LOADMASTER);
    expect(launchCall.intercom).toBe(true);
    const j = r.firstLaunch!.jet;
    const right = (r.firstLaunch!.pos.x - j.x) * Math.cos(j.headingRad) + (r.firstLaunch!.pos.z - j.z) * Math.sin(j.headingRad) >= 0;
    expect(launchCall.clips).toEqual([right ? 'lm_launch_right' : 'lm_launch_left']);
    // Nothing about the threat was said before it.
    const before = r.said.slice(0, r.said.indexOf(launchCall));
    for (const tx of before) expect(tx.text).not.toMatch(THREAT_WORDS);
    expect(r.hits).toBeLessThan(3);
    expect(r.script.missileLaunches()).toBe(r.launches);
    // The script: graded (the loadmaster sees the loads down), and the mission ends once clear of
    // the missiles and climbed out: Netra's closing call, then success within a few minutes of the drop.
    expect(r.said.some((tx) => tx.from === LOADMASTER && (tx.clips.includes('lm_drop_shack') || tx.clips.includes('lm_drop_good')))).toBe(true);
    // The drop's crew calls, in order; Netra only checks in and closes; no tower.
    const crew = r.said.filter((tx) => tx.from === LOADMASTER).map((tx) => tx.clips[0]!);
    const order = ['lm_ramp_opening', 'lm_ramp_open', 'lm_one_min', 'lm_ten_sec', 'lm_green', 'lm_load_clear_16', 'lm_ramp_closing'];
    expect(order.map((c) => crew.indexOf(c as never))).toEqual([...order.map((c) => crew.indexOf(c as never))].sort((a, b) => a - b));
    for (const c of order) expect(crew, c).toContain(c);
    for (const tx of r.said.filter((x) => x.from === LOADMASTER)) expect(tx.intercom).toBe(true);
    const netra = r.said.filter((tx) => tx.from === 'NETRA').flatMap((tx) => tx.clips);
    for (const c of netra) expect(['ad_netra', 'ad_checkin', 'ad_complete', 'ad_home']).toContain(c);
    for (const tx of r.said) expect(tx.clips.some((c) => c.startsWith('tw_'))).toBe(false);
    expect(r.script.currentPhase()).toBe('done');
    expect(r.successAt).toBeGreaterThan(r.releasedAt);
    expect(r.successAt - r.releasedAt).toBeLessThan(180);
    const closing = r.said.find((tx) => tx.clips.includes('ad_complete'))!;
    expect(closing.clips).toContain('ad_home');
    expect(r.script.completedAt()).toBeLessThan(r.successAt);
    // The debrief: the grade, the passes and the missiles evaded.
    const tiles = Object.fromEntries(r.script.results().tiles.map((x) => [x.label, x.value]));
    expect(tiles['Drop']).toMatch(/^(Excellent|Good) · \d+ m$/);
    expect(tiles['Passes']).toBe('1');
    expect(tiles['Missiles evaded']).toBe(`${r.launches - r.hits} of ${r.launches}`);
    expect(tiles['Simikot']).toBeUndefined();
    // Nobody offers a landing at Simikot: the mission just ends.
    for (const tx of r.said) expect(tx.text).not.toMatch(/\bland\b|landing|runway two eight|runway 28/i);
  }, 90_000);

  test('the script runs: brief, glidepath, run-in, a good stick, climb-out, the end', () => {
    const s = new SimikotAirdropScript({ x: 2, y: 0, z: -1.5 });
    s.update(frame({ t: 3 }));
    const brief = s.drain();
    expect(brief.map((tx) => tx.clips)).toEqual([['ad_netra', 'ad_checkin']]);
    expect(s.objective()?.step).toBe(1);
    expect(s.currentPhase()).toBe('inbound');
    // High on the glidepath 20 km out: nobody talks it down (the HUD needles do that).
    const hi = onPath(20000);
    s.update(frame({ t: 120, player: { ...hi, y: hi.y + 300 } }));
    expect(s.drain()).toEqual([]);
    // Lined up 10 km out: the run-in. The loadmaster: the ramp coming open, then open.
    s.update(frame({ t: 200, player: onPath(10000) }));
    expect(s.currentPhase()).toBe('runin');
    s.update(frame({ t: 201, player: onPath(9900), rampPos: 0.3 }));
    s.update(frame({ t: 220, player: onPath(8400), rampPos: 1 }));
    const ramp = s.drain();
    expect(ramp.map((tx) => tx.clips[0])).toEqual(['lm_ramp_opening', 'lm_ramp_open']);
    for (const tx of ramp) expect(tx).toMatchObject({ from: LOADMASTER, intercom: true });
    // The countdown from the CARP: one minute, ten seconds, green.
    s.update(frame({ t: 230, player: onPath(4400), rampPos: 1, airdropState: AirdropStateCode.Armed }));
    expect(s.drain().map((tx) => tx.clips[0])).toEqual(['lm_one_min']);
    s.update(frame({ t: 270, player: onPath(1300), rampPos: 1, airdropState: AirdropStateCode.Armed }));
    expect(s.drain().map((tx) => tx.clips[0])).toEqual(['lm_ten_sec']);
    // The whole load (16) lands ~100 m from the T; the loadmaster calls the load clear once the last is out.
    s.event({ type: 'airdropRelease', entityId: 1, stickId: 1, count: 16, pos: { x: 0, y: 0, z: 0 }, iasMps: 180 * KT, aglM: 150, reserve: false }, 1);
    expect(s.currentPhase()).toBe('egress');
    s.update(frame({ t: 272, player: { x: DZ.x - 300, y: 3130, z: DZ.z - 200 }, rampPos: 1 }));
    expect(s.drain().some((tx) => tx.clips.includes('lm_load_clear_16'))).toBe(false);
    s.update(frame({ t: 279, player: { x: DZ.x - 900, y: 3160, z: DZ.z - 400 }, rampPos: 0.95 }));
    expect(s.drain().map((tx) => tx.clips[0])).toEqual(['lm_load_clear_16', 'lm_ramp_closing']);
    for (let i = 0; i < 16; i++) s.event({ type: 'airdropLanded', entityId: 1, stickId: 1, index: i, count: 16, pos: { x: DZ.x + 95 + i * 3, y: DZ_GROUND_M, z: DZ.z }, impactMps: 9, destroyed: false }, 1);
    expect(s.drops()[0]!.grade).toBe('good');
    const graded = s.drain();
    expect(graded.map((tx) => tx.clips)).toEqual([['lm_drop_good']]);
    // A missile goes up on the climb-out: not complete while the warning is on, nor inside the teams' reach.
    s.event({ type: 'missileLaunch', shooterId: 99, missileId: 100, weapon: 'ir', pos: { x: DZ.x - 2400, y: 3000, z: DZ.z - 1350 } } as unknown as SimEvent, 1);
    // Up ahead and to the left of the nose (the jet still on 315): 'left side'.
    expect(s.drain().map((tx) => tx.clips)).toEqual([['lm_launch_left']]);
    s.update(frame({ t: 290, player: { x: DZ.x - 2000, y: 3500, z: DZ.z - 500 }, warningBits: WarningBit.MissileLaunch }));
    expect(s.objectives()).toEqual({ drop: true, threatClear: false, climbedOut: false });
    expect(s.currentPhase()).toBe('egress');
    // Still near the teams, high: climbed out but the threat is not behind yet.
    s.update(frame({ t: 295, player: { x: DZ.x - 3000, y: 4200, z: DZ.z - 1500 } }));
    expect(s.objectives()).toEqual({ drop: true, threatClear: false, climbedOut: true });
    // Out of their reach, quiet: complete. The closing call, then success after the outro.
    s.update(frame({ t: 300, player: { x: DZ.x - 9000, y: 4300, z: DZ.z - 2500 } }));
    expect(s.currentPhase()).toBe('done');
    const closing = s.drain();
    expect(closing.some((tx) => tx.clips.includes('ad_complete') && tx.clips.includes('ad_home'))).toBe(true);
    expect(s.outcome()).toBeUndefined();
    s.update(frame({ t: 300 + s.outroSec + 0.1, player: { x: DZ.x - 9500, y: 4400, z: DZ.z - 2500 } }));
    expect(s.outcome()).toBe('success');
    const tiles = s.results().tiles;
    expect(tiles[0]!.value).toMatch(/^Good/);
    expect(tiles.find((x) => x.label === 'Missiles evaded')?.value).toBe('1 of 1');
  });

  test('never fired on: complete as soon as the stick is graded and the jet has climbed out', () => {
    const s = new SimikotAirdropScript({ x: 0, y: 0, z: 0 });
    s.update(frame({ t: 200, player: onPath(6000) }));
    s.event({ type: 'airdropRelease', entityId: 1, stickId: 1, count: 4, pos: { x: 0, y: 0, z: 0 }, iasMps: DROP_KT * KT, aglM: 150, reserve: false }, 1);
    for (let i = 0; i < 4; i++) s.event({ type: 'airdropLanded', entityId: 1, stickId: 1, index: i, count: 4, pos: { x: DZ.x + 20, y: DZ_GROUND_M, z: DZ.z + i * 10 }, impactMps: 9, destroyed: false }, 1);
    expect(s.drops()[0]!.grade).toBe('excellent');
    // Low near the strip: not yet.
    s.update(frame({ t: 230, player: { x: DZ.x - 2000, y: 3300, z: DZ.z } }));
    expect(s.currentPhase()).toBe('egress');
    // 8 km out (still low in the valley): complete.
    s.update(frame({ t: 300, player: { x: DZ.x - 8100, y: 3600, z: DZ.z } }));
    expect(s.currentPhase()).toBe('done');
    expect(s.results().tiles.find((x) => x.label === 'Missiles evaded')?.value).toBe('None fired');
  });

  test('grades: bands and wrecked loads', () => {
    expect(gradeDrop(30, 0, 4)).toBe('excellent');
    expect(gradeDrop(150, 0, 4)).toBe('good');
    expect(gradeDrop(300, 1, 4)).toBe('acceptable');
    expect(gradeDrop(400, 0, 4)).toBe('miss');
    expect(gradeDrop(20, 3, 4)).toBe('destroyed');
    expect(gradeSucceeds('acceptable')).toBe(true);
    expect(gradeSucceeds('miss')).toBe(false);
  });

  test('a stick released on the CARP on the run-in, ~150 m over the strip at the drop speed, scores good or better', () => {
    expect(DROP_KT).toBeGreaterThanOrEqual(170);
    expect(TOO_FAST_KT).toBeGreaterThan(DROP_KT + 25);
    const w = runInWorld(3000, 150, DROP_KT);
    const r = flyDrop(w, DROP_KT, onCarp(w.mission.weather.windWorldMps), DZ_GROUND_M + 150);
    expect(r.released).toBe(true);
    // The whole load in one pass.
    expect(r.landed.length).toBe(16);
    expect(r.destroyed).toBe(0);
    expect(Math.abs(r.releaseIas / KT - DROP_KT)).toBeLessThan(15);
    expect(['excellent', 'good']).toContain(gradeDrop(r.distM, r.destroyed, r.landed.length));
  });

  test('A-22 bundles under G-12s: a normal release lands skid first at the canopy sink rate and survives', () => {
    const w = runInWorld(3000, 150, DROP_KT, { calm: true, rampOpen: true });
    const r = flyDrop(w, DROP_KT, onCarp({ x: 0, y: 0, z: 0 }), DZ_GROUND_M + 150);
    expect(r.landed.length).toBe(16);
    for (const l of r.landed) {
      expect(l.destroyed).toBe(false);
      // ~10 m/s under the canopy at 3,000 m (8.5 at sea level), drifting little in calm air.
      expect(l.impactMps).toBeGreaterThan(8);
      expect(l.impactMps).toBeLessThan(CDS.maxImpactMps);
    }
    // Sea level: the G-12's published ~8.5 m/s with 1,000 kg.
    const sl = predictCdsDrop({ x: 0, y: 300, z: 0 }, { x: 70, y: 0, z: 0 }, 0, { x: 0, y: 0, z: 0 });
    expect(sl.sinkMps).toBeGreaterThan(7.8);
    expect(sl.sinkMps).toBeLessThan(9.2);
  });

  test('the stick (the whole load, 16) rolls out of the ramp in sequence and lands spread along the track; the loads stay on the ground with their canopies', () => {
    // The roll-out: the aftmost first, the rest at decreasing intervals, all within ~4 s.
    const outs = [0, 1, 2, 3].map((i) => cdsRollOut(i));
    for (let i = 1; i < 4; i++) {
      const gap = outs[i]!.sec - outs[i - 1]!.sec;
      expect(gap).toBeGreaterThan(0.35);
      expect(gap).toBeLessThan(0.8);
    }
    expect(outs[0]!.sec).toBeGreaterThan(1.5);
    expect(outs[3]!.sec).toBeLessThan(4.5);
    // Steeper deck, faster out.
    expect(cdsRollOut(0, 0.17).sec).toBeLessThan(outs[0]!.sec);

    const w = runInWorld(3000, 150, DROP_KT, { calm: true, rampOpen: true });
    const { world, id } = w;
    const code = STORE_IDS.indexOf('cds-bundle');
    const loads = (): EntityState[] => {
      const out: EntityState[] = [];
      for (let e = 0; e < 4096; e++) {
        const st = world.getEntityState(e as EntityId);
        if (st && st.alive && st.kind === EntityKind.Effect && st.stores === code) out.push(st);
      }
      return out;
    };
    const snap = new Float64Array(SNAPSHOT_FLOATS);
    const left = (): number => {
      world.writeSnapshot(snap);
      return snap[HUD_BLOCK_START + HUD_EXT_BASE + HUD_AIRDROP_OFFSET + SnapshotHudAirdrop.LEFT]!;
    };
    const exitAt: number[] = [];
    const events: SimEvent[] = new Array(4096);
    const landed: AirdropLandedEvent[] = [];
    let releasedAt = -1;
    let inHoldAtRelease = 0;
    let prevLeft = 16;
    const carp = onCarp({ x: 0, y: 0, z: 0 });
    for (let i = 0; i < Math.round(60 / SIM_DT_SEC) && landed.length < STICK; i++) {
      const t = i * SIM_DT_SEC;
      const s = world.getEntityState(id)!;
      const inp = baseInputs();
      inp.rampOpen = true;
      inp.flapLever = 2;
      inp.throttle = 0.7;
      inp.pitch = Math.max(-0.5, Math.min(0.5, (DZ_GROUND_M + 150 - s.pos.y) * 0.006 - s.vel.y * 0.04));
      if (releasedAt < 0 && carp(s)) {
        inp.launch = true;
        releasedAt = t;
      }
      world.setPlayerInput(id, inp);
      world.stepOnce();
      if (releasedAt >= 0 && inHoldAtRelease === 0) {
        // Just released: four bundles on the rollers, in the hold behind the jet's centre, moving with it.
        const l = loads();
        inHoldAtRelease = l.length;
        const jet = world.getEntityState(id)!;
        for (const b of l) {
          expect(Math.hypot(b.pos.x - jet.pos.x, b.pos.y - jet.pos.y, b.pos.z - jet.pos.z)).toBeLessThan(25);
          expect(Math.hypot(b.vel.x - jet.vel.x, b.vel.z - jet.vel.z)).toBeLessThan(1);
        }
      }
      if (releasedAt >= 0) {
        const n = left();
        if (n < prevLeft) exitAt.push(t - releasedAt);
        prevLeft = n;
      }
      const n = world.drainEvents(events);
      for (let k = 0; k < n; k++) if (events[k]!.type === 'airdropLanded') landed.push(events[k] as AirdropLandedEvent);
    }
    expect(inHoldAtRelease).toBe(16);
    // Out one at a time: 16 -> 0 in sixteen steps, the first ~2 s after the release, the last ~7-8 s.
    expect(exitAt.length).toBe(16);
    expect(exitAt[0]!).toBeGreaterThan(1.5);
    expect(exitAt[15]!).toBeLessThan(9);
    for (let i = 1; i < 16; i++) expect(exitAt[i]! - exitAt[i - 1]!).toBeGreaterThan(0.15);
    // On the ground in their order along the track, tens of metres apart.
    expect(landed.length).toBe(16);
    const hd = (RUN_IN_DEG * Math.PI) / 180;
    const along = landed.sort((a, b) => a.index - b.index).map((l) => l.pos.x * Math.sin(hd) - l.pos.z * Math.cos(hd));
    // In their order (the canopies' scatter brings a few close together), each within ~100 m of the last.
    for (let i = 1; i < 16; i++) {
      expect(along[i]! - along[i - 1]!).toBeGreaterThan(-1);
      expect(along[i]! - along[i - 1]!).toBeLessThan(120);
    }
    // The stick is ~500-700 m long on the ground at 180 kt.
    expect(along[15]! - along[0]!).toBeGreaterThan(350);
    expect(along[15]! - along[0]!).toBeLessThan(900);
    // They stay: upright on their skids, on the ground, the canopy beside each (OnGround + TailOpen).
    for (let i = 0; i < 60; i++) {
      world.setPlayerInput(id, baseInputs());
      world.stepOnce();
    }
    const down = loads();
    expect(down.length).toBe(16);
    for (const b of down) {
      expect(b.flags & EntityFlag.OnGround).toBeTruthy();
      expect(b.flags & EntityFlag.TailOpen).toBeTruthy();
      expect(Math.hypot(b.vel.x, b.vel.y, b.vel.z)).toBe(0);
      const ground = w.deps.sampler.heightAt(b.pos.x, b.pos.z);
      expect(Math.abs(b.pos.y - CDS.halfHeightM - ground)).toBeLessThan(0.2);
      const up = Quat.rotate(b.rot, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 });
      expect(up.y).toBeGreaterThan(0.99);
    }
  });

  test('a stick released far short is a miss, and the mission goes on', () => {
    const w = runInWorld(3000, 150, DROP_KT, { rampOpen: true });
    // Released 600 m before the CARP.
    const r = flyDrop(w, DROP_KT, onCarp(w.mission.weather.windWorldMps, 600), DZ_GROUND_M + 150);
    expect(r.landed.length).toBe(16);
    expect(gradeDrop(r.distM, r.destroyed, 16)).toBe('miss');
    const s = new SimikotAirdropScript(w.mission.weather.windWorldMps);
    s.update(frame({ t: 300, player: onPath(5000) }));
    expect(s.currentPhase()).toBe('runin');
    s.event({ type: 'airdropRelease', entityId: 1, stickId: 1, count: 16, pos: { x: 0, y: 0, z: 0 }, iasMps: r.releaseIas, aglM: 150, reserve: false }, 1);
    for (const l of r.landed) s.event({ ...l, entityId: 1 }, 1);
    expect(s.drops()[0]!.grade).toBe('miss');
    expect(s.drain().some((tx) => tx.from === LOADMASTER && tx.clips.includes('lm_drop_miss'))).toBe(true);
    expect(s.currentPhase()).toBe('reattack');
    expect(s.outcome()).toBeUndefined();
    // Back on the approach: another run-in.
    s.update(frame({ t: 700, player: onPath(9000) }));
    expect(s.currentPhase()).toBe('runin');
    // The rigged load is gone in the one stick (this test's autopilot just climbs straight on, into
    // the hills; the mission's flies the valley): another pass drops reserve bundles, still armed.
    const snap = new Float64Array(SNAPSHOT_FLOATS);
    w.world.writeSnapshot(snap);
    expect(snap[HUD_BLOCK_START + HUD_EXT_BASE + HUD_AIRDROP_OFFSET + SnapshotHudAirdrop.LEFT]).toBe(0);
  });

  test('a stick released too low is wrecked', () => {
    // 45 m: the canopies are still filling when the bundles hit.
    const w = runInWorld(1500, 45, DROP_KT, { calm: true, rampOpen: true });
    const r = flyDrop(w, DROP_KT, onCarp({ x: 0, y: 0, z: 0 }), DZ_GROUND_M + 45);
    expect(r.landed.length).toBe(16);
    expect(r.destroyed).toBeGreaterThan(8);
    expect(gradeDrop(r.distM, r.destroyed, 16)).toBe('destroyed');
  });

  test('the fuel jettison takes fuel off and stops at the minimum', () => {
    const m = resolveBuiltinMission(ID);
    const world = createWorld(buildWorldDependencies(m));
    world.loadMission(m);
    const id = world.getPlayerEntityId();
    const f0 = world.getEntityState(id)!.fuelKg;
    for (let i = 0; i < Math.round(60 / SIM_DT_SEC); i++) {
      world.setPlayerInput(id, { ...baseInputs(), fuelDump: true });
      world.stepOnce();
    }
    const f1 = world.getEntityState(id)!.fuelKg;
    const rate = c17Definition.fuelDump!.rateKgS;
    expect(f0 - f1).toBeGreaterThan(rate * 60 * 0.95);
    const world2 = createWorld(buildWorldDependencies(m));
    world2.loadMission(m);
    const id2 = world2.getPlayerEntityId();
    for (let i = 0; i < Math.round(60 / SIM_DT_SEC); i++) {
      world2.setPlayerInput(id2, baseInputs());
      world2.stepOnce();
    }
    expect(f0 - world2.getEntityState(id2)!.fuelKg).toBeLessThan((f0 - f1) / 3);
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
    const beam = flareSeductionChance(res, { x: 2000, y: 3700, z: 0 }, jet, vel, false);
    const tail = flareSeductionChance(res, { x: 0, y: 3700, z: 2000 }, jet, vel, false);
    const press = (p: number, presses: number): number => 1 - Math.pow(1 - p, 2 * presses);
    expect(press(beam, 1)).toBeGreaterThan(0.6);
    expect(press(tail, 1)).toBeGreaterThan(0.45);
    expect(press(tail, 2)).toBeGreaterThan(0.75);
    expect(press(beam, 1)).toBeLessThan(0.95);
  });

  test('the teams hold fire on the inbound run; without flares a hit on the climb-out is not a kill (one engine out)', () => {
    const r = flyMission({ flares: false, afterSec: 60 });
    expect(r.release).toBeDefined();
    expect(r.launches).toBeGreaterThan(0);
    expect(r.launchesShortOfStrip).toBe(0);
    expect(r.firstLaunch!.afterRelease).toBe(true);
    expect(r.firstHit).toBeDefined();
    expect(r.firstHit!.alive).toBe(true);
    expect(r.firstHit!.engines).toBe(3);
  }, 60_000);
});
