/**
 * tests/integration/contractsCompile.test.ts — shells out to
 * scripts/checkContracts.mjs, asserts exit code 0. See
 * docs/spec/12-verification.md section 4.9.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

describe('contracts compile audit', () => {
  test(
    'every docs/spec/contracts/*.ts file compiles standalone under tsc --noEmit --strict',
    () => {
      expect(() => {
        execFileSync('node', ['scripts/checkContracts.mjs'], { stdio: 'pipe' });
      }).not.toThrow();
    },
    30000
  );
});
