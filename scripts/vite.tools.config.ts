/**
 * scripts/vite.tools.config.ts — bundles tools/sim-check.ts into a plain-node
 * runnable ESM script (dist-tools/sim-check.mjs), since the project's
 * tsconfig.json uses moduleResolution:"Bundler" output that plain `node`
 * cannot run directly and the fixed devDependency list has no tsx/ts-node.
 * See docs/spec/12-verification.md section 4.1.
 */
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: true,
    target: 'node18',
    outDir: 'dist-tools',
    emptyOutDir: true,
    rollupOptions: {
      input: { 'sim-check': 'tools/sim-check.ts' },
      output: { format: 'es', entryFileNames: '[name].mjs' },
    },
  },
});
