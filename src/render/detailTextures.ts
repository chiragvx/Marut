/**
 * src/render/detailTextures.ts — procedural ground detail textures, generated at load (nothing is
 * downloaded).
 *
 * One THREE.DataArrayTexture, 512x512 x DETAIL_LAYER_COUNT layers, RGBA8, seamless (every noise is
 * periodic in the tile), mipmapped. Texel values are multiplicative detail around 0.5, so a
 * shader applies `col *= 2.0 * texel` and the mip chain averages out to exactly "no change" far
 * away, with no aliasing. About 5.6 MB of VRAM with mips.
 *
 * Layers: 0 crop/grass canopy, 1 soil, 2 sand, 3 asphalt.
 */

import * as THREE from 'three';

export const DETAIL_SIZE = 512;
export const DetailLayer = { Crop: 0, Soil: 1, Sand: 2, Asphalt: 3 } as const;
export const DETAIL_LAYER_COUNT = 4;

function hash(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise with a `period`-cell lattice across the tile (so it tiles seamlessly). u, v in [0, 1). */
function pnoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period;
  const y = v * period;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % period) + period) % period;
  const y0 = ((iy % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const a = hash(x0, y0, seed);
  const b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed);
  const d = hash(x1, y1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(u: number, v: number, basePeriod: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * pnoise(u, v, period, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return sum / norm;
}

type Texel = (u: number, v: number, ix: number, iy: number) => [number, number, number];

const LAYERS: readonly Texel[] = [
  // Crop / grass canopy: clumps at several scales, per-texel speckle and a little yellow-green hue
  // shift. (No regular sowing rows: any periodic stripe moires into rings at a distance.)
  (u, v, ix, iy) => {
    const clumps = fbm(u, v, 16, 4, 11);
    const fine = hash(ix, iy, 12) - 0.5;
    const l = 0.5 + 0.5 * (clumps - 0.5) + 0.1 * fine;
    const hue = fbm(u, v, 4, 3, 13) - 0.5;
    return [l * (1 + 0.18 * hue), l, l * (1 - 0.12 * hue)];
  },
  // Soil: clods and tone, dark cracks, pale pebbles.
  (u, v, ix, iy) => {
    const tone = fbm(u, v, 8, 5, 21);
    const crackN = pnoise(u, v, 16, 22) * 0.6 + pnoise(u, v, 32, 23) * 0.4;
    const crack = Math.max(0, 1 - Math.abs(crackN - 0.5) / 0.03);
    const pebble = hash(ix >> 2, iy >> 2, 24) > 0.985 ? 0.12 : 0;
    const l = 0.5 + 0.45 * (tone - 0.5) + 0.08 * (hash(ix, iy, 25) - 0.5) - 0.18 * crack + pebble;
    return [l * 1.03, l, l * 0.96];
  },
  // Sand: fine grain and wind ripples.
  (u, v, ix, iy) => {
    const grain = hash(ix, iy, 31) - 0.5;
    const warp = fbm(u, v, 4, 3, 32);
    const ripple = Math.sin((v * DETAIL_SIZE + 40 * warp) / 7) * 0.05;
    const l = 0.5 + 0.25 * (fbm(u, v, 8, 4, 33) - 0.5) + 0.1 * grain + ripple;
    return [l, l, l * 0.98];
  },
  // Asphalt: aggregate speckle, patched blotches, a few cracks.
  (u, v, ix, iy) => {
    const agg = hash(ix, iy, 41) - 0.5;
    const patch = fbm(u, v, 4, 3, 42);
    const crack = Math.max(0, 1 - Math.abs(pnoise(u, v, 8, 43) - 0.5) / 0.012) * (patch > 0.55 ? 1 : 0);
    const l = 0.5 + 0.18 * agg + 0.3 * (patch - 0.5) - 0.2 * crack;
    return [l, l, l * 1.02];
  },
];

let cached: THREE.DataArrayTexture | undefined;

/** The shared detail texture (built on first call, ~100-200 ms). */
export function getDetailTexture(): THREE.DataArrayTexture {
  if (cached) return cached;
  const N = DETAIL_SIZE;
  const data = new Uint8Array(N * N * DETAIL_LAYER_COUNT * 4);
  for (let layer = 0; layer < DETAIL_LAYER_COUNT; layer++) {
    const f = LAYERS[layer]!;
    let o = layer * N * N * 4;
    for (let iy = 0; iy < N; iy++) {
      for (let ix = 0; ix < N; ix++) {
        const [r, g, b] = f(ix / N, iy / N, ix, iy);
        data[o++] = Math.max(0, Math.min(255, Math.round(r * 255)));
        data[o++] = Math.max(0, Math.min(255, Math.round(g * 255)));
        data[o++] = Math.max(0, Math.min(255, Math.round(b * 255)));
        data[o++] = 255;
      }
    }
  }
  const tex = new THREE.DataArrayTexture(data, N, N, DETAIL_LAYER_COUNT);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}

/**
 * GLSL helper: multiplicative detail (mean 1.0) for `layer` at world xz, sampling the tile at two
 * scales rotated against each other so the repeat never lines up. The small scale fades out once
 * a pixel covers more than ~1/10 of its tile (`px`, metres per pixel), and so does the large scale
 * relative to its own tile: past that the detail is gone and only the repeat would remain, which
 * reads as a lattice (moire arcs, or a grid from altitude).
 */
export const DETAIL_GLSL = /* glsl */ `
  uniform highp sampler2DArray uDetail;
  vec3 detailAt(vec2 p, float layer, float tileM, float px) {
    float bigM = tileM * 6.1;
    float coarseW = 1.0 - smoothstep(bigM * 0.04, bigM * 0.1, px);
    if (coarseW <= 0.0) return vec3(1.0);
    vec2 q = vec2(0.8 * p.x - 0.6 * p.y, 0.6 * p.x + 0.8 * p.y);
    vec3 b = mix(vec3(1.0), texture(uDetail, vec3(q / bigM, layer)).rgb * 2.0, coarseW);
    float fineW = 1.0 - smoothstep(tileM * 0.03, tileM * 0.1, px);
    if (fineW <= 0.0) return b;
    vec3 a = texture(uDetail, vec3(p / tileM, layer)).rgb * 2.0;
    return b * mix(vec3(1.0), a, fineW);
  }
`;
