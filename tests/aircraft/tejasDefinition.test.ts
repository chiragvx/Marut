import { describe, it, expect } from 'vitest';
import { tejasDefinition } from '../../src/aircraft';

describe('tejasDefinition', () => {
  it('has the exact fixed id', () => {
    expect(tejasDefinition.id).toBe('tejas-mk1a');
  });

  it('combat weight exceeds empty weight', () => {
    expect(tejasDefinition.massKg).toBeGreaterThan(tejasDefinition.emptyMassKg);
  });

  it('never claims more mass than empty + full internal fuel could support', () => {
    expect(tejasDefinition.massKg).toBeLessThanOrEqual(tejasDefinition.emptyMassKg + tejasDefinition.maxFuelKg);
  });

  it('inertia tensor satisfies the triangle inequality', () => {
    const { xx, yy, zz } = tejasDefinition.inertiaBodyKgM2;
    expect(xx + yy).toBeGreaterThanOrEqual(zz);
    expect(yy + zz).toBeGreaterThanOrEqual(xx);
    expect(xx + zz).toBeGreaterThanOrEqual(yy);
  });

  it('wing geometry falls inside the acceptance bounds', () => {
    expect(tejasDefinition.wingAreaM2).toBeGreaterThanOrEqual(34);
    expect(tejasDefinition.wingAreaM2).toBeLessThanOrEqual(43);
    expect(tejasDefinition.wingSpanM).toBeGreaterThanOrEqual(8.0);
    expect(tejasDefinition.wingSpanM).toBeLessThanOrEqual(8.4);
  });

  it('has exactly 3 gear legs with the required ids', () => {
    expect(tejasDefinition.gear.length).toBe(3);
    const ids = new Set(tejasDefinition.gear.map((g) => g.id));
    expect(ids).toEqual(new Set(['nose', 'mainLeft', 'mainRight']));
  });

  it('has exactly 7 hardpoints with all four types represented', () => {
    expect(tejasDefinition.hardpoints.length).toBe(7);
    const types = new Set(tejasDefinition.hardpoints.map((h) => h.type));
    expect(types).toEqual(new Set(['gun', 'ir_missile', 'radar_missile', 'fuel_tank']));
  });
});
