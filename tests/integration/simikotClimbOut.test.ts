/**
 * tests/integration/simikotClimbOut.test.ts — the climb-out after the drop in "Simikot Lifeline":
 * from the release point (180 KIAS, flaps 1/2, ~150 m over the strip at 2,971 m), full power and the
 * flaps up, the C-17 accelerates to a climb speed and climbs out of the valley along the mission's
 * route (left onto 270 off the terrace, then up the Karnali on ~298) with real margin
 * over the ground. It flies the mission as loaded (src/core/missions/himalayaAirdrop.json: fuel 0.3,
 * the whole 16 t load dropped in one stick) and, for comparison, the load it had before (fuel 0.4,
 * one stick of 4: 12 t still aboard on the climb-out), printing both.
 *
 * The flight model itself is checked in tests/integration/c17Performance.test.ts; this one checks
 * the mission leaves the player a comfortable margin with it.
 */
import { describe, expect, test } from 'vitest';
import { SIM_DT_SEC, type Mission, type PilotInputs, type SimEvent } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld } from '../../src/core';
import { resolveBuiltinMission } from '../../src/core/missions';
import { predictCdsDrop } from '../../src/core/airdrop';
import { c17Definition } from '../../src/aircraft/c17Definition';
import { aircraftMassKg } from '../../src/physics/integrator';
import { CLIMB_OUT_ALT_M, DROP_KT, DZ, DZ_GROUND_M, RUN_IN_DEG } from '../../src/script/missions/simikotAirdrop';

const KT = 0.514444;
/** The speed the climb is flown at once the flaps are up, KIAS (clean minimum ~165 at this weight and height). */
const CLIMB_KT = 210;
const wrap180 = (d: number): number => ((((d % 360) + 540) % 360) - 180);
const baseInputs = (): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.7, afterburner: false, brakes: 0, gearDown: false, airbrake: false,
  trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, nwsEnabled: true,
});

interface ClimbOut {
  releaseMassT: number;
  climbMassT: number;
  /** From the release to CLIMB_KT, s (NaN: never). */
  toClimbSpeedSec: number;
  /** Mean rate of climb over the 30 s after reaching CLIMB_KT (at that speed), m/s. */
  climbRateMps: number;
  /** Lowest height over the ground after the release, m. */
  minAglM: number;
  /** Lowest height over the ground anywhere within 500 m either side of the track (a turn or a drift off the line), m. */
  minCorridorM: number;
  /** From the release to CLIMB_OUT_ALT_M (4,000 m), s. */
  to4000Sec: number;
  /** Height and distance from the strip 120 s after the release. */
  alt120M: number;
  dist120M: number;
  alive: boolean;
}

/** The run-in from 3 km out, release on the CARP, then the climb-out as a pilot flies it. */
function climbOut(load: { fuelFrac?: number; stick?: number } = {}): ClimbOut {
  const base = resolveBuiltinMission('himalaya-airdrop');
  const stick = load.stick ?? base.playerStart.airdrop!.stick;
  const hd = (RUN_IN_DEG * Math.PI) / 180;
  const tx = Math.sin(hd), tz = -Math.cos(hd);
  const holdY = DZ_GROUND_M + 150;
  const rho = 1.225 * Math.pow(1 - 2.25577e-5 * holdY, 4.2559);
  const mission: Mission = {
    ...base,
    // The performance alone: no MANPADS.
    groundGroups: [],
    playerStart: {
      ...base.playerStart,
      ...(load.fuelFrac !== undefined ? { fuelFrac: load.fuelFrac } : {}),
      airdrop: { ...base.playerStart.airdrop!, stick },
      pos: { x: DZ.x - tx * 3000, y: holdY, z: DZ.z - tz * 3000 },
      headingRad: hd,
      speedMps: DROP_KT * KT * Math.sqrt(1.225 / rho),
    },
  };
  const deps = buildWorldDependencies(mission);
  const world = createWorld(deps);
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const st = world.getEntityState(id)!;
  st.rampPos = 1;
  st.flapDetent = 2;
  st.flapPos = 2;
  st.slatPos = 1;
  const events: SimEvent[] = new Array(4096);
  let thr = 0.7;
  let relAt = -1;
  let releaseMass = 0;
  let climbMass = 0;
  let atSpeedAt = -1;
  let atSpeedY = 0;
  let climbRate = NaN;
  let minAgl = Infinity;
  let minCorridor = Infinity;
  let to4000 = NaN;
  let alt120 = NaN;
  let dist120 = NaN;
  let alive = true;
  for (let i = 0; i < Math.round(200 / SIM_DT_SEC); i++) {
    const t = i * SIM_DT_SEC;
    const s = world.getEntityState(id)!;
    const tel = world.getTelemetry(id)!;
    if (!s.alive) {
      alive = false;
      break;
    }
    const inp = baseInputs();
    const ias = tel.iasMps / KT;
    const hdg = (tel.headingRad * 180) / Math.PI;
    let wantHdg = RUN_IN_DEG;
    if (relAt < 0) {
      // Level at 150 m over the strip, 180 kt on the throttle, flaps 1/2, ramp open.
      inp.rampOpen = true;
      inp.flapLever = 2;
      thr = Math.min(1, Math.max(0.05, thr + (DROP_KT - ias) * KT * 0.004));
      inp.throttle = thr;
      inp.pitch = Math.max(-0.5, Math.min(0.5, (holdY - s.pos.y) * 0.006 - s.vel.y * 0.04));
      const hit = predictCdsDrop(s.pos, s.vel, DZ_GROUND_M, mission.weather.windWorldMps, stick);
      const gs = Math.hypot(s.vel.x, s.vel.z);
      if (((DZ.x - hit.x) * s.vel.x + (DZ.z - hit.z) * s.vel.z) / gs <= 0) {
        inp.launch = true;
        relAt = t;
        releaseMass = aircraftMassKg(s, c17Definition);
      }
    } else {
      const k = t - relAt;
      // Full power at once; the flaps come up (lever to UP) 2 s after the release; the ramp
      // closes once the load is clear. The climb: a gentle 4 m/s while the speed builds, then
      // the climb speed held on the flight path (the stick commands it: transport FCS).
      inp.throttle = 1;
      inp.rampOpen = k < 9;
      inp.flapLever = k > 2 ? 0 : 2;
      if (atSpeedAt < 0 && ias >= CLIMB_KT) {
        atSpeedAt = t;
        atSpeedY = s.pos.y;
      }
      const vsWant = atSpeedAt < 0 ? 4 : Math.max(0, Math.min(30, 12 + (ias - CLIMB_KT) * 1.5));
      inp.pitch = Math.max(-0.4, Math.min(0.6, (vsWant - s.vel.y) * 0.05));
      wantHdg = s.pos.x - DZ.x > -3500 ? 270 : 298;
      if (atSpeedAt >= 0 && Number.isNaN(climbRate) && t - atSpeedAt >= 30) climbRate = (s.pos.y - atSpeedY) / (t - atSpeedAt);
      const agl = s.pos.y - deps.sampler.heightAt(s.pos.x, s.pos.z);
      minAgl = Math.min(minAgl, agl);
      const gs = Math.hypot(s.vel.x, s.vel.z);
      for (const off of [-500, -250, 250, 500]) {
        const cx = s.pos.x - (s.vel.z / gs) * off, cz = s.pos.z + (s.vel.x / gs) * off;
        minCorridor = Math.min(minCorridor, s.pos.y - deps.sampler.heightAt(cx, cz));
      }
      if (Number.isNaN(to4000) && s.pos.y >= CLIMB_OUT_ALT_M) to4000 = k;
      if (k >= 12 && climbMass === 0) climbMass = aircraftMassKg(s, c17Definition);
      if (Number.isNaN(alt120) && k >= 120) {
        alt120 = s.pos.y;
        dist120 = Math.hypot(s.pos.x - DZ.x, s.pos.z - DZ.z);
      }
    }
    const bankLim = ((relAt >= 0 ? 25 : 15) * Math.PI) / 180;
    const bankWant = Math.max(-bankLim, Math.min(bankLim, (wrap180(wantHdg - hdg) * Math.PI) / 180));
    inp.roll = Math.max(-1, Math.min(1, (bankWant - tel.rollRad) * 1.2));
    world.setPlayerInput(id, inp);
    world.stepOnce();
    world.drainEvents(events);
    if (relAt >= 0 && !Number.isNaN(alt120)) break;
  }
  return {
    releaseMassT: releaseMass / 1000,
    climbMassT: climbMass / 1000,
    toClimbSpeedSec: atSpeedAt >= 0 ? atSpeedAt - relAt : NaN,
    climbRateMps: climbRate,
    minAglM: minAgl,
    minCorridorM: minCorridor,
    to4000Sec: to4000,
    alt120M: alt120,
    dist120M: dist120,
    alive,
  };
}

const fmt = (label: string, r: ClimbOut): string =>
  `${label}: release ${r.releaseMassT.toFixed(1)} t, climb ${r.climbMassT.toFixed(1)} t · ${CLIMB_KT} KIAS after ${r.toClimbSpeedSec.toFixed(1)} s · climb ${r.climbRateMps.toFixed(1)} m/s (${Math.round(r.climbRateMps * 196.85)} ft/min) at ${CLIMB_KT} KIAS · 4,000 m after ${r.to4000Sec.toFixed(0)} s · at 120 s ${Math.round(r.alt120M)} m, ${(r.dist120M / 1000).toFixed(1)} km out · lowest ${Math.round(r.minAglM)} m over the ground (${Math.round(r.minCorridorM)} m within 500 m of the track)`;

describe('Simikot Lifeline: the climb-out after the drop', () => {
  test('full power and flaps up from the drop: the jet accelerates to a climb speed and climbs out over the valley with margin', () => {
    const now = climbOut();
    const before = climbOut({ fuelFrac: 0.4, stick: 4 });
    console.log(`\n${fmt('mission now (fuel 0.3, 16 t in one stick)', now)}\n${fmt('as it was (fuel 0.4, a stick of 4)', before)}`);
    expect(now.alive).toBe(true);
    // The whole load is gone: ~16 t lighter than at the release.
    expect(now.releaseMassT - now.climbMassT).toBeGreaterThan(15.5);
    expect(now.climbMassT).toBeLessThan(165);
    // Up to the climb speed quickly, then a strong climb at it.
    expect(now.toClimbSpeedSec).toBeLessThan(25);
    expect(now.climbRateMps).toBeGreaterThan(13);
    // Out of the valley: 4,000 m inside 90 s, never close to the ground on the way.
    expect(now.to4000Sec).toBeLessThan(90);
    expect(now.minAglM).toBeGreaterThan(110);
    // ... nor beside the track: the valley is wide enough to turn in and drift.
    expect(now.minCorridorM).toBeGreaterThan(60);
    expect(now.alt120M).toBeGreaterThan(4300);
    // The old load was clearly worse (the reason for the change).
    expect(now.climbRateMps).toBeGreaterThan(before.climbRateMps + 2);
  }, 60_000);
});
