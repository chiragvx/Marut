import { describe, it, expect } from 'vitest';
import { interpolate2D } from '../../src/math';
import { tejasDefinition } from '../../src/aircraft';

const engine = tejasDefinition.engine;

describe('tejasEngineTables', () => {
  it('sea-level-static military/afterburner thrust match cited ratings within 1%', () => {
    const mil = interpolate2D(engine.militaryThrustN, 0, 0);
    const ab = interpolate2D(engine.afterburnerThrustN, 0, 0);
    expect(mil).toBeGreaterThanOrEqual(53900 * 0.99);
    expect(mil).toBeLessThanOrEqual(53900 * 1.01);
    expect(ab).toBeGreaterThanOrEqual(84500 * 0.99);
    expect(ab).toBeLessThanOrEqual(84500 * 1.01);
  });

  it('militaryThrustN is non-increasing in altitude for every mach breakpoint', () => {
    for (let i = 0; i < engine.militaryThrustN.xs.length; i++) {
      const row = engine.militaryThrustN.zs[i] as readonly number[];
      for (let j = 1; j < row.length; j++) {
        expect(row[j] as number).toBeLessThanOrEqual(row[j - 1] as number);
      }
    }
  });

  it('afterburner thrust always exceeds military thrust at the same flight condition', () => {
    const mach = engine.militaryThrustN.xs;
    const alt = engine.militaryThrustN.ys;
    for (let i = 0; i < mach.length; i++) {
      const milRow = engine.militaryThrustN.zs[i] as readonly number[];
      const abRow = engine.afterburnerThrustN.zs[i] as readonly number[];
      for (let j = 0; j < alt.length; j++) {
        expect(abRow[j] as number).toBeGreaterThan(milRow[j] as number);
      }
    }
  });

  it('afterburner fuel flow always exceeds military fuel flow at the same flight condition', () => {
    const mach = engine.militaryFuelFlowKgS.xs;
    const alt = engine.militaryFuelFlowKgS.ys;
    for (let i = 0; i < mach.length; i++) {
      const milRow = engine.militaryFuelFlowKgS.zs[i] as readonly number[];
      const abRow = engine.afterburnerFuelFlowKgS.zs[i] as readonly number[];
      for (let j = 0; j < alt.length; j++) {
        expect(abRow[j] as number).toBeGreaterThan(milRow[j] as number);
      }
    }
  });
});
