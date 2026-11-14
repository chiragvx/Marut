/**
 * tests/ui/heavyEngineSound.test.ts — the multi-engine (C-17) engine sound's numbers
 * (src/ui/audio/heavyEngineModel.ts): the profile from the aircraft's data, N1 to each engine's
 * frequencies and levels, an engine out falling silent, the reverser's roar, the cockpit's
 * muffling, directivity, the louder/further distance law, and the param de-duplication
 * (src/ui/audio/targetParam.ts) that keeps the main thread's audio cost down.
 */
import { describe, expect, it } from 'vitest';
import { c17Definition } from '../../src/aircraft/c17Definition';
import { tejasDefinition } from '../../src/aircraft/tejasDefinition';
import {
  createHeavyEngineStates,
  createHeavyVoiceParams,
  ENGINE_DETUNE,
  FAN_TIP_MPS,
  heavyEngineParams,
  heavyEngineProfile,
  hearDistanceM,
  loudRefM,
  MAX_HEAR_M,
  stepHeavyEngine,
  type HeavyEngineProfile,
  type HeavyEngineState,
  type HeavyVoiceParams,
} from '../../src/ui/audio/heavyEngineModel';
import { createEngineSoundState, engineVoiceParams, stepEngineSound, type EngineVoiceParams } from '../../src/ui/audio/engineModel';
import { distanceGain, HEAR_ENGINE_M } from '../../src/ui/audio/spatial';
import { TargetParam } from '../../src/ui/audio/targetParam';

const prof = heavyEngineProfile(c17Definition)!;
const GROUND_IDLE_N1 = Math.sqrt(0.035);
const WINDMILL_N1 = 0.08;

const state = (n1: number, rev = 0): HeavyEngineState => ({ n1, rev, accel: 0, initialised: true });
const params = (i: number, n1: number, opts: { rev?: number; ear?: 'cockpit' | 'outside'; aspect?: number; p?: HeavyEngineProfile } = {}): HeavyVoiceParams =>
  heavyEngineParams(opts.p ?? prof, i, state(n1, opts.rev ?? 0), opts.ear ?? 'outside', opts.aspect ?? 0, createHeavyVoiceParams());
/** A rough loudness: the broadband parts, incoherent sum. */
const energy = (p: HeavyVoiceParams): number => p.jet ** 2 + p.rumble ** 2 + p.reverse ** 2 + p.whine ** 2 + p.buzz ** 2;

describe('heavy engine profile (from the aircraft data)', () => {
  it('the C-17: four engines at their nacelles, a big slow fan', () => {
    expect(prof).not.toBeNull();
    expect(prof.count).toBe(4);
    expect(prof.positions.map((p) => p.z)).toEqual(c17Definition.engines!.map((e) => e.posBodyM.z));
    // 78.5 in fan at ~430 m/s tip speed: ~69 Hz shaft (~4,100 rpm), 36 blades -> ~2.5 kHz blade-pass at 100% N1.
    expect(prof.shaftHz).toBeCloseTo(FAN_TIP_MPS / (Math.PI * 1.994), 6);
    expect(prof.shaftHz).toBeGreaterThan(60);
    expect(prof.shaftHz).toBeLessThan(80);
    expect(prof.blades).toBe(36);
    expect(prof.idleN1).toBeCloseTo(Math.sqrt(0.07), 6);
    // ~180 kN each.
    expect(prof.totalThrustN).toBeGreaterThan(650_000);
  });

  it('a single-engine fighter has none (it keeps engineModel.ts)', () => {
    expect(heavyEngineProfile(tejasDefinition)).toBeNull();
  });

  it('without explicit fan data, the diameter comes from the reverser fan area', () => {
    const { sound: _sound, ...engine } = c17Definition.engine;
    void _sound;
    const p = heavyEngineProfile({ ...c17Definition, engine })!;
    expect(p.shaftHz).toBeCloseTo(FAN_TIP_MPS / (Math.PI * Math.sqrt((4 * 3.12) / Math.PI)), 6);
    expect(p.blades).toBe(24);
  });

  it('every engine is detuned a little from the others (they beat)', () => {
    expect(new Set(prof.detune).size).toBe(4);
    for (const d of prof.detune) expect(Math.abs(d - 1)).toBeLessThan(0.005);
    expect(prof.detune[0]).toBe(1 + ENGINE_DETUNE[0]!);
  });
});

describe('heavy engine voice: N1 to frequencies and levels', () => {
  it('the whine is the blade-pass frequency, the buzz-saw the shaft, both following N1 per engine', () => {
    for (let i = 0; i < 4; i++) {
      const p = params(i, 0.9);
      expect(p.shaftHz).toBeCloseTo(prof.shaftHz * 0.9 * prof.detune[i]!, 6);
      expect(p.whineHz).toBeCloseTo(p.shaftHz * 36, 6);
    }
    expect(params(0, 1).whineHz).toBeGreaterThan(2000);
    expect(params(0, GROUND_IDLE_N1).whineHz).toBeLessThan(600);
    // At the same N1 the engines' tones differ by a few hertz: the beat.
    const beat = Math.abs(params(0, 0.9).whineHz - params(1, 0.9).whineHz);
    expect(beat).toBeGreaterThan(1);
    expect(beat).toBeLessThan(30);
  });

  it('idle to take-off power: the roar and rumble rise steeply, the buzz-saw comes in near full power', () => {
    const idle = params(0, GROUND_IDLE_N1);
    const mid = params(0, 0.7);
    const to = params(0, 1);
    expect(to.jet).toBeGreaterThan(8 * idle.jet);
    expect(mid.jet).toBeGreaterThan(idle.jet);
    expect(to.jet).toBeGreaterThan(mid.jet);
    expect(to.rumble).toBeGreaterThan(2 * idle.rumble);
    expect(to.jetHz).toBeGreaterThan(idle.jetHz);
    expect(idle.buzz).toBe(0);
    expect(mid.buzz).toBe(0);
    expect(to.buzz).toBeGreaterThan(0);
    // Idling, it is still clearly heard.
    expect(idle.rumble).toBeGreaterThan(0.05);
  });

  it('an engine out (windmilling) is silent; the others are not', () => {
    const dead = params(0, WINDMILL_N1);
    expect(dead.whine).toBe(0);
    expect(dead.buzz).toBe(0);
    expect(dead.jet).toBe(0);
    expect(dead.rumble).toBe(0);
    expect(dead.reverse).toBe(0);
    expect(params(0, 0).jet).toBe(0);
    expect(params(1, 1).jet).toBeGreaterThan(0.1);
    // Even with its reverser deployed.
    expect(params(0, WINDMILL_N1, { rev: 1 }).reverse).toBe(0);
  });

  it('the reversers roar when deployed, loudest at reverse power', () => {
    expect(params(0, 1).reverse).toBe(0);
    const revIdle = params(0, GROUND_IDLE_N1, { rev: 1 });
    const revFull = params(0, 1, { rev: 1 });
    expect(revIdle.reverse).toBeGreaterThan(0);
    expect(revFull.reverse).toBeGreaterThan(3 * revIdle.reverse);
    expect(energy(revFull)).toBeGreaterThan(energy(params(0, 1)));
    // Half deployed: half the roar.
    expect(params(0, 1, { rev: 0.5 }).reverse).toBeCloseTo(revFull.reverse / 2, 6);
  });

  it('cockpit: muffled, the whine faint, a strong low rumble', () => {
    const inside = params(0, 1, { ear: 'cockpit' });
    const outside = params(0, 1);
    expect(inside.muffleHz).toBeLessThan(1000);
    expect(outside.muffleHz).toBeGreaterThan(10000);
    expect(inside.rumble).toBeGreaterThan(inside.jet);
    expect(inside.rumble).toBeGreaterThan(10 * inside.whine);
    expect(inside.whine).toBeLessThan(outside.whine);
    // Stronger than a fighter's in its cockpit (four big engines).
    const fs = createEngineSoundState();
    stepEngineSound(fs, { throttle: 1, afterburner: false, running: true, iasMps: 0 }, 0, { abLit: false, abOut: false });
    const fighter = engineVoiceParams(fs, 'cockpit', {} as EngineVoiceParams);
    expect(4 * inside.rumble ** 2).toBeGreaterThan(fighter.rumble ** 2);
    // Aspect means nothing in the cockpit.
    expect(params(0, 1, { ear: 'cockpit', aspect: 1 })).toEqual(inside);
  });

  it('outside: the whine and buzz-saw radiate forward, the roar aft', () => {
    const ahead = params(0, 1, { aspect: 1 });
    const behind = params(0, 1, { aspect: -1 });
    expect(ahead.whine).toBeGreaterThan(1.5 * behind.whine);
    expect(ahead.buzz).toBeGreaterThan(1.5 * behind.buzz);
    expect(behind.jet).toBeGreaterThan(1.5 * ahead.jet);
  });

  it('four engines at take-off power are much louder than a fighter at military power', () => {
    const fs = createEngineSoundState();
    stepEngineSound(fs, { throttle: 1, afterburner: false, running: true, iasMps: 0 }, 0, { abLit: false, abOut: false });
    const f = engineVoiceParams(fs, 'outside', {} as EngineVoiceParams);
    const fighter = f.jet ** 2 + f.rumble ** 2 + f.whine ** 2 + f.buzz ** 2;
    let heavy = 0;
    for (let i = 0; i < 4; i++) heavy += energy(params(i, 1));
    // More than +3 dB at the source, before the distance law's own boost.
    expect(heavy).toBeGreaterThan(2 * fighter);
  });
});

describe('heavy engine state', () => {
  it('follows the snapshot N1 smoothly (6-bit steps do not jump) and spools nothing itself', () => {
    const [st] = createHeavyEngineStates(1) as [HeavyEngineState];
    stepHeavyEngine(st, 0.19, 0, true, 0.033);
    expect(st.n1).toBeCloseTo(0.19, 6);
    stepHeavyEngine(st, 0.19 + 1 / 63, 0, true, 0.033);
    expect(st.n1).toBeGreaterThan(0.19);
    expect(st.n1).toBeLessThan(0.19 + 1 / 63);
    for (let k = 0; k < 90; k++) stepHeavyEngine(st, 1, 0, true, 0.033);
    expect(st.n1).toBeGreaterThan(0.99);
    expect(st.accel).toBeGreaterThanOrEqual(0);
  });

  it('the reverser position is followed; a destroyed aircraft winds down to silence', () => {
    const [st] = createHeavyEngineStates(1) as [HeavyEngineState];
    stepHeavyEngine(st, 1, 0, true, 0.033);
    for (let k = 0; k < 60; k++) stepHeavyEngine(st, 1, 1, true, 0.033);
    expect(st.rev).toBeGreaterThan(0.95);
    for (let k = 0; k < 600; k++) stepHeavyEngine(st, 1, 1, false, 0.033);
    expect(params(0, st.n1).jet).toBe(0);
  });
});

describe('heavy engine distance law', () => {
  it('scales with the total thrust: heard further, louder at every distance', () => {
    expect(hearDistanceM(85_000)).toBe(HEAR_ENGINE_M);
    expect(hearDistanceM(10_000)).toBe(HEAR_ENGINE_M);
    expect(loudRefM(85_000)).toBe(20);
    expect(prof.hearM).toBeGreaterThan(10_000);
    expect(prof.hearM).toBeLessThanOrEqual(MAX_HEAR_M);
    expect(prof.refM).toBeGreaterThan(40);
    expect(prof.refM).toBeLessThanOrEqual(60);
    for (const d of [100, 1000, 4000]) expect(distanceGain(d, prof.hearM, prof.refM)).toBeGreaterThan(1.9 * distanceGain(d));
    // A fighter is gone at 7 km; the C-17 still rumbles at 10 km, gone beyond its range.
    expect(distanceGain(7000)).toBe(0);
    expect(distanceGain(10_000, prof.hearM, prof.refM)).toBeGreaterThan(0.005);
    expect(distanceGain(prof.hearM * 1.3 + 1, prof.hearM, prof.refM)).toBe(0);
  });

  it('the fighter default is unchanged', () => {
    const old = (d: number): number => {
      if (d <= 20) return 1;
      const u = Math.min(1, Math.max(0, (d - HEAR_ENGINE_M) / 1500));
      return Math.pow(20 / d, 0.75) * (1 - u * u * (3 - 2 * u));
    };
    for (const d of [5, 20, 100, 1000, 4999, 5500, 6400, 9000]) expect(distanceGain(d)).toBeCloseTo(old(d), 12);
  });
});

describe('TargetParam (fewer setTargetAtTime calls)', () => {
  it('sends the first value and real changes only', () => {
    const calls: number[] = [];
    const tp = new TargetParam({ setTargetAtTime: (v: number) => calls.push(v) }, 0.01, 0.01);
    expect(tp.to(100, 0, 0.1)).toBe(true);
    expect(tp.to(100.5, 0, 0.1)).toBe(false); // within 0.01 + 1%
    expect(tp.to(103, 0, 0.1)).toBe(true);
    expect(tp.to(103, 0, 0.1)).toBe(false);
    tp.reset();
    expect(tp.to(103, 0, 0.1)).toBe(true);
    expect(calls).toEqual([100, 103, 103]);
  });

  it('a steady heavy engine costs no calls after the first update', () => {
    let n = 0;
    const sink = { setTargetAtTime: () => n++ };
    const slots = Array.from({ length: 7 }, () => new TargetParam(sink, 1e-5, 2e-3));
    const p = createHeavyVoiceParams();
    for (let k = 0; k < 30; k++) {
      heavyEngineParams(prof, 0, state(0.6), 'outside', 0.3, p);
      [p.whineHz, p.whine, p.buzz, p.jet, p.jetHz, p.rumble, p.reverse].forEach((v, j) => slots[j]!.to(v, 0, 0.08));
    }
    expect(n).toBe(7);
  });
});
