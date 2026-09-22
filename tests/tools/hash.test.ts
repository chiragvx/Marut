/**
 * tests/tools/hash.test.ts — HashSimState fixed-vector regression.
 * See docs/spec/12-verification.md section 4.4.
 */
import { describe, expect, test } from 'vitest';
import type { ObservedEntity } from '../../src/contracts/verify';
import { hashSimState } from '../../tools/lib/hash';

describe('hashSimState', () => {
  test('known vector hashes to the pinned golden value', () => {
    const e: ObservedEntity = {
      state: {
        id: 1,
        kind: 'aircraft',
        team: 0,
        pos: { x: 100, y: 2000, z: -500 },
        rot: { x: 0, y: 0, z: 0, w: 1 },
        vel: { x: 50, y: 0, z: -150 },
        omega: { x: 0, y: 0, z: 0 },
        alive: true,
        hp: 100,
        fuelKg: 0,
        elevonL: 0,
        elevonR: 0,
        rudder: 0,
        gearPos: 0,
        throttle: 0.8,
        afterburnerOn: false,
        flags: 0,
      },
    };
    expect(hashSimState([e])).toBe('fbe75177');
  });

  test('same entity array contents hash identically on repeated calls', () => {
    const e: ObservedEntity = {
      state: {
        id: 7,
        kind: 'missile',
        team: 1,
        pos: { x: 1, y: 2, z: 3 },
        rot: { x: 0, y: 0, z: 0, w: 1 },
        vel: { x: 10, y: 0, z: 0 },
        omega: { x: 0, y: 0, z: 0 },
        alive: true,
        hp: 100,
        fuelKg: 0,
        elevonL: 0,
        elevonR: 0,
        rudder: 0,
        gearPos: 0,
        throttle: 0,
        afterburnerOn: false,
        flags: 0,
      },
    };
    expect(hashSimState([e])).toBe(hashSimState([e]));
  });

  test('damage/telemetry presence changes the hash (sentinel differentiation)', () => {
    const baseState: ObservedEntity['state'] = {
      id: 2,
      kind: 'aircraft',
      team: 0,
      pos: { x: 0, y: 0, z: 0 },
      rot: { x: 0, y: 0, z: 0, w: 1 },
      vel: { x: 0, y: 0, z: 0 },
      omega: { x: 0, y: 0, z: 0 },
      alive: true,
      hp: 100,
      fuelKg: 0,
      elevonL: 0,
      elevonR: 0,
      rudder: 0,
      gearPos: 0,
      throttle: 0,
      afterburnerOn: false,
      flags: 0,
    };
    const withoutDamage = hashSimState([{ state: baseState }]);
    const withDamage = hashSimState([
      {
        state: baseState,
        damage: {
          structurePct: 1,
          engineHealthPct: 1,
          controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
          hydraulicsOk: true,
          fuelLeak: false,
          radarHealthPct: 1,
          gearHealthPct: 1,
        },
      },
    ]);
    expect(withDamage).not.toBe(withoutDamage);
  });

  test('8 hex characters, always', () => {
    const e: ObservedEntity = {
      state: {
        id: 0,
        kind: 'bullet',
        team: 0,
        pos: { x: 0, y: 0, z: 0 },
        rot: { x: 0, y: 0, z: 0, w: 1 },
        vel: { x: 0, y: 0, z: 0 },
        omega: { x: 0, y: 0, z: 0 },
        alive: false,
        hp: 100,
        fuelKg: 0,
        elevonL: 0,
        elevonR: 0,
        rudder: 0,
        gearPos: 0,
        throttle: 0,
        afterburnerOn: false,
        flags: 0,
      },
    };
    expect(hashSimState([e])).toMatch(/^[0-9a-f]{8}$/);
    expect(hashSimState([])).toMatch(/^[0-9a-f]{8}$/);
  });
});
