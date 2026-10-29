/**
 * src/ui/audio/engineVoice.ts — one jet engine's sound, synthesised in Web Audio from
 * src/ui/audio/engineModel.ts's numbers:
 *
 * - the fan's blade-pass whine (two sines, the fundamental and its second harmonic, with a little
 *   jitter, as the blades never pass perfectly evenly);
 * - the buzz-saw: the fan shaft's harmonics, with uneven weights (no two blades are alike);
 * - the jet's roar: pink noise, its upper corner rising with the jet speed;
 * - the core rumble: brown noise;
 * - the afterburner: a deeper roar and a crackle (sparse sharp pressure spikes);
 * - turbulence: the roar's level wanders a little, a few times a second, as a real jet's does.
 *
 * Everything goes through one low-pass (the canopy and helmet in the cockpit) into `dest`.
 */
import type { EngineVoiceParams } from './engineModel';

export interface EngineVoice {
  set(p: EngineVoiceParams): void;
  /** A thump: the afterburner lighting. */
  thump(gain: number): void;
  silence(): void;
}

/** Noise buffers shared by every engine (built once per context). */
interface Buffers {
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

export function createEngineVoice(ac: AudioContext, dest: AudioNode): EngineVoice {
  let bufs = buffersFor.get(ac);
  if (!bufs) {
    bufs = buildBuffers(ac);
    buffersFor.set(ac, bufs);
  }
  const muffle = ac.createBiquadFilter();
  muffle.type = 'lowpass';
  muffle.frequency.value = 16000;
  muffle.Q.value = 0.5;
  muffle.connect(dest);

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

  // Fan whine: fundamental and second harmonic, each with a little frequency jitter.
  const whineOut = gain(muffle);
  const whine1 = ac.createOscillator();
  const whine2 = ac.createOscillator();
  const whine2Gain = gain(whineOut, 0.35);
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
  const buzzOut = gain(muffle);
  buzzOsc.connect(filter('bandpass', 1200, 0.4)).connect(buzzOut);
  buzzOsc.start();

  // Jet roar: pink noise; its level wanders with the turbulence.
  const jetLp = filter('lowpass', 2000, 0.5);
  const jetOut = gain(muffle);
  loop(bufs.pink).connect(filter('highpass', 35)).connect(jetLp).connect(jetOut);
  const wander = loop(bufs.wander, 1);
  const jetWander = gain(jetOut.gain);
  wander.connect(jetWander);

  // Core rumble.
  const rumbleOut = gain(muffle);
  loop(bufs.brown).connect(filter('lowpass', 180)).connect(rumbleOut);

  // Afterburner: a deep roar (brown + low pink) and the crackle.
  const abOut = gain(muffle);
  loop(bufs.brown, 0.8).connect(filter('lowpass', 400)).connect(abOut);
  loop(bufs.pink, 0.7).connect(filter('lowpass', 900)).connect(gain(abOut, 0.6));
  const abWander = gain(abOut.gain);
  wander.connect(abWander);
  const crackleOut = gain(muffle);
  loop(bufs.crackle).connect(filter('highpass', 700)).connect(crackleOut);

  const t = (): number => ac.currentTime;
  const to = (p: AudioParam, v: number, tc = 0.05): void => {
    p.setTargetAtTime(v, t(), tc);
  };

  return {
    set(p) {
      to(whine1.frequency, p.whineHz);
      to(whine2.frequency, p.whineHz * 2);
      jitter1.gain.setTargetAtTime(p.whineHz * 0.004, t(), 0.1);
      jitter2.gain.setTargetAtTime(p.whineHz * 0.008, t(), 0.1);
      to(whineOut.gain, p.whine);
      to(buzzOsc.frequency, Math.max(1, p.shaftHz));
      to(buzzOut.gain, p.buzz);
      to(jetLp.frequency, p.jetHz);
      to(jetOut.gain, p.jet);
      to(jetWander.gain, p.jet * 0.25, 0.2);
      to(rumbleOut.gain, p.rumble);
      to(abOut.gain, p.ab, 0.08);
      to(abWander.gain, p.ab * 0.3, 0.2);
      to(crackleOut.gain, p.crackle, 0.08);
      to(muffle.frequency, p.muffleHz, 0.1);
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
      for (const g of [whineOut, buzzOut, jetOut, rumbleOut, abOut, crackleOut, jetWander, abWander]) to(g.gain, 0, 0.05);
    },
  };
}
