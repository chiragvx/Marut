/**
 * tests/e2e/appSmoke.test.ts — end-to-end smoke test. See
 * docs/spec/12-verification.md section 4.8. Opportunistic: if `playwright`
 * is not installed, the browser-driven suite self-skips (never fails)
 * except for the mandatory, dependency-free "vite build produces
 * dist/index.html" check, which always runs.
 *
 * Excluded from the default `npx vitest run` by vitest.config.ts's
 * `exclude: ['tests/e2e/**']`; run explicitly per 12-verification.md section
 * 8 row 11: `npx vitest run tests/e2e --testTimeout=60000`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

interface PlaywrightPage {
  on(event: 'console', listener: (msg: { type(): string; text(): string }) => void): void;
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  $(selector: string): Promise<{ boundingBox(): Promise<{ width: number; height: number } | null> } | null>;
}
interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightModule {
  chromium: { launch(): Promise<PlaywrightBrowser> };
}

// `playwright` is never a package.json dependency (00-architecture.md
// section 2's fixed devDependency list) and is therefore usually not
// resolvable. The specifier is read from a non-literal (widened `string`)
// local so `tsc` cannot statically resolve it at compile time -- this file
// must still typecheck clean when playwright is absent, per this file's own
// header note.
const OPTIONAL_PLAYWRIGHT_SPECIFIER: string = 'playwright';
let playwright: PlaywrightModule | undefined;
try {
  playwright = (await import(OPTIONAL_PLAYWRIGHT_SPECIFIER)) as unknown as PlaywrightModule;
} catch {
  playwright = undefined;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

describe('vite build (mandatory, dependency-free)', () => {
  test(
    'vite build produces dist/index.html',
    () => {
      execFileSync('npx', ['vite', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
      expect(existsSync('dist/index.html')).toBe(true);
    },
    60000
  );
});

describe.skipIf(playwright === undefined)('app smoke (playwright)', () => {
  test(
    'the built app renders a canvas with no console errors',
    async () => {
      if (!existsSync('dist/index.html')) {
        execFileSync('npx', ['vite', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
      }
      const preview = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { shell: process.platform === 'win32' });
      try {
        await waitForHttp('http://localhost:4173', 10000);
        if (playwright === undefined) throw new Error('unreachable: describe.skipIf guards this');
        const browser = await playwright.chromium.launch();
        try {
          const page = await browser.newPage();
          const errors: string[] = [];
          page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text());
          });
          await page.goto('http://localhost:4173/play/', { waitUntil: 'load' });
          await page.waitForTimeout(3000); // let the first sim/render frames run
          const canvas = await page.$('canvas');
          expect(canvas).not.toBeNull();
          const box = await canvas?.boundingBox();
          expect(box && box.width).toBeGreaterThan(0);
          expect(box && box.height).toBeGreaterThan(0);
          expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
        } finally {
          await browser.close();
        }
      } finally {
        preview.kill();
      }
    },
    60000
  );
});
