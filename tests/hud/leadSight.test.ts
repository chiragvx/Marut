import { describe, expect, it } from 'vitest';
import { WeaponKindCode } from '../../src/contracts/core';
import { computePipperWorldPoint, type PipperGateFields } from '../../src/hud/targetBox';

describe('leadSight gate (computePipperWorldPoint)', () => {
  it('passes and returns the exact world point when valid, gun selected, in range', () => {
    const fields: PipperGateFields = {
      pipperValid: 1,
      weaponIdx: WeaponKindCode.gun,
      targetRangeM: 1000,
      pipperX: 1000,
      pipperY: 9.638,
      pipperZ: 70.1,
    };
    const out = { x: 0, y: 0, z: 0 };
    const result = computePipperWorldPoint(fields, out);
    expect(result).not.toBeNull();
    expect(out.x).toBe(1000);
    expect(out.y).toBe(9.638);
    expect(out.z).toBe(70.1);
  });

  it('is not drawn when pipperValid is 0, regardless of weaponIdx/targetRangeM', () => {
    const fields: PipperGateFields = {
      pipperValid: 0,
      weaponIdx: WeaponKindCode.gun,
      targetRangeM: 100,
      pipperX: 1,
      pipperY: 2,
      pipperZ: 3,
    };
    const out = { x: 0, y: 0, z: 0 };
    expect(computePipperWorldPoint(fields, out)).toBeNull();
  });

  it('is not drawn just over GUN_MAX_EFFECTIVE_RANGE_M', () => {
    const fields: PipperGateFields = {
      pipperValid: 1,
      weaponIdx: WeaponKindCode.gun,
      targetRangeM: 1800.001,
      pipperX: 1,
      pipperY: 2,
      pipperZ: 3,
    };
    const out = { x: 0, y: 0, z: 0 };
    expect(computePipperWorldPoint(fields, out)).toBeNull();
  });
});
