/**
 * tests/integration/jf17Performance.test.ts — the JF-17's own flight data (src/aircraft/jf17Data.ts)
 * against its performance targets (tools/lib/perfTargets.ts JF17_PERFORMANCE_TARGETS), and the
 * relations to the Tejas its sourced figures support: less MTOW and internal fuel, a thirstier
 * afterburner, a smaller wing (higher stall speed, less lift in hand, a lower sustained turn rate).
 */
import { describe, expect, test } from 'vitest';
import { tejasDefinition } from '../../src/aircraft';
import { jf17Definition } from '../../src/aircraft/aggressors';
import { interpolate2D } from '../../src/math';
import { stepAircraft } from '../../src/physics';
import { checkPerformanceTarget } from '../../tools/lib/trimSolver';
import { JF17_PERFORMANCE_TARGETS, PERFORMANCE_TARGETS } from '../../tools/lib/perfTargets';
import { formatPerformanceTable } from '../../tools/lib/table';

const DEG = Math.PI / 180;

describe('JF-17 flight data', () => {
  test(
    'meets its performance targets',
    () => {
      const results = JF17_PERFORMANCE_TARGETS.map((t) => checkPerformanceTarget(stepAircraft, jf17Definition, t));
      const failing = results.filter((r) => !r.passed);
      expect(failing, `\n${formatPerformanceTable(results)}\n\nFailing: ${failing.map((r) => r.target.id).join(', ')}`).toEqual([]);
    },
    120000
  );

  test(
    'the Tejas out-turns it at the same condition (Mach 0.6, 5 km, 9500 kg, full afterburner)',
    () => {
      const target = PERFORMANCE_TARGETS.find((t) => t.id === 'turn_5000_m06')!;
      const tejas = checkPerformanceTarget(stepAircraft, tejasDefinition, target).measured;
      const jf17 = checkPerformanceTarget(stepAircraft, jf17Definition, target).measured;
      expect(tejas).toBeGreaterThan(jf17 * 1.2);
    },
    120000
  );

  test('sourced weights: less MTOW and internal fuel than the Tejas, a heavier empty jet', () => {
    expect(jf17Definition.maxTakeoffMassKg).toBe(12474);
    expect(jf17Definition.maxTakeoffMassKg!).toBeLessThan(tejasDefinition.maxTakeoffMassKg!);
    expect(jf17Definition.maxFuelKg).toBe(2330);
    expect(jf17Definition.maxFuelKg).toBeLessThan(tejasDefinition.maxFuelKg);
    expect(jf17Definition.emptyMassKg).toBeGreaterThan(tejasDefinition.emptyMassKg);
  });

  test('the RD-93 matches the F404 for thrust but burns more fuel in afterburner', () => {
    for (const [m, h] of [[0, 0], [0.9, 5000], [1.2, 11000]] as const) {
      const abJ = interpolate2D(jf17Definition.engine.afterburnerThrustN, m, h);
      const abT = interpolate2D(tejasDefinition.engine.afterburnerThrustN, m, h);
      expect(Math.abs(abJ / abT - 1)).toBeLessThan(0.02);
      const tsfcJ = interpolate2D(jf17Definition.engine.afterburnerFuelFlowKgS, m, h) / abJ;
      const tsfcT = interpolate2D(tejasDefinition.engine.afterburnerFuelFlowKgS, m, h) / abT;
      expect(tsfcJ).toBeGreaterThan(tsfcT * 1.1);
    }
  });

  test('a smaller wing: less lift in hand at its alpha limit, a higher stall speed', () => {
    // Maximum lift force per unit dynamic pressure (CL at the alpha limit x wing area), Mach 0.6.
    const liftArea = (def: typeof tejasDefinition): number => interpolate2D(def.aero.CL, def.fcsLimits.maxAlphaRad, 0.6) * def.wingAreaM2;
    expect(liftArea(tejasDefinition)).toBeGreaterThan(liftArea(jf17Definition) * 1.2);
    const stall = (def: typeof tejasDefinition): number => {
      const t = PERFORMANCE_TARGETS.find((p) => p.id === 'stall_clean')!;
      return checkPerformanceTarget(stepAircraft, def, { ...t, assumedClMax: 2 }).measured;
    };
    expect(stall(jf17Definition)).toBeGreaterThan(stall(tejasDefinition));
    expect(jf17Definition.fcsLimits.maxAlphaRad).toBeCloseTo(26 * DEG, 5);
  });
});
