/**
 * src/ui/audio/ambience.ts — the sound of the jet, synthesised (no recorded sound):
 *
 * - in the cockpit, the air conditioning's steady rush (the loudest thing in a Tejas cockpit, its
 *   test pilots say), the F404 a quiet whine and rumble behind it, and the wind rising with the
 *   airspeed (more with the airbrake out or the gear down);
 * - outside (chase, external, fly-by), the engine's roar instead, louder with the afterburner;
 * - one-shots from the sim's events: the gun, a store's release thump, a missile's motor, chaff and
 *   flares, the gear's motor and its lock, touchdown, hits on you, and explosions near you (heard
 *   after the sound's travel time).
 *
 * `ambienceLevels` (pure, tested) maps the flight state to the loops' levels.
 */
import type { SimEvent, Vec3Like } from '../../contracts/core';
import { AudioChannel, type AudioBus } from './audioBus';

export interface AmbienceInputs {
  alive: boolean;
  /** Engine thrust, 0..1 of military; afterburner lit. */
  thrustFrac: number;
  afterburner: boolean;
  iasMps: number;
  /** Gear position 0 up .. 1 down. */
  gearPos: number;
  airbrake: boolean;
  /** Listening from the cockpit (else from outside the jet). */
  inCockpit: boolean;
}

export interface AmbienceLevels {
  aircon: number;
  whine: number;
  whineHz: number;
  rumble: number;
  rumbleHz: number;
  wind: number;
  windHz: number;
}

const SOUND_MPS = 340;
/** Explosions further than this are not heard. */
const HEAR_EXPLOSION_M = 6000;

export function ambienceLevels(inp: AmbienceInputs, rpm: number, out: AmbienceLevels): AmbienceLevels {
  if (!inp.alive) {
    out.aircon = out.whine = out.rumble = out.wind = 0;
    return out;
  }
  const q = Math.min(1, (inp.iasMps / 300) ** 2);
  const drag = 1 + (inp.airbrake ? 0.5 : 0) + inp.gearPos * 0.35;
  const ab = inp.afterburner ? 1 : 0;
  out.whineHz = 220 + 1100 * rpm;
  out.rumbleHz = 160 + 500 * rpm + 300 * ab;
  if (inp.inCockpit) {
    out.aircon = 0.05;
    out.whine = 0.012 + 0.02 * rpm;
    out.rumble = 0.03 * rpm + 0.05 * ab;
    out.wind = Math.min(0.16, 0.11 * q * drag);
  } else {
    out.aircon = 0;
    out.whine = 0.02 + 0.03 * rpm;
    out.rumble = 0.05 + 0.12 * rpm + 0.16 * ab;
    out.wind = Math.min(0.12, 0.07 * q * drag);
  }
  out.windHz = 350 + inp.iasMps * 4;
  return out;
}

export interface Ambience {
  update(inp: AmbienceInputs, dtSec: number): void;
  /** The sim's events (only the ones about you, or near you, sound). */
  event(ev: SimEvent, playerId: number, playerPos: Vec3Like): void;
  silence(): void;
}

interface Loop {
  gain: GainNode;
  filter: BiquadFilterNode;
  osc?: OscillatorNode;
}

export function createAmbience(bus: AudioBus): Ambience {
  let loops: { aircon: Loop; whine: Loop; rumble: Loop; wind: Loop; gun: Loop; gearMotor: Loop } | null = null;
  let rpm = 0;
  let gearWas = -1;
  let gunUntil = 0;
  let live = false;
  const lv: AmbienceLevels = { aircon: 0, whine: 0, whineHz: 0, rumble: 0, rumbleHz: 0, wind: 0, windHz: 0 };

  const build = (): typeof loops => {
    const ac = bus.context();
    const amb = bus.channel(AudioChannel.Ambience);
    const fx = bus.channel(AudioChannel.Effects);
    const noise = bus.noise();
    if (!ac || !amb || !fx || !noise) return null;
    const noiseLoop = (type: BiquadFilterType, hz: number, q: number, dest: AudioNode): Loop => {
      const src = ac.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      // Each loop starts at a different place in the buffer, so they never beat together.
      src.start(0, Math.random() * 1.9);
      const filter = ac.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = hz;
      filter.Q.value = q;
      const gain = ac.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(dest);
      return { gain, filter };
    };
    const oscLoop = (type: OscillatorType, hz: number, filterType: BiquadFilterType, fhz: number, q: number, dest: AudioNode): Loop => {
      const osc = ac.createOscillator();
      osc.type = type;
      osc.frequency.value = hz;
      osc.start();
      const filter = ac.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.value = fhz;
      filter.Q.value = q;
      const gain = ac.createGain();
      gain.gain.value = 0;
      osc.connect(filter).connect(gain).connect(dest);
      return { gain, filter, osc };
    };
    return {
      aircon: noiseLoop('highpass', 2200, 0.5, amb),
      whine: oscLoop('sawtooth', 400, 'bandpass', 1200, 6, amb),
      rumble: noiseLoop('lowpass', 300, 0.7, amb),
      wind: noiseLoop('bandpass', 800, 0.6, amb),
      // The GSh-23's buzz: ~57 shots a second.
      gun: oscLoop('square', 57, 'lowpass', 900, 1, fx),
      gearMotor: oscLoop('sawtooth', 110, 'lowpass', 500, 1, fx),
    };
  };

  /** A short burst: a falling tone under filtered noise. */
  const thump = (opts: { hz: number; toHz: number; sec: number; gain: number; noise?: number; noiseHz?: number; delaySec?: number }): void => {
    const ac = bus.context();
    const fx = bus.channel(AudioChannel.Effects);
    const noise = bus.noise();
    if (!ac || !fx || !noise) return;
    const t0 = ac.currentTime + 0.005 + (opts.delaySec ?? 0);
    const end = t0 + opts.sec;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(opts.hz, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.toHz), end);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(opts.gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g).connect(fx);
    osc.start(t0);
    osc.stop(end + 0.02);
    if (opts.noise) {
      const src = ac.createBufferSource();
      src.buffer = noise;
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.noiseHz ?? 1200;
      const ng = ac.createGain();
      ng.gain.setValueAtTime(0, t0);
      ng.gain.linearRampToValueAtTime(opts.noise, t0 + 0.01);
      ng.gain.exponentialRampToValueAtTime(0.0001, end);
      src.connect(f).connect(ng).connect(fx);
      src.start(t0, Math.random());
      src.stop(end + 0.02);
    }
  };

  const set = (p: AudioParam, v: number, tc = 0.08): void => {
    const ac = bus.context();
    if (ac) p.setTargetAtTime(v, ac.currentTime, tc);
  };

  return {
    update(inp, dt) {
      if (!loops) loops = build();
      if (!loops) return;
      const ac = bus.context()!;
      live = true;
      // The sim's thrust already lags the throttle (spool-up); this only smooths it.
      const target = inp.alive ? 0.25 + 0.75 * Math.min(1, inp.thrustFrac) : 0;
      rpm += (target - rpm) * Math.min(1, dt * 4);
      ambienceLevels(inp, rpm, lv);
      set(loops.aircon.gain.gain, lv.aircon, 0.3);
      set(loops.whine.gain.gain, lv.whine);
      set(loops.whine.osc!.frequency, lv.whineHz * 0.35);
      set(loops.whine.filter.frequency, lv.whineHz);
      set(loops.rumble.gain.gain, lv.rumble);
      set(loops.rumble.filter.frequency, lv.rumbleHz);
      set(loops.wind.gain.gain, lv.wind);
      set(loops.wind.filter.frequency, lv.windHz);
      set(loops.gun.gain.gain, inp.alive && ac.currentTime < gunUntil ? 0.22 : 0, 0.01);
      // The gear: its motor while it moves, a clunk as it locks.
      const moving = gearWas >= 0 && Math.abs(inp.gearPos - gearWas) > 1e-4;
      set(loops.gearMotor.gain.gain, moving && inp.alive ? 0.035 : 0, 0.05);
      if (gearWas >= 0 && gearWas > 0 && gearWas < 1 && (inp.gearPos <= 0 || inp.gearPos >= 1)) thump({ hz: 140, toHz: 60, sec: 0.18, gain: 0.25, noise: 0.15, noiseHz: 900 });
      gearWas = inp.gearPos;
    },
    event(ev, playerId, pos) {
      const ac = bus.context();
      if (!ac || !live) return;
      switch (ev.type) {
        case 'gunFire':
          if (ev.shooterId === playerId) gunUntil = ac.currentTime + 0.09;
          break;
        case 'missileLaunch':
          if (ev.shooterId !== playerId) break;
          // The ejector's thump; a missile's or rocket's motor roars past as it goes.
          thump({ hz: 110, toHz: 45, sec: 0.25, gain: 0.35, noise: 0.12, noiseHz: 700 });
          if (ev.weapon !== 'bomb' && ev.weapon !== 'guided_bomb') thump({ hz: 300, toHz: 120, sec: 1.1, gain: 0.04, noise: 0.25, noiseHz: 2500, delaySec: 0.05 });
          break;
        case 'countermeasure':
          if (ev.entityId === playerId) thump({ hz: 900, toHz: 300, sec: 0.06, gain: 0.08, noise: 0.18, noiseHz: 4000 });
          break;
        case 'touchdown':
          if (ev.entityId === playerId) thump({ hz: 90, toHz: 40, sec: 0.3, gain: Math.min(0.5, 0.12 + ev.vspeedMps * 0.08), noise: 0.2, noiseHz: 2000 });
          break;
        case 'hit':
          if (ev.targetId === playerId) thump({ hz: 160, toHz: 50, sec: 0.35, gain: 0.5, noise: 0.45, noiseHz: 3000 });
          break;
        case 'explosion': {
          const d = Math.hypot(ev.pos.x - pos.x, ev.pos.y - pos.y, ev.pos.z - pos.z);
          if (d > HEAR_EXPLOSION_M) break;
          const g = Math.min(0.6, 0.6 / (1 + d / 400)) * Math.min(1, 0.4 + ev.radiusM / 40);
          thump({ hz: 70, toHz: 25, sec: 1.2, gain: g, noise: g * 0.8, noiseHz: Math.max(250, 1500 - d * 0.25), delaySec: d / SOUND_MPS });
          break;
        }
        default:
          break;
      }
    },
    silence() {
      if (!loops) return;
      live = false;
      gunUntil = 0;
      gearWas = -1;
      for (const l of Object.values(loops)) set(l.gain.gain, 0, 0.05);
    },
  };
}
