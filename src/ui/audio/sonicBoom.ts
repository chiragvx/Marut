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
 * what speakers play):
 * - the double crack: the N-wave (its length grows as distance^1/4, about 0.08 s for a fighter a
 *   few hundred metres off) with a sharp broadband crack on each shock;
 * - the punch: a falling low thump (90 -> 38 Hz) at each shock, the "boom" a speaker can play;
 * - the ground reflection a few ms behind (wider apart in the two ears);
 * - the roll: low rumble swelling just after and rolling on for seconds, and a few duller echoes
 *   off the terrain, like thunder.
 * Further off it is duller and longer. The buffer is normalised to full scale (the master bus
 * limits it).
 */
export function createBoomBuffer(ac: BaseAudioContext, distM: number): AudioBuffer {
  const sr = ac.sampleRate;
  const d0 = Math.max(50, distM);
  const nLen = 0.08 * Math.pow(d0 / 300, 0.25);
  const reflDelay = Math.min(0.03, 0.004 + distM / 60000);
  const len = Math.floor(sr * 4.2);
  const buf = ac.createBuffer(2, len, sr);
  // Duller with distance (air takes the highs).
  const crackHz = Math.max(1800, 11000 / (1 + d0 / 1500));
  const rollSec = 1.1 + Math.min(1.2, d0 / 2500);
  let seed = 0x9e3779b9 ^ Math.floor(d0);
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  const nWave = (t: number): number => (t < 0 || t > nLen ? 0 : 1 - (2 * t) / nLen);
  // A low thump at t0: a falling sine (90 -> 38 Hz), quick attack, ~0.25 s decay.
  const thump = (t: number, t0: number, decay = 0.25): number => {
    const u = t - t0;
    if (u < 0 || u > decay * 6) return 0;
    const phase = 2 * Math.PI * (38 * u + 52 * 0.06 * (1 - Math.exp(-u / 0.06)));
    return Math.sin(phase) * Math.min(1, u / 0.002) * Math.exp(-u / decay);
  };
  // Echoes off the terrain: [delay s, level, decay s].
  const echoes: readonly [number, number, number][] = [
    [0.38 + d0 / 9000, 0.32, 0.35],
    [0.85 + d0 / 6000, 0.2, 0.45],
    [1.6 + d0 / 4000, 0.11, 0.6],
  ];
  const peaks = [0, 0];
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const refl = reflDelay + ch * 0.0009;
    let r1 = 0;
    let r2 = 0;
    let lfo = 0;
    let lfoT = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // The N-wave, and its reflection.
      let s = 0.9 * (nWave(t) + 0.65 * nWave(t - refl));
      // The cracks: short broadband bursts on the bow and tail shocks (and their reflections).
      for (const [t0, a] of [[0, 1], [nLen, 0.9], [refl, 0.6], [nLen + refl, 0.55]] as const) {
        const u = t - t0;
        if (u >= 0 && u < 0.04) s += rnd() * a * 3.2 * Math.exp(-u / 0.006);
      }
      // The punch on each shock.
      s += 1.25 * thump(t, 0) + 1.0 * thump(t, nLen) + 0.6 * thump(t, refl, 0.3);
      // The roll: low rumble (two one-poles, ~100 Hz), swelling then rolling away, wobbling slowly.
      r1 += (rnd() - r1) * 0.015;
      r2 += (r1 - r2) * 0.03;
      if (t >= lfoT) {
        lfoT = t + 0.12 + 0.2 * Math.abs(rnd());
        lfo = 0.55 + 0.45 * Math.abs(rnd());
      }
      s += r2 * 14 * lfo * Math.min(1, t / 0.05) * Math.exp(-t / rollSec);
      // Echoes: duller thumps arriving later.
      for (const [dl, a, dc] of echoes) s += a * thump(t, dl + ch * 0.011, dc);
      d[i] = s;
    }
    // Shape: the cracks' top end (one-pole low-pass), DC out.
    let lp = 0;
    let dc = 0;
    const k = 1 - Math.exp((-2 * Math.PI * crackHz) / sr);
    for (let i = 0; i < len; i++) {
      lp += (d[i]! - lp) * k;
      dc += (lp - dc) * 0.0003;
      d[i] = lp - dc;
      peaks[ch] = Math.max(peaks[ch]!, Math.abs(d[i]!));
    }
    // Fade the tail to nothing.
    const fade = Math.floor(sr * 0.5);
    for (let i = 0; i < fade; i++) d[len - 1 - i]! *= i / fade;
  }
  // Full scale (both ears by the same factor), then driven hard into a soft saturator: the
  // average level jumps (a dense, wall-shaking boom) while the peak stays at full scale.
  const norm = 1 / Math.max(1e-6, peaks[0]!, peaks[1]!);
  const tn = Math.tanh(BOOM_DRIVE);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (0.98 * Math.tanh(BOOM_DRIVE * d[i]! * norm)) / tn;
  }
  return buf;
}

/** How hard the boom is driven into its saturator (louder and denser as it rises). */
const BOOM_DRIVE = 5;

/**
 * The boom's level at `distM` from the flight path: full within ~700 m, then falling (overpressure
 * ~ distance^-3/4, eased). Over 1: it drives the master limiter, the rest of the mix ducking under it.
 */
export function boomGain(distM: number): number {
  return Math.min(4, 4 * Math.pow(700 / Math.max(50, distM), 0.6));
}
