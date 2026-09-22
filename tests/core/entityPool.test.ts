/**
 * tests/core/entityPool.test.ts — packEntityId/unpackEntityId round-trip,
 * generation increments on despawn/respawn. See docs/spec/12-verification.md
 * section 7.
 */
import { describe, expect, test } from 'vitest';
import { NO_ENTITY_ID } from '../../src/contracts/core';
import { createEntityPool, packEntityId, unpackEntityId } from '../../src/core/entityPool';

describe('packEntityId / unpackEntityId', () => {
  test('round-trips without bitwise overflow at high generation', () => {
    const id = packEntityId(42, 40000); // generation > 0x8000, would corrupt with `<<`
    const { index, generation } = unpackEntityId(id);
    expect(index).toBe(42);
    expect(generation).toBe(40000);
  });

  test('index alone (generation=0) round-trips', () => {
    const { index, generation } = unpackEntityId(packEntityId(0, 0));
    expect(index).toBe(0);
    expect(generation).toBe(0);
  });

  test('round-trips across a spread of indices/generations', () => {
    for (const index of [0, 1, 31, 65535]) {
      for (const generation of [0, 1, 100, 40000, 1_000_000]) {
        const id = packEntityId(index, generation);
        const unpacked = unpackEntityId(id);
        expect(unpacked.index).toBe(index);
        expect(unpacked.generation).toBe(generation);
      }
    }
  });
});

describe('EntityPool', () => {
  const capacity = { aircraft: 4, missile: 4, bullet: 4, effect: 4 };

  test('allocate returns a fresh, alive entity; release marks it not alive', () => {
    const pool = createEntityPool(capacity);
    const id = pool.allocate('aircraft', 0);
    expect(id).not.toBe(NO_ENTITY_ID);
    expect(pool.isAlive(id)).toBe(true);
    const state = pool.get(id);
    expect(state).toBeDefined();
    expect(state?.alive).toBe(true);
    expect(state?.hp).toBe(100);

    pool.release(id);
    expect(pool.isAlive(id)).toBe(false);
  });

  test('generation increments when a released slot is reallocated, so the stale id is detected', () => {
    const pool = createEntityPool({ aircraft: 1, missile: 0, bullet: 0, effect: 0 });
    const firstId = pool.allocate('aircraft', 0);
    const { index: firstIndex, generation: firstGeneration } = unpackEntityId(firstId);
    pool.release(firstId);

    const secondId = pool.allocate('aircraft', 1);
    const { index: secondIndex, generation: secondGeneration } = unpackEntityId(secondId);

    expect(secondIndex).toBe(firstIndex); // same reused slot
    expect(secondGeneration).toBeGreaterThan(firstGeneration);
    expect(pool.isAlive(firstId)).toBe(false); // stale id from before the release must not read as alive
    expect(pool.isAlive(secondId)).toBe(true);
  });

  test('allocate beyond a kind budget returns NO_ENTITY_ID rather than throwing', () => {
    const pool = createEntityPool({ aircraft: 1, missile: 0, bullet: 0, effect: 0 });
    const first = pool.allocate('aircraft', 0);
    expect(first).not.toBe(NO_ENTITY_ID);
    const second = pool.allocate('aircraft', 0);
    expect(second).toBe(NO_ENTITY_ID);
  });

  test('liveCount and liveAt reflect only currently-allocated entities', () => {
    const pool = createEntityPool(capacity);
    expect(pool.liveCount).toBe(0);
    const a = pool.allocate('aircraft', 0);
    const b = pool.allocate('aircraft', 1);
    expect(pool.liveCount).toBe(2);
    const ids = [pool.liveAt(0).id, pool.liveAt(1).id].sort();
    expect(ids).toEqual([a, b].sort());
  });

  test('get returns undefined for a stale/invalid id', () => {
    const pool = createEntityPool(capacity);
    const id = pool.allocate('aircraft', 0);
    pool.release(id);
    expect(pool.get(id)).toBeUndefined();
  });
});
