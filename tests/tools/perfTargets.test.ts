/**
 * tests/tools/perfTargets.test.ts — every PerformanceTarget in
 * tools/lib/perfTargets.ts has toleranceRel in (0,1] and a non-empty
 * sourceNote. See docs/spec/12-verification.md section 7.
 */
import { describe, expect, test } from 'vitest';
import { PERFORMANCE_TARGETS } from '../../tools/lib/perfTargets';

describe('PERFORMANCE_TARGETS', () => {
  test('every target has a plausible tolerance and a non-empty source note', () => {
    for (const t of PERFORMANCE_TARGETS) {
      expect(t.toleranceRel).toBeGreaterThan(0);
      expect(t.toleranceRel).toBeLessThanOrEqual(1);
      expect(t.sourceNote.length).toBeGreaterThan(10);
      expect(t.targetValue).toBeGreaterThan(0);
    }
  });

  test('the 8 named ids from 12-verification.md section 5.1 are all present exactly once', () => {
    const ids = PERFORMANCE_TARGETS.map((t) => t.id).sort();
    expect(ids).toEqual(
      ['climb_sl', 'landing_roll', 'stall_clean', 'stall_landing', 'takeoff_roll', 'turn_5000_m06', 'vmax_11000', 'vmax_sl'].sort()
    );
  });

  test('every target uses aircraftDefId tejas-mk1 implicitly (massKg is a representative combat-configuration weight)', () => {
    for (const t of PERFORMANCE_TARGETS) {
      expect(t.massKg).toBeGreaterThan(0);
      expect(t.configNote.length).toBeGreaterThan(0);
    }
  });
});
