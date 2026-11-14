/**
 * src/ui/audio/engineVoice.ts — one jet engine's sound, synthesised in Web Audio from
 * src/ui/audio/engineModel.ts's numbers:
 *
 * - the fan's whine (two sines, the tone and a faint octave, with a little jitter, as the blades
 *   never pass perfectly evenly), softened above 2.5 kHz;
 * - the buzz-saw: the fan shaft's harmonics, with uneven weights (no two blades are alike);
 * - the jet's roar: pink noise, its upper corner rising with the jet speed;
 * - the rumble: brown noise and low pink noise, roughened ~30 times a second (the uneven pressure
 *   of the core and the jet), with the lows lifted;
 * - the afterburner: a deeper roar and a crackle (sparse sharp pressure spikes);
 * - turbulence: the roar's level wanders a little, a few times a second, as a real jet's does.
 *
 * Two outputs, so each can be placed where it comes from (src/ui/audio/spatial.ts): the intake
 * (`front`: the whine and buzz-saw) and the nozzle (`rear`: the roar, rumble and afterburner).
 * Each goes through a low-pass (the canopy and helmet in the cockpit) first.
 */
import type { EngineVoiceParams } from './engineModel';
import { TargetParam } from './targetParam';

export interface EngineVoice {
  set(p: EngineVoiceParams): void;
  /** A thump: the afterburner lighting. */
  thump(gain: number): void;
  silence(): void;
}

/** Noise buffers shared by every engine (built once per context). */
export interface Buffers {
  pink: AudioBuffer;
  brown: AudioBuffer;
  crackle: AudioBuffer;
  wander: AudioBuffer;
}
const buffersFor = new WeakMap<BaseAudioContext, Buffers>();

function buildBuffers(ac: BaseAudioContext): Buffers {
  const sr = ac.sampleRate;
  const make = (sec: number, fill: (d: Float32Array) => void): AudioBuffer => {
    const b = ac.createBuffer(1, Math.floor(sr * sec), sr);
    fill(b.getChannelData(0));
    return b;
  };
  const normalise = (d: Float32Array): void => {
    let m = 0;
    for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]!));
    if (m > 0) for (let i = 0; i < d.length; i++) d[i] = d[i]! / m;
  };
  // Pink noise (Paul Kellet's filter).
  const pink = make(4, (d) => {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
    normalise(d);
  });
  // Brown noise (integrated white, leaky).
  const brown = make(4, (d) => {
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last;
    }
    normalise(d);
  });
  // Crackle: sparse, sharp, one-sided pressure spikes (~70 a second), each decaying in ~2 ms.
  const crackle = make(3, (d) => {
    const decay = Math.exp(-1 / (0.002 * sr));
    let env = 0;
    for (let i = 0; i < d.length; i++) {
      if (Math.random() < 70 / sr) env += Math.pow(Math.random(), 2) * (Math.random() < 0.8 ? 1 : -0.4);
      env *= decay;
      d[i] = env + (Math.random() * 2 - 1) * 0.05 * Math.abs(env);
    }
    normalise(d);
  });
  // Wander: a slow random walk (a few hertz), for the turbulence in the roar.
  const wander = make(6, (d) => {
    let v = 0, target = 0;
    const step = Math.floor(sr / 6);
    for (let i = 0; i < d.length; i++) {
      if (i % step === 0) target = Math.random() * 2 - 1;
      v += (target - v) * (6 / sr) * 4;
      d[i] = v;
    }
    normalise(d);
  });
  return { pink, brown, crackle, wander };
}

/** The shared noise buffers for a context (also src/ui/audio/heavyEngineVoice.ts's). */
export function engineNoiseBuffers(ac: BaseAudioContext): Buffers {
  let bufs = buffersFor.get(ac);
  if (!bufs) {
    bufs = buildBuffers(ac);
    buffersFor.set(ac, bufs);
  }
  return bufs;
}

export function createEngineVoice(ac: BaseAudioContext, outs: { front: AudioNode; rear: AudioNode }): EngineVoice {
  const bufs = engineNoiseBuffers(ac);
  const muffleFor = (dest: AudioNode): BiquadFilterNode => {
    const m = ac.createBiquadFilter();
    m.type = 'lowpass';
    m.frequency.value = 16000;
    m.Q.value = 0.5;
    m.connect(dest);
    return m;
  };
  const front = muffleFor(outs.front);
  const muffle = muffleFor(outs.rear);

  const gain = (to: AudioNode | AudioParam, v = 0): GainNode => {
    const g = ac.createGain();
    g.gain.value = v;
    if (to instanceof AudioParam) g.connect(to);
    else g.connect(to);
    return g;
  };
  const loop = (buf: AudioBuffer, rate = 1): AudioBufferSourceNode => {
    const s = ac.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(0, Math.random() * buf.duration);
    return s;
  };
  const filter = (type: BiquadFilterType, hz: number, q = 0.7): BiquadFilterNode => {
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    return f;
  };

  // Fan whine: the tone and a faint octave, each with a little frequency jitter, softened on top.
  const whineSoft = filter('lowpass', 2500, 0.5);
  whineSoft.connect(front);
  const whineOut = gain(whineSoft);
  const whine1 = ac.createOscillator();
  const whine2 = ac.createOscillator();
  const whine2Gain = gain(whineOut, 0.12);
  whine1.connect(whineOut);
  whine2.connect(whine2Gain);
  const jitter = loop(bufs.wander, 8);
  const jitter1 = ac.createGain();
  const jitter2 = ac.createGain();
  jitter.connect(jitter1).connect(whine1.frequency);
  jitter.connect(jitter2).connect(whine2.frequency);
  whine1.start();
  whine2.start();

  // Buzz-saw: the shaft's harmonics 1..40, uneven, through a band that favours the growl.
  const real = new Float32Array(41);
  const imag = new Float32Array(41);
  for (let k = 1; k <= 40; k++) imag[k] = (0.3 + 0.7 * Math.random()) / Math.sqrt(k);
  const buzzOsc = ac.createOscillator();
  buzzOsc.setPeriodicWave(ac.createPeriodicWave(real, imag));
  const buzzOut = gain(front);
  buzzOsc.connect(filter('bandpass', 1200, 0.4)).connect(buzzOut);
  buzzOsc.start();

  // Jet roar: pink noise; its level wanders with the turbulence.
  const jetLp = filter('lowpass', 2000, 0.5);
  const jetOut = gain(muffle);
  loop(bufs.pink).connect(filter('highpass', 35)).connect(jetLp).connect(jetOut);
  const wander = loop(bufs.wander, 1);
  const jetWander = gain(jetOut.gain);
  wander.connect(jetWander);

  // Rumble: brown noise and low pink noise, lows lifted, roughened by a fast wander on its level.
  const rumbleShelf = filter('lowshelf', 120);
  rumbleShelf.gain.value = 6;
  rumbleShelf.connect(muffle);
  const rumbleOut = gain(rumbleShelf);
  loop(bufs.brown).connect(filter('lowpass', 160)).connect(rumbleOut);
  loop(bufs.pink, 0.6).connect(filter('lowpass', 260)).connect(gain(rumbleOut, 0.5));
  const rough = loop(bufs.wander, 5);
  const rumbleRough = gain(rumbleOut.gain);
  rough.connect(rumbleRough);

  // Afterburner: a deep roar (brown + low pink) and the crackle.
  const abOut = gain(muffle);
  loop(bufs.brown, 0.8).connect(filter('lowpass', 400)).connect(abOut);
  loop(bufs.pink, 0.7).connect(filter('lowpass', 900)).connect(gain(abOut, 0.6));
  const abWander = gain(abOut.gain);
  wander.connect(abWander);
  const crackleOut = gain(muffle);
  loop(bufs.crackle).connect(filter('highpass', 700)).connect(crackleOut);

  const t = (): number => ac.currentTime;
  // Only real changes are sent (src/ui/audio/targetParam.ts): steady flight costs no calls. The
  // margins (0.05% of a frequency, 0.1% of a level) are far below hearing.
  const hz = (p: AudioParam): TargetParam => new TargetParam(p, 1e-3, 5e-4);
  const lvl = (p: AudioParam): TargetParam => new TargetParam(p, 1e-6, 1e-3);
  const w1Hz = hz(whine1.frequency), w2Hz = hz(whine2.frequency), j1 = lvl(jitter1.gain), j2 = lvl(jitter2.gain);
  const whineG = lvl(whineOut.gain), buzzHz = hz(buzzOsc.frequency), buzzG = lvl(buzzOut.gain);
  const jetHz = hz(jetLp.frequency), jetG = lvl(jetOut.gain), jetW = lvl(jetWander.gain);
  const rumbleG = lvl(rumbleOut.gain), rumbleR = lvl(rumbleRough.gain);
  const abG = lvl(abOut.gain), abW = lvl(abWander.gain), crackleG = lvl(crackleOut.gain);
  const muffleHz = hz(muffle.frequency), frontHz = hz(front.frequency);
  const gains = [whineG, buzzG, jetG, rumbleG, abG, crackleG, jetW, abW, rumbleR];

  return {
    set(p) {
      const now = t();
      w1Hz.to(p.whineHz, now, 0.05);
      w2Hz.to(p.whineHz * 2, now, 0.05);
      j1.to(p.whineHz * 0.004, now, 0.1);
      j2.to(p.whineHz * 0.008, now, 0.1);
      whineG.to(p.whine, now, 0.05);
      buzzHz.to(Math.max(1, p.shaftHz), now, 0.05);
      buzzG.to(p.buzz, now, 0.05);
      jetHz.to(p.jetHz, now, 0.05);
      jetG.to(p.jet, now, 0.05);
      jetW.to(p.jet * 0.25, now, 0.2);
      rumbleG.to(p.rumble, now, 0.05);
      rumbleR.to(p.rumble * 0.5, now, 0.2);
      abG.to(p.ab, now, 0.08);
      abW.to(p.ab * 0.3, now, 0.2);
      crackleG.to(p.crackle, now, 0.08);
      muffleHz.to(p.muffleHz, now, 0.1);
      frontHz.to(p.muffleHz, now, 0.1);
    },
    thump(g) {
      const t0 = t() + 0.005;
      const osc = ac.createOscillator();
      osc.frequency.setValueAtTime(70, t0);
      osc.frequency.exponentialRampToValueAtTime(30, t0 + 0.35);
      const env = ac.createGain();
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(g, t0 + 0.015);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
      osc.connect(env).connect(muffle);
      osc.start(t0);
      osc.stop(t0 + 0.45);
    },
    silence() {
      const now = t();
      for (const g of gains) g.to(0, now, 0.05);
    },
  };
}
