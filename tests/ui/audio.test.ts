/**
 * tests/ui/audio.test.ts — the sound's logic (no Web Audio here): the RWR's tones from one picture
 * to the next, what the voice warnings say and when, the voice queue's order and cut-offs, the
 * air conditioning and wind, and the engine's RPM and sound levels.
 */
import { describe, expect, it } from 'vitest';
import { AutopilotFlag, WarningBit } from '../../src/contracts/core';
import { createRwrToneState, FORGET_SEC, LOCK_TONE_SEC, stepRwrTones, type RwrEmitter, type RwrToneCommand } from '../../src/ui/audio/rwrTones';
import { BINGO_FRAC, createVoiceWarningState, REARM_SEC, stepVoiceWarnings, VOICE_LINES, type VoiceInputs, type VoiceLineDef } from '../../src/ui/audio/voiceWarnings';
import { STALE_SEC, VoiceQueue } from '../../src/ui/audio/voicePlayer';
import { ambienceLevels, type AmbienceInputs, type AmbienceLevels } from '../../src/ui/audio/ambience';
import { createEngineSoundState, engineVoiceParams, FAN_BLADES, FAN_SHAFT_HZ, IDLE_N2, n2ForThrottle, stepEngineSound, type EngineSoundInputs, type EngineSoundState, type EngineVoiceParams } from '../../src/ui/audio/engineModel';

const SAM = 3; // LY-80
const FIGHTER = 7; // JF-17

describe('RWR tones', () => {
  const cmd = (): RwrToneCommand => ({ newRadar: false, newAircraft: false, lock: false, launch: false });
  const step = (st: ReturnType<typeof createRwrToneState>, e: RwrEmitter[], t: number) => ({ ...stepRwrTones(st, e, t, cmd()) });

  it('a new ground radar: the single tone; a new aircraft: the waterfall; once each', () => {
    const st = createRwrToneState();
    expect(step(st, [{ symbol: SAM, bearingRad: 1, state: 0 }], 0)).toMatchObject({ newRadar: true, newAircraft: false });
    expect(step(st, [{ symbol: SAM, bearingRad: 1.05, state: 0 }], 0.1)).toMatchObject({ newRadar: false });
    expect(step(st, [{ symbol: SAM, bearingRad: 1, state: 0 }, { symbol: FIGHTER, bearingRad: -2, state: 0 }], 0.2)).toMatchObject({ newRadar: false, newAircraft: true });
    // A second radar of the same kind somewhere else is new.
    expect(step(st, [{ symbol: SAM, bearingRad: 1, state: 0 }, { symbol: SAM, bearingRad: 2.5, state: 0 }], 0.3)).toMatchObject({ newRadar: true });
  });

  it('a lock: the slow warble for a while; a missile guided at you: the fast warble while it lasts', () => {
    const st = createRwrToneState();
    step(st, [{ symbol: FIGHTER, bearingRad: 0, state: 0 }], 0);
    expect(step(st, [{ symbol: FIGHTER, bearingRad: 0, state: 1 }], 1)).toMatchObject({ lock: true, launch: false });
    expect(step(st, [{ symbol: FIGHTER, bearingRad: 0, state: 1 }], 1 + LOCK_TONE_SEC + 0.1)).toMatchObject({ lock: false });
    expect(step(st, [{ symbol: FIGHTER, bearingRad: 0, state: 2 }], 5)).toMatchObject({ launch: true, lock: false });
    expect(step(st, [{ symbol: FIGHTER, bearingRad: 0, state: 2 }], 20)).toMatchObject({ launch: true });
    expect(step(st, [{ symbol: FIGHTER, bearingRad: 0, state: 1 }], 21)).toMatchObject({ launch: false });
  });

  it('an emitter gone for a while is new again when it comes back', () => {
    const st = createRwrToneState();
    step(st, [{ symbol: SAM, bearingRad: 0, state: 0 }], 0);
    step(st, [], 1);
    expect(step(st, [{ symbol: SAM, bearingRad: 0, state: 0 }], 2)).toMatchObject({ newRadar: false });
    step(st, [], 3);
    expect(step(st, [{ symbol: SAM, bearingRad: 0, state: 0 }], 3 + FORGET_SEC + 0.5)).toMatchObject({ newRadar: true });
  });
});

describe('voice warnings', () => {
  const base: VoiceInputs = { warningBits: 0, apFlags: 0, chaff: 30, flares: 30, fuelKg: 2400, alive: true };
  const run = () => {
    const st = createVoiceWarningState();
    const out: VoiceLineDef[] = [];
    return (inp: Partial<VoiceInputs>, t: number): string[] => stepVoiceWarnings(st, { ...base, ...inp }, t, out).map((l) => l.id);
  };

  it('says a warning once when it comes on, most urgent first', () => {
    const say = run();
    expect(say({}, 0)).toEqual([]);
    expect(say({ warningBits: WarningBit.OverG | WarningBit.TerrainPullUp }, 1)).toEqual(['pull_up', 'over_g']);
    expect(say({ warningBits: WarningBit.OverG | WarningBit.TerrainPullUp }, 1.5)).toEqual([]);
  });

  it('repeats PULL UP and MISSILE LAUNCH while they last', () => {
    const say = run();
    const bits = WarningBit.TerrainPullUp | WarningBit.MissileLaunch;
    const said: string[] = [];
    for (let t = 0; t <= 6; t = Math.round((t + 0.05) * 100) / 100) said.push(...say({ warningBits: bits }, t));
    expect(said.filter((x) => x === 'pull_up').length).toBe(5); // 0, 1.4, 2.8, 4.2, 5.6
    expect(said.filter((x) => x === 'missile_launch').length).toBe(3); // 0, 3, 6
  });

  it('a warning that flickers is not said again until it has been clear a while', () => {
    const say = run();
    expect(say({ warningBits: WarningBit.Overspeed }, 0)).toEqual(['overspeed']);
    say({}, 0.5);
    expect(say({ warningBits: WarningBit.Overspeed }, 1)).toEqual([]);
    say({}, 2);
    expect(say({ warningBits: WarningBit.Overspeed }, 2 + REARM_SEC)).toEqual(['overspeed']);
  });

  it('chaff and flares: low at a quarter, out at none; a rearm starts again', () => {
    const say = run();
    say({}, 0);
    expect(say({ chaff: 8 }, 1)).toEqual([]);
    expect(say({ chaff: 7 }, 2)).toEqual(['chaff_low']);
    expect(say({ chaff: 1, flares: 0 }, 3)).toEqual(['flare_out']);
    expect(say({ chaff: 0, flares: 0 }, 4)).toEqual(['chaff_out']);
    say({ chaff: 30, flares: 30 }, 5);
    expect(say({ chaff: 7, flares: 30 }, 6)).toEqual(['chaff_low']);
  });

  it('bingo at a fraction of the fullest tanks; not over FUEL LOW', () => {
    const say = run();
    say({}, 0);
    expect(say({ fuelKg: 2400 * BINGO_FRAC + 10 }, 1)).toEqual([]);
    expect(say({ fuelKg: 2400 * BINGO_FRAC - 10 }, 2)).toEqual(['bingo']);
    expect(say({ fuelKg: 2400 * BINGO_FRAC - 20 }, 3)).toEqual([]);
    expect(say({ fuelKg: 200, warningBits: WarningBit.LowFuel }, 4)).toEqual(['fuel_low']);
  });

  it('autopilot disengaged on the disconnect flash; nothing while dead', () => {
    const say = run();
    say({}, 0);
    expect(say({ apFlags: AutopilotFlag.ApOffFlash }, 1)).toEqual(['autopilot_off']);
    expect(say({ warningBits: WarningBit.TerrainPullUp, alive: false }, 2)).toEqual([]);
  });
});

describe('voice queue', () => {
  it('says the most urgent first; does not queue a line twice; drops stale lines', () => {
    const q = new VoiceQueue();
    q.push(VOICE_LINES.fuelLow, 0, null);
    q.push(VOICE_LINES.overG, 0, null);
    q.push(VOICE_LINES.overG, 0.1, null);
    expect(q.pending.length).toBe(2);
    expect(q.next(0.2)?.id).toBe('over_g');
    expect(q.next(STALE_SEC + 1)).toBeNull();
  });

  it('PULL UP cuts off a less urgent line; a less urgent line never cuts off', () => {
    const q = new VoiceQueue();
    expect(q.push(VOICE_LINES.pullUp, 0, VOICE_LINES.fuelLow)).toBe(true);
    expect(q.push(VOICE_LINES.overG, 0, VOICE_LINES.fuelLow)).toBe(false);
    expect(q.push(VOICE_LINES.missileLaunch, 0, VOICE_LINES.pullUp)).toBe(false);
    // The line already being said is not queued again.
    expect(q.push(VOICE_LINES.pullUp, 0, VOICE_LINES.pullUp)).toBe(false);
  });
});

describe('air conditioning and wind', () => {
  const lv = (): AmbienceLevels => ({ aircon: 0, wind: 0, windHz: 0 });
  const inp = (o: Partial<AmbienceInputs> = {}): AmbienceInputs => ({ alive: true, throttle: 0.5, afterburner: false, fuelKg: 1000, iasMps: 200, gearPos: 0, airbrake: false, inCockpit: true, ...o });

  it('the air conditioning only in the cockpit; wind rises with airspeed and the airbrake; silent when dead', () => {
    expect(ambienceLevels(inp(), lv()).aircon).toBeGreaterThan(0);
    expect(ambienceLevels(inp({ inCockpit: false }), lv()).aircon).toBe(0);
    expect(ambienceLevels(inp({ iasMps: 250 }), lv()).wind).toBeGreaterThan(ambienceLevels(inp({ iasMps: 100 }), lv()).wind);
    expect(ambienceLevels(inp({ airbrake: true }), lv()).wind).toBeGreaterThan(ambienceLevels(inp(), lv()).wind);
    const d = ambienceLevels(inp({ alive: false }), lv());
    expect(d.aircon + d.wind).toBe(0);
  });
});

describe('engine model', () => {
  const run = (inputs: Partial<EngineSoundInputs>, sec: number, st = createEngineSoundState()) => {
    const ev = { abLit: false, abOut: false };
    let lit = 0, out = 0;
    for (let t = 0; t < sec; t += 1 / 60) {
      stepEngineSound(st, { throttle: 0, afterburner: false, running: true, iasMps: 0, ...inputs }, 1 / 60, ev);
      if (ev.abLit) lit++;
      if (ev.abOut) out++;
    }
    return { st, lit, out };
  };
  const params = (st: EngineSoundState, ear: 'cockpit' | 'outside' = 'outside'): EngineVoiceParams =>
    engineVoiceParams(st, ear, { whineHz: 0, whine: 0, shaftHz: 0, buzz: 0, jet: 0, jetHz: 0, rumble: 0, ab: 0, crackle: 0, muffleHz: 0 });

  it('RPM: idle at zero throttle, 100% at full, climbing steeply off idle (half thrust ~90%)', () => {
    expect(n2ForThrottle(0)).toBe(IDLE_N2);
    expect(n2ForThrottle(1)).toBe(1);
    expect(n2ForThrottle(0.5)).toBeGreaterThan(0.88);
    expect(n2ForThrottle(0.5)).toBeLessThan(0.93);
  });

  it('the fan whine rises in pitch with RPM (a few kHz, as a jet on the ramp screams)', () => {
    const idle = params(run({ throttle: 0 }, 2).st);
    const mil = params(run({ throttle: 1 }, 2).st);
    expect(idle.whineHz).toBeGreaterThan(1800);
    expect(mil.whineHz).toBeGreaterThan(idle.whineHz * 1.5);
    expect(mil.whineHz).toBe(FAN_SHAFT_HZ * FAN_BLADES);
  });

  it('the jet roar rises steeply with power; the buzz-saw only near full power; the reheat roar only lit', () => {
    const idle = params(run({ throttle: 0 }, 2).st);
    const mid = params(run({ throttle: 0.3 }, 2).st);
    const mil = params(run({ throttle: 1 }, 2).st);
    const ab = params(run({ throttle: 1, afterburner: true }, 2).st);
    expect(mil.jet).toBeGreaterThan(idle.jet * 5);
    expect(idle.buzz).toBe(0);
    expect(mid.buzz).toBe(0);
    expect(mil.buzz).toBeGreaterThan(0);
    expect(mil.ab).toBe(0);
    expect(ab.ab).toBeGreaterThan(0);
    expect(ab.jet).toBeGreaterThan(mil.jet);
  });

  it('the afterburner lights over a moment (one thump) and goes out', () => {
    const { st, lit } = run({ throttle: 1, afterburner: true }, 0.3);
    expect(lit).toBe(1);
    expect(st.ab).toBeGreaterThan(0.3);
    expect(st.ab).toBeLessThan(0.7);
    expect(run({ throttle: 1 }, 1, st).out).toBe(1);
  });

  it('out of fuel it runs down to a windmill over seconds, not at once', () => {
    const { st } = run({ throttle: 1 }, 2);
    run({ throttle: 1, running: false, iasMps: 200 }, 1, st);
    expect(st.n2).toBeGreaterThan(0.6);
    run({ throttle: 1, running: false, iasMps: 200 }, 20, st);
    expect(st.n2).toBeLessThan(0.3);
  });

  it('muffled and quieter in the cockpit', () => {
    const { st } = run({ throttle: 1 }, 2);
    const c = params(st, 'cockpit'), o = params(st, 'outside');
    expect(c.muffleHz).toBeLessThan(o.muffleHz);
    expect(c.jet).toBeLessThan(o.jet);
  });
});
