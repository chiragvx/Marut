#!/usr/bin/env node
/**
 * scripts/checkContracts.mjs — contract-compile audit (module 12).
 * Shells `tsc --noEmit --strict` over every docs/spec/contracts/*.ts file,
 * standalone, with no project file (contracts import nothing external).
 * See docs/spec/12-verification.md section 4.9.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const dir = 'docs/spec/contracts';
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => `${dir}/${f}`);

try {
  execFileSync(
    'npx',
    [
      'tsc',
      '--noEmit',
      '--strict',
      '--target', 'ES2022',
      '--module', 'ESNext',
      '--moduleResolution', 'Bundler',
      '--noUncheckedIndexedAccess',
      '--noImplicitOverride',
      '--noFallthroughCasesInSwitch',
      '--forceConsistentCasingInFileNames',
      '--skipLibCheck',
      '--esModuleInterop',
      '--isolatedModules',
      ...files,
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' }
  );
  process.exit(0);
} catch {
  process.exit(1);
}
