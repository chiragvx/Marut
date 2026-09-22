import { describe, expect, it } from 'vitest';
import { subSeed } from '../../src/core/seed';

describe('subSeed', () => {
  it('worked examples', () => {
    expect(subSeed(42, 'ai:a')).toBe(1264669096);
    expect(subSeed(42, 'ai:b')).toBe(1315001953);
    expect(subSeed(43, 'terrain')).toBe(2108588079);
    expect(subSeed(1234567, 'wind')).toBe(1578955088);
  });

  it('same args -> same result; different tag -> different result', () => {
    expect(subSeed(42, 'ai:a')).toBe(subSeed(42, 'ai:a'));
    expect(subSeed(42, 'ai:a')).not.toBe(subSeed(42, 'ai:b'));
  });
});
