import { describe, expect, it } from 'vitest';
import { GUN_LOOP_SHOTS, GUN_SHOT_HZ, GUN_TAIL_SEC, createGunLoopBuffer, createGunTailBuffer } from '../../src/ui/audio/gunSound';

describe('gun sound buffers', () => {
  const sr = 48000;
  const fake = {
    sampleRate: sr,
    createBuffer: (n: number, len: number) => {
      const ch = Array.from({ length: n }, () => new Float32Array(len));
      return { length: len, numberOfChannels: n, getChannelData: (i: number) => ch[i]! } as unknown as AudioBuffer;
    },
  } as unknown as BaseAudioContext;
  const peakOf = (d: Float32Array): number => d.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const rms = (d: Float32Array, i0: number, i1: number): number => {
    let s = 0;
    for (let i = i0; i < i1; i++) s += d[i]! * d[i]!;
    return Math.sqrt(s / (i1 - i0));
  };
  /** The energy envelope (|x| smoothed over ~1 ms), mean removed. */
  const envelope = (d: Float32Array): Float32Array => {
    const k = 1 - Math.exp(-1 / (0.001 * sr));
    const e = new Float32Array(d.length);
    let y = 0;
    for (let i = 0; i < d.length; i++) e[i] = y += (Math.abs(d[i]!) - y) * k;
    const mean = e.reduce((a, v) => a + v, 0) / e.length;
    return e.map((v) => v - mean);
  };
  const autocorr = (e: Float32Array, lag: number): number => {
    let s = 0;
    for (let i = 0; i < e.length; i++) s += e[i]! * e[(i + lag) % e.length]!;
    return s;
  };

  for (const view of ['cockpit', 'outside'] as const) {
    it(`${view}: a loop of whole shots, peak just under full scale`, () => {
      const b = createGunLoopBuffer(fake, view);
      const period = Math.round(sr / GUN_SHOT_HZ);
      const d0 = b.getChannelData(0);
      expect(d0.length).toBe(period * GUN_LOOP_SHOTS);
      for (const d of [d0, b.getChannelData(1)]) {
        expect(peakOf(d)).toBeLessThanOrEqual(0.98 + 1e-6);
        expect(d.every(Number.isFinite)).toBe(true);
      }
      expect(Math.max(peakOf(d0), peakOf(b.getChannelData(1)))).toBeGreaterThan(0.9);
    });

    it(`${view}: its energy repeats at the fire rate (~57 Hz), not at half of it`, () => {
      const e = envelope(createGunLoopBuffer(fake, view).getChannelData(0));
      // The strongest repetition between 10 and 30 ms is one shot period.
      let best = 0;
      let bestLag = 0;
      for (let lag = Math.floor(0.01 * sr); lag <= Math.floor(0.03 * sr); lag++) {
        const c = autocorr(e, lag);
        if (c > best) {
          best = c;
          bestLag = lag;
        }
      }
      expect(sr / bestLag).toBeGreaterThan(GUN_SHOT_HZ * 0.97);
      expect(sr / bestLag).toBeLessThan(GUN_SHOT_HZ * 1.03);
      // Sharp shots: half a period off, the envelope is far from itself.
      const period = Math.round(sr / GUN_SHOT_HZ);
      expect(autocorr(e, Math.round(period / 2))).toBeLessThan(best * 0.5);
    });

    it(`${view}: loops without a click at the seam`, () => {
      const d = createGunLoopBuffer(fake, view).getChannelData(0);
      let maxStep = 0;
      for (let i = 1; i < d.length; i++) maxStep = Math.max(maxStep, Math.abs(d[i]! - d[i - 1]!));
      expect(Math.abs(d[0]! - d[d.length - 1]!)).toBeLessThanOrEqual(maxStep);
    });

    it(`${view}: the tail rings down to nothing, under the burst's level`, () => {
      const loop = createGunLoopBuffer(fake, view).getChannelData(0);
      const d = createGunTailBuffer(fake, view).getChannelData(0);
      expect(d.length).toBe(Math.floor(sr * GUN_TAIL_SEC));
      expect(peakOf(d)).toBeLessThan(peakOf(loop));
      const head = rms(d, 0, Math.floor(0.05 * sr));
      expect(head).toBeGreaterThan(0.02);
      expect(rms(d, d.length - Math.floor(0.05 * sr), d.length)).toBeLessThan(head * 0.02);
      expect(Math.abs(d[d.length - 1]!)).toBeLessThan(1e-3);
    });
  }

  it('is the same every time', () => {
    const a = createGunLoopBuffer(fake, 'cockpit').getChannelData(1);
    const b = createGunLoopBuffer(fake, 'cockpit').getChannelData(1);
    expect(Array.from(a)).toEqual(Array.from(b));
    const ta = createGunTailBuffer(fake, 'outside').getChannelData(0);
    const tb = createGunTailBuffer(fake, 'outside').getChannelData(0);
    expect(Array.from(ta)).toEqual(Array.from(tb));
  });

  it('is brighter outside, with more low thump in the cockpit', () => {
    // Brightness: the energy of the sample-to-sample difference against the signal's.
    const bright = (d: Float32Array): number => {
      let diff = 0;
      let all = 0;
      for (let i = 1; i < d.length; i++) {
        diff += (d[i]! - d[i - 1]!) ** 2;
        all += d[i]! ** 2;
      }
      return diff / all;
    };
    // The low share: a 150 Hz one-pole low-pass's energy against the signal's.
    const lowShare = (d: Float32Array): number => {
      const k = 1 - Math.exp((-2 * Math.PI * 150) / sr);
      let y = 0;
      let lo = 0;
      let all = 0;
      for (const v of d) {
        y += (v - y) * k;
        lo += y * y;
        all += v * v;
      }
      return lo / all;
    };
    const cockpit = createGunLoopBuffer(fake, 'cockpit').getChannelData(0);
    const outside = createGunLoopBuffer(fake, 'outside').getChannelData(0);
    expect(bright(outside)).toBeGreaterThan(bright(cockpit) * 1.5);
    expect(lowShare(cockpit)).toBeGreaterThan(lowShare(outside));
  });

  it('works at 44.1 kHz too', () => {
    const f44 = { ...fake, sampleRate: 44100, createBuffer: (fake as unknown as { createBuffer: (n: number, l: number) => AudioBuffer }).createBuffer } as unknown as BaseAudioContext;
    const d = createGunLoopBuffer(f44, 'outside').getChannelData(0);
    expect(d.length).toBe(Math.round(44100 / GUN_SHOT_HZ) * GUN_LOOP_SHOTS);
    expect(peakOf(d)).toBeLessThanOrEqual(0.98 + 1e-6);
  });
});
