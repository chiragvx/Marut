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
 * The boom at `distM` from the flight path: an N-wave (its length grows as distance^1/4, about
 * 0.1 s for a fighter a few hundred metres off), its ground reflection a few ms behind it, with
 * the shocks' rise softened (a few kHz) and the low rumble rolling after it.
 */
export function createBoomBuffer(ac: BaseAudioContext, distM: number): AudioBuffer {
  const sr = ac.sampleRate;
  const nLen = 0.075 * Math.pow(Math.max(50, distM) / 300, 0.25);
  const reflDelay = Math.min(0.03, 0.004 + distM / 60000);
  const len = Math.floor(sr * 2.4);
  const buf = ac.createBuffer(2, len, sr);
  const nWave = (t: number): number => (t < 0 || t > nLen ? 0 : 1 - (2 * t) / nLen);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let rumble = 0;
    let rumble2 = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // Two cracks (bow and tail shocks), the reflection off the ground a moment after.
      let s = nWave(t) + 0.7 * nWave(t - reflDelay - ch * 0.0004);
      // The rumble: low, filtered noise, swelling just after the cracks and rolling away.
      rumble += (Math.random() * 2 - 1 - rumble) * 0.02;
      rumble2 += (rumble - rumble2) * 0.05;
      s += rumble2 * 9 * Math.min(1, t / 0.03) * Math.exp(-t / 0.45);
      d[i] = s;
    }
    // Soften the shocks' rise (a one-pole low-pass at ~4 kHz) and take out the DC.
    let lp = 0;
    let dc = 0;
    const k = 1 - Math.exp((-2 * Math.PI * 4000) / sr);
    for (let i = 0; i < len; i++) {
      lp += (d[i]! - lp) * k;
      dc += (lp - dc) * 0.0004;
      d[i] = (lp - dc) * 0.8;
    }
    // Fade the tail to nothing.
    const fade = Math.floor(sr * 0.3);
    for (let i = 0; i < fade; i++) d[len - 1 - i]! *= i / fade;
  }
  return buf;
}
