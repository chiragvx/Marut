/**
 * src/render/clouds.ts — fair-weather cumulus: soft billboard puffs, and their shadows on the ground.
 *
 * The cloud field is deterministic: one potential cloud per CELL_M cell, present if its hash is
 * below `coverage`, with 8-18 puffs arranged in a flattened dome (flat base, bulging top). Puffs
 * near the camera (within VIEW_RADIUS_M) are drawn as camera-facing quads from one instanced mesh,
 * textured from a small generated puff atlas, lit brighter on top and on the sun side, sorted back
 * to front every few frames, and faded into the horizon haze with distance.
 *
 * Shadows: every cloud on the map is rasterised once into a 512x512 coverage texture over the
 * whole world (~390 m per texel, soft edges). Ground shaders project each point up along the sun
 * to the cloud layer and darken the sunlight by the coverage there (CLOUD_SHADOW_GLSL).
 */

import * as THREE from 'three';
import type { Vec3Like } from '../contracts/core';
import type { SceneEnvironment } from '../contracts/render';
import { TERRAIN_WORLD_HALF_EXTENT_M } from '../contracts/terrain';

type CloudConfig = NonNullable<SceneEnvironment['clouds']>;

const CELL_M = 3500;
const VIEW_RADIUS_M = 38000;
const RESEED_DISTANCE_M = 4000;
const SHADOW_TEX = 512;
const PUFF_TEX = 128;
const PUFF_VARIANTS = 4;
const MAX_PUFFS = 4000;

function hash(a: number, b: number, c: number, seed: number): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x2545f491) ^ Math.imul(seed | 0, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Cloud {
  x: number;
  z: number;
  radius: number;
  base: number;
  top: number;
  cell: [number, number];
}

function cloudAt(cfg: CloudConfig, ix: number, iz: number): Cloud | undefined {
  if (hash(ix, iz, 1, cfg.seed) > cfg.coverage) return undefined;
  const radius = 500 + 1000 * hash(ix, iz, 4, cfg.seed);
  return {
    x: (ix + 0.2 + 0.6 * hash(ix, iz, 2, cfg.seed)) * CELL_M,
    z: (iz + 0.2 + 0.6 * hash(ix, iz, 3, cfg.seed)) * CELL_M,
    radius,
    base: cfg.baseM + 150 * (hash(ix, iz, 5, cfg.seed) - 0.5),
    top: cfg.baseM + (cfg.topM - cfg.baseM) * (0.5 + 0.5 * hash(ix, iz, 6, cfg.seed)),
    cell: [ix, iz],
  };
}

/** Soft puff sprites: a noisy, cauliflower-edged disc per variant, luminance in RGB, density in A. */
function makePuffTexture(): THREE.DataArrayTexture {
  const N = PUFF_TEX;
  const data = new Uint8Array(N * N * PUFF_VARIANTS * 4);
  for (let v = 0; v < PUFF_VARIANTS; v++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = (x + 0.5) / N - 0.5;
        const w = (y + 0.5) / N - 0.5;
        const r = Math.hypot(u, w) * 2;
        // Lumpy edge: a few angular lobes plus fine noise.
        const ang = Math.atan2(w, u);
        const lobes = 0.08 * Math.sin(ang * 5 + v * 1.7) + 0.05 * Math.sin(ang * 11 + v * 3.1) + 0.04 * (hash(x >> 3, y >> 3, v, 7) - 0.5);
        const d = Math.max(0, 1 - r / (0.85 + lobes));
        const density = Math.min(1, d * 1.8) * (0.85 + 0.15 * hash(x, y, v, 9));
        // Brighter towards the upper half of the sprite (tops of puffs catch the light).
        const lum = 0.8 + 0.2 * (0.5 - w) + 0.05 * (hash(x >> 2, y >> 2, v, 8) - 0.5);
        const o = ((v * N + y) * N + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = Math.round(Math.max(0, Math.min(1, lum)) * 255);
        data[o + 3] = Math.round(density * density * 255);
      }
    }
  }
  const tex = new THREE.DataArrayTexture(data, N, N, PUFF_VARIANTS);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const PUFF_VS = /* glsl */ `
  attribute vec4 iPuff;  // world x, y, z, radius
  attribute vec4 iShade; // height in cloud 0..1, sunward -1..1, sprite variant, opacity
  uniform vec3 uOrigin;
  varying vec2 vUv;
  varying vec4 vShade;
  varying float vDist;
  void main() {
    vec4 mv = viewMatrix * vec4(iPuff.xyz - uOrigin, 1.0);
    mv.xy += position.xy * iPuff.w;
    vUv = position.xy * 0.5 + 0.5;
    vShade = iShade;
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const PUFF_FS = /* glsl */ `
  precision highp float;
  uniform highp sampler2DArray uPuff;
  uniform vec3 uFogColor;
  uniform float uFadeEnd;
  varying vec2 vUv;
  varying vec4 vShade;
  varying float vDist;
  void main() {
    vec4 t = texture(uPuff, vec3(vUv, vShade.z));
    float a = t.a * vShade.w;
    if (a < 0.01) discard;
    // Flat grey-blue bases, white sunlit tops.
    float lit = clamp(0.25 + 0.75 * vShade.x + 0.25 * vShade.y, 0.0, 1.0) * t.r;
    vec3 col = mix(vec3(0.60, 0.64, 0.72), vec3(1.0, 0.99, 0.96), lit);
    float fog = smoothstep(uFadeEnd * 0.35, uFadeEnd, vDist);
    col = mix(col, uFogColor, fog * 0.85);
    gl_FragColor = vec4(col, a * (1.0 - smoothstep(uFadeEnd * 0.85, uFadeEnd, vDist)));
  }
`;

/**
 * GLSL for ground shaders: `cloudShadow(worldPos)` = 1 in sunlight, down to 1 - strength in a
 * cloud's shadow. Needs uniforms uCloudShadow (texture), uCloudShadowParams (x = world half extent,
 * y = cloud-layer height, z = strength, w = enabled) and uSunDir.
 */
export const CLOUD_SHADOW_GLSL = /* glsl */ `
  uniform sampler2D uCloudShadow;
  uniform vec4 uCloudShadowParams;
  float cloudShadow(vec3 w) {
    if (uCloudShadowParams.w < 0.5) return 1.0;
    vec3 L = normalize(uSunDir);
    vec2 p = w.xz + L.xz / max(L.y, 0.2) * max(uCloudShadowParams.y - w.y, 0.0);
    vec2 uv = (p + uCloudShadowParams.x) / (2.0 * uCloudShadowParams.x);
    return 1.0 - uCloudShadowParams.z * texture2D(uCloudShadow, uv).r;
  }
`;

let sharedShadowUniforms: CloudSystem['shadowUniforms'] | undefined;
/** The one set of cloud-shadow uniforms every ground material shares (filled by the CloudSystem). */
export function getCloudShadowUniforms(): CloudSystem['shadowUniforms'] {
  if (!sharedShadowUniforms) {
    const data = new Uint8Array(SHADOW_TEX * SHADOW_TEX);
    const tex = new THREE.DataTexture(data, SHADOW_TEX, SHADOW_TEX, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    sharedShadowUniforms = {
      uCloudShadow: { value: tex },
      uCloudShadowParams: { value: new THREE.Vector4(TERRAIN_WORLD_HALF_EXTENT_M, 2000, 0.5, 0) },
    };
  }
  return sharedShadowUniforms;
}

export interface CloudSystem {
  setConfig(cfg: SceneEnvironment['clouds']): void;
  /** Per frame, after the camera is placed. */
  update(cameraWorld: Readonly<Vec3Like>, originWorld: Readonly<Vec3Like>): void;
  setFog(fogColor: THREE.Color, fogEndM: number): void;
  setSunDirection(dir: Readonly<Vec3Like>): void;
  /** Shared uniforms for ground shaders (see CLOUD_SHADOW_GLSL). */
  readonly shadowUniforms: { uCloudShadow: { value: THREE.Texture }; uCloudShadowParams: { value: THREE.Vector4 } };
  dispose(): void;
}

export function createCloudSystem(scene: THREE.Scene): CloudSystem {
  const puffTex = makePuffTexture();
  const quad = new THREE.PlaneGeometry(2, 2);
  const geom = new THREE.InstancedBufferGeometry();
  geom.index = quad.index;
  geom.setAttribute('position', quad.getAttribute('position'));
  const iPuff = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 4), 4);
  const iShade = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 4), 4);
  iPuff.setUsage(THREE.DynamicDrawUsage);
  iShade.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('iPuff', iPuff);
  geom.setAttribute('iShade', iShade);
  geom.instanceCount = 0;
  const sunDir = new THREE.Vector3(0.4, 0.7, -0.3).normalize();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uPuff: { value: puffTex },
      uOrigin: { value: new THREE.Vector3() },
      uFogColor: { value: new THREE.Color(0xbcd4e8) },
      uFadeEnd: { value: VIEW_RADIUS_M },
    },
    vertexShader: PUFF_VS,
    fragmentShader: PUFF_FS,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.visible = false;
  scene.add(mesh);

  const shadowUniforms = getCloudShadowUniforms();
  const shadowTex = shadowUniforms.uCloudShadow.value as THREE.DataTexture;
  const shadowData = shadowTex.image.data as unknown as Uint8Array;

  let cfg: CloudConfig | undefined;
  // Puffs near the camera: world positions (x, y, z, radius) and shading, unsorted.
  let puffs: Float32Array = new Float32Array(0);
  let shades: Float32Array = new Float32Array(0);
  let puffCount = 0;
  let seededAt: { x: number; z: number } | undefined;
  let frame = 0;
  const order: number[] = [];
  const dist: Float32Array = new Float32Array(MAX_PUFFS);

  function buildShadowMap(c: CloudConfig): void {
    shadowData.fill(0);
    const texel = (2 * TERRAIN_WORLD_HALF_EXTENT_M) / SHADOW_TEX;
    const n = Math.ceil(TERRAIN_WORLD_HALF_EXTENT_M / CELL_M) + 1;
    for (let iz = -n; iz <= n; iz++) {
      for (let ix = -n; ix <= n; ix++) {
        const cl = cloudAt(c, ix, iz);
        if (!cl) continue;
        const r = cl.radius * 0.9;
        const x0 = Math.floor((cl.x - r + TERRAIN_WORLD_HALF_EXTENT_M) / texel);
        const x1 = Math.ceil((cl.x + r + TERRAIN_WORLD_HALF_EXTENT_M) / texel);
        const z0 = Math.floor((cl.z - r + TERRAIN_WORLD_HALF_EXTENT_M) / texel);
        const z1 = Math.ceil((cl.z + r + TERRAIN_WORLD_HALF_EXTENT_M) / texel);
        for (let tz = Math.max(0, z0); tz <= Math.min(SHADOW_TEX - 1, z1); tz++) {
          for (let tx = Math.max(0, x0); tx <= Math.min(SHADOW_TEX - 1, x1); tx++) {
            const wx = (tx + 0.5) * texel - TERRAIN_WORLD_HALF_EXTENT_M;
            const wz = (tz + 0.5) * texel - TERRAIN_WORLD_HALF_EXTENT_M;
            const d = Math.hypot(wx - cl.x, wz - cl.z) / r;
            const v = Math.max(0, Math.min(1, (1 - d) * 2.5));
            const k = tz * SHADOW_TEX + tx;
            shadowData[k] = Math.max(shadowData[k]!, Math.round(v * 255));
          }
        }
      }
    }
    shadowTex.needsUpdate = true;
  }

  function reseed(c: CloudConfig, cx: number, cz: number): void {
    const list: number[] = [];
    const sh: number[] = [];
    const n = Math.ceil(VIEW_RADIUS_M / CELL_M) + 1;
    const icx = Math.floor(cx / CELL_M);
    const icz = Math.floor(cz / CELL_M);
    const L = sunDir;
    for (let iz = icz - n; iz <= icz + n; iz++) {
      for (let ix = icx - n; ix <= icx + n; ix++) {
        const cl = cloudAt(c, ix, iz);
        if (!cl || Math.hypot(cl.x - cx, cl.z - cz) > VIEW_RADIUS_M + cl.radius) continue;
        const np = 8 + Math.floor(10 * hash(ix, iz, 7, c.seed));
        const thick = cl.top - cl.base;
        for (let p = 0; p < np && list.length / 4 < MAX_PUFFS; p++) {
          // Dome: puffs spread wide near the base, fewer and higher towards the centre.
          const a = hash(ix * 31 + p, iz, 8, c.seed) * Math.PI * 2;
          const rr = Math.sqrt(hash(ix * 31 + p, iz, 9, c.seed));
          const hgt = (1 - rr * rr) * (0.3 + 0.7 * hash(ix * 31 + p, iz, 10, c.seed));
          const ox = Math.cos(a) * rr * cl.radius * 0.75;
          const oz = Math.sin(a) * rr * cl.radius * 0.75;
          const size = cl.radius * (0.35 + 0.25 * hash(ix * 31 + p, iz, 11, c.seed)) * (1 - 0.4 * hgt);
          const y = cl.base + size * 0.55 + hgt * thick;
          list.push(cl.x + ox, y, cl.z + oz, size);
          const sunward = (ox * L.x + oz * L.z) / (cl.radius * 0.75 * Math.max(Math.hypot(L.x, L.z), 1e-3));
          sh.push(hgt, Math.max(-1, Math.min(1, sunward)), Math.floor(hash(ix * 31 + p, iz, 12, c.seed) * PUFF_VARIANTS), 0.9);
        }
      }
    }
    puffs = Float32Array.from(list);
    shades = Float32Array.from(sh);
    puffCount = puffs.length / 4;
    order.length = puffCount;
    for (let i = 0; i < puffCount; i++) order[i] = i;
    seededAt = { x: cx, z: cz };
  }

  return {
    shadowUniforms,

    setConfig(c) {
      cfg = c;
      seededAt = undefined;
      mesh.visible = !!c;
      shadowUniforms.uCloudShadowParams.value.w = c ? 1 : 0;
      if (c) {
        shadowUniforms.uCloudShadowParams.value.y = (c.baseM + c.topM) / 2;
        buildShadowMap(c);
      }
    },

    update(cam, origin) {
      if (!cfg) return;
      if (!seededAt || Math.hypot(cam.x - seededAt.x, cam.z - seededAt.z) > RESEED_DISTANCE_M) reseed(cfg, cam.x, cam.z);
      (mat.uniforms['uOrigin']!.value as THREE.Vector3).set(origin.x, origin.y, origin.z);
      // Back-to-front order, refreshed every few frames (puffs are static; only the camera moves).
      if (frame++ % 4 === 0) {
        for (let i = 0; i < puffCount; i++) {
          const dx = puffs[i * 4]! - cam.x;
          const dy = puffs[i * 4 + 1]! - cam.y;
          const dz = puffs[i * 4 + 2]! - cam.z;
          dist[i] = dx * dx + dy * dy + dz * dz;
        }
        order.sort((a, b) => dist[b]! - dist[a]!);
        const pa = iPuff.array as Float32Array;
        const sa = iShade.array as Float32Array;
        for (let k = 0; k < puffCount; k++) {
          const i = order[k]!;
          pa.set(puffs.subarray(i * 4, i * 4 + 4), k * 4);
          sa.set(shades.subarray(i * 4, i * 4 + 4), k * 4);
        }
        iPuff.needsUpdate = true;
        iShade.needsUpdate = true;
        geom.instanceCount = puffCount;
      }
    },

    setFog(color) {
      (mat.uniforms['uFogColor']!.value as THREE.Color).copy(color);
    },

    setSunDirection(dir) {
      sunDir.set(dir.x, dir.y, dir.z).normalize();
      seededAt = undefined;
    },

    dispose() {
      scene.remove(mesh);
      geom.dispose();
      quad.dispose();
      mat.dispose();
      puffTex.dispose();
    },
  };
}
