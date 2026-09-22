/**
 * vitest.config.ts — test runner configuration (module 12).
 * See docs/spec/12-verification.md section 4.10.
 *
 * Node is the default environment for every test file (DOM-free by
 * construction across math/physics/aircraft/terrain/airport/ai/combat/core/
 * tools/integration/render/hud). Exactly three files genuinely need a DOM
 * and are switched to jsdom via environmentMatchGlobs, per
 * 00-architecture.md section 2 and this document's section 1/4.10.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['tests/input/playerPilot.test.ts', 'jsdom'],
      ['tests/ui/screens.test.ts', 'jsdom'],
      ['tests/ui/orientationPrompt.test.ts', 'jsdom'],
    ],
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    testTimeout: 5000,
    hookTimeout: 10000,
    isolate: true,
    pool: 'forks',
    reporters: ['default'],
    coverage: { enabled: false },
  },
});
