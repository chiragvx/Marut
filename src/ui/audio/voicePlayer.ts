/**
 * src/ui/audio/voicePlayer.ts — says the voice warnings (src/ui/audio/voiceWarnings.ts): one at a
 * time, most urgent first. A line of priority <= INTERRUPT_PRIORITY (PULL UP, ENGINE FIRE, MISSILE
 * LAUNCH) cuts off a less urgent one; a line already waiting is not queued twice; one that has
 * waited STALE_SEC is dropped (it is no longer news).
 *
 * The voice is the recorded file public/audio/voice/<id>.mp3 when there is one. Until it is
 * recorded, the browser's own speech says the line (an Indian English voice when the system has
 * one), so every line works from the start and the files can be added one by one.
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

  /** The next line to say, if any. */
  next(nowSec: number): VoiceLineDef | null {
    while (this.pending.length) {
      const p = this.pending.shift()!;
      if (nowSec - p.queuedSec <= STALE_SEC) return p.line;
    }
    return null;
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
    const female = (v: SpeechSynthesisVoice): boolean => /female|heera|neerja|swara|kalpana|veena|lekha|google/i.test(v.name);
    synthVoice =
      voices.find((v) => v.lang === 'en-IN' && female(v)) ??
      voices.find((v) => v.lang === 'en-IN') ??
      voices.find((v) => v.lang.startsWith('en') && female(v)) ??
      voices.find((v) => v.lang.startsWith('en')) ??
      null;
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
    if (clip === undefined) load(line.id);
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
      playing = null;
      return;
    }
    const u = new SpeechSynthesisUtterance(line.text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = v?.lang ?? 'en-IN';
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
      const line = queue.next(now());
      if (line) start(line);
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
