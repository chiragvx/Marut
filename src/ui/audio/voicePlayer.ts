/**
 * src/ui/audio/voicePlayer.ts — says the voice warnings (src/ui/audio/voiceWarnings.ts): one at a
 * time, most urgent first. A line of priority <= INTERRUPT_PRIORITY (PULL UP, ENGINE FIRE, MISSILE
 * LAUNCH) cuts off a less urgent one; a line already waiting is not queued twice; one that has
 * waited STALE_SEC is dropped (it is no longer news).
 *
 * The voice is the recorded file public/audio/voice/<id>.mp3 (a female Indian English voice). A
 * line whose file is still loading waits for it. Only a file that cannot be had falls back to the
 * browser's speech, and only to a female voice: no female voice on the system, no fallback (the
 * warning is still on the HUD), so the voice never changes to a man's.
 */
import { AudioChannel, type AudioBus } from './audioBus';
import { ALL_VOICE_LINES, INTERRUPT_PRIORITY, type VoiceLineDef } from './voiceWarnings';

export const STALE_SEC = 4;
const MAX_QUEUE = 4;

interface Pending {
  line: VoiceLineDef;
  queuedSec: number;
}

/** The waiting lines (pure, tested). */
export class VoiceQueue {
  readonly pending: Pending[] = [];

  /** Queue a line; true when it should cut off `playing`. */
  push(line: VoiceLineDef, nowSec: number, playing: VoiceLineDef | null): boolean {
    if (playing?.id === line.id) return false;
    if (this.pending.some((p) => p.line.id === line.id)) return false;
    this.pending.push({ line, queuedSec: nowSec });
    this.pending.sort((a, b) => a.line.priority - b.line.priority || a.queuedSec - b.queuedSec);
    if (this.pending.length > MAX_QUEUE) this.pending.length = MAX_QUEUE;
    return playing !== null && line.priority <= INTERRUPT_PRIORITY && line.priority < playing.priority;
  }

  /** The next line to say, if any (it stays queued: `next` takes it). */
  peek(nowSec: number): VoiceLineDef | null {
    while (this.pending.length && nowSec - this.pending[0]!.queuedSec > STALE_SEC) this.pending.shift();
    return this.pending[0]?.line ?? null;
  }

  /** The next line to say, if any. */
  next(nowSec: number): VoiceLineDef | null {
    const line = this.peek(nowSec);
    if (line) this.pending.shift();
    return line;
  }

  clear(): void {
    this.pending.length = 0;
  }
}

export interface VoicePlayer {
  say(lines: readonly VoiceLineDef[]): void;
  /** Starts the next line when the last has finished (call each frame). */
  update(): void;
  silence(): void;
  setEnabled(on: boolean): void;
  /** Starts loading the recorded files (after the first key press, when audio may play). */
  preload(): void;
  /** The browser's speech (the fallback) has no Web Audio node: its volume, 0..1 (voice x master). */
  setSpeechVolume(v: number): void;
}

type Clip = AudioBuffer | 'missing' | 'loading';

/** A system voice known to be a woman's (by name: the browsers give no gender). */
export const isFemaleVoice = (name: string): boolean =>
  !/\bmale\b/i.test(name) && /female|heera|neerja|swara|kalpana|veena|lekha|zira|aria|jenny|hazel|susan|samantha|karen|moira|tessa|google us english|google हिन्दी/i.test(name);

export function createVoicePlayer(bus: AudioBus, baseUrl: string): VoicePlayer {
  const queue = new VoiceQueue();
  const clips = new Map<string, Clip>();
  let playing: VoiceLineDef | null = null;
  let source: AudioBufferSourceNode | null = null;
  let enabled = true;
  let preloaded = false;
  let voiceVolume = 1;
  const now = (): number => performance.now() / 1000;

  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  let synthVoice: SpeechSynthesisVoice | null | undefined;
  const pickVoice = (): SpeechSynthesisVoice | null => {
    if (synthVoice !== undefined && synthVoice !== null) return synthVoice;
    const voices = synth?.getVoices() ?? [];
    if (!voices.length) return null;
    synthVoice = voices.find((v) => v.lang === 'en-IN' && isFemaleVoice(v.name)) ?? voices.find((v) => v.lang.startsWith('en') && isFemaleVoice(v.name)) ?? null;
    return synthVoice;
  };

  const load = (id: string): void => {
    if (clips.has(id)) return;
    const ac = bus.context();
    if (!ac || typeof fetch !== 'function') {
      clips.set(id, 'missing');
      return;
    }
    clips.set(id, 'loading');
    fetch(`${baseUrl}audio/voice/${id}.mp3`)
      .then((r) => {
        // A dev server answers a missing file with the app page: only audio counts.
        if (!r.ok || !(r.headers.get('content-type') ?? '').startsWith('audio')) throw new Error('missing');
        return r.arrayBuffer();
      })
      .then((b) => ac.decodeAudioData(b))
      .then((buf) => clips.set(id, buf))
      .catch(() => clips.set(id, 'missing'));
  };

  const finished = (line: VoiceLineDef): void => {
    if (playing === line) {
      playing = null;
      source = null;
    }
  };

  const stopCurrent = (): void => {
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    synth?.cancel();
    playing = null;
    source = null;
  };

  const start = (line: VoiceLineDef): void => {
    const clip = clips.get(line.id);
    const ac = bus.context();
    const dest = bus.channel(AudioChannel.Voice);
    playing = line;
    if (clip instanceof AudioBuffer && ac && dest) {
      const src = ac.createBufferSource();
      src.buffer = clip;
      src.connect(dest);
      src.onended = () => finished(line);
      src.start();
      source = src;
      return;
    }
    // No file: a female system voice, or nothing.
    const v = pickVoice();
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined' || !v) {
      playing = null;
      return;
    }
    const u = new SpeechSynthesisUtterance(line.text);
    u.voice = v;
    u.lang = v.lang;
    u.rate = 1.15;
    u.volume = Math.min(1, voiceVolume);
    u.onend = () => finished(line);
    u.onerror = () => finished(line);
    synth.speak(u);
  };


  return {
    say(lines) {
      if (!enabled) return;
      const t = now();
      for (const line of lines) {
        if (queue.push(line, t, playing)) stopCurrent();
      }
    },
    update() {
      if (playing || !enabled) return;
      const t = now();
      const next = queue.peek(t);
      if (!next) return;
      // Its file not loaded yet: wait for it (it is dropped if it goes stale).
      const clip = clips.get(next.id);
      if (clip === undefined) load(next.id);
      if (clip === undefined || clip === 'loading') return;
      start(queue.next(t)!);
    },
    silence() {
      queue.clear();
      stopCurrent();
    },
    setEnabled(on) {
      enabled = on;
      if (!on) {
        queue.clear();
        stopCurrent();
      }
    },
    preload() {
      if (preloaded || !bus.context()) return;
      preloaded = true;
      for (const l of ALL_VOICE_LINES) load(l.id);
    },
    setSpeechVolume(v) {
      voiceVolume = v;
    },
  };
}
