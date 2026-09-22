import { describe, it, expect } from 'vitest';
import { createPrng, nextFloat01, deriveSubSeed } from '../../src/math';

describe('mulberry32 PRNG (bit-exact)', () => {
  it('createPrng(1) sequence', () => {
    const s = createPrng(1);
    expect(nextFloat01(s)).toBe(0.6270739405881613);
    expect(nextFloat01(s)).toBe(0.002735721180215478);
    expect(nextFloat01(s)).toBe(0.5274470399599522);
  });

  it('createPrng(12345) sequence', () => {
    const s = createPrng(12345);
    const out: number[] = [];
    for (let i = 0; i < 5; i++) out.push(nextFloat01(s));
    expect(out).toEqual([
      0.9797282677609473,
      0.3067522644996643,
      0.484205421525985,
      0.817934412509203,
      0.5094283693470061,
    ]);
  });

  it('every output over 100000 calls is within [0,1)', () => {
    const s = createPrng(999);
    for (let i = 0; i < 100000; i++) {
      const v = nextFloat01(s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('deriveSubSeed', () => {
  it('worked examples', () => {
    expect(deriveSubSeed(42, 'terrain')).toBe(2176990980);
    expect(deriveSubSeed(42, 'ai:red-1')).toBe(1195213530);
  });

  it('is a pure function (same args -> same result)', () => {
    expect(deriveSubSeed(42, 'terrain')).toBe(deriveSubSeed(42, 'terrain'));
  });

  it('feeding the derived sub-seed into createPrng reproduces the worked example stream', () => {
    const s = createPrng(deriveSubSeed(42, 'terrain'));
    const out = [nextFloat01(s), nextFloat01(s), nextFloat01(s)];
    expect(out).toEqual([0.35095783742144704, 0.29663478187285364, 0.6339825305622071]);
  });
});
