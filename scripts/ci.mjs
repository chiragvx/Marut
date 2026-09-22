#!/usr/bin/env node
/**
 * scripts/ci.mjs — orchestrates the full acceptance sequence.
 * See docs/spec/12-verification.md section 8 for the exact command
 * sequence, pass conditions and AcceptanceCheckId list this mirrors.
 *
 * Plain JS (no build step needed), run directly by .github/workflows/ci.yml
 * as `node scripts/ci.mjs`. `npm ci`/`npm install` is assumed to have
 * already run as a separate CI step (ci.yml does this); the 'install' check
 * below is a lightweight sanity check, not a re-install, so this script
 * does not duplicate that slow network step.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const isWindows = process.platform === 'win32';
const PLAYWRIGHT_ENABLED = process.env.PLAYWRIGHT === '1';

/** @type {{id: string, status: 'pass'|'fail'|'skip', detail: string, durationMs: number}[]} */
const checks = [];

function run(id, description, fn) {
  const start = Date.now();
  console.log(`\n=== [${id}] ${description} ===`);
  try {
    const detail = fn();
    const durationMs = Date.now() - start;
    checks.push({ id, status: 'pass', detail: detail ?? 'ok', durationMs });
    console.log(`--- [${id}] PASS (${durationMs}ms)`);
  } catch (err) {
    const durationMs = Date.now() - start;
    const detail = err && err.message ? err.message : String(err);
    checks.push({ id, status: 'fail', detail, durationMs });
    console.log(`--- [${id}] FAIL (${durationMs}ms): ${detail}`);
  }
}

function skip(id, description, reason) {
  console.log(`\n=== [${id}] ${description} ===`);
  checks.push({ id, status: 'skip', detail: reason, durationMs: 0 });
  console.log(`--- [${id}] SKIP: ${reason}`);
}

function sh(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', shell: isWindows, ...opts });
}

// 1. install (lightweight check; the real `npm ci` runs as its own CI step).
run('install', 'npm install (sanity check)', () => {
  if (!existsSync('node_modules')) {
    sh('npm', ['install']);
  }
  if (!existsSync('node_modules')) throw new Error('node_modules missing after install');
  return 'node_modules present';
});

// 2. contracts_compile
run('contracts_compile', 'node scripts/checkContracts.mjs', () => {
  sh('node', ['scripts/checkContracts.mjs']);
  return 'all docs/spec/contracts/*.ts compile standalone, strict';
});

// 3. src_compile
run('src_compile', 'tsc --noEmit (both tsconfigs)', () => {
  sh('npx', ['tsc', '--noEmit', '-p', 'tsconfig.json']);
  sh('npx', ['tsc', '--noEmit', '-p', 'tsconfig.worker.json']);
  return 'tsconfig.json and tsconfig.worker.json both compile clean';
});

// 4. unit_tests + integration_tests (vitest reports both; split by directory here)
run('unit_tests', 'vitest run (everything except tests/integration and tests/e2e)', () => {
  sh('npx', [
    'vitest', 'run',
    'tests/math', 'tests/physics', 'tests/aircraft', 'tests/terrain', 'tests/airport',
    'tests/ai', 'tests/combat', 'tests/core', 'tests/tools',
    'tests/render', 'tests/hud', 'tests/input', 'tests/ui',
  ]);
  return 'unit suites passed';
});
run('integration_tests', 'vitest run tests/integration', () => {
  sh('npx', ['vitest', 'run', 'tests/integration']);
  return 'integration suites passed';
});

// 5. trim_performance
run('trim_performance', 'sim-check.ts --mode trim', () => {
  sh('npx', ['vite', 'build', '--config', 'scripts/vite.tools.config.ts']);
  sh('node', ['dist-tools/sim-check.mjs', '--mode', 'trim', '--mission', 'src/core/missions/freeFlight.json', '--seed', '12345']);
  return 'all named performance targets passed, trim grid has no hole';
});

// 6. determinism
run('determinism', 'sim-check.ts --mode determinism', () => {
  sh('node', ['dist-tools/sim-check.mjs', '--mode', 'determinism', '--mission', 'src/core/missions/dogfight1v1.json', '--seed', '424242']);
  return 'DeterminismResult.matched === true';
});

// 7/8. ai_dogfight_veteran / ai_dogfight_ace
run('ai_dogfight_veteran', 'sim-check.ts --mode dogfight --difficulty veteran', () => {
  sh('node', ['dist-tools/sim-check.mjs', '--mode', 'dogfight', '--mission', 'src/core/missions/dogfight1v1.json', '--seed', '1', '--difficulty', 'veteran']);
  return 'cheatSuspected=false, groundCollision=false';
});
run('ai_dogfight_ace', 'sim-check.ts --mode dogfight --difficulty ace', () => {
  sh('node', ['dist-tools/sim-check.mjs', '--mode', 'dogfight', '--mission', 'src/core/missions/dogfight1v1.json', '--seed', '1', '--difficulty', 'ace']);
  return 'cheatSuspected=false, groundCollision=false';
});

// 9. no_allocation_hot_path
run('no_allocation_hot_path', 'vitest run tests/integration/noAllocation.test.ts (--expose-gc)', () => {
  sh('npx', ['vitest', 'run', 'tests/integration/noAllocation.test.ts'], {
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --expose-gc`.trim() },
  });
  return 'heap growth under 2MB over 6000 ticks (or gracefully skipped without --expose-gc)';
});

// 10. build
run('build', 'vite build', () => {
  sh('npx', ['vite', 'build']);
  if (!existsSync('dist/index.html')) throw new Error('dist/index.html missing after build');
  return 'dist/index.html exists';
});

// 11/12. e2e_smoke / mobile_smoke — only when PLAYWRIGHT=1 (never silently omitted from the report either way).
// Uses vitest.e2e.config.ts, not the default vitest.config.ts, because that
// default config's own `test.exclude` (fixed verbatim by 12-verification.md
// section 4.10) excludes tests/e2e/** and a CLI path filter does not
// override a config-level exclude -- see vitest.e2e.config.ts's own header
// note for the full explanation.
if (PLAYWRIGHT_ENABLED) {
  run('e2e_smoke', 'playwright install + vitest run tests/e2e/appSmoke.test.ts', () => {
    sh('npm', ['install', '--no-save', 'playwright']);
    sh('npx', ['playwright', 'install', '--with-deps', 'chromium']);
    sh('npx', ['vitest', 'run', '--config', 'vitest.e2e.config.ts', 'tests/e2e/appSmoke.test.ts']);
    return 'app smoke test passed';
  });
  run('mobile_smoke', 'vitest run tests/e2e/mobile.test.ts', () => {
    sh('npx', ['vitest', 'run', '--config', 'vitest.e2e.config.ts', 'tests/e2e/mobile.test.ts']);
    return 'mobile smoke test passed';
  });
} else {
  skip('e2e_smoke', 'playwright install + vitest run tests/e2e', 'PLAYWRIGHT=1 not set');
  skip('mobile_smoke', 'vitest run tests/e2e/mobile.test.ts', 'PLAYWRIGHT=1 not set');
}

// -----------------------------------------------------------------------------
// Report.
// -----------------------------------------------------------------------------

const requiredIds = [
  'install', 'contracts_compile', 'src_compile', 'unit_tests', 'integration_tests',
  'trim_performance', 'determinism', 'ai_dogfight_veteran', 'ai_dogfight_ace',
  'no_allocation_hot_path', 'build',
];
const optionalIds = ['e2e_smoke', 'mobile_smoke'];

const allPassed =
  requiredIds.every((id) => checks.find((c) => c.id === id)?.status === 'pass') &&
  optionalIds.every((id) => {
    const status = checks.find((c) => c.id === id)?.status;
    return status === 'pass' || status === 'skip';
  });

const report = {
  generatedAtIso: new Date().toISOString(),
  checks,
  allPassed,
};

console.log('\n=== Acceptance report ===');
for (const c of checks) {
  console.log(`${c.status.toUpperCase().padEnd(4)} ${c.id.padEnd(24)} ${c.durationMs}ms  ${c.detail}`);
}
console.log(`\nOverall: ${allPassed ? 'PASS' : 'FAIL'}`);

writeFileSync('acceptance-report.json', JSON.stringify(report, null, 2));

process.exit(allPassed ? 0 : 1);
