/**
 * src/ui/audio/gunSound.ts — the GSh-23L's sound, synthesised (no recorded sound).
 *
 * The Tejas's gun is a twin-barrel 23 mm Gast cannon: each barrel's recoil works the other's
 * breech, so it fires ~3,400 rounds a minute (src/contracts/combat.ts), ~57 shots a second. Heard
 * from the cockpit it is a hard, fast mechanical "brrrrt": every shot a sharp report over a low
 * thump of the airframe, so close together they buzz at the fire rate (a rasp with a pitch, not a
 * hiss), with the clatter of the feed under it. Outside the jet it is a louder, ripping report,
 * duller further off.
 *
 * `createGunLoopBuffer` (pure, tested) builds a seamless loop of shots at the real fire rate,
 * each shot:
 * - the crack: a broadband burst a couple of ms long (bright outside; through the airframe in the
 *   cockpit, muffled);
 * - the thump: a falling low sine (the airframe kicked by the recoil), and the panels ringing;
 * - the feed's click: a short metallic tick a few ms after the shot (the next round chambering);
 * - the two barrels alternating (every other shot a little different), each shot slightly
 *   different in level and timing.
 * `createGunTailBuffer` (pure, tested) is what follows the last round: the airframe and barrels
 * ringing down, the bolt's last clack, and outside the report rolling away.
 *
 * `createGunVoice` plays them from the sim's `gunFire` events (one per round): the loop while the
 * rounds keep coming (spinning up over the first few, the first round the hardest), the tail when
 * they stop.
 */
import { GUN_ROF_ROUNDS_PER_MIN } from '../../contracts/combat';

export type GunView = 'cockpit' | 'outside';

/** Shots a second (~56.7). */
export const GUN_SHOT_HZ = GUN_ROF_ROUNDS_PER_MIN / 60;
/** Shots in the loop (~0.85 s: long enough that its shot-to-shot variation never sounds repeated). */
export const GUN_LOOP_SHOTS = 48;

/** How each part of a shot sounds, from the cockpit and from outside. */
interface Voicing {
  /** The crack's level, its decay (s) and its band (Hz). */
  crack: number;
  crackTau: number;
  crackLoHz: number;
  crackHiHz: number;
  /** The thump's level, decay (s) and its pitch falling from `thumpHz0` to `thumpHz1`. */
  thump: number;
  thumpTau: number;
  thumpHz0: number;
  thumpHz1: number;
  /** The airframe panels ringing: level, decay (s), modes (Hz). */
  ring: number;
  ringTau: number;
  ringHz: readonly number[];
  /** The feed's click: level and its pitch (Hz). */
  click: number;
  clickHz: number;
  /** Drive into the soft saturator (denser, harsher as it rises). */
  drive: number;
}

/** The tuning knobs: from the cockpit more thump and ring, the crack muffled; outside the crack. */
const VOICING: Record<GunView, Voicing> = {
  cockpit: {
    crack: 1.5, crackTau: 0.0016, crackLoHz: 200, crackHiHz: 3500,
    thump: 0.75, thumpTau: 0.008, thumpHz0: 130, thumpHz1: 58,
    ring: 0.25, ringTau: 0.014, ringHz: [185, 410, 730],
    click: 0.35, clickHz: 2300,
    drive: 1.6,
  },
  outside: {
    crack: 1, crackTau: 0.0024, crackLoHz: 220, crackHiHz: 6000,
    thump: 0.55, thumpTau: 0.007, thumpHz0: 150, thumpHz1: 70,
    ring: 0.14, ringTau: 0.012, ringHz: [240, 620],
    click: 0.12, clickHz: 3600,
    drive: 2,
  },
};
/** Shot-to-shot variation: level (fraction) and timing (s). */
const SHOT_LEVEL_JITTER = 0.12;
const SHOT_TIME_JITTER_SEC = 0.0003;
/** The second barrel's level against the first's. */
const ALT_BARREL = 0.9;
/** How long each shot's sound lasts (its tail overlaps the next shots'), s. */
const SHOT_SEC = 0.06;

/** A seeded LCG (-1..1): the same buffer every time. */
function rng(s0: number): () => number {
  let seed = s0 >>> 0;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
}

/** One-pole coefficient for a corner at `hz`. */
const onePole = (hz: number, sr: number): number => 1 - Math.exp((-2 * Math.PI * hz) / sr);

/** Runs a filter over a loop twice, keeping the second pass, so the loop has no seam. */
function filterLoop(d: Float32Array, step: (x: number) => number): void {
  for (let i = 0; i < d.length; i++) step(d[i]!);
  for (let i = 0; i < d.length; i++) d[i] = step(d[i]!);
}

/** A band (one-pole high-pass then two one-pole low-passes). */
function band(loHz: number, hiHz: number, sr: number): (x: number) => number {
  const kl = onePole(loHz, sr);
  const kh = onePole(hiHz, sr);
  let lo = 0;
  let a = 0;
  let b = 0;
  return (x) => {
    lo += (x - lo) * kl;
    a += (x - lo - a) * kh;
    b += (a - b) * kh;
    return b;
  };
}

/** A resonant band-pass (RBJ biquad, 0 dB at the peak). */
function bandPass(hz: number, q: number, sr: number): (x: number) => number {
  const w = (2 * Math.PI * hz) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const a1 = (-2 * Math.cos(w)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/** The thump: a sine falling from hz0 to hz1 (over ~6 ms), quick attack, decaying with `tau`. */
function thumpAt(t: number, hz0: number, hz1: number, tau: number): number {
  const fall = 0.006;
  const phase = 2 * Math.PI * (hz1 * t + (hz0 - hz1) * fall * (1 - Math.exp(-t / fall)));
  return Math.sin(phase) * Math.min(1, t / 0.0006) * Math.exp(-t / tau);
}

/** Soft-saturates both channels and scales them so the peak sits at 0.98. */
function finish(chs: Float32Array[], drive: number, peakTo: number): void {
  let peak = 0;
  for (const d of chs) for (const v of d) peak = Math.max(peak, Math.abs(v));
  const norm = 1 / Math.max(1e-9, peak);
  const tn = Math.tanh(drive);
  for (const d of chs) for (let i = 0; i < d.length; i++) d[i] = (peakTo * Math.tanh(drive * d[i]! * norm)) / tn;
}

/**
 * A seamless loop of `shots` rounds at the fire rate (the shot period rounded to whole samples),
 * stereo, full scale (peak 0.98). Deterministic.
 */
export function createGunLoopBuffer(ac: BaseAudioContext, view: GunView, shots = GUN_LOOP_SHOTS): AudioBuffer {
  const sr = ac.sampleRate;
  const v = VOICING[view];
  const period = Math.round(sr / GUN_SHOT_HZ);
  const len = period * shots;
  const buf = ac.createBuffer(2, len, sr);
  // Each shot's level, timing and click delay (the same in both ears).
  const pr = rng(0x6a09e667 + (view === 'cockpit' ? 0 : 101));
  const shot = Array.from({ length: shots }, (_, k) => ({
    start: k * period + (k === 0 ? 0 : Math.round(pr() * SHOT_TIME_JITTER_SEC * sr)),
    amp: (k % 2 === 0 ? 1 : ALT_BARREL) * (1 + SHOT_LEVEL_JITTER * pr()),
    clickAt: 0.004 + 0.0015 * (pr() + 1),
    clickHz: v.clickHz * (1 + 0.06 * pr()),
    ringPhase: pr() * Math.PI,
  }));
  const shared = rng(0xbb67ae85);
  const sharedNoise = new Float32Array(len);
  for (let i = 0; i < len; i++) sharedNoise[i] = shared();
  const win = Math.floor(SHOT_SEC * sr);
  const chs: Float32Array[] = [];
  for (let ch = 0; ch < 2; ch++) {
    const own = rng(0x3c6ef372 + ch * 7919 + (view === 'cockpit' ? 0 : 13));
    const crack = new Float32Array(len);
    const click = new Float32Array(len);
    const low = new Float32Array(len);
    for (const s of shot) {
      for (let j = 0; j < win; j++) {
        const i = (((s.start + j) % len) + len) % len;
        const t = j / sr;
        const n = 0.85 * sharedNoise[i]! + 0.5 * own();
        // The crack: near-instant attack, a couple of ms long.
        crack[i]! += s.amp * Math.min(1, t / 0.00012) * Math.exp(-t / v.crackTau) * n;
        // The feed's click, a few ms later.
        const tc = t - s.clickAt;
        if (tc >= 0) click[i]! += s.amp * Math.min(1, tc / 0.0001) * Math.exp(-tc / 0.0009) * n;
        // The thump and the airframe ringing.
        let l = v.thump * thumpAt(t, v.thumpHz0, v.thumpHz1, v.thumpTau);
        for (let m = 0; m < v.ringHz.length; m++) {
          l += (v.ring / (m + 1)) * Math.sin(2 * Math.PI * v.ringHz[m]! * (1 + 0.01 * ch) * t + s.ringPhase * (m + 1)) * Math.min(1, t / 0.001) * Math.exp(-t / v.ringTau);
        }
        low[i]! += s.amp * l;
      }
    }
    filterLoop(crack, band(v.crackLoHz, v.crackHiHz, sr));
    filterLoop(click, bandPass(v.clickHz, 5, sr));
    const d = buf.getChannelData(ch);
    // The crack's band takes level out of the noise: put it back so `crack` means what it says.
    const crackGain = 3.2 * v.crack;
    const clickGain = 6 * v.click;
    for (let i = 0; i < len; i++) d[i] = crackGain * crack[i]! + clickGain * click[i]! + low[i]!;
    // DC and the sub-bass speakers can't play out.
    filterLoop(d, ((): ((x: number) => number) => {
      const k = onePole(28, sr);
      let lo = 0;
      return (x) => {
        lo += (x - lo) * k;
        return x - lo;
      };
    })());
    chs.push(d);
  }
  finish(chs, v.drive, 0.98);
  return buf;
}

/** The tail's length, s. */
export const GUN_TAIL_SEC = 0.6;
/** The tail's peak against the loop's (full scale). */
const TAIL_LEVEL: Record<GunView, number> = { cockpit: 0.45, outside: 0.5 };

/**
 * After the last round: the airframe and barrels ringing down, the bolt's last clack, and
 * (outside) the report rolling away, fading to nothing by the end. Stereo, deterministic.
 */
export function createGunTailBuffer(ac: BaseAudioContext, view: GunView): AudioBuffer {
  const sr = ac.sampleRate;
  const v = VOICING[view];
  const len = Math.floor(sr * GUN_TAIL_SEC);
  const buf = ac.createBuffer(2, len, sr);
  const chs: Float32Array[] = [];
  const shared = rng(0x510e527f);
  const sharedNoise = new Float32Array(len);
  for (let i = 0; i < len; i++) sharedNoise[i] = shared();
  const outside = view === 'outside';
  for (let ch = 0; ch < 2; ch++) {
    const own = rng(0x9b05688c + ch * 7919);
    const d = buf.getChannelData(ch);
    const clack = new Float32Array(len);
    const roll = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const n = 0.8 * sharedNoise[i]! + 0.6 * own();
      // The bolt's last clack, ~15 ms on.
      const tc = t - 0.015;
      if (tc >= 0) clack[i] = Math.min(1, tc / 0.0001) * Math.exp(-tc / 0.0015) * n;
      // The report rolling away (outside), or the airframe's rumble settling (cockpit).
      roll[i] = Math.min(1, t / 0.004) * Math.exp(-t / (outside ? 0.14 : 0.06)) * n;
      // The airframe and barrels ringing down, slower than within the burst.
      let l = 0.8 * v.thump * Math.sin(2 * Math.PI * v.thumpHz1 * t) * Math.min(1, t / 0.003) * Math.exp(-t / 0.05);
      for (let m = 0; m < v.ringHz.length; m++) {
        l += (v.ring / (m + 1)) * Math.sin(2 * Math.PI * v.ringHz[m]! * (1 + 0.01 * ch) * t) * Math.min(1, t / 0.002) * Math.exp(-t / (0.06 + 0.02 * m));
      }
      d[i] = l;
    }
    const fClack = bandPass(v.clickHz * 0.8, 4, sr);
    const fRoll = band(outside ? 120 : 60, outside ? 2200 : 700, sr);
    for (let i = 0; i < len; i++) d[i]! += 3 * v.click * fClack(clack[i]!) + (outside ? 2.2 : 1.6) * fRoll(roll[i]!);
    // Fade the end to nothing.
    const fade = Math.floor(sr * 0.15);
    for (let i = 0; i < fade; i++) d[len - 1 - i]! *= i / fade;
    chs.push(d);
  }
  finish(chs, 1.2, TAIL_LEVEL[view]);
  return buf;
}

/** Levels in the mix (each buffer is full scale; the master limiter takes the peaks). */
const GUN_LEVEL: Record<GunView, number> = { cockpit: 0.75, outside: 0.9 };
/** The first round's accent over the rest (the burst's start hits hardest). */
const FIRST_ROUND_ACCENT = 1.25;
/** The spin-up: the loop starts at this fraction of the fire rate, reaching it in this long. */
const SPINUP_FROM = 0.78;
const SPINUP_SEC = 0.1;
/** The burst is over this long after the last round's event (the events come in batches). */
const GUN_HOLD_SEC = 0.06;

export interface GunVoice {
  /** A round fired (the sim's `gunFire` for the player). */
  fire(): void;
  /** Each frame: where it is heard from; a dead pilot hears no gun. */
  update(inCockpit: boolean, alive: boolean): void;
  /** From outside, the listener's distance from the jet (m): quieter and duller further off. */
  distance(m: number): void;
  silence(): void;
}

interface Burst {
  mix: GainNode;
  src: { view: GunView; node: AudioBufferSourceNode; gain: GainNode }[];
}

export function createGunVoice(ac: BaseAudioContext, dest: AudioNode): GunVoice {
  const loops: Record<GunView, AudioBuffer> = { cockpit: createGunLoopBuffer(ac, 'cockpit'), outside: createGunLoopBuffer(ac, 'outside') };
  const tails: Record<GunView, AudioBuffer> = { cockpit: createGunTailBuffer(ac, 'cockpit'), outside: createGunTailBuffer(ac, 'outside') };
  // Distance: a low-pass (air takes the highs) and a level.
  const tone = ac.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 20000;
  tone.Q.value = 0.5;
  const out = ac.createGain();
  tone.connect(out).connect(dest);
  let view: GunView = 'cockpit';
  let burst: Burst | null = null;
  let lastRound = -1;

  const start = (): void => {
    const t = ac.currentTime + 0.005;
    const mix = ac.createGain();
    mix.connect(tone);
    mix.gain.setValueAtTime(FIRST_ROUND_ACCENT, t);
    mix.gain.setTargetAtTime(1, t + 0.02, 0.04);
    const src = (['cockpit', 'outside'] as const).map((v) => {
      const node = ac.createBufferSource();
      node.buffer = loops[v];
      node.loop = true;
      node.playbackRate.setValueAtTime(SPINUP_FROM, t);
      node.playbackRate.linearRampToValueAtTime(1, t + SPINUP_SEC);
      const gain = ac.createGain();
      gain.gain.value = v === view ? GUN_LEVEL[v] : 0;
      node.connect(gain).connect(mix);
      node.start(t, 0);
      return { view: v, node, gain };
    });
    burst = { mix, src };
  };

  const stop = (withTail: boolean): void => {
    if (!burst) return;
    const t = ac.currentTime;
    const b = burst;
    burst = null;
    b.mix.gain.cancelScheduledValues(t);
    b.mix.gain.setTargetAtTime(0, t, 0.005);
    for (const s of b.src) {
      s.node.stop(t + 0.05);
      s.node.onended = () => s.gain.disconnect();
    }
    if (!withTail) return;
    const tail = ac.createBufferSource();
    tail.buffer = tails[view];
    const g = ac.createGain();
    g.gain.value = GUN_LEVEL[view];
    tail.connect(g).connect(tone);
    tail.onended = () => g.disconnect();
    tail.start(t);
  };

  return {
    fire() {
      lastRound = ac.currentTime;
      if (!burst) start();
    },
    update(inCockpit, alive) {
      const v: GunView = inCockpit ? 'cockpit' : 'outside';
      if (v !== view) {
        view = v;
        if (burst) for (const s of burst.src) s.gain.gain.setTargetAtTime(s.view === v ? GUN_LEVEL[s.view] : 0, ac.currentTime, 0.01);
      }
      if (burst && (!alive || ac.currentTime > lastRound + GUN_HOLD_SEC)) stop(alive);
    },
    distance(m) {
      const d = Math.max(0, m);
      const t = ac.currentTime;
      tone.frequency.setTargetAtTime(Math.max(1500, 20000 / (1 + d / 250)), t, 0.05);
      out.gain.setTargetAtTime(Math.min(1, Math.sqrt(80 / Math.max(1, d))), t, 0.05);
    },
    silence() {
      stop(false);
      lastRound = -1;
    },
  };
}
