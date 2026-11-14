/**
 * src/ui/audio/heavyEngineVoice.ts — the big high-bypass turbofans of a multi-engine aircraft (the
 * C-17's four F117s), synthesised in Web Audio from src/ui/audio/heavyEngineModel.ts's numbers. One
 * voice per engine, each into its own output (an emitter at that engine, src/ui/audio/spatial.ts):
 *
 * - the fan's blade-pass whine (a tone and a faint octave, jittered: no fan is perfectly even);
 * - the buzz-saw: the fan shaft's harmonics (uneven weights, every engine its own), a deep growl;
 * - the jet's roar: pink noise with a lift round 200 Hz, its upper corner opening with power, its
 *   level wandering with the turbulence;
 * - the rumble: brown and low pink noise, the lows lifted, roughened a few times a second;
 * - the thrust reverser's roar: broadband noise centred in the low mids, turbulent.
 *
 * Cheap on the main thread: each engine's numbers go to a handful of ConstantSourceNodes that drive
 * the real params through the audio graph (one call sets the whine's tone, its octave, its jitter
 * depth and the buzz-saw's pitch; one sets a level and its turbulence), and only real changes are
 * sent (src/ui/audio/targetParam.ts). The cockpit's muffling is one source for all the engines.
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
  hz: TargetParam;
  whine: TargetParam;
  buzz: TargetParam;
  jet: TargetParam;
  jetHz: TargetParam;
  rumble: TargetParam;
  reverse: TargetParam;
}

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
  const hzParam = (c: ConstantSourceNode): TargetParam => new TargetParam(c.offset, 0.05, 1e-3);
  const lvlParam = (c: ConstantSourceNode): TargetParam => new TargetParam(c.offset, 1e-5, 2e-3);

  // The cockpit's muffling: one control for every engine's low-pass.
  const muffleSrc = driver();
  const muffle = new TargetParam(muffleSrc.offset, 1, 0.005);

  const engines: EngineNodes[] = outs.map((out) => {
    const m = ac.createBiquadFilter();
    m.type = 'lowpass';
    m.Q.value = 0.5;
    m.frequency.value = 0;
    muffleSrc.connect(m.frequency);
    m.connect(out);
    muffles.push(m);

    // Fan whine: tone + octave, from one Hz control; its jitter depth follows the tone.
    const hz = driver();
    const whineSoft = filter('lowpass', 4000, 0.5);
    whineSoft.connect(m);
    const whineOut = gain(whineSoft);
    const w1 = ac.createOscillator();
    const w2 = ac.createOscillator();
    w1.frequency.value = 0;
    w2.frequency.value = 0;
    hz.connect(w1.frequency);
    hz.connect(gain(w2.frequency, 2));
    w1.connect(whineOut);
    w2.connect(gain(whineOut, 0.15));
    const jitterDepth = ac.createGain();
    jitterDepth.gain.value = 0;
    hz.connect(gain(jitterDepth.gain, 0.003));
    loop(bufs.wander, 8).connect(jitterDepth);
    jitterDepth.connect(w1.frequency);
    jitterDepth.connect(gain(w2.frequency, 2));
    w1.start();
    w2.start();
    sources.push(w1, w2);
    const whine = driver();
    whine.connect(whineOut.gain);

    // Buzz-saw: the shaft's harmonics 1..48, uneven, through a broad band round 900 Hz.
    const n = 49;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) imag[k] = (0.25 + 0.75 * Math.random()) / Math.sqrt(k);
    const buzzOsc = ac.createOscillator();
    buzzOsc.setPeriodicWave(ac.createPeriodicWave(real, imag));
    buzzOsc.frequency.value = 0;
    hz.connect(gain(buzzOsc.frequency, 1 / Math.max(1, blades)));
    const buzzOut = gain(m);
    buzzOsc.connect(filter('bandpass', 900, 0.35)).connect(buzzOut);
    buzzOsc.start();
    sources.push(buzzOsc);
    const buzz = driver();
    buzz.connect(buzzOut.gain);

    // Jet roar: pink noise, body round 200 Hz, corner from a control; turbulent level.
    const jetLp = filter('lowpass', 0, 0.5);
    const jetHz = driver();
    jetHz.connect(jetLp.frequency);
    const jetOut = gain(m);
    loop(bufs.pink).connect(filter('highpass', 30)).connect(filter('peaking', 200, 0.7, 5)).connect(jetLp).connect(jetOut);
    const jet = driver();
    jet.connect(jetOut.gain);
    const jetTurb = ac.createGain();
    jetTurb.gain.value = 0;
    jet.connect(gain(jetTurb.gain, 0.25));
    loop(bufs.wander, 1.3).connect(jetTurb).connect(jetOut.gain);

    // Rumble: brown + low pink, the lows (round 90 Hz) lifted, roughened.
    const shelf = filter('lowshelf', 90, 0.7, 6);
    // (Nothing below ~35 Hz: inaudible on most speakers, it would only eat the limiter's headroom.)
    shelf.connect(filter('highpass', 35, 0.7)).connect(m);
    const rumbleOut = gain(shelf);
    loop(bufs.brown).connect(filter('lowpass', 120)).connect(rumbleOut);
    loop(bufs.pink, 0.5).connect(filter('lowpass', 250)).connect(gain(rumbleOut, 0.5));
    const rumble = driver();
    rumble.connect(rumbleOut.gain);
    const rough = ac.createGain();
    rough.gain.value = 0;
    rumble.connect(gain(rough.gain, 0.45));
    loop(bufs.wander, 5).connect(rough).connect(rumbleOut.gain);

    // Reverser roar: broadband, low mids, turbulent.
    const revOut = gain(m);
    loop(bufs.pink, 0.85).connect(filter('bandpass', 700, 0.5)).connect(revOut);
    loop(bufs.brown, 0.7).connect(filter('lowpass', 350)).connect(gain(revOut, 0.6));
    const reverse = driver();
    reverse.connect(revOut.gain);
    const revTurb = ac.createGain();
    revTurb.gain.value = 0;
    reverse.connect(gain(revTurb.gain, 0.3));
    loop(bufs.wander, 1.7).connect(revTurb).connect(revOut.gain);

    return {
      hz: hzParam(hz),
      whine: lvlParam(whine),
      buzz: lvlParam(buzz),
      jet: lvlParam(jet),
      jetHz: hzParam(jetHz),
      rumble: lvlParam(rumble),
      reverse: lvlParam(reverse),
    };
  });

  return {
    set(i, p, tc) {
      const e = engines[i];
      if (!e) return;
      const t = ac.currentTime;
      e.hz.to(p.whineHz, t, tc);
      e.whine.to(p.whine, t, tc);
      e.buzz.to(p.buzz, t, tc);
      e.jet.to(p.jet, t, tc);
      e.jetHz.to(p.jetHz, t, tc);
      e.rumble.to(p.rumble, t, tc);
      e.reverse.to(p.reverse, t, tc);
    },
    setMuffle(hz) {
      muffle.to(hz, ac.currentTime, 0.1);
    },
    silence() {
      const t = ac.currentTime;
      for (const e of engines) for (const g of [e.whine, e.buzz, e.jet, e.rumble, e.reverse]) g.to(0, t, 0.05);
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
