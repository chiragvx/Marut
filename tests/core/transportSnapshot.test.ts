import { describe, expect, test } from 'vitest';
import { packEngines, packUnits4, unpackEngines, unpackUnits4 } from '../../src/contracts/core';

describe('transport snapshot packing (SnapshotEntity.HIGH_LIFT / ENGINES)', () => {
  test('four unit values round-trip to 1/255', () => {
    const out = [0, 0, 0, 0];
    unpackUnits4(packUnits4(0.25, 1, 0, 0.6), out);
    expect(out[0]).toBeCloseTo(0.25, 2);
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(0);
    expect(out[3]).toBeCloseTo(0.6, 2);
  });
  test('four engines: N1 and reverser round-trip to 1/63, independently', () => {
    const n1 = [0, 0, 0, 0], rev = [0, 0, 0, 0];
    unpackEngines(packEngines([0.26, 1, 0.5, 0.9], [0, 1, 0.5, 0]), n1, rev);
    [0.26, 1, 0.5, 0.9].forEach((v, i) => expect(Math.abs(n1[i]! - v)).toBeLessThan(1 / 63));
    [0, 1, 0.5, 0].forEach((v, i) => expect(Math.abs(rev[i]! - v)).toBeLessThan(1 / 63));
    expect(Number.isSafeInteger(packEngines([1, 1, 1, 1], [1, 1, 1, 1]))).toBe(true);
  });
});
