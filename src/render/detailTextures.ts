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
import { DETAIL_LAYER_COUNT, DETAIL_SIZE, buildDetailData } from './detailTextureData';

export { DETAIL_LAYER_COUNT, DETAIL_SIZE, DetailLayer } from './detailTextureData';

let cached: THREE.DataArrayTexture | undefined;

/**
 * The shared detail texture. Its texels (~1 s of noise on a slow PC) are built in a worker
 * (detailTextures.worker.ts) so opening the game doesn't freeze the page: until they arrive (a
 * fraction of a second, while the menu's cinematic is still fading in from black) every texel is
 * mid-grey, i.e. "no detail". Without workers (tests) they are built here at once.
 */
export function getDetailTexture(): THREE.DataArrayTexture {
  if (cached) return cached;
  const N = DETAIL_SIZE;
  const tex = new THREE.DataArrayTexture(new Uint8Array(N * N * DETAIL_LAYER_COUNT * 4).fill(128), N, N, DETAIL_LAYER_COUNT);
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
  const fill = (data: Uint8Array): void => {
    tex.image.data.set(data);
    tex.needsUpdate = true;
  };
  let worker: Worker | undefined;
  try {
    worker = typeof Worker === 'undefined' ? undefined : new Worker(new URL('./detailTextures.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = undefined;
  }
  if (!worker) {
    fill(buildDetailData());
    return tex;
  }
  const w = worker;
  w.onmessage = (e: MessageEvent<Uint8Array>): void => {
    fill(e.data);
    w.terminate();
  };
  w.onerror = (): void => {
    w.terminate();
    fill(buildDetailData());
  };
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
