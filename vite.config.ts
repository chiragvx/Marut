import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  base: './',
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    // Two pages: the landing page (no 3D engine) and the game.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play/index.html'),
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
