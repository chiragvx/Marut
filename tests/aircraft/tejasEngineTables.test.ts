import { describe, it, expect } from 'vitest';
import { interpolate2D } from '../../src/math';
import { tejasDefinition } from '../../src/aircraft';

const engine = tejasDefinition.engine;

describe('tejasEngineTables', () => {
  it('sea-level-static military/afterburner thrust match cited ratings within 1%', () => {
    const mil = interpolate2D(engine.militaryThrustN, 0, 0);
    const ab = interpolate2D(engine.afterburnerThrustN, 0, 0);
    // F404-GE-IN20: 84 kN with afterburner (GE datasheet), 48.9 kN dry (F404 family rating).
    expect(mil).toBeGreaterThanOrEqual(48900 * 0.99);
    expect(mil).toBeLessThanOrEqual(48900 * 1.01);
    expect(ab).toBeGreaterThanOrEqual(84000 * 0.99);
    expect(ab).toBeLessThanOrEqual(84000 * 1.01);
  });

  // Subsonic rows only: at Mach 1.2+ a real turbofan is limited LOW DOWN by compressor-inlet
  // (ram) temperature, so its thrust genuinely peaks at altitude -- see tejasEngineTables.ts's
  // derivation. (An earlier hand-tuned table rose with altitude for a different, non-physical
  // reason -- inflated to offset excess supersonic drag -- which is what this test first caught.)
  const SUBSONIC_ROWS = engine.militaryThrustN.xs.filter((m) => m <= 0.9).length;

  it('militaryThrustN is non-increasing in altitude for every subsonic mach breakpoint', () => {
    for (let i = 0; i < SUBSONIC_ROWS; i++) {
      const row = engine.militaryThrustN.zs[i] as readonly number[];
      for (let j = 1; j < row.length; j++) {
        expect(row[j] as number).toBeLessThanOrEqual(row[j - 1] as number);
      }
    }
  });

  it('afterburnerThrustN is non-increasing in altitude for every subsonic mach breakpoint', () => {
    for (let i = 0; i < SUBSONIC_ROWS; i++) {
      const row = engine.afterburnerThrustN.zs[i] as readonly number[];
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

  it('fuel flow matches F404 published TSFC at sea-level static (dry 0.81, AB 1.74 lb/lbf/h)', () => {
    const LB_PER_LBF_H = 2.8325e-5; // kg/(N*s)
    const dry = interpolate2D(engine.militaryFuelFlowKgS, 0, 0) / interpolate2D(engine.militaryThrustN, 0, 0) / LB_PER_LBF_H;
    const ab = interpolate2D(engine.afterburnerFuelFlowKgS, 0, 0) / interpolate2D(engine.afterburnerThrustN, 0, 0) / LB_PER_LBF_H;
    expect(dry).toBeCloseTo(0.81, 1);
    expect(ab).toBeCloseTo(1.74, 1);
  });
});
