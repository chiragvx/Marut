/**
 * src/terrain/noise.ts — 2D simplex noise (module 04).
 * Algorithm, constants and fixtures: docs/spec/04-terrain.md section 4.3.1/4.3.2.
 */
import type { Noise2D, CreateNoise2D } from '../contracts/terrain';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

// Only the first two components (x,y treated as x,z) of each 3D cube-edge-midpoint
// gradient are used, per 04-terrain.md section 4.3.2.
const GRAD3: readonly (readonly [number, number, number])[] = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

/** Local xorshift32 generator, self-contained (never mulberry32 — see file/module header rationale in 04-terrain.md section 9). */
function xorshift32(state: { s: number }): number {
  let x = state.s;
  x ^= x << 13;
  x |= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x |= 0;
  state.s = x;
  return (x >>> 0) / 4294967296;
}

function buildPermutation(seed: number): Uint16Array {
  const state = { s: (seed >>> 0) || 1 }; // xorshift32 requires a nonzero state
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const r = Math.floor(xorshift32(state) * (i + 1));
    const tmp = p[i]!;
    p[i] = p[r]!;
    p[r] = tmp;
  }
  const perm = new Uint16Array(512); // doubled to avoid index-wrap branches in rawNoise2D
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!;
  return perm;
}

function rawNoise2D(perm: Uint16Array, x: number, z: number): number {
  const s = (x + z) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(z + s);
  const t = (i + j) * G2;
  const X0 = i - t;
  const Z0 = j - t;
  const x0 = x - X0;
  const z0 = z - Z0;
  let i1: number;
  let j1: number;
  if (x0 > z0) {
    i1 = 1;
    j1 = 0;
  } else {
    i1 = 0;
    j1 = 1;
  }
  const x1 = x0 - i1 + G2;
  const z1 = z0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const z2 = z0 - 1 + 2 * G2;
  const ii = i & 255;
  const jj = j & 255;
  const gi0 = perm[ii + perm[jj & 511]!]! % 12;
  const gi1 = perm[ii + i1 + perm[(jj + j1) & 511]!]! % 12;
  const gi2 = perm[ii + 1 + perm[(jj + 1) & 511]!]! % 12;

  let n0 = 0;
  let n1 = 0;
  let n2 = 0;

  let t0 = 0.5 - x0 * x0 - z0 * z0;
  if (t0 >= 0) {
    t0 *= t0;
    const g = GRAD3[gi0]!;
    n0 = t0 * t0 * (g[0] * x0 + g[1] * z0);
  }
  let t1 = 0.5 - x1 * x1 - z1 * z1;
  if (t1 >= 0) {
    t1 *= t1;
    const g = GRAD3[gi1]!;
    n1 = t1 * t1 * (g[0] * x1 + g[1] * z1);
  }
  let t2 = 0.5 - x2 * x2 - z2 * z2;
  if (t2 >= 0) {
    t2 *= t2;
    const g = GRAD3[gi2]!;
    n2 = t2 * t2 * (g[0] * x2 + g[1] * z2);
  }
  return 70.0 * (n0 + n1 + n2);
}

/** Builds a deterministic Noise2D from an integer seed. Output clamped to [-1,1] (the classic formula has no analytic proof of exactly <=1; empirically it never reaches the clamp — see 04-terrain.md section 4.3.2). */
export const createNoise2D: CreateNoise2D = (seed: number): Noise2D => {
  const perm = buildPermutation(seed);
  return (x: number, z: number): number => {
    const v = rawNoise2D(perm, x, z);
    return v < -1 ? -1 : v > 1 ? 1 : v;
  };
};
