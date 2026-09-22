/**
 * tests/integration/trimAndPerformance.test.ts — runs tools/sim-check.ts's
 * trim/performance logic in-process (mode=trim) against the real Tejas,
 * asserts all PerformanceCheckResult.passed. See
 * docs/spec/12-verification.md section 2, 4.1, 5.1.
 *
 * A failure here is a normal, expected review finding (not automatically a
 * flight-model bug) per section 9's open assumption #1: this module's own
 * PERFORMANCE_TARGETS table is a public-data-derived approximation, drafted
 * blind to module 03's real AeroTables/EngineTables.
 */
import { describe, expect, test } from 'vitest';
import { tejasDefinition } from '../../src/aircraft';
import { stepAircraft } from '../../src/physics';
import { checkPerformanceTarget } from '../../tools/lib/trimSolver';
import { PERFORMANCE_TARGETS } from '../../tools/lib/perfTargets';
import { formatPerformanceTable } from '../../tools/lib/table';

describe('trim + performance targets (real Tejas data)', () => {
  test(
    'every named performance target in 12-verification.md section 5.1 passes',
    () => {
      const results = PERFORMANCE_TARGETS.map((target) => checkPerformanceTarget(stepAircraft, tejasDefinition, target));
      const table = formatPerformanceTable(results);
      const failing = results.filter((r) => !r.passed);
      expect(failing, `\n${table}\n\nFailing targets: ${failing.map((r) => r.target.id).join(', ')}`).toEqual([]);
    },
    30000
  );
});
