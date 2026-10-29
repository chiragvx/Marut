/**
 * src/ui/audio/audioBus.ts — the one Web Audio context the game's sound shares, and its mix: a
 * master gain over four channels (voice warnings, warning and RWR tones, the engine and wind, and
 * one-shot effects), each with its own volume (Settings -> Audio). The context starts on the first
 * sound after a key press or click (browsers only let audio play after one); `resume()` is called
 * from the input handlers so it is running before the first warning.
 */

export const AudioChannel = {
  Voice: 'voice',
  Tones: 'tones',
  Ambience: 'ambience',
  Effects: 'effects',
} as const;
export type AudioChannel = (typeof AudioChannel)[keyof typeof AudioChannel];

/** Volumes, 0..1. Effects follow the ambience volume (one "engine and effects" control). */
export interface AudioVolumes {
  master: number;
  voice: number;
  tones: number;
  ambience: number;
}
export const DEFAULT_AUDIO_VOLUMES: Readonly<AudioVolumes> = { master: 0.8, voice: 1, tones: 0.8, ambience: 0.7 };

export interface AudioBus {
  /** The context, created on first use; null where there is no Web Audio. */
  context(): AudioContext | null;
  /** A channel's input node (connect sources here); null where there is no Web Audio. */
  channel(c: AudioChannel): AudioNode | null;
  /** A looping white-noise buffer (2 s) for the engine, wind and effects. */
  noise(): AudioBuffer | null;
  setVolumes(v: AudioVolumes): void;
  /** Starts (or restarts) the context: call from a key press or click. */
  resume(): void;
}

export function createAudioBus(): AudioBus {
  let ac: AudioContext | null = null;
  let failed = false;
  let master: GainNode | null = null;
  const channels = new Map<AudioChannel, GainNode>();
  let noiseBuf: AudioBuffer | null = null;
  let volumes: AudioVolumes = { ...DEFAULT_AUDIO_VOLUMES };

  const apply = (): void => {
    if (!ac || !master) return;
    const t = ac.currentTime;
    master.gain.setTargetAtTime(volumes.master, t, 0.02);
    channels.get(AudioChannel.Voice)?.gain.setTargetAtTime(volumes.voice, t, 0.02);
    channels.get(AudioChannel.Tones)?.gain.setTargetAtTime(volumes.tones, t, 0.02);
    channels.get(AudioChannel.Ambience)?.gain.setTargetAtTime(volumes.ambience, t, 0.02);
    channels.get(AudioChannel.Effects)?.gain.setTargetAtTime(volumes.ambience, t, 0.02);
  };

  const ensure = (): AudioContext | null => {
    if (ac || failed) return ac;
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor) {
      failed = true;
      return null;
    }
    try {
      ac = new Ctor();
      master = ac.createGain();
      // A gentle limiter so a burst of warnings over the engine never clips.
      const limiter = ac.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.ratio.value = 12;
      master.connect(limiter).connect(ac.destination);
      for (const c of Object.values(AudioChannel)) {
        const g = ac.createGain();
        g.connect(master);
        channels.set(c, g);
      }
      apply();
    } catch {
      ac = null;
      failed = true;
    }
    return ac;
  };

  return {
    context: ensure,
    channel(c) {
      return ensure() ? channels.get(c) ?? null : null;
    },
    noise() {
      const ctx = ensure();
      if (!ctx) return null;
      if (!noiseBuf) {
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      return noiseBuf;
    },
    setVolumes(v) {
      volumes = { ...v };
      apply();
    },
    resume() {
      const ctx = ensure();
      if (ctx && ctx.state === 'suspended') void ctx.resume();
    },
  };
}
