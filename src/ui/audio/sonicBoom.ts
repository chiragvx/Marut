/**
 * src/ui/audio/sonicBoom.ts — the sonic boom, heard from a camera standing still outside the jet
 * (the flyby view) as a supersonic jet goes past.
 *
 * Faster than sound, the jet drags a cone of pressure behind it (the Mach cone, half-angle
 * asin(c / v)). Ahead of it and outside the cone nothing of the jet has reached you yet: it comes
 * in silence. The moment the cone's surface sweeps over you, you hear the boom, the double crack
 * of the N-wave (the jump at the nose's shock, the fall to under ambient, the jump back at the
 * tail's), and only after it the engine's roar.
 *
 * `machConeState` (pure, tested) says where a listener is; `createBoomBuffer` synthesises the boom
 * (no recorded sound).
 */
import type { Vec3Like } from '../../contracts/core';

/** Speed of sound at an altitude (ISA troposphere, constant above the tropopause), m/s. */
export function soundSpeedAt(altM: number): number {
  const t = Math.max(216.65, 288.15 - 0.0065 * Math.max(0, altM));
  return 340.3 * Math.sqrt(t / 288.15);
}

/**
 * Where the listener is relative to the Mach cone of a source at `rel` from it (source minus
 * listener) moving at `vel`, with sound at `c`: 'subsonic' (no cone), 'outside' (ahead of the
 * cone: not heard yet) or 'inside' (the cone has passed over: heard).
 */
export function machConeState(rel: Vec3Like, vel: Vec3Like, c: number): 'subsonic' | 'outside' | 'inside' {
  const u = Math.hypot(vel.x, vel.y, vel.z);
  if (u <= c) return 'subsonic';
  // The listener from the source, along the flight path (a < 0: behind) and across it (b).
  const a = -(rel.x * vel.x + rel.y * vel.y + rel.z * vel.z) / u;
  const r2 = rel.x * rel.x + rel.y * rel.y + rel.z * rel.z;
  const b = Math.sqrt(Math.max(0, r2 - a * a));
  if (a >= 0) return 'outside';
  // Inside the cone behind the jet: across / behind <= tan(mu), tan(mu) = c / sqrt(u^2 - c^2).
  return b * Math.sqrt(u * u - c * c) <= -a * c ? 'inside' : 'outside';
}

/**
 * The boom at `distM` from the flight path, built to be felt (the N-wave alone is mostly below
 * what speakers play), voiced after the boom heard in a modern combat sim:
 * - the double crack: the N-wave (its length grows as distance^1/4, ~0.12 s a few hundred metres
 *   off) with a broadband crack on each shock, ~60 ms of it, a snap over a heavy body;
 * - the punch: a falling low thump (80 -> 56 Hz) at each shock, the "boom" a speaker can play;
 * - the ground reflection a few ms behind (wider apart in the two ears);
 * - the roar: straight after the cracks, a dense low-mid rumble (mostly 100-800 Hz) only a few dB
 *   under them, held for ~5 s like rolling thunder, wobbling slowly, with a few duller echoes off
 *   the terrain in it, then dying away.
 * Further off it is duller. The buffer is driven to full scale (the master bus limits it).
 */
export function createBoomBuffer(ac: BaseAudioContext, distM: number): AudioBuffer {
  const sr = ac.sampleRate;
  const d0 = Math.max(50, distM);
  const nLen = 0.12 * Math.pow(d0 / 300, 0.25);
  const reflDelay = Math.min(0.03, 0.004 + distM / 60000);
  const len = Math.floor(sr * BOOM_SEC);
  const buf = ac.createBuffer(2, len, sr);
  // Duller with distance (air takes the highs).
  const crackHz = Math.max(1800, 5000 / (1 + d0 / 2000));
  const roarHz = Math.max(300, 600 / (1 + d0 / 4000));
  const rng = (s0: number): (() => number) => {
    let seed = s0 >>> 0;
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2147483648 - 1;
    };
  };
  // Noise shared by both ears and each ear's own (the two ears mostly, not wholly, alike).
  const shared = rng(0x9e3779b9 ^ Math.floor(d0));
  const sharedCrack = new Float32Array(len);
  const sharedRoar = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    sharedCrack[i] = shared();
    sharedRoar[i] = shared();
  }
  const lp = (hz: number): number => 1 - Math.exp((-2 * Math.PI * hz) / sr);
  const kCrack = lp(crackHz);
  const kBody = lp(500);
  const kRoar = lp(roarHz);
  const kRoarHi = lp(roarHz * 4);
  const kHp = lp(55);
  const nWave = (t: number): number => (t < 0 || t > nLen ? 0 : 1 - (2 * t) / nLen);
  // A low thump at t0: a falling sine (80 -> 56 Hz), quick attack.
  const thump = (t: number, t0: number, decay = 0.3): number => {
    const u = t - t0;
    if (u < 0 || u > decay * 6) return 0;
    const phase = 2 * Math.PI * (56 * u + 24 * 0.05 * (1 - Math.exp(-u / 0.05)));
    return Math.sin(phase) * Math.min(1, u / 0.002) * Math.exp(-u / decay);
  };
  // Echoes off the terrain inside the roar: [delay s, level, decay s].
  const echoes: readonly [number, number, number][] = [
    [0.45 + d0 / 9000, 0.35, 0.35],
    [1.1 + d0 / 6000, 0.25, 0.45],
    [2.2 + d0 / 4000, 0.18, 0.6],
  ];
  const fadeAt = BOOM_SEC - 1.0;
  const peaks = [0, 0];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const own = rng(0x51ed27 + ch * 7919 + Math.floor(d0));
    const refl = reflDelay + ch * 0.0009;
    let c1 = 0;
    let b1 = 0;
    let b2 = 0;
    let r1 = 0;
    let r2 = 0;
    let rh = 0;
    let rLow = 0;
    let lfo = 1;
    let lfoTo = 1;
    let lfoT = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // The cracks: ~60 ms broadband bursts on the bow and tail shocks (and their reflections).
      let crack = 0;
      for (const [t0, a] of [[0, 1], [nLen, 0.9], [refl, 0.5], [nLen + refl, 0.45]] as const) {
        const u = t - t0;
        if (u >= 0 && u < 0.09) crack += a * Math.min(1, u / 0.0015) * Math.exp(-u / 0.022);
      }
      if (crack > 0) crack *= 0.85 * sharedCrack[i]! + 0.45 * own();
      c1 += (crack - c1) * kCrack;
      // ...with body (its low mids) under the snap.
      b1 += (crack - b1) * kBody;
      b2 += (b1 - b2) * kBody;
      // The N-wave (and its reflection), and the punch on each shock.
      let s = CRACK * (c1 + BODY * b2) + 0.5 * (nWave(t) + 0.65 * nWave(t - refl));
      s += 0.9 * thump(t, 0) + 0.8 * thump(t, nLen) + 0.45 * thump(t, refl, 0.35);
      // The roar: low-mid rumble (two low-passes, a little brighter edge, low end cut), coming in
      // as the cracks end, held, wobbling, and dying away at the end.
      const n = 0.85 * sharedRoar[i]! + 0.45 * own();
      r1 += (n - r1) * kRoar;
      r2 += (r1 - r2) * kRoar;
      rh += (n - rh) * kRoarHi;
      const roarRaw = r2 * 9 + rh * 0.22;
      rLow += (roarRaw - rLow) * kHp;
      if (t >= lfoT) {
        lfoT = t + 0.15 + 0.25 * Math.abs(own());
        lfoTo = 0.7 + 0.3 * Math.abs(own());
      }
      lfo += (lfoTo - lfo) * 0.0004;
      const rise = Math.min(1, Math.max(0, (t - nLen - 0.01) / 0.1));
      const fall = t < fadeAt ? 1 : Math.max(0, 1 - (t - fadeAt) / (BOOM_SEC - fadeAt));
      s += ROAR * (roarRaw - rLow) * lfo * rise * Math.exp(-t / 9) * fall * fall;
      // Echoes: duller thumps arriving later.
      for (const [dl, a, dc] of echoes) s += a * thump(t, dl + ch * 0.011, dc);
      d[i] = s;
    }
    // DC and the sub-bass speakers can't play out (a one-pole high-pass at ~30 Hz).
    let dc = 0;
    const kDc = lp(30);
    for (let i = 0; i < len; i++) {
      dc += (d[i]! - dc) * kDc;
      d[i] = d[i]! - dc;
      peaks[ch] = Math.max(peaks[ch]!, Math.abs(d[i]!));
    }
    // Fade the tail to nothing.
    const fade = Math.floor(sr * 0.3);
    for (let i = 0; i < fade; i++) d[len - 1 - i]! *= i / fade;
  }
  // Full scale (both ears by the same factor), then driven into a soft saturator: the average
  // level jumps (a dense, wall-shaking boom) while the peak stays at full scale.
  const norm = 1 / Math.max(1e-6, peaks[0]!, peaks[1]!);
  const tn = Math.tanh(BOOM_DRIVE);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (0.98 * Math.tanh(BOOM_DRIVE * d[i]! * norm)) / tn;
  }
  return buf;
}

/** The boom's length, s (the cracks, then ~5 s of roar). */
const BOOM_SEC = 6.5;
/** The cracks' level, their body's under them, and the roar's. */
const CRACK = 2.6;
const BODY = 3;
const ROAR = 1;
/** How hard the boom is driven into its saturator (louder and denser as it rises). */
const BOOM_DRIVE = 3;

/**
 * The boom's level at `distM` from the flight path: full within ~700 m, then falling (overpressure
 * ~ distance^-3/4, eased). Over 1: it drives the master limiter, the rest of the mix ducking under it.
 */
export function boomGain(distM: number): number {
  return Math.min(4, 4 * Math.pow(700 / Math.max(50, distM), 0.6));
}
