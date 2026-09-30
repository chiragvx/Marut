/**
 * tests/catalog/storeCodes.test.ts — every catalogue store can ride in the snapshot (it has a
 * STORE_IDS code inside the packing's code range) and has display names for the HUD/stores page.
 */
import { describe, expect, test } from 'vitest';
import { MAX_STORE_CODE, STORE_IDS } from '../../src/contracts/core';
import { FUEL_TANKS, WEAPONS, storeInfo } from '../../src/catalog';

describe('store codes', () => {
  const ids = [...Object.keys(WEAPONS).filter((id) => WEAPONS[id]!.kind !== 'gun'), ...Object.keys(FUEL_TANKS)];

  test('every carried store has a snapshot code within range', () => {
    expect(STORE_IDS.length - 1).toBeLessThanOrEqual(MAX_STORE_CODE);
    expect(new Set(STORE_IDS).size).toBe(STORE_IDS.length);
    for (const id of ids) expect(STORE_IDS.indexOf(id), id).toBeGreaterThan(0);
  });

  test('every store has a label and a short station legend', () => {
    for (const id of [...ids, 'gsh-23']) {
      const info = storeInfo(id)!;
      expect(info, id).toBeDefined();
      expect(info.label.length, id).toBeGreaterThan(0);
      expect(info.short.length, id).toBeGreaterThan(0);
      expect(info.short.length, id).toBeLessThanOrEqual(4);
    }
    expect(storeInfo('nope')).toBeUndefined();
  });
});
