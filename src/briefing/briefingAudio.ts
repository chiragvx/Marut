/**
 * src/briefing/briefingAudio.ts — the intro's sound: the narration (public/audio/briefing/<id>.mp3,
 * played clean, no radio), a score where the script has one, and a room made in code (Web Audio,
 * no recordings): a low room tone and air-conditioning hum, now and then a murmur of distant radio
 * traffic (filtered noise shaped like speech, never words), a soft tick as each pin drops, and a
 * low hit for the title cards. Under a score the room and the hits are left out (the music is the
 * room); the pin ticks stay, quiet.
 *
 * Two kinds of clip. A line clip (`line`) is short: one still loading when its line is due
 * starts late if it is less than a second late, else is skipped. A track (`track`: a whole
 * narration recording, or the score) is long: it starts when it has loaded, that far in, and its
 * gain is set live (`trackGain`: the score's ducking and fade). A missing clip is skipped (the
 * subtitles still show).
 */
import { AudioChannel, type AudioBus } from '../ui/audio/audioBus';

export interface BriefingAudio {
  /** Fetches and decodes the clips (call as the intro starts). */
  preload(ids: readonly string[]): void;
  /** Says a line `lateSec` after it was due (a clip starts that far in). */
  line(id: string, lateSec?: number): void;
  /** A loaded line's length, s (undefined while loading or missing): the subtitles pace to it. */
  duration(id: string): number | undefined;
  /**
   * Plays a long clip (a narration recording on the voice channel, a score on the ambience one)
   * from `offsetSec` in; one still loading starts when it arrives, as far in as it is late.
   */
  track(id: string, kind: 'voice' | 'music', offsetSec: number, gain: number): void;
  /** Where a playing track is, s from its start (undefined if it is not playing). */
  trackPosition(id: string): number | undefined;
  /** Moves a playing track's gain to `gain` with time constant `tcSec`. */
  trackGain(id: string, gain: number, tcSec?: number): void;
  /** Starts the room tone and chatter (`quiet`: under a score, so no room and no hits). */
  start(quiet?: boolean): void;
  tick(): void;
  sting(): void;
  /** Fades everything out over `sec` and stops. */
  stop(sec?: number): void;
}

const MAX_LATE_SEC = 1;

export function createBriefingAudio(bus: AudioBus, baseUrl: string): BriefingAudio {
  const clips = new Map<string, AudioBuffer | 'loading' | 'missing'>();
  const voices: AudioBufferSourceNode[] = [];
  let room: { gain: GainNode; nodes: AudioScheduledSourceNode[]; chatterTimer: ReturnType<typeof setTimeout> | undefined } | null = null;
  let stopped = false;
  let quietRoom = false;
  const tracks = new Map<string, { src: AudioBufferSourceNode; gain: GainNode; startedAt: number; offset: number; duration: number; music: boolean }>();
  const ctx = (): AudioContext | null => bus.context();

  const load = (id: string): void => {
    const ac = ctx();
    if (!ac || clips.has(id) || typeof fetch !== 'function') return;
    clips.set(id, 'loading');
    fetch(`${baseUrl}audio/briefing/${id}.mp3`)
      .then((r) => {
        if (!r.ok || !(r.headers.get('content-type') ?? '').startsWith('audio')) throw new Error('missing');
        return r.arrayBuffer();
      })
      .then((b) => ac.decodeAudioData(b))
      .then((buf) => clips.set(id, buf))
      .catch(() => clips.set(id, 'missing'));
  };

  const playClip = (buf: AudioBuffer, offset: number): void => {
    const ac = ctx();
    const dest = bus.channel(AudioChannel.Voice);
    if (!ac || !dest || stopped) return;
    const src = ac.createBufferSource();
    src.buffer = buf;
    // A touch of warmth and presence, still clean (the radio's band-pass is never used here).
    const lo = ac.createBiquadFilter();
    lo.type = 'lowshelf';
    lo.frequency.value = 180;
    lo.gain.value = 3;
    const g = ac.createGain();
    g.gain.value = 0.95;
    src.connect(lo).connect(g).connect(dest);
    src.start(ac.currentTime + 0.01, Math.max(0, offset));
    voices.push(src);
    src.onended = () => {
      const i = voices.indexOf(src);
      if (i >= 0) voices.splice(i, 1);
    };
  };

  /** Speech-shaped noise: syllable bursts through a voice band, a burst of a few seconds, quiet. */
  const chatter = (): void => {
    const ac = ctx();
    const noise = bus.noise();
    if (!ac || !room || !noise || stopped) return;
    const t0 = ac.currentTime + 0.05;
    const dur = 1.2 + Math.random() * 2.2;
    const src = ac.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + Math.random() * 700;
    bp.Q.value = 2.2;
    const env = ac.createGain();
    env.gain.value = 0;
    let t = t0;
    while (t < t0 + dur) {
      const syl = 0.07 + Math.random() * 0.16;
      const peak = 0.25 + Math.random() * 0.75;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peak, t + syl * 0.3);
      env.gain.linearRampToValueAtTime(0, t + syl);
      t += syl + (Math.random() < 0.18 ? 0.25 : 0.02);
    }
    const pan = ac.createStereoPanner ? ac.createStereoPanner() : null;
    const level = ac.createGain();
    level.gain.value = 0.05;
    if (pan) pan.pan.value = Math.random() * 1.6 - 0.8;
    src.connect(bp).connect(env).connect(level);
    if (pan) level.connect(pan).connect(room.gain);
    else level.connect(room.gain);
    src.start(t0);
    src.stop(t + 0.1);
    room.chatterTimer = setTimeout(chatter, 3500 + Math.random() * 6000);
  };

  const startTrack = (id: string, buf: AudioBuffer, kind: 'voice' | 'music', offset: number, level: number): void => {
    const ac = ctx();
    const dest = bus.channel(kind === 'voice' ? AudioChannel.Voice : AudioChannel.Ambience);
    if (!ac || !dest || stopped || tracks.has(id) || offset >= buf.duration) return;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const g = ac.createGain();
    // A recorded take is played as it is; a short fade in if it starts part way through.
    const t0 = ac.currentTime + 0.02;
    g.gain.setValueAtTime(offset > 0.05 ? 0 : level, t0);
    if (offset > 0.05) g.gain.linearRampToValueAtTime(level, t0 + 0.25);
    src.connect(g).connect(dest);
    src.start(t0, Math.max(0, offset));
    tracks.set(id, { src, gain: g, startedAt: t0, offset: Math.max(0, offset), duration: buf.duration, music: kind === 'music' });
    src.onended = () => {
      if (tracks.get(id)?.src === src) tracks.delete(id);
    };
  };

  return {
    track(id, kind, offsetSec, gain) {
      const c = clips.get(id);
      if (c instanceof AudioBuffer) return startTrack(id, c, kind, offsetSec, gain);
      if (c === 'missing') return;
      if (c === undefined) load(id);
      const due = performance.now() - offsetSec * 1000;
      const retry = (): void => {
        if (stopped) return;
        const cc = clips.get(id);
        if (cc instanceof AudioBuffer) startTrack(id, cc, kind, (performance.now() - due) / 1000, gain);
        else if (cc === 'loading') setTimeout(retry, 60);
      };
      setTimeout(retry, 60);
    },
    trackPosition(id) {
      const ac = ctx();
      const tr = tracks.get(id);
      if (!ac || !tr) return undefined;
      const p = tr.offset + Math.max(0, ac.currentTime - tr.startedAt);
      return p < tr.duration ? p : undefined;
    },
    trackGain(id, gain, tcSec = 0.3) {
      const ac = ctx();
      const tr = tracks.get(id);
      if (!ac || !tr || stopped) return;
      tr.gain.gain.setTargetAtTime(gain, Math.max(ac.currentTime, tr.startedAt + 0.3), tcSec);
    },
    preload(ids) {
      for (const id of ids) load(id);
    },
    duration(id) {
      const c = clips.get(id);
      return c instanceof AudioBuffer ? c.duration : undefined;
    },
    line(id, lateSec = 0) {
      const c = clips.get(id);
      if (c instanceof AudioBuffer) {
        if (lateSec < c.duration) playClip(c, lateSec);
        return;
      }
      if (c === 'missing') return;
      if (c === undefined) load(id);
      // Still loading: say it if it arrives in time.
      const due = performance.now() - lateSec * 1000;
      const retry = (): void => {
        const late = (performance.now() - due) / 1000;
        const cc = clips.get(id);
        if (cc instanceof AudioBuffer) {
          if (late < MAX_LATE_SEC) playClip(cc, late);
        } else if (cc === 'loading' && late < MAX_LATE_SEC) setTimeout(retry, 60);
      };
      setTimeout(retry, 60);
    },
    start(quiet = false) {
      stopped = false;
      quietRoom = quiet;
      if (quiet) return;
      const ac = ctx();
      const dest = bus.channel(AudioChannel.Ambience);
      const noise = bus.noise();
      if (!ac || !dest || !noise || room) return;
      const gain = ac.createGain();
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(1, ac.currentTime, 0.8);
      gain.connect(dest);
      // Room tone: noise, low-passed hard.
      const tone = ac.createBufferSource();
      tone.buffer = noise;
      tone.loop = true;
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 220;
      const tg = ac.createGain();
      tg.gain.value = 0.16;
      tone.connect(lp).connect(tg).connect(gain);
      tone.start();
      // Air handling: a soft 50 Hz hum and its second harmonic, slowly breathing.
      const hum = ac.createOscillator();
      hum.frequency.value = 50;
      const hum2 = ac.createOscillator();
      hum2.frequency.value = 100;
      const hg = ac.createGain();
      hg.gain.value = 0.012;
      const h2g = ac.createGain();
      h2g.gain.value = 0.006;
      const lfo = ac.createOscillator();
      lfo.frequency.value = 0.13;
      const lfoG = ac.createGain();
      lfoG.gain.value = 0.004;
      lfo.connect(lfoG).connect(hg.gain);
      hum.connect(hg).connect(gain);
      hum2.connect(h2g).connect(gain);
      hum.start();
      hum2.start();
      lfo.start();
      room = { gain, nodes: [tone, hum, hum2, lfo], chatterTimer: setTimeout(chatter, 2500) };
    },
    tick() {
      const ac = ctx();
      const dest = bus.channel(AudioChannel.Effects);
      if (!ac || !dest || stopped) return;
      const t = ac.currentTime;
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(1250, t);
      o.frequency.exponentialRampToValueAtTime(700, t + 0.09);
      const g = ac.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(quietRoom ? 0.025 : 0.06, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.16);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + 0.2);
    },
    sting() {
      const ac = ctx();
      const dest = bus.channel(AudioChannel.Effects);
      const noise = bus.noise();
      if (!ac || !dest || !noise || stopped || quietRoom) return;
      const t = ac.currentTime;
      // A low drop (sine 70 -> 32 Hz) under a short swell of dark noise.
      const o = ac.createOscillator();
      o.frequency.setValueAtTime(70, t);
      o.frequency.exponentialRampToValueAtTime(32, t + 1.8);
      const og = ac.createGain();
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(0.42, t + 0.03);
      og.gain.exponentialRampToValueAtTime(0.001, t + 2.6);
      o.connect(og).connect(dest);
      o.start(t);
      o.stop(t + 2.7);
      const n = ac.createBufferSource();
      n.buffer = noise;
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.exponentialRampToValueAtTime(120, t + 1.5);
      const ng = ac.createGain();
      ng.gain.setValueAtTime(0, t);
      ng.gain.linearRampToValueAtTime(0.14, t + 0.02);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
      n.connect(lp).connect(ng).connect(dest);
      n.start(t);
      n.stop(t + 1.7);
    },
    stop(sec = 0.6) {
      const ac = ctx();
      stopped = true;
      if (!ac) return;
      const t = ac.currentTime;
      for (const [, tr] of tracks) {
        // The voice stops at once; the score fades out over a few seconds (on under the flight's start).
        const f = tr.music ? Math.max(sec, 3) : sec;
        tr.gain.gain.cancelScheduledValues(t);
        tr.gain.gain.setValueAtTime(tr.gain.gain.value, t);
        tr.gain.gain.linearRampToValueAtTime(0, t + f);
        try {
          tr.src.stop(t + f + 0.05);
        } catch {
          // already stopped
        }
      }
      tracks.clear();
      for (const v of voices.splice(0)) {
        try {
          v.stop(t + sec);
        } catch {
          // already stopped
        }
      }
      if (room) {
        const r = room;
        room = null;
        clearTimeout(r.chatterTimer);
        r.gain.gain.cancelScheduledValues(t);
        r.gain.gain.setTargetAtTime(0, t, sec / 3);
        for (const n of r.nodes) n.stop(t + sec + 0.1);
        setTimeout(() => r.gain.disconnect(), (sec + 0.3) * 1000);
      }
    },
  };
}
