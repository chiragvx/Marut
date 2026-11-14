/**
 * src/ui/audio/heavyEngineVoice.ts — the big high-bypass turbofans of a multi-engine aircraft (the
 * C-17's four F117s), synthesised in Web Audio from src/ui/audio/heavyEngineModel.ts's numbers. One
 * voice per engine, each into its own output (an emitter at that engine, src/ui/audio/spatial.ts).
 * Noise, not oscillators, makes the sound — a big turbofan is heard as a roar, not as notes:
 *
 * - the jet's roar: pink noise, a body round 140 Hz, a soft double low-pass whose corner opens with
 *   power and wanders slowly (the spectrum breathes), its level wandering with the turbulence;
 * - the rumble: brown and low pink noise, the lows lifted, with a fast turbulence flutter and a slow
 *   throb of its own (each engine at its own rate: together a subtle, slow pulse);
 * - the intake's whoosh: soft band-passed noise in the low mids;
 * - the fan's blade-passing tone: only narrowband noise round the blade-pass frequency (a modest
 *   Q, a little jitter), faint;
 * - the rasp: low band-passed noise roughened at the shaft rate (amplitude modulation, no tone),
 *   near take-off power;
 * - the crackle behind the jet near take-off power, and the reversers' roar (broadband, low mids).
 *
 * Cheap on the main thread: each engine's numbers go to a few ConstantSourceNodes that drive the
 * real params through the audio graph (one call sets a level and its turbulence; one sets the fan
 * band, its jitter and the rasp's rate), and only real changes are sent
 * (src/ui/audio/targetParam.ts). The cockpit's muffling is one source for all the engines.
 */
import type { HeavyVoiceParams } from './heavyEngineModel';
import { engineNoiseBuffers } from './engineVoice';
import { TargetParam } from './targetParam';

export interface HeavyEngineRig {
  /** Engine `i`'s voice (time constant `tc`, s: the update interval or so). */
  set(i: number, p: HeavyVoiceParams, tc: number): void;
  /** Every engine's muffle corner, Hz. */
  setMuffle(hz: number): void;
  silence(): void;
  /** Stops and disconnects everything (a different aircraft). */
  dispose(): void;
}

interface EngineNodes {
  fanHz: TargetParam;
  fan: TargetParam;
  rasp: TargetParam;
  jet: TargetParam;
  jetHz: TargetParam;
  rumble: TargetParam;
  hiss: TargetParam;
  reverse: TargetParam;
  crackle: TargetParam;
}

/** The slow throb of each engine's rumble, Hz (cycled): a little different for each. */
const THROB_HZ = [0.43, 0.61, 0.52, 0.71, 0.47, 0.66];

export function createHeavyEngineRig(ac: BaseAudioContext, outs: readonly AudioNode[], blades: number): HeavyEngineRig {
  const bufs = engineNoiseBuffers(ac);
  const sources: AudioScheduledSourceNode[] = [];
  const muffles: BiquadFilterNode[] = [];

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
    sources.push(s);
    return s;
  };
  const filter = (type: BiquadFilterType, hz: number, q = 0.7, dbGain = 0): BiquadFilterNode => {
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    f.gain.value = dbGain;
    return f;
  };
  /** A control signal (its offset is the value), started at 0. */
  const driver = (): ConstantSourceNode => {
    const c = ac.createConstantSource();
    c.offset.value = 0;
    c.start();
    sources.push(c);
    return c;
  };
  /** A level: `out.gain` = control x (1 + sum of depth x modulator). */
  const modulated = (out: GainNode, control: ConstantSourceNode, ...mods: [AudioNode, number][]): void => {
    control.connect(out.gain);
    for (const [mod, depth] of mods) {
      const m = ac.createGain();
      m.gain.value = 0;
      control.connect(gain(m.gain, depth));
      mod.connect(m).connect(out.gain);
    }
  };
  const hzParam = (c: ConstantSourceNode): TargetParam => new TargetParam(c.offset, 0.05, 1e-3);
  const lvlParam = (c: ConstantSourceNode): TargetParam => new TargetParam(c.offset, 1e-5, 2e-3);

  // The cockpit's muffling: one control for every engine's low-pass.
  const muffleSrc = driver();
  const muffle = new TargetParam(muffleSrc.offset, 1, 0.005);

  const engines: EngineNodes[] = outs.map((out, idx) => {
    const m = ac.createBiquadFilter();
    m.type = 'lowpass';
    m.Q.value = 0.5;
    m.frequency.value = 0;
    muffleSrc.connect(m.frequency);
    m.connect(out);
    muffles.push(m);
    // Slow random walks (a few per second), each engine its own (different playback rates and offsets).
    const slow = loop(bufs.wander, 0.6 + 0.1 * idx);
    const turb = loop(bufs.wander, 1.4 + 0.15 * idx);

    // Jet roar: pink noise, body round 140 Hz, a soft double low-pass whose corner breathes.
    const jetHz = driver();
    const lp1 = filter('lowpass', 0, 0.5);
    const lp2 = filter('lowpass', 0, 0.5);
    jetHz.connect(lp1.frequency);
    jetHz.connect(gain(lp2.frequency, 2.2));
    const breathe = ac.createGain();
    breathe.gain.value = 0;
    jetHz.connect(gain(breathe.gain, 0.18));
    slow.connect(breathe);
    breathe.connect(lp1.frequency);
    const jetOut = gain(m);
    loop(bufs.pink).connect(filter('highpass', 35)).connect(filter('peaking', 140, 0.6, 5)).connect(lp1).connect(lp2).connect(jetOut);
    const jet = driver();
    modulated(jetOut, jet, [turb, 0.3]);

    // Rumble: brown + low pink, lows lifted; fast flutter and a slow throb on its level.
    const shelf = filter('lowshelf', 80, 0.7, 5);
    // (Nothing below ~35 Hz: inaudible on most speakers, it would only eat the limiter's headroom.)
    shelf.connect(filter('highpass', 35, 0.7)).connect(m);
    const rumbleOut = gain(shelf);
    loop(bufs.brown).connect(filter('lowpass', 110)).connect(rumbleOut);
    loop(bufs.pink, 0.5).connect(filter('lowpass', 200)).connect(gain(rumbleOut, 0.5));
    const rumble = driver();
    const throb = ac.createOscillator();
    throb.frequency.value = THROB_HZ[idx % THROB_HZ.length]!;
    throb.start();
    sources.push(throb);
    modulated(rumbleOut, rumble, [loop(bufs.wander, 6 + 0.7 * idx), 0.3], [throb, 0.12]);

    // The intake's whoosh: soft, low mids.
    const hissOut = gain(m);
    loop(bufs.pink, 1.1).connect(filter('bandpass', 700, 0.45)).connect(filter('lowpass', 2200, 0.5)).connect(hissOut);
    const hiss = driver();
    modulated(hissOut, hiss, [slow, 0.2]);

    // Fan blade-pass: narrowband noise round the blade-pass frequency, jittered, softened on top.
    const fanHz = driver();
    const band = filter('bandpass', 0, 7);
    fanHz.connect(band.frequency);
    const jitter = ac.createGain();
    jitter.gain.value = 0;
    fanHz.connect(gain(jitter.gain, 0.006));
    loop(bufs.wander, 4 + 0.5 * idx).connect(jitter).connect(band.frequency);
    const fanOut = gain(m);
    loop(bufs.pink, 1.3).connect(band).connect(filter('lowpass', 3000, 0.5)).connect(fanOut);
    const fan = driver();
    modulated(fanOut, fan, [turb, 0.4]);

    // Rasp: low band of noise, amplitude-modulated at the fan shaft rate (rough, no tone).
    const shaft = ac.createOscillator();
    shaft.frequency.value = 0;
    fanHz.connect(gain(shaft.frequency, 1 / Math.max(1, blades)));
    shaft.start();
    sources.push(shaft);
    const am = ac.createGain();
    am.gain.value = 0;
    shaft.connect(am.gain);
    const raspOut = gain(m);
    loop(bufs.pink, 0.9).connect(filter('bandpass', 380, 0.8)).connect(am).connect(raspOut);
    const rasp = driver();
    rasp.connect(raspOut.gain);

    // Crackle behind the jet: sparse pressure spikes, dulled.
    const crackleOut = gain(m);
    loop(bufs.crackle, 0.9 + 0.05 * idx).connect(filter('highpass', 250)).connect(filter('lowpass', 2000, 0.5)).connect(crackleOut);
    const crackle = driver();
    crackle.connect(crackleOut.gain);

    // Reverser roar: broadband, low mids, turbulent.
    const revOut = gain(m);
    loop(bufs.pink, 0.85).connect(filter('bandpass', 450, 0.6)).connect(revOut);
    loop(bufs.brown, 0.7).connect(filter('lowpass', 300)).connect(gain(revOut, 0.7));
    const reverse = driver();
    modulated(revOut, reverse, [turb, 0.3]);

    return {
      fanHz: hzParam(fanHz),
      fan: lvlParam(fan),
      rasp: lvlParam(rasp),
      jet: lvlParam(jet),
      jetHz: hzParam(jetHz),
      rumble: lvlParam(rumble),
      hiss: lvlParam(hiss),
      reverse: lvlParam(reverse),
      crackle: lvlParam(crackle),
    };
  });

  return {
    set(i, p, tc) {
      const e = engines[i];
      if (!e) return;
      const t = ac.currentTime;
      e.fanHz.to(p.fanHz, t, tc * 2); // the pitch lags the roar a little (a heavy rotor)
      e.fan.to(p.fan, t, tc);
      e.rasp.to(p.rasp, t, tc);
      e.jet.to(p.jet, t, tc);
      e.jetHz.to(p.jetHz, t, tc * 2);
      e.rumble.to(p.rumble, t, tc);
      e.hiss.to(p.hiss, t, tc);
      e.reverse.to(p.reverse, t, tc);
      e.crackle.to(p.crackle, t, tc);
    },
    setMuffle(hz) {
      muffle.to(hz, ac.currentTime, 0.1);
    },
    silence() {
      const t = ac.currentTime;
      for (const e of engines) for (const g of [e.fan, e.rasp, e.jet, e.rumble, e.hiss, e.reverse, e.crackle]) g.to(0, t, 0.05);
    },
    dispose() {
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          // already stopped
        }
        s.disconnect();
      }
      for (const m of muffles) m.disconnect();
      sources.length = 0;
    },
  };
}
