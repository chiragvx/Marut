/**
 * src/render/clouds.ts — fair-weather cumulus built from lit puffs, and their shadows on the ground.
 *
 * The cloud field is deterministic: one potential cloud per CELL_M cell, present if its hash is
 * below `coverage`. Each cloud is 25-70 puffs laid out as a real cumulus: a wide, flat base layer,
 * and 2-4 turrets that climb higher towards the cores (the tallest reaching `topM`).
 *
 * Each puff is a camera-facing quad shaded as a soft SPHERE (an impostor): per-pixel normals from
 * the sphere, blended with the whole cloud's dome normal, give sunlit tops, shaded undersides and
 * self-shadowing away from the sun. Pixels below the cloud base are cut, so bases are flat and
 * grey. Thin edges glow when looking towards the sun (silver lining). The same aerial perspective
 * as the terrain applies. This is far cheaper than ray-marching (one textured quad per puff, no
 * per-pixel loops) and still reads as 3D. Puffs within VIEW_RADIUS_M are drawn from one instanced
 * mesh, sorted back to front every few frames.
 *
 * Shadows: every cloud on the map is rasterised once into a 512x512 coverage texture over the
 * whole world (~390 m per texel, soft edges). Ground shaders project each point up along the sun
 * to the cloud layer and darken the sunlight by the coverage there (CLOUD_SHADOW_GLSL).
 */

import * as THREE from 'three';
import type { Vec3Like } from '../contracts/core';
import type { SceneEnvironment } from '../contracts/render';
import { TERRAIN_WORLD_HALF_EXTENT_M } from '../contracts/terrain';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';

type CloudConfig = NonNullable<SceneEnvironment['clouds']>;

const CELL_M = 3500;
const VIEW_RADIUS_M = 38000;
const RESEED_DISTANCE_M = 4000;
const SHADOW_TEX = 512;
const PUFF_TEX = 128;
const PUFF_VARIANTS = 4;
const MAX_PUFFS = 9000;
/**
 * Clouds exist for cells whose hash is below this; each fades in as the live coverage (weather)
 * passes its hash, so coverage changes smoothly without regenerating anything.
 */
const COVERAGE_CAP = 0.25;
/** Coverage over which one cloud fades in or out. */
const COVERAGE_FADE = 0.03;

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
  /** Coverage at which this cloud appears. */
  h: number;
}

function cloudAt(cfg: CloudConfig, ix: number, iz: number): Cloud | undefined {
  const h = hash(ix, iz, 1, cfg.seed);
  if (h > COVERAGE_CAP) return undefined;
  const radius = 500 + 1000 * hash(ix, iz, 4, cfg.seed);
  return {
    x: (ix + 0.2 + 0.6 * hash(ix, iz, 2, cfg.seed)) * CELL_M,
    z: (iz + 0.2 + 0.6 * hash(ix, iz, 3, cfg.seed)) * CELL_M,
    radius,
    base: cfg.baseM + 150 * (hash(ix, iz, 5, cfg.seed) - 0.5),
    top: cfg.baseM + (cfg.topM - cfg.baseM) * (0.5 + 0.5 * hash(ix, iz, 6, cfg.seed)),
    cell: [ix, iz],
    h,
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
  attribute vec4 iCloud; // cloud centre x, cloud base y, cloud centre z, cloud radius
  attribute vec4 iMisc;  // cloud top y, sprite variant, coverage at which the cloud appears, brightness jitter
  uniform vec3 uOrigin;
  uniform float uCoverage;
  varying vec2 vQ;
  varying vec3 vCentre;
  varying float vRadius;
  varying vec4 vCloud;
  varying vec4 vMisc;
  varying vec3 vRight;
  varying vec3 vUp;
  varying vec3 vBack;
  void main() {
    float show = clamp((uCoverage - iMisc.z) / ${COVERAGE_FADE.toFixed(3)}, 0.0, 1.0);
    if (show <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec4 mv = viewMatrix * vec4(iPuff.xyz - uOrigin, 1.0);
    mv.xy += position.xy * iPuff.w;
    vQ = position.xy;
    vCentre = iPuff.xyz;
    vRadius = iPuff.w;
    vCloud = iCloud;
    vMisc = vec4(iMisc.xy, 0.85 * show, iMisc.w);
    // Camera axes in world space (the rows of the view rotation).
    vRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vBack = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    gl_Position = projectionMatrix * mv;
  }
`;

const PUFF_FS = /* glsl */ `
  precision highp float;
  uniform highp sampler2DArray uPuff;
  uniform float uFadeEnd;
  uniform float uCloudDark;
  uniform float uCoverage;
  ${ATMOSPHERE_GLSL}
  varying vec2 vQ;
  varying vec3 vCentre;
  varying float vRadius;
  varying vec4 vCloud;
  varying vec4 vMisc;
  varying vec3 vRight;
  varying vec3 vUp;
  varying vec3 vBack;
  void main() {
    vec4 t = texture(uPuff, vec3(vQ * 0.5 + 0.5, vMisc.y));
    float r2 = dot(vQ, vQ);
    if (t.a < 0.01 || r2 >= 1.0) discard;
    // Sphere impostor: the point on this puff's sphere seen through this pixel.
    float z = sqrt(1.0 - r2);
    vec3 nPuff = normalize(vRight * vQ.x + vUp * vQ.y + vBack * z);
    vec3 pw = vCentre + nPuff * vRadius;
    // Flat base: cut everything below the cloud base (soft over ~20 m).
    float baseCut = smoothstep(vCloud.y - 5.0, vCloud.y + 20.0, pw.y);
    if (baseCut <= 0.0) discard;
    // The whole cloud's dome normal (from a point low in the cloud), blended with the puff's own.
    float cloudH = max(vMisc.x - vCloud.y, 50.0);
    vec3 dc = pw - vec3(vCloud.x, vCloud.y + 0.2 * cloudH, vCloud.z);
    dc.y *= vCloud.w / cloudH;
    vec3 nCloud = normalize(dc);
    vec3 n = normalize(mix(nPuff, nCloud, 0.55));
    vec3 L = normalize(uAtmSunDir);
    float h = clamp((pw.y - vCloud.y) / cloudH, 0.0, 1.0);
    // Sun: wrapped diffuse, with self-shadow on the side of the cloud away from the sun.
    float sun = clamp(dot(n, L) * 0.55 + 0.45, 0.0, 1.0) * mix(0.45, 1.0, clamp(0.5 + 0.6 * dot(nCloud, L), 0.0, 1.0));
    // Darker, flatter grey towards the base.
    float baseDark = mix(0.74, 1.0, smoothstep(0.0, 0.45, h));
    vec3 V = normalize(pw - uAtmCamPos);
    float mu = dot(V, L);
    // Silver lining: thin edges glow when looking towards the sun.
    float lining = pow(max(mu, 0.0), 6.0) * smoothstep(0.55, 1.0, r2) * 0.9;
    vec3 sky = mix(vec3(0.52, 0.58, 0.68), vec3(0.72, 0.78, 0.88), h) * (uAtmAmbSky / vec3(0.44, 0.47, 0.52));
    // Rain clouds: darker all over, darkest at the base.
    baseDark *= 1.0 - uCloudDark * (0.55 - 0.25 * h);
    vec3 col = (sky * 0.58 + uAtmSunCol * (1.53 * sun)) * baseDark * vMisc.w + uAtmSunCol * (1.6 * lining) * (1.0 - uCloudDark);
    col = min(col, vec3(1.0));
    col = atmApply(col, pw);
    // Soft, lumpy sprite edge; fade puffs right next to the camera and at the view limit.
    float camD = length(vCentre - uAtmCamPos);
    float a = t.a * vMisc.z * baseCut * smoothstep(0.0, 1.0, (camD - vRadius * 0.6) / (vRadius * 1.2)) * (1.0 - smoothstep(uFadeEnd * 0.85, uFadeEnd, camD));
    if (a < 0.004) discard;
    gl_FragColor = vec4(col, a);
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
  /** Live weather: cumulus coverage (0..0.25, fades clouds in and out) and darkness (0 white, 1 rain clouds). */
  setWeather(coverage: number, dark: number): void;
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
  const iCloud = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 4), 4);
  const iMisc = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 4), 4);
  for (const at of [iPuff, iCloud, iMisc]) at.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('iPuff', iPuff);
  geom.setAttribute('iCloud', iCloud);
  geom.setAttribute('iMisc', iMisc);
  geom.instanceCount = 0;
  const sunDir = new THREE.Vector3(0.4, 0.7, -0.3).normalize();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uPuff: { value: puffTex },
      uOrigin: { value: new THREE.Vector3() },
      uFadeEnd: { value: VIEW_RADIUS_M },
      uCoverage: { value: 0 },
      uCloudDark: { value: 0 },
      ...getAtmosphereUniforms(),
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
  let darkness = 0;
  /** Coverage the ground-shadow map was last built for. */
  let shadowCoverage = -1;
  // Puffs near the camera: world positions (x, y, z, radius) and shading, unsorted.
  let puffs: Float32Array = new Float32Array(0);
  let cloudsArr: Float32Array = new Float32Array(0);
  let misc: Float32Array = new Float32Array(0);
  let puffCount = 0;
  let seededAt: { x: number; z: number } | undefined;
  let frame = 0;
  const order: number[] = [];
  const dist: Float32Array = new Float32Array(MAX_PUFFS);

  function buildShadowMap(c: CloudConfig, coverage: number): void {
    shadowData.fill(0);
    const texel = (2 * TERRAIN_WORLD_HALF_EXTENT_M) / SHADOW_TEX;
    const n = Math.ceil(TERRAIN_WORLD_HALF_EXTENT_M / CELL_M) + 1;
    for (let iz = -n; iz <= n; iz++) {
      for (let ix = -n; ix <= n; ix++) {
        const cl = cloudAt(c, ix, iz);
        if (!cl) continue;
        const show = Math.max(0, Math.min(1, (coverage - cl.h) / COVERAGE_FADE));
        if (show <= 0) continue;
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
            const v = Math.max(0, Math.min(1, (1 - d) * 2.5)) * show;
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
    const cl4: number[] = [];
    const mi: number[] = [];
    const n = Math.ceil(VIEW_RADIUS_M / CELL_M) + 1;
    const icx = Math.floor(cx / CELL_M);
    const icz = Math.floor(cz / CELL_M);
    for (let iz = icz - n; iz <= icz + n; iz++) {
      for (let ix = icx - n; ix <= icx + n; ix++) {
        const cl = cloudAt(c, ix, iz);
        if (!cl) continue;
        const dist = Math.hypot(cl.x - cx, cl.z - cz);
        if (dist > VIEW_RADIUS_M + cl.radius) continue;
        const R = cl.radius;
        const H = cl.top - cl.base;
        // Far clouds get fewer, larger puffs (they cover few pixels anyway).
        const far = dist > 18000;
        const np = Math.round((25 + 45 * hash(ix, iz, 7, c.seed)) * (far ? 0.45 : 1));
        const sizeMul = far ? 1.35 : 1;
        // 2-4 turrets: the tall parts grow over these, the rest is the spreading base.
        const nt = 2 + Math.floor(3 * hash(ix, iz, 13, c.seed));
        for (let p = 0; p < np && list.length / 4 < MAX_PUFFS; p++) {
          const hp = (k: number): number => hash(ix * 97 + p, iz, k, c.seed);
          let x: number;
          let z: number;
          let h: number;
          if (hp(1) < 0.45) {
            // Base layer: wide and low.
            const a = hp(2) * Math.PI * 2;
            const rr = Math.sqrt(hp(3)) * R * 0.85;
            x = cl.x + Math.cos(a) * rr;
            z = cl.z + Math.sin(a) * rr;
            h = 0.12 * hp(4);
          } else {
            // Turrets: puffs stacked over a turret centre, narrowing with height.
            const ti = Math.floor(hp(5) * nt);
            const ta = hash(ix * 97 + ti, iz, 14, c.seed) * Math.PI * 2;
            const td = R * 0.45 * hash(ix * 97 + ti, iz, 15, c.seed);
            const tTop = 0.45 + 0.55 * hash(ix * 97 + ti, iz, 16, c.seed);
            h = tTop * Math.pow(hp(6), 0.8);
            const a = hp(7) * Math.PI * 2;
            const rr = Math.sqrt(hp(8)) * R * 0.45 * (1 - 0.6 * h);
            x = cl.x + Math.cos(ta) * td + Math.cos(a) * rr;
            z = cl.z + Math.sin(ta) * td + Math.sin(a) * rr;
          }
          const size = Math.max(110, R * (0.22 + 0.16 * hp(9)) * (1 - 0.35 * h)) * sizeMul;
          // Base-layer puff centres sit a little above the base so the flat cut shows.
          const y = cl.base + size * 0.35 + h * H;
          list.push(x, y, z, size);
          cl4.push(cl.x, cl.base, cl.z, R);
          mi.push(cl.top, Math.floor(hp(10) * PUFF_VARIANTS), cl.h, 0.92 + 0.16 * hp(11));
        }
      }
    }
    puffs = Float32Array.from(list);
    cloudsArr = Float32Array.from(cl4);
    misc = Float32Array.from(mi);
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
      shadowCoverage = -1;
      if (c) {
        shadowUniforms.uCloudShadowParams.value.y = (c.baseM + c.topM) / 2;
        this.setWeather(c.coverage, darkness);
      } else {
        mesh.visible = false;
        shadowUniforms.uCloudShadowParams.value.w = 0;
      }
    },

    setWeather(coverage, dark) {
      darkness = dark;
      mat.uniforms['uCloudDark']!.value = dark;
      const cov = cfg ? Math.min(coverage, COVERAGE_CAP) : 0;
      mat.uniforms['uCoverage']!.value = cov;
      mesh.visible = cov > 0;
      shadowUniforms.uCloudShadowParams.value.w = cov > 0 ? 1 : 0;
      // Shadows darken with the clouds; the coverage map is rebuilt only when coverage has moved.
      shadowUniforms.uCloudShadowParams.value.z = 0.5 + 0.25 * dark;
      if (cfg && Math.abs(cov - shadowCoverage) > 0.004) {
        shadowCoverage = cov;
        buildShadowMap(cfg, cov);
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
        const ca = iCloud.array as Float32Array;
        const ma = iMisc.array as Float32Array;
        for (let k = 0; k < puffCount; k++) {
          const i = order[k]!;
          pa.set(puffs.subarray(i * 4, i * 4 + 4), k * 4);
          ca.set(cloudsArr.subarray(i * 4, i * 4 + 4), k * 4);
          ma.set(misc.subarray(i * 4, i * 4 + 4), k * 4);
        }
        iPuff.needsUpdate = true;
        iCloud.needsUpdate = true;
        iMisc.needsUpdate = true;
        geom.instanceCount = puffCount;
      }
    },

    setFog() {
      // Clouds use the shared atmosphere (src/render/atmosphere.ts) for haze.
    },

    setSunDirection(dir) {
      // Shading reads the shared uAtmSunDir; nothing to rebuild.
      sunDir.set(dir.x, dir.y, dir.z).normalize();
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
