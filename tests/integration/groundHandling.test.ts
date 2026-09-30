/**
 * tests/integration/groundHandling.test.ts — steering and landing on the gear (through the real
 * World): steering fades with speed, the tyres grip instead of sliding, and a gentle nose-high
 * landing settles onto the nose wheel instead of tipping back.
 */
import { describe, expect, test } from 'vitest';
import { HUD_BLOCK_START, SIM_DT_SEC, SNAPSHOT_FLOATS, SnapshotHud, EntityFlag, type PilotInputs } from '../../src/contracts/core';
import type { AirportLayout } from '../../src/contracts/airport';
import { buildWorldDependencies, createWorld } from '../../src/core';
import { freeFlightMission } from '../../src/core/missions/catalogue';
import { nwsAuthority } from '../../src/physics/landingGear';
import { keyboardResponse } from '../../src/input/playerPilot';

const calm = { windWorldMps: { x: 0, y: 0, z: 0 }, gustMps: 0, turbulence: 0 };
const inputs = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 0, gearDown: true, airbrake: false,
  trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, nwsEnabled: true, ...over,
});
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Full rudder for 2 s at `speed`: degrees turned and the largest sideways slide, degrees. */
function steer(speed: number, yaw: number): { turnedDeg: number; slideDeg: number; rollDeg: number } {
  const mission = { ...freeFlightMission('hansa', 'runway'), weather: calm };
  const world = createWorld(buildWorldDependencies(mission));
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const snap = new Float64Array(SNAPSHOT_FLOATS);
  let hdg0 = NaN;
  let slide = 0;
  let roll = 0;
  let steerTicks = 0;
  for (let k = 0; k < 60 / SIM_DT_SEC && steerTicks < 2 / SIM_DT_SEC; k++) {
    world.writeSnapshot(snap);
    const st = world.getEntityState(id)!;
    const v = Math.hypot(st.vel.x, st.vel.z);
    const hdg = snap[HUD_BLOCK_START + SnapshotHud.HEADING_RAD]!;
    const inp = inputs({ throttle: v < speed ? 1 : 0.3 });
    if (Number.isNaN(hdg0) && v >= speed - 0.5 && k > 2 / SIM_DT_SEC) hdg0 = hdg;
    if (!Number.isNaN(hdg0)) {
      inp.yaw = yaw;
      inp.throttle = v < speed ? 0.6 : 0.1;
      slide = Math.max(slide, Math.abs(wrap(Math.atan2(st.vel.x, -st.vel.z) - hdg)));
      roll = Math.max(roll, Math.abs(snap[HUD_BLOCK_START + SnapshotHud.ROLL_RAD]!));
      steerTicks++;
    }
    world.setPlayerInput(id, inp);
    world.stepOnce();
  }
  world.writeSnapshot(snap);
  return { turnedDeg: (wrap(snap[HUD_BLOCK_START + SnapshotHud.HEADING_RAD]! - hdg0) * 180) / Math.PI, slideDeg: (slide * 180) / Math.PI, rollDeg: (roll * 180) / Math.PI };
}

describe('ground handling', () => {
  test('steering authority fades from full when taxiing to a fifth at take-off speed', () => {
    expect(nwsAuthority(3)).toBe(1);
    expect(nwsAuthority(26.5)).toBeCloseTo(0.6, 5);
    expect(nwsAuthority(70)).toBeCloseTo(0.2, 5);
  });

  test('keyboard roll/rudder is gentle for a tap and full at full deflection', () => {
    expect(keyboardResponse(1)).toBe(1);
    expect(keyboardResponse(-1)).toBe(-1);
    expect(keyboardResponse(0.3)).toBeLessThan(0.13);
  });

  test('the tyres grip: full steering at taxi speed turns without sliding', () => {
    const r = steer(6, 1);
    // ~30 deg in 2 s. The nose tyre's side grip follows its (light) load, so it steers with a few
    // degrees of slip angle, a little wider than the old fixed-stiffness tyres (33 deg).
    expect(r.turnedDeg).toBeGreaterThan(27);
    expect(r.slideDeg).toBeLessThan(10);
  });

  test('full steering at a fast taxi does not roll the aircraft over (centre of gravity ~1.7 m up, 2.2 m track)', () => {
    const r = steer(12, 1);
    expect(r.turnedDeg).toBeGreaterThan(15);
    expect(r.slideDeg).toBeLessThan(10);
    expect(r.rollDeg).toBeLessThan(8);
  });

  test('at take-off speed, full rudder is a correction, not a swerve', () => {
    const r = steer(65, 1);
    expect(Math.abs(r.turnedDeg)).toBeLessThan(30);
    expect(r.slideDeg).toBeLessThan(10);
  });

  test('a gentle nose-high landing settles onto the nose wheel and stays upright', () => {
    const base = freeFlightMission('hansa', 'runway');
    const layout = (base.world.airports as AirportLayout[]).find((a) => a.id === 'ins-hansa')!;
    const rwy = layout.runways.find((r) => r.id === base.playerStart.runwayId)!;
    const dx = Math.sin(rwy.headingRad);
    const dz = -Math.cos(rwy.headingRad);
    const mission = { ...base, weather: calm, playerStart: { pos: { x: rwy.thresholdWorldX + dx * 150, y: layout.elevationM + 15, z: rwy.thresholdWorldZ + dz * 150 }, headingRad: rwy.headingRad, speedMps: 75 } };
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const id = world.getPlayerEntityId();
    const snap = new Float64Array(SNAPSHOT_FLOATS);
    const hud = (f: number): number => snap[HUD_BLOCK_START + f]!;
    let touchdown = -1;
    let maxPitchAfter = 0;
    let maxRollAfter = 0;
    let pitchAtTouchdown = 0;
    for (let k = 0; k < 40 / SIM_DT_SEC; k++) {
      const t = k * SIM_DT_SEC;
      world.writeSnapshot(snap);
      const st = world.getEntityState(id)!;
      const onGround = (st.flags & EntityFlag.OnGround) !== 0;
      if (touchdown < 0 && onGround) {
        touchdown = t;
        pitchAtTouchdown = hud(SnapshotHud.PITCH_RAD);
      }
      const inp = inputs();
      if (touchdown < 0) {
        inp.pitch = Math.max(-1, Math.min(1, 0.25 * (-1.5 - hud(SnapshotHud.VSPEED_MPS))));
        inp.roll = Math.max(-1, Math.min(1, -2 * hud(SnapshotHud.ROLL_RAD)));
      } else {
        inp.brakes = t - touchdown > 3 ? 1 : 0;
        if (onGround) maxPitchAfter = Math.max(maxPitchAfter, hud(SnapshotHud.PITCH_RAD));
        maxRollAfter = Math.max(maxRollAfter, Math.abs(hud(SnapshotHud.ROLL_RAD)));
      }
      world.setPlayerInput(id, inp);
      world.stepOnce();
    }
    world.writeSnapshot(snap);
    expect(touchdown).toBeGreaterThan(0);
    expect(pitchAtTouchdown).toBeGreaterThan((8 * Math.PI) / 180); // a real nose-high landing
    expect(maxPitchAfter).toBeLessThan((20 * Math.PI) / 180); // never tips back
    expect(maxRollAfter).toBeLessThan((5 * Math.PI) / 180);
    expect(Math.abs(hud(SnapshotHud.PITCH_RAD))).toBeLessThan((3 * Math.PI) / 180); // resting on all three wheels
    expect(world.getEntityState(id)!.alive).toBe(true);
  });
});
