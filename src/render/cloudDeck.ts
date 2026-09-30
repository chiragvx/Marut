/**
 * src/render/cloudDeck.ts — the overcast stratus deck: one big horizontal layer that follows the
 * camera, textured by two scales of a tiling noise (clumps and breaks), with earth curvature and
 * the shared haze.
 *
 * Seen from below it is the grey underside (darker where thick, and for rain clouds); from above,
 * a sunlit white top. Inside the layer the view whites out (a full-screen veil). Cost: one layer
 * of fragments with two texture reads, plus the veil only while inside.
 */
import * as THREE from 'three';
import type { Vec3Like } from '../contracts/core';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';

const RADIUS_M = 70000;
const NOISE_N = 256;
/** Metres per tile of the coarse and fine noise. */
const TILE_COARSE_M = 9000;
const TILE_FINE_M = 2300;

/** Tileable value-noise fbm, 0..1, in one channel. */
function makeNoiseTexture(): THREE.DataTexture {
  const N = NOISE_N;
  const data = new Uint8Array(N * N);
  const lattice = (p: number, i: number, j: number): number => {
    const a = ((i % p) + p) % p;
    const b = ((j % p) + p) % p;
    let h = (Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(p, 2246822519)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const noise = (x: number, y: number, p: number): number => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = lattice(p, i, j);
    const b = lattice(p, i + 1, j);
    const c = lattice(p, i, j + 1);
    const d = lattice(p, i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let v = 0;
      let amp = 0.5;
      let total = 0;
      for (let o = 0, p = 4; o < 5; o++, p *= 2) {
        v += amp * noise((x / N) * p, (y / N) * p, p);
        total += amp;
        amp *= 0.5;
      }
      data[y * N + x] = Math.round((v / total) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  uniform float uLevel;
  uniform vec3 uOrigin;
  varying vec3 vWorld;
  void main() {
    vec3 w = vec3(position.x + uAtmCamPos.x, uLevel, position.z + uAtmCamPos.z);
    vWorld = w;
    gl_Position = projectionMatrix * viewMatrix * vec4(atmCurve(w) - uOrigin, 1.0);
  }
`;

const FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  uniform sampler2D uNoise;
  uniform float uCover;
  uniform float uDark;
  uniform float uFromAbove;
  uniform vec3 uSunAbove;
  uniform float uTime;
  varying vec3 vWorld;
  void main() {
    vec2 drift = vec2(uTime * 2.0, uTime * 0.7);
    float d = 0.62 * texture2D(uNoise, (vWorld.xz + drift) / ${TILE_COARSE_M.toFixed(1)}).r
            + 0.38 * texture2D(uNoise, (vWorld.xz + drift * 1.6) / ${TILE_FINE_M.toFixed(1)} + 0.37).r;
    // Denser where the noise is high; cover 1 closes every break.
    float thr = 1.0 - uCover * 1.15;
    float a = smoothstep(thr - 0.05, thr + 0.18, d);
    float dist = length(vWorld.xz - uAtmCamPos.xz);
    a *= 1.0 - smoothstep(${(RADIUS_M * 0.75).toFixed(1)}, ${(RADIUS_M * 0.98).toFixed(1)}, dist);
    if (a < 0.01) discard;
    float thick = smoothstep(0.35, 0.9, d);
    vec3 col;
    if (uFromAbove > 0.5) {
      // Sunlit tops: bright, with soft relief from the texture.
      float L = max(normalize(uAtmSunDir).y, 0.0);
      col = vec3(0.92, 0.93, 0.95) * (uAtmAmbSky * 0.8 + uSunAbove * (0.8 + 0.5 * L)) * (0.72 + 0.4 * thick);
    } else {
      // The underside: grey, darker where thick and for rain clouds.
      float shade = mix(0.95, 0.62, thick) * (1.0 - 0.45 * uDark * (0.5 + thick));
      col = vec3(0.78, 0.80, 0.84) * shade * (uAtmAmbSky * 1.15 + uAtmSunCol * 0.6);
    }
    if (uAtmThermal > 0.5) col = vec3(0.1) * atmLightLevel();
    gl_FragColor = vec4(atmApply(col, vWorld), a);
  }
`;

export interface CloudDeck {
  /** Layer base and top, m MSL (per theatre). */
  setLevels(baseM: number, topM: number): void;
  /**
   * Per frame. cover/dark from the weather (0 hides the deck); sunAbove = unobstructed sunlight
   * colour (for the tops). Returns how far below the deck the camera is, as a 0..1 "under cloud"
   * weight (1 well below the base, 0 above the top), for the sky and light.
   */
  update(camWorld: Readonly<Vec3Like>, originWorld: Readonly<Vec3Like>, cover: number, dark: number, sunAbove: Readonly<[number, number, number]>, timeSec: number): number;
  dispose(): void;
}

export function createCloudDeck(scene: THREE.Scene): CloudDeck {
  const noise = makeNoiseTexture();
  // A disc with dense rings near the middle and sparse ones far out (curvature follows the rings).
  const rings = [0, 300, 700, 1300, 2200, 3500, 5500, 8500, 13000, 20000, 30000, 45000, RADIUS_M];
  const seg = 48;
  const pos: number[] = [];
  const idx: number[] = [];
  pos.push(0, 0, 0);
  for (let r = 1; r < rings.length; r++) {
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * rings[r]!, 0, Math.sin(a) * rings[r]!);
    }
  }
  for (let s = 0; s < seg; s++) idx.push(0, 1 + ((s + 1) % seg), 1 + s);
  for (let r = 1; r < rings.length - 1; r++) {
    const a0 = 1 + (r - 1) * seg;
    const b0 = 1 + r * seg;
    for (let s = 0; s < seg; s++) {
      const s1 = (s + 1) % seg;
      idx.push(a0 + s, a0 + s1, b0 + s, a0 + s1, b0 + s1, b0 + s);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...getAtmosphereUniforms(),
      uNoise: { value: noise },
      uLevel: { value: 1000 },
      uOrigin: { value: new THREE.Vector3() },
      uCover: { value: 0 },
      uDark: { value: 0 },
      uFromAbove: { value: 0 },
      uSunAbove: { value: new THREE.Color() },
      uTime: { value: 0 },
    },
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  // After the cumulus when seen from below (they are above it), before them from above.
  mesh.renderOrder = 9;
  mesh.visible = false;
  scene.add(mesh);

  // Inside the layer: a full-screen grey veil.
  const veilMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform vec3 uColor; uniform float uAlpha; void main() { gl_FragColor = vec4(uColor, uAlpha); }',
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const veil = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), veilMat);
  veil.frustumCulled = false;
  veil.renderOrder = 1000;
  veil.visible = false;
  scene.add(veil);

  let base = 1000;
  let top = 1500;
  const u = getAtmosphereUniforms();

  return {
    setLevels(b, t) {
      base = b;
      top = t;
    },

    update(cam, origin, cover, dark, sunAbove, timeSec) {
      const on = cover > 0.02;
      mesh.visible = on;
      const below = 1 - Math.max(0, Math.min(1, (cam.y - base) / Math.max(top - base, 1)));
      if (!on) {
        veil.visible = false;
        return 1;
      }
      const fromAbove = cam.y > (base + top) / 2;
      mat.uniforms['uLevel']!.value = fromAbove ? top : base;
      mat.uniforms['uFromAbove']!.value = fromAbove ? 1 : 0;
      (mat.uniforms['uOrigin']!.value as THREE.Vector3).set(origin.x, origin.y, origin.z);
      mat.uniforms['uCover']!.value = cover;
      mat.uniforms['uDark']!.value = dark;
      (mat.uniforms['uSunAbove']!.value as THREE.Color).setRGB(sunAbove[0], sunAbove[1], sunAbove[2]);
      mat.uniforms['uTime']!.value = timeSec;
      // Veil: grows over the first/last ~60 m inside the layer.
      const inside = Math.min(cam.y - base, top - cam.y);
      const va = inside > 0 ? Math.min(1, inside / 60) * Math.min(1, cover * 1.1) * 0.97 : 0;
      veil.visible = va > 0.01;
      const amb = u.uAtmAmbSky.value;
      const sun = u.uAtmSunCol.value;
      (veilMat.uniforms['uColor']!.value as THREE.Color).setRGB(0.8 * (amb.r * 1.1 + sun.r * 0.6), 0.82 * (amb.g * 1.1 + sun.g * 0.6), 0.85 * (amb.b * 1.1 + sun.b * 0.6));
      veilMat.uniforms['uAlpha']!.value = va;
      return below;
    },

    dispose() {
      scene.remove(mesh);
      scene.remove(veil);
      geom.dispose();
      mat.dispose();
      veilMat.dispose();
      veil.geometry.dispose();
      noise.dispose();
    },
  };
}
