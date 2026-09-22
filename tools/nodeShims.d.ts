/**
 * tools/nodeShims.d.ts — minimal ambient Node.js type shims.
 *
 * 00-architecture.md section 2 fixes the devDependency list to exactly
 * `typescript`/`vite`/`vitest`/`@types/three`/`jsdom` — no `@types/node`.
 * This project's own tests/tools code nonetheless legitimately needs a
 * handful of Node built-ins (tools/sim-check.ts reads a mission file by
 * path; the e2e smoke tests shell out to `vite build`/`vite preview`; the
 * no-allocation proxy test reads `process.memoryUsage()`/`global.gc`).
 * Rather than add @types/node (a package.json change outside this module's
 * ownership — see 00-architecture.md section 11), this file declares ONLY
 * the exact symbols this module's own code uses, as a global ambient
 * declaration file. It is not a general-purpose @types/node replacement and
 * should be deleted the moment a real @types/node is ever added (its
 * declarations would then conflict/duplicate and should be removed, not
 * merged). This file is included in `tsc --noEmit -p tsconfig.json` simply
 * by living under the `tools/` path already in that config's `include`
 * list, and its ambient declarations apply to the whole compiled program.
 */

declare const process: {
  argv: string[];
  exitCode: number | undefined;
  env: Record<string, string | undefined>;
  platform: string;
  memoryUsage(): { heapUsed: number; heapTotal: number; rss: number; external: number; arrayBuffers: number };
  exit(code?: number): never;
};

declare const global: {
  gc?: () => void;
};

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf-8' | 'utf8'): string;
  export function writeFileSync(path: string, data: string, encoding?: 'utf-8' | 'utf8'): void;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
}

declare module 'node:child_process' {
  export interface ExecFileSyncOptions {
    stdio?: string | readonly string[];
    shell?: boolean;
    cwd?: string;
  }
  export function execFileSync(command: string, args?: readonly string[], options?: ExecFileSyncOptions): unknown;

  export interface SpawnedProcessLike {
    kill(): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    stdout: { on(event: string, listener: (chunk: unknown) => void): void } | null;
    stderr: { on(event: string, listener: (chunk: unknown) => void): void } | null;
  }
  export function spawn(command: string, args?: readonly string[], options?: Record<string, unknown>): SpawnedProcessLike;
}
