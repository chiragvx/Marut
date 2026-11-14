/**
 * terrain-lab/src/lab.worker.ts - builds terrain ring meshes (heights, normals, surface hints) and
 * the minimap off the main thread.
 */

import { heightAt, type SurfaceInfo } from '../../src/terrain/himalaya/height';
import { MAP_HALF_M } from '../../src/terrain/himalaya/layout';
import { perimeter } from './grid';

export interface RingRequest { type: 'ring'; id: number; level: number; cx: number; cz: number; n: number; step: number; skirt: number }
export interface MinimapRequest { type: 'minimap'; size: number }
export interface RingResult { type: 'ring'; id: number; level: number; cx: number; cz: number; positions: Float32Array; normals: Float32Array; surf: Float32Array; ms: number }
export interface MinimapResult { type: 'minimap'; size: number; rgba: Uint8ClampedArray; heights: Float32Array }

const ctx = self as unknown as { postMessage(m: unknown, t: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };

function buildRing(q: RingRequest): RingResult {
  const t0 = performance.now();
  const { n, step, cx, cz } = q;
  const g = n + 3; // a one-sample border for normals
  const hs = new Float32Array(g * g);
  const half = (n / 2) * step;
  const nv = (n + 1) * (n + 1);
  const total = nv + 4 * n;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const surf = new Float32Array(total * 3);
  const info: SurfaceInfo = { flat: 0, river: 0, dry: 0 };
  for (let j = 0; j < g; j++) {
    const z = cz - half + (j - 1) * step;
    for (let i = 0; i < g; i++) {
      hs[j * g + i] = heightAt(cx - half + (i - 1) * step, z, info);
      if (i >= 1 && i <= n + 1 && j >= 1 && j <= n + 1) {
        const k = (j - 1) * (n + 1) + (i - 1);
        surf[k * 3] = info.flat; surf[k * 3 + 1] = info.river; surf[k * 3 + 2] = info.dry;
      }
    }
  }
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const k = j * (n + 1) + i;
      const gi = (j + 1) * g + (i + 1);
      const lx = -half + i * step, lz = -half + j * step;
      positions[k * 3] = lx; positions[k * 3 + 1] = hs[gi]; positions[k * 3 + 2] = lz;
      const nx = -(hs[gi + 1] - hs[gi - 1]) / (2 * step);
      const nz = -(hs[gi + g] - hs[gi - g]) / (2 * step);
      const il = 1 / Math.hypot(nx, 1, nz);
      normals[k * 3] = nx * il; normals[k * 3 + 1] = il; normals[k * 3 + 2] = nz * il;
    }
  }
  // Skirt: the perimeter again, dropped, to hide cracks against the coarser ring outside.
  const per = perimeter(n);
  for (let p = 0; p < per.length; p++) {
    const k = per[p], s = nv + p;
    positions[s * 3] = positions[k * 3]; positions[s * 3 + 1] = positions[k * 3 + 1] - q.skirt; positions[s * 3 + 2] = positions[k * 3 + 2];
    for (let c = 0; c < 3; c++) { normals[s * 3 + c] = normals[k * 3 + c]; surf[s * 3 + c] = surf[k * 3 + c]; }
  }
  return { type: 'ring', id: q.id, level: q.level, cx, cz, positions, normals, surf, ms: performance.now() - t0 };
}

function buildMinimap(size: number): MinimapResult {
  const heights = new Float32Array(size * size);
  const step = (2 * MAP_HALF_M) / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) heights[j * size + i] = heightAt(-MAP_HALF_M + (i + 0.5) * step, -MAP_HALF_M + (j + 0.5) * step);
  }
  const rgba = new Uint8ClampedArray(size * size * 4);
  const stops: [number, number, number, number][] = [
    [300, 60, 100, 50], [1500, 95, 120, 60], [3000, 140, 130, 90], [4300, 170, 150, 110],
    [5000, 150, 135, 120], [5800, 215, 215, 220], [7800, 255, 255, 255],
  ];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const h = heights[k];
      let c = stops[stops.length - 1];
      let col: [number, number, number] = [c[1], c[2], c[3]];
      for (let s = 0; s + 1 < stops.length; s++) {
        const a = stops[s], b = stops[s + 1];
        if (h <= b[0]) {
          const t = Math.max(0, Math.min(1, (h - a[0]) / (b[0] - a[0])));
          col = [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
          c = b;
          break;
        }
      }
      const hx = heights[j * size + Math.min(size - 1, i + 1)] - heights[j * size + Math.max(0, i - 1)];
      const hz = heights[Math.min(size - 1, j + 1) * size + i] - heights[Math.max(0, j - 1) * size + i];
      const shade = Math.max(0.35, Math.min(1.35, 1 + (-hx - hz) / (2 * step) * 1.2));
      rgba[k * 4] = col[0] * shade; rgba[k * 4 + 1] = col[1] * shade; rgba[k * 4 + 2] = col[2] * shade; rgba[k * 4 + 3] = 255;
    }
  }
  return { type: 'minimap', size, rgba, heights };
}

ctx.onmessage = (e: MessageEvent) => {
  const q = e.data as RingRequest | MinimapRequest;
  if (q.type === 'ring') {
    const r = buildRing(q);
    ctx.postMessage(r, [r.positions.buffer, r.normals.buffer, r.surf.buffer]);
  } else {
    const r = buildMinimap(q.size);
    ctx.postMessage(r, [r.rgba.buffer, r.heights.buffer]);
  }
};
