// Dev helper (npx vite-node terrain-lab/sample.ts geo <lat> <lon> <sizeKm> <n> <out.raw>): sample heights to a raw float32 file.
import { writeFileSync } from 'node:fs';
import { heightAt } from './src/height';
import { geo } from './src/layout';
import { Noise2 } from './src/noise';
const [mode, a1, a2, a3, a4, out] = process.argv.slice(2);
if (mode === 'stats') {
  const N = new Noise2(1729);
  const take = (f: (x: number, z: number) => number): string => {
    const v: number[] = [];
    for (let i = 0; i < 20000; i++) v.push(f(Math.random() * 1000, Math.random() * 1000));
    v.sort((p, q) => p - q);
    return [0.01, 0.1, 0.5, 0.9, 0.99].map((q) => v[Math.floor(q * v.length)].toFixed(3)).join(' ');
  };
  console.log('noise', take((x, z) => N.noise(x, z)));
  console.log('fbm6', take((x, z) => N.fbm(x, z, 6)));
  console.log('eroded9', take((x, z) => N.erodedFbm(x, z, 9)));
  console.log('ridged7', take((x, z) => N.ridged(x, z, 7)));
} else {
  // region: centre lat lon (or x z km with 'xz'), size km, n
  const [cx, cz] = mode === 'geo' ? geo(Number(a1), Number(a2)) : [Number(a1) * 1000, Number(a2) * 1000];
  const size = Number(a3) * 1000, n = Number(a4);
  const h = new Float32Array(n * n);
  const t0 = performance.now();
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = heightAt(cx - size / 2 + (i * size) / (n - 1), cz - size / 2 + (j * size) / (n - 1));
  writeFileSync(out, Buffer.from(h.buffer));
  console.log('sampled', n * n, 'in', (performance.now() - t0).toFixed(0), 'ms');
}
