/**
 * vitest.e2e.config.ts — companion to vitest.config.ts, used ONLY to run
 * tests/e2e/**.
 *
 * SPEC-INCONSISTENCY NOTE (see this module's final report / contract
 * concerns): 12-verification.md section 4.10 fixes vitest.config.ts's
 * `test.exclude` to `['tests/e2e/**', 'node_modules/**']`, and section 8 row
 * 11 says to then run e2e via `npx vitest run tests/e2e
 * --testTimeout=60000`. Empirically (vitest 1.6.1), a config-level `exclude`
 * pattern is NOT overridden by a CLI positional path filter -- an explicitly
 * named excluded file still yields "No test files found". vitest.config.ts
 * is kept exactly as section 4.10 specifies (verbatim); this second, minimal
 * config is what actually makes section 8 rows 11/12's commands work,
 * without weakening vitest.config.ts's own exclude for the fast default
 * `npx vitest run`. scripts/ci.mjs uses this config's `--config` flag for
 * its e2e_smoke/mobile_smoke steps.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['node_modules/**'],
    testTimeout: 60000,
    hookTimeout: 60000,
    isolate: true,
    pool: 'forks',
    reporters: ['default'],
    coverage: { enabled: false },
  },
});
