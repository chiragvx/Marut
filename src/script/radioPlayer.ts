/**
 * src/script/radioPlayer.ts — says the mission scripts' radio calls (src/script/radio.ts): the
 * recorded clips public/audio/radio/<id>.mp3 back to back, through a radio's sound (a 300 Hz -
 * 3.3 kHz band, a little drive, hiss under the voice, a squelch click at each end). One call at a
 * time, most urgent first; an Urgent call cuts off a lesser one; a call that waited too long is
 * dropped. The subtitle is shown as the call starts (the player's own calls at once). With the
 * voice volume at zero, or a clip missing, the subtitle still shows for as long as it would take.
 */
import { AudioChannel, type AudioBus } from '../ui/audio/audioBus';
import { RADIO_CLIP_IDS, RadioPriority, type RadioClipId, type Transmission } from './radio';

const MAX_QUEUE = 6;
/** Silence between clips of one call, s. */
const GAP_SEC = 0.045;
/** Subtitles stay this long after the voice, ms. */
const HOLD_AFTER_MS = 1600;

export interface RadioPlayer {
  say(calls: readonly Transmission[]): void;
  /** Each frame: starts the next call when the channel is free. */
  update(): void;
  silence(): void;
  setEnabled(on: boolean): void;
  preload(): void;
}

type Clip = AudioBuffer | 'missing' | 'loading';

interface Pending {
  tx: Transmission;
  queuedSec: number;
}

/** Reading speed for a subtitle with no voice, ms. */
export const readMs = (text: string): number => Math.max(1800, text.length * 62);

export function createRadioPlayer(bus: AudioBus, baseUrl: string, onSubtitle: (tx: Transmission, holdMs: number) => void): RadioPlayer {
  const clips = new Map<RadioClipId, Clip>();
  const queue: Pending[] = [];
  let enabled = true;
  let preloaded = false;
  let busyUntil = 0;
  let playing: Transmission | null = null;
  let sources: AudioScheduledSourceNode[] = [];
  let chain: { input: GainNode; hiss: GainNode; noise: AudioBuffer } | null = null;
  const now = (): number => performance.now() / 1000;

  const load = (id: RadioClipId): void => {
    if (clips.has(id)) return;
    const ac = bus.context();
    // No audio yet (before the first key press): try again later.
    if (!ac) return;
    if (typeof fetch !== 'function') {
      clips.set(id, 'missing');
      return;
    }
    clips.set(id, 'loading');
    fetch(`${baseUrl}audio/radio/${id}.mp3`)
      .then((r) => {
        if (!r.ok || !(r.headers.get('content-type') ?? '').startsWith('audio')) throw new Error('missing');
        return r.arrayBuffer();
      })
      .then((b) => ac.decodeAudioData(b))
      .then((buf) => clips.set(id, buf))
      .catch(() => clips.set(id, 'missing'));
  };

  /** The radio's sound, built once. */
  const build = (): typeof chain => {
    const ac = bus.context();
    const dest = bus.channel(AudioChannel.Voice);
    if (!ac || !dest) return null;
    const input = ac.createGain();
    input.gain.value = 1.1;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    hp.Q.value = 0.8;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3300;
    lp.Q.value = 0.9;
    const presence = ac.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 1800;
    presence.gain.value = 5;
    const drive = ac.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2);
    }
    drive.curve = curve;
    const out = ac.createGain();
    out.gain.value = 0.62;
    input.connect(hp).connect(presence).connect(lp).connect(drive).connect(out).connect(dest);
    // Hiss under the voice (open while a call is on).
    const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const hissSrc = ac.createBufferSource();
    hissSrc.buffer = noise;
    hissSrc.loop = true;
    const hissBand = ac.createBiquadFilter();
    hissBand.type = 'bandpass';
    hissBand.frequency.value = 2400;
    hissBand.Q.value = 0.6;
    const hiss = ac.createGain();
    hiss.gain.value = 0;
    hissSrc.connect(hissBand).connect(hiss).connect(dest);
    hissSrc.start();
    return { input, hiss, noise };
  };

  /** A squelch click: a short burst of band-passed noise. */
  const click = (ac: AudioContext, at: number, sec: number, gain: number, hz: number): void => {
    if (!chain) return;
    const src = ac.createBufferSource();
    src.buffer = chain.noise;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = hz;
    bp.Q.value = 1.2;
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + sec);
    src.connect(bp).connect(g).connect(bus.channel(AudioChannel.Voice)!);
    src.start(at, Math.random() * 0.5, sec + 0.02);
    sources.push(src);
  };

  const stop = (): void => {
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    sources = [];
    const ac = bus.context();
    if (chain && ac) chain.hiss.gain.setTargetAtTime(0, ac.currentTime, 0.02);
    playing = null;
    busyUntil = 0;
  };

  const start = (tx: Transmission): void => {
    playing = tx;
    const ac = bus.context();
    const bufs = tx.clips.map((id) => clips.get(id));
    const voiced = enabled && ac && bufs.length > 0 && bufs.every((b) => b instanceof AudioBuffer);
    if (!voiced || !ac) {
      const ms = readMs(tx.text);
      busyUntil = now() + ms / 1000;
      onSubtitle(tx, ms);
      return;
    }
    if (!chain) chain = build();
    if (!chain) return;
    let t = ac.currentTime + 0.09;
    click(ac, ac.currentTime + 0.01, 0.06, 0.1, 2600);
    chain.hiss.gain.setTargetAtTime(0.012, ac.currentTime, 0.02);
    for (const b of bufs as AudioBuffer[]) {
      const src = ac.createBufferSource();
      src.buffer = b;
      src.connect(chain.input);
      src.start(t);
      sources.push(src);
      t += b.duration + GAP_SEC;
    }
    click(ac, t + 0.02, 0.11, 0.14, 1800);
    chain.hiss.gain.setTargetAtTime(0, t + 0.05, 0.02);
    const sec = t + 0.16 - ac.currentTime;
    busyUntil = now() + sec;
    onSubtitle(tx, sec * 1000 + HOLD_AFTER_MS);
  };

  return {
    say(calls) {
      const t = now();
      for (const tx of calls) {
        if (tx.own) {
          onSubtitle(tx, 2200);
          continue;
        }
        for (const id of tx.clips) load(id);
        queue.push({ tx, queuedSec: t });
        if (playing && tx.priority === RadioPriority.Urgent && playing.priority > RadioPriority.Urgent) stop();
      }
      queue.sort((a, b) => a.tx.priority - b.tx.priority || a.queuedSec - b.queuedSec);
      if (queue.length > MAX_QUEUE) queue.length = MAX_QUEUE;
    },
    update() {
      const t = now();
      if (playing && t < busyUntil) return;
      if (playing) {
        playing = null;
        sources = [];
      }
      while (queue.length && t - queue[0]!.queuedSec > queue[0]!.tx.maxAgeSec) queue.shift();
      const next = queue[0];
      if (!next) return;
      // Its clips still loading: wait (it goes stale if they never come).
      if (enabled && bus.context() && next.tx.clips.some((id) => clips.get(id) === 'loading' || clips.get(id) === undefined)) {
        for (const id of next.tx.clips) load(id);
        return;
      }
      queue.shift();
      start(next.tx);
    },
    silence() {
      queue.length = 0;
      stop();
    },
    setEnabled(on) {
      enabled = on;
    },
    preload() {
      if (preloaded || !bus.context()) return;
      preloaded = true;
      for (const id of RADIO_CLIP_IDS) load(id);
    },
  };
}
