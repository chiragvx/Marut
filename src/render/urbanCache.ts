/**
 * src/render/urbanCache.ts — the urban layer's street and lot detail, baked into camera-centred
 * cache textures so the terrain shader only reads it (urbanLayer.ts).
 *
 * Three levels of N x N texels (1.25, 5 and 20 m per texel) in one RGBA8 texture array, three
 * layers per level (the parts A and R, and the street lights; urbanParts.ts). Each level is a window around the camera that
 * moves in steps of STEP texels. Texel (i, j) always holds world cell (i, j) mod N (toroidal
 * addressing, sampled with repeat wrapping), so when the window moves only the strip of cells that
 * came into it is re-baked; everything else stays put. Work goes through a queue with a per-frame
 * budget of texels: filling all levels at a mission start or a jump is spread over some frames
 * (a level is only used once it is complete), and a strip normally takes a single frame.
 */
import * as THREE from 'three';
import type { UrbanLayer } from '../contracts/terrain';
import { URBAN_PARTS_GLSL } from './urbanParts';

export const URBAN_CACHE_LEVELS = 3;
/** Texel size of each level (m). */
const TEXEL_M = [1.25, 5, 20] as const;
/** The windows move in steps of this many texels. */
const STEP = 32;
/** Layers per level: parts A, R and the street lights. */
const LAYERS = 3;
/** Texels baked per frame at most (every layer counts). */
const BUDGET_TEXELS = 262144;

const cacheUniforms = {
  uUrbCache: { value: emptyArray() as THREE.Texture },
  /** Per level: window min x, min z, extent (m), texel (m); extent 0 = level not ready. */
  uUrbCacheInfo: { value: Array.from({ length: URBAN_CACHE_LEVELS }, () => new THREE.Vector4(0, 0, 0, 1)) },
  uUrbCacheOn: { value: 0 },
};

/** Shared by every terrain material (the cache updates them in place). */
export function getUrbanCacheUniforms(): typeof cacheUniforms {
  return cacheUniforms;
}

function emptyArray(): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(new Uint8Array(4 * LAYERS * URBAN_CACHE_LEVELS), 1, 1, LAYERS * URBAN_CACHE_LEVELS);
  t.needsUpdate = true;
  return t;
}

/**
 * The terrain side (needs ATMOSPHERE_GLSL's uAtmLights declared before it). Level weights are a tent over f = log2(px / t0) / 2 + 0.25 (levels are 4x apart),
 * with a fourth slot for the far-view mean already in A, R. A level's weight passes on to the next
 * one outside its window (with a fade at the window's edge, where cells may be stale).
 */
export const URBAN_CACHE_GLSL = /* glsl */ `
  uniform highp sampler2DArray uUrbCache;
  uniform vec4 uUrbCacheInfo[${URBAN_CACHE_LEVELS}];
  uniform float uUrbCacheOn;

  // A, R, Lg (street lights: glow, white glow): the far-view means on entry; the cached detail
  // blended in on return.
  void uCacheParts(vec2 p, float px, inout vec4 A, inout vec4 R, inout vec2 Lg) {
    float f = clamp(log2(max(px, 1e-3) / uUrbCacheInfo[0].w) * 0.5 + 0.25, 0.0, ${URBAN_CACHE_LEVELS.toFixed(1)});
    vec4 a = vec4(0.0);
    vec4 r = vec4(0.0);
    vec2 lg = vec2(0.0);
    float used = 0.0;
    float carry = 0.0;
    for (int L = 0; L < ${URBAN_CACHE_LEVELS}; L++) {
      float wn = max(0.0, 1.0 - abs(f - float(L))) + carry;
      carry = 0.0;
      if (wn <= 0.0) continue;
      vec4 I = uUrbCacheInfo[L];
      float v = 0.0;
      if (I.z > 0.0) {
        vec2 q = (p - I.xy) / I.z - 0.5;
        v = 1.0 - smoothstep(0.44, 0.49, max(abs(q.x), abs(q.y)));
      }
      if (v > 0.0) {
        vec2 uv = p / I.z;
        a += wn * v * textureLod(uUrbCache, vec3(uv, float(${LAYERS} * L)), 0.0);
        r += wn * v * textureLod(uUrbCache, vec3(uv, float(${LAYERS} * L + 1)), 0.0);
        // Street lights only at night (stored at half scale: a lamp head peaks near 2).
        if (uAtmLights > 0.01) lg += wn * v * 2.0 * textureLod(uUrbCache, vec3(uv, float(${LAYERS} * L + 2)), 0.0).xy;
        used += wn * v;
      }
      carry = wn * (1.0 - v);
    }
    float meanW = 1.0 - used;
    A = a + meanW * A;
    R = r + meanW * R;
    Lg = lg + meanW * Lg;
  }
`;

const BAKE_VS = /* glsl */ `
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BAKE_FS = /* glsl */ `
  precision highp float;
  ${URBAN_PARTS_GLSL}
  uniform vec4 uLevel; // window min x, min z (multiples of the texel), texel (m), N
  uniform int uOut;    // 0 = A, 1 = R, 2 = street lights (half scale)
  void main() {
    vec2 ij = floor(gl_FragCoord.xy);
    // The window cell stored at texel ij (toroidal): its offset from the window's min corner.
    vec2 k = mod(ij - mod(uLevel.xy / uLevel.z, uLevel.w), uLevel.w);
    vec2 p = uLevel.xy + (k + 0.5) * uLevel.z;
    if (uOut == 2) {
      gl_FragColor = vec4(min(0.5 * uStreetLights(p, uLevel.z), vec2(1.0)), 0.0, 1.0);
      return;
    }
    vec4 A;
    vec4 R;
    uDetailParts(p, vec2(uLevel.z, 0.0), vec2(0.0, uLevel.z), uLevel.z, A, R);
    gl_FragColor = uOut == 0 ? A : R;
  }
`;

export interface UrbanCache {
  /** The theatre's urban field (null = none: the cache is off). */
  setLayer(layer: UrbanLayer | null | undefined): void;
  /** Per frame, before the scene renders: follow the camera and bake queued cells. */
  update(renderer: THREE.WebGLRenderer, camX: number, camZ: number): void;
  dispose(): void;
}

interface Job {
  level: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LevelState {
  x0: number;
  z0: number;
  placed: boolean;
  /** Jobs of a full (re)fill still queued: the level is not used until they are done. */
  pendingFill: number;
}

export function createUrbanCache(N = 1024): UrbanCache {
  const target = new THREE.WebGLArrayRenderTarget(N, N, LAYERS * URBAN_CACHE_LEVELS, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
  });
  target.texture.wrapS = THREE.RepeatWrapping;
  target.texture.wrapT = THREE.RepeatWrapping;
  target.scissorTest = true;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uUrbanTex: { value: null as THREE.Texture | null },
      uUrbanInfo: { value: new THREE.Vector4() },
      uUrbanSize: { value: new THREE.Vector2(1, 1) },
      uUrbanSeed: { value: 0 },
      uLevel: { value: new THREE.Vector4() },
      uOut: { value: 0 },
    },
    vertexShader: BAKE_VS,
    fragmentShader: BAKE_FS,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let fieldTex: THREE.DataTexture | null = null;
  const levels: LevelState[] = TEXEL_M.map(() => ({ x0: 0, z0: 0, placed: false, pendingFill: 0 }));
  let queue: (Job & { fill: boolean })[] = [];
  const info = cacheUniforms.uUrbCacheInfo.value;

  const mod = (a: number, n: number): number => ((a % n) + n) % n;

  /** Queue the texel columns (axis 0) or rows (axis 1) holding world cells [c0, c0 + count). */
  function queueCells(level: number, axis: 0 | 1, c0: number, count: number, fill: boolean): void {
    let start = mod(c0, N);
    let left = Math.min(count, N);
    while (left > 0) {
      const run = Math.min(left, N - start);
      const job = axis === 0 ? { level, x: start, y: 0, w: run, h: N, fill } : { level, x: 0, y: start, w: N, h: run, fill };
      queue.push(job);
      if (fill) levels[level]!.pendingFill++;
      left -= run;
      start = 0;
    }
  }

  function bake(renderer: THREE.WebGLRenderer, job: Job): void {
    const t = TEXEL_M[job.level]!;
    const L = levels[job.level]!;
    (mat.uniforms['uLevel']!.value as THREE.Vector4).set(L.x0, L.z0, t, N);
    target.scissor.set(job.x, job.y, job.w, job.h);
    for (let out = 0; out < LAYERS; out++) {
      mat.uniforms['uOut']!.value = out;
      renderer.setRenderTarget(target, LAYERS * job.level + out);
      renderer.render(scene, cam);
    }
  }

  return {
    setLayer(layer) {
      fieldTex?.dispose();
      fieldTex = null;
      queue = [];
      for (const L of levels) {
        L.placed = false;
        L.pendingFill = 0;
      }
      for (const v of info) v.z = 0;
      cacheUniforms.uUrbCacheOn.value = 0;
      if (!layer) return;
      // The bake reads the field with texelFetch only; a copy of its own keeps it independent of the terrain material's.
      fieldTex = new THREE.DataTexture(layer.data as Uint8Array<ArrayBuffer>, layer.nx, layer.nz, THREE.RGBAFormat, THREE.UnsignedByteType);
      fieldTex.needsUpdate = true;
      const u = mat.uniforms;
      u['uUrbanTex']!.value = fieldTex;
      (u['uUrbanInfo']!.value as THREE.Vector4).set(layer.originX, layer.originZ, layer.resM, 1);
      (u['uUrbanSize']!.value as THREE.Vector2).set(layer.nx, layer.nz);
      u['uUrbanSeed']!.value = layer.seed;
      cacheUniforms.uUrbCache.value = target.texture;
      cacheUniforms.uUrbCacheOn.value = 1;
    },

    update(renderer, camX, camZ) {
      if (!fieldTex) return;
      // Follow the camera: coarse levels first, so the wide view fills in first.
      for (let l = URBAN_CACHE_LEVELS - 1; l >= 0; l--) {
        const t = TEXEL_M[l]!;
        const step = STEP * t;
        const E = N * t;
        const L = levels[l]!;
        const nx0 = Math.round(camX / step) * step - E / 2;
        const nz0 = Math.round(camZ / step) * step - E / 2;
        if (L.placed && nx0 === L.x0 && nz0 === L.z0) continue;
        const full = !L.placed || Math.abs(nx0 - L.x0) >= E || Math.abs(nz0 - L.z0) >= E;
        const ox0 = L.x0;
        const oz0 = L.z0;
        L.x0 = nx0;
        L.z0 = nz0;
        if (full) {
          L.placed = true;
          // Drop this level's stale jobs; refill it in row bands.
          queue = queue.filter((j) => j.level !== l);
          L.pendingFill = 0;
          info[l]!.z = 0;
          const band = Math.max(1, Math.floor(BUDGET_TEXELS / LAYERS / N));
          for (let y = 0; y < N; y += band) {
            queue.push({ level: l, x: 0, y, w: N, h: Math.min(band, N - y), fill: true });
            L.pendingFill++;
          }
          continue;
        }
        // The cells that came into the window (columns, then rows).
        const c = Math.round(nx0 / t);
        const oc = Math.round(ox0 / t);
        if (c > oc) queueCells(l, 0, oc + N, c - oc, false);
        else if (c < oc) queueCells(l, 0, c, oc - c, false);
        const r = Math.round(nz0 / t);
        const or = Math.round(oz0 / t);
        if (r > or) queueCells(l, 1, or + N, r - or, false);
        else if (r < or) queueCells(l, 1, r, or - r, false);
        // A moved, complete level stays in use: the new strips sit in its faded edge.
        if (L.pendingFill === 0) info[l]!.set(L.x0, L.z0, E, t);
      }
      if (queue.length === 0) return;

      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      let budget = BUDGET_TEXELS;
      while (queue.length > 0 && budget > 0) {
        const job = queue.shift()!;
        bake(renderer, job);
        budget -= LAYERS * job.w * job.h;
        if (job.fill) {
          const L = levels[job.level]!;
          L.pendingFill--;
          if (L.pendingFill === 0) info[job.level]!.set(L.x0, L.z0, N * TEXEL_M[job.level]!, TEXEL_M[job.level]!);
        } else {
          const L = levels[job.level]!;
          if (L.pendingFill === 0) info[job.level]!.set(L.x0, L.z0, N * TEXEL_M[job.level]!, TEXEL_M[job.level]!);
        }
      }
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
    },

    dispose() {
      target.dispose();
      mat.dispose();
      quad.geometry.dispose();
      fieldTex?.dispose();
    },
  };
}
