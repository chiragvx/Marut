import { describe, expect, it } from 'vitest';
import { boomGain, createBoomBuffer, machConeState, soundSpeedAt } from '../../src/ui/audio/sonicBoom';

describe('sonic boom', () => {
  it('speed of sound falls with altitude to the tropopause', () => {
    expect(soundSpeedAt(0)).toBeCloseTo(340.3, 1);
    expect(soundSpeedAt(11000)).toBeCloseTo(295.1, 0);
    expect(soundSpeedAt(15000)).toBeCloseTo(soundSpeedAt(11000), 6);
  });

  it('no cone below the speed of sound', () => {
    expect(machConeState({ x: -100, y: 0, z: 0 }, { x: 300, y: 0, z: 0 }, 340)).toBe('subsonic');
  });

  it('ahead of the jet and beside it, the cone has not arrived; well behind it, it has', () => {
    const vel = { x: 680, y: 0, z: 0 }; // Mach 2: half-angle 30 deg
    const c = 340;
    // Listener 300 m off the flight path; jet (rel = jet - listener) still 500 m short of abeam.
    expect(machConeState({ x: -500, y: 0, z: 300 }, vel, c)).toBe('outside');
    // Abeam: still outside (the cone trails the jet).
    expect(machConeState({ x: 0, y: 0, z: 300 }, vel, c)).toBe('outside');
    // 300 / tan(30) = 520 m past: on the cone. 450 m past: outside; 600 m past: inside.
    expect(machConeState({ x: 450, y: 0, z: 300 }, vel, c)).toBe('outside');
    expect(machConeState({ x: 600, y: 0, z: 300 }, vel, c)).toBe('inside');
  });
});

describe('createBoomBuffer / boomGain', () => {
  const sr = 48000;
  const fake = {
    sampleRate: sr,
    createBuffer: (n: number, len: number) => {
      const ch = Array.from({ length: n }, () => new Float32Array(len));
      return { getChannelData: (i: number) => ch[i]! } as unknown as AudioBuffer;
    },
  } as unknown as BaseAudioContext;
  const rms = (d: Float32Array, t0: number, t1: number): number => {
    let s = 0;
    for (let i = Math.floor(t0 * sr); i < Math.floor(t1 * sr); i++) s += d[i]! * d[i]!;
    return Math.sqrt(s / ((t1 - t0) * sr));
  };

  it('is full scale, punches at once and rolls on for seconds', () => {
    const d = createBoomBuffer(fake, 400).getChannelData(0);
    let peak = 0;
    for (const v of d) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.9);
    expect(peak).toBeLessThanOrEqual(1);
    const hit = rms(d, 0, 0.3);
    expect(rms(d, 1.0, 1.5)).toBeGreaterThan(hit * 0.02); // still rolling a second later
    expect(rms(d, 1.0, 1.5)).toBeLessThan(hit); // but well under the hit
    expect(rms(d, d.length / sr - 0.05, d.length / sr)).toBeLessThan(hit * 0.01); // fades out
  });

  it('is loud close by and falls off with distance', () => {
    expect(boomGain(200)).toBeCloseTo(4);
    expect(boomGain(1500)).toBeLessThan(boomGain(700));
    expect(boomGain(5000)).toBeLessThan(boomGain(1500));
    expect(boomGain(5000)).toBeGreaterThan(0.2);
  });
});
