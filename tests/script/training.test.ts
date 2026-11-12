/**
 * tests/script/training.test.ts — Flight School: the lessons walk through their steps from what
 * the pilot does, drop instructions already overtaken, end themselves; the approach geometry; and
 * the target drone in the real World (flagged, orbiting, never shooting).
 */
import { describe, expect, it } from 'vitest';
import type { ScriptFrame } from '../../src/script/director';
import type { Transmission } from '../../src/script/radio';
import { RADIO_CLIP_IDS } from '../../src/script/radio';
import { DroneLesson, LandingLessonScript, TakeoffLesson, approachTo } from '../../src/script/missions/training';
import { createMissionScript } from '../../src/script';
import { TRAINING } from '../../src/core/missions/catalogue';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import type { AirportLayout } from '../../src/contracts/airport';
import { EntityFlag, LockStateCode, NO_ENTITY_ID, SIM_DT_SEC, type SimEvent } from '../../src/contracts/core';
import { EVENT_QUEUE_CAPACITY } from '../../src/contracts/sim';
import { existsSync } from 'node:fs';

function frame(over: Partial<Omit<ScriptFrame, 'player'>> & { player?: Partial<ScriptFrame['player']> } = {}): ScriptFrame {
  const { player, ...rest } = over;
  return {
    t: 0,
    hostiles: [],
    targetId: -1,
    lockState: 0,
    warningBits: 0,
    rwrCount: 0,
    spiValid: false,
    spiX: 0,
    spiZ: 0,
    dlz: 0,
    iasMps: 0,
    altMslM: 190,
    vsMps: 0,
    pitchRad: 0,
    rollRad: 0,
    gearPos: 1,
    gearDown: true,
    airbrake: false,
    afterburner: false,
    thrustFrac: 0,
    throttle: 0,
    weaponIdx: 1,
    radarMode: 0,
    cameraChanges: 0,
    radarRangeChanges: 0,
    trackCount: 0,
    radioBusy: false,
    ...rest,
    player: { id: 1, x: 30500, y: 190, z: -11000, vx: 0, vy: 0, vz: 0, headingRad: 2.28, aglM: 0, onGround: true, alive: true, ...player },
  };
}

const layouts = resolveBuiltinMission('train-landing').world.airports as readonly AirportLayout[];

describe('Flight School catalogue', () => {
  it('has four lessons, each with a mission file and a script', () => {
    expect(TRAINING.map((l) => l.lesson)).toEqual([1, 2, 3, 4]);
    for (const l of TRAINING) {
      const m = resolveBuiltinMission(l.id);
      expect(m.objectives).toHaveLength(0); // the script ends the lesson
      expect(createMissionScript(m)).toBeDefined();
    }
  });
  it('has a rendered clip for every instructor line', () => {
    for (const id of RADIO_CLIP_IDS.filter((c) => /^(t\d_|tr_|p_cadet)/.test(c))) expect(existsSync(`public/audio/radio/${id}.mp3`), id).toBe(true);
  });
});

describe('TakeoffLesson', () => {
  it('walks from throttle-up to the camera views and then ends itself', () => {
    const s = new TakeoffLesson();
    let t = 0;
    const step = (over: Parameters<typeof frame>[0]): string => {
      t += 0.5;
      s.update(frame({ t, ...over }));
      return s.objective()?.title ?? '';
    };
    expect(step({})).toBe('Throttle up');
    expect(s.prompt()?.highlight).toContain('throttleUp');
    expect(step({ throttle: 1 })).toBe('Afterburner');
    expect(step({ throttle: 1, afterburner: true, iasMps: 30 })).toBe('Accelerate to 250 km/h');
    expect(step({ afterburner: true, iasMps: 70 })).toBe('Rotate');
    expect(step({ iasMps: 85, player: { onGround: false, aglM: 30 } })).toBe('Gear up');
    expect(s.prompt()?.highlight).toEqual(['gear']);
    expect(step({ iasMps: 120, gearDown: false, player: { onGround: false, aglM: 60 } })).toBe('Climb to 1,500 m');
    expect(step({ iasMps: 150, gearDown: false, altMslM: 1500, vsMps: 20, pitchRad: 0.2, player: { onGround: false, aglM: 1300 } })).toBe('Level off');
    const level = { iasMps: 160, gearDown: false, altMslM: 1500, player: { onGround: false, aglM: 1300, headingRad: 2.28 } };
    for (let i = 0; i < 6; i++) step(level);
    expect(s.objective()?.title).toBe('Turn 90°');
    expect(step({ ...level, rollRad: 0.8, player: { ...level.player, headingRad: 2.28 + 1.5 } })).toBe('Roll out');
    for (let i = 0; i < 4; i++) step({ ...level, player: { ...level.player, headingRad: 3.8 } });
    expect(s.objective()?.title).toBe('Try the camera views');
    step({ ...level, cameraChanges: 3, player: { ...level.player, headingRad: 3.8 } });
    expect(s.objective()?.title).toBe('Lesson complete');
    expect(s.outcome()).toBeUndefined();
    for (let i = 0; i < 6; i++) step({ ...level, cameraChanges: 3 });
    expect(s.outcome()).toBe('success');
  });

  it("drops an instruction the pilot has already done before it was said", () => {
    const s = new TakeoffLesson();
    s.update(frame({ t: 0.1 }));
    const intro = s.drain();
    expect(intro.map((x) => x.clips[0])).toContain('t1_intro');
    s.update(frame({ t: 0.2, throttle: 1 }));
    const ab = s.drain().find((x: Transmission) => x.clips.includes('t1_ab'))!;
    expect(ab.stale?.()).toBe(false);
    s.update(frame({ t: 0.3, throttle: 1, afterburner: true }));
    // The afterburner step is done: its line is no longer worth saying.
    expect(ab.stale?.()).toBe(true);
  });
});

describe('approach geometry', () => {
  const rwy = { x: 29450, z: -11903, elevationM: 190, headingRad: 2.28132 };
  const dir = { x: Math.sin(rwy.headingRad), z: -Math.cos(rwy.headingRad) };
  it('is zero on the centre line and the 3° glide path, and signs high and right', () => {
    const d = 6000;
    const y = 190 + 15 + d * Math.tan((3 * Math.PI) / 180);
    const on = approachTo(rwy, { x: rwy.x - dir.x * d, y, z: rwy.z - dir.z * d, headingRad: rwy.headingRad });
    expect(on.alongM).toBeCloseTo(d, 3);
    expect(on.aboveM).toBeCloseTo(0, 3);
    expect(on.crossM).toBeCloseTo(0, 3);
    // 100 m to the right (looking down the approach) and 50 m high.
    const right = { x: Math.cos(rwy.headingRad), z: Math.sin(rwy.headingRad) };
    const off = approachTo(rwy, { x: rwy.x - dir.x * d + right.x * 100, y: y + 50, z: rwy.z - dir.z * d + right.z * 100, headingRad: rwy.headingRad + 0.1 });
    expect(off.crossM).toBeCloseTo(100, 3);
    expect(off.aboveM).toBeCloseTo(50, 3);
    expect(off.headingOffRad).toBeCloseTo(0.1, 3);
  });
  it('the landing lesson starts its jet a little high on a 12 km final to runway 13', () => {
    const m = resolveBuiltinMission('train-landing');
    const p = m.playerStart.pos!;
    const a = approachTo(rwy, { ...p, headingRad: m.playerStart.headingRad! });
    expect(a.alongM).toBeGreaterThan(11500);
    expect(Math.abs(a.crossM)).toBeLessThan(50);
    expect(a.aboveM).toBeGreaterThan(30);
    expect(a.aboveM).toBeLessThan(150);
  });
});

describe('LandingLessonScript', () => {
  it('calls a go-around when the jet passes the threshold far too high, and coaches it back', () => {
    const s = new LandingLessonScript(layouts);
    const rwy = { x: 29450, z: -11903, h: 2.28132 };
    const at = (d: number, agl: number) => ({ x: rwy.x - Math.sin(rwy.h) * d, y: 190 + agl, z: rwy.z + Math.cos(rwy.h) * d, headingRad: rwy.h, aglM: agl, onGround: false });
    let t = 0;
    const go = (over: Parameters<typeof frame>[0]): void => {
      t += 0.5;
      s.update(frame({ t, iasMps: 80, gearPos: 1, airbrake: true, ...over }));
    };
    // Slow, gear, airbrake: on to the approach.
    go({ player: at(9000, 500) });
    go({ player: at(8800, 480) });
    go({ player: at(8600, 470) });
    expect(s.objective()?.title).toBe('Fly the glide path');
    s.drain();
    go({ player: at(-200, 300) });
    expect(s.drain().some((x) => x.clips.includes('t2_goaround'))).toBe(true);
    expect(s.prompt()?.text).toMatch(/Go around/);
    // Back on a long final: the approach again.
    go({ player: at(8000, 450) });
    expect(s.objective()?.title).toBe('Fly the glide path');
    expect(s.prompt()?.text).not.toMatch(/Go around/);
  });
});

describe('DroneLesson', () => {
  it('teaches the radar, then needs a missile kill and a gun kill', () => {
    const s = new DroneLesson();
    const drones = [
      { id: 11, x: 30500, y: 3200, z: -40000, vx: 0, vy: 0, vz: 0 },
      { id: 12, x: 26000, y: 2600, z: -50000, vx: 0, vy: 0, vz: 0 },
    ];
    const air = { onGround: false, aglM: 2800, x: 30500, y: 3000, z: -16000, headingRad: 0 };
    let t = 0;
    const go = (over: Parameters<typeof frame>[0]): string => {
      t += 1;
      s.update(frame({ t, iasMps: 200, gearDown: false, gearPos: 0, hostiles: drones, player: air, ...over }));
      return s.objective()?.title ?? '';
    };
    for (let i = 0; i < 8; i++) go({});
    // No RWR heard: that step is skipped.
    expect(go({})).toBe('Change the radar mode');
    expect(go({ radarMode: 1 })).toBe('Back to search');
    expect(go({ radarMode: 0 })).toBe('Zoom the scope');
    expect(go({ radarRangeChanges: 2 })).toBe('Designate a drone');
    expect(go({ radarRangeChanges: 2, targetId: 11 })).toBe('Lock on');
    expect(go({ radarRangeChanges: 2, targetId: 11, lockState: LockStateCode.locked })).toBe('Fire a missile');
    const pid = 1;
    s.event({ type: 'missileLaunch', shooterId: pid, weapon: 'ir_missile' } as SimEvent, pid);
    expect(go({ targetId: 11 })).toBe('Splash the first drone');
    s.event({ type: 'kill', sourceId: pid, targetId: 11 } as SimEvent, pid);
    expect(go({ hostiles: [drones[1]!] })).toBe('Guns: the second drone');
    expect(s.prompt()?.text).toMatch(/GUN/);
    s.event({ type: 'kill', sourceId: pid, targetId: 12 } as SimEvent, pid);
    expect(go({ hostiles: [] })).toBe('Lesson complete');
    for (let i = 0; i < 3; i++) go({ hostiles: [] });
    expect(s.outcome()).toBe('success');
  });
});

describe('target drone in the World', () => {
  it('is flagged a drone, holds its orbit and height, and never fires', () => {
    const mission = resolveBuiltinMission('train-drone');
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const player = world.getPlayerEntityId();
    expect(player).not.toBe(NO_ENTITY_ID);
    // Find the drones: aircraft of team 1.
    const ids: number[] = [];
    for (let id = 0; id < 4096 && ids.length < 2; id++) {
      const s = world.getEntityState(id);
      if (s && s.kind === 'aircraft' && s.team === 1) ids.push(id);
    }
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(world.getEntityState(id)!.flags & EntityFlag.Drone).toBeTruthy();
    const startY = ids.map((id) => world.getEntityState(id)!.pos.y);
    const events: SimEvent[] = new Array(EVENT_QUEUE_CAPACITY);
    let launches = 0;
    // 60 s: the drones' orbit; the player's jet holds on (no input).
    for (let i = 0; i < 60 / SIM_DT_SEC; i++) {
      world.stepOnce();
      const n = world.drainEvents(events);
      for (let k = 0; k < n; k++) {
        const e = events[k]!;
        if ((e.type === 'missileLaunch' || e.type === 'gunFire') && ids.includes(e.shooterId)) launches++;
      }
    }
    expect(launches).toBe(0);
    ids.forEach((id, k) => {
      const s = world.getEntityState(id)!;
      expect(s.alive).toBe(true);
      expect(Math.abs(s.pos.y - startY[k]!)).toBeLessThan(400);
      const c = mission.aiFlights[k]!.patrolCenterWorld!;
      expect(Math.hypot(s.pos.x - c.x, s.pos.z - c.z)).toBeLessThan(9000);
    });
  });
});
