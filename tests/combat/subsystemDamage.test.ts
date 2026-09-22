import { describe, it, expect } from 'vitest';
import {
  subsystemHitFromU01,
  rollSubsystemHit,
  applyHit,
  createDamageState,
  createCombatRngState,
  SUBSYSTEM_HIT_WEIGHT,
  SubsystemHitKind,
} from '../../src/combat';
import type { EntityState } from '../../src/contracts/core';

describe('subsystemHitFromU01', () => {
  it('walks the fixed cumulative-order boundary table from 07-combat.md section 5', () => {
    expect(subsystemHitFromU01(0)).toBe(SubsystemHitKind.StructureOnly);
    expect(subsystemHitFromU01(0.399)).toBe(SubsystemHitKind.StructureOnly);
    expect(subsystemHitFromU01(0.4)).toBe(SubsystemHitKind.Engine);
    expect(subsystemHitFromU01(0.5499)).toBe(SubsystemHitKind.Engine);
    expect(subsystemHitFromU01(0.55)).toBe(SubsystemHitKind.ElevonL);
    expect(subsystemHitFromU01(0.9999)).toBe(SubsystemHitKind.Hydraulics);
  });

  it('SUBSYSTEM_HIT_WEIGHT sums to exactly 1.0', () => {
    const sum = Object.values(SUBSYSTEM_HIT_WEIGHT).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 9);
  });
});

describe('rollSubsystemHit', () => {
  it('empirical frequency matches SUBSYSTEM_HIT_WEIGHT within 0.01', () => {
    const rng = createCombatRngState(12345);
    const counts: Record<string, number> = {};
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const kind = rollSubsystemHit(rng);
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    for (const kind of Object.keys(SUBSYSTEM_HIT_WEIGHT) as (keyof typeof SUBSYSTEM_HIT_WEIGHT)[]) {
      const freq = (counts[kind] ?? 0) / N;
      expect(Math.abs(freq - SUBSYSTEM_HIT_WEIGHT[kind])).toBeLessThanOrEqual(0.01);
    }
  });
});

describe('applyHit', () => {
  it('a 0.04 gun hit on a full-health target reduces structurePct to 0.96 / hp to 96', () => {
    const state: EntityState = { id: 1, kind: 'aircraft', team: 0, pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 }, alive: true, hp: 100, fuelKg: 0, elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0, afterburnerOn: false, flags: 0 };
    const damage = createDamageState();
    const rng = createCombatRngState(1);

    const result = applyHit('gun', 0.04, state, damage, rng);

    expect(damage.structurePct).toBeCloseTo(0.96, 9);
    expect(state.hp).toBe(96);
    expect(result.lethal).toBe(false);
  });

  it('25 successive 0.04 hits bring structurePct to 0 and the 25th is lethal', () => {
    const state: EntityState = { id: 1, kind: 'aircraft', team: 0, pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 }, alive: true, hp: 100, fuelKg: 0, elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0, afterburnerOn: false, flags: 0 };
    const damage = createDamageState();
    const rng = createCombatRngState(2);

    let result;
    for (let i = 0; i < 25; i++) {
      result = applyHit('gun', 0.04, state, damage, rng);
    }

    expect(damage.structurePct).toBeLessThanOrEqual(1e-9);
    expect(result!.lethal).toBe(true);
  });
});
