/**
 * src/render/airfieldPavement.ts — draws airbases' paved surfaces (src/airport/pavementGeometry.ts)
 * with their markings, all procedural in the fragment shader from the per-vertex surface frame:
 *
 * - Runways (asphalt, rubber deposits in the touchdown zones): threshold "piano keys", the runway
 *   designator (and L/R/C) in a 5x7 block font, dashed centreline, touchdown-zone and aiming-point
 *   markings, edge stripes; both ends.
 * - Taxiways (concrete): yellow centreline, and hold-short lines (two solid, two dashed) where the
 *   taxiway crosses the runway-holding distance of any runway.
 * - Blast pads: yellow chevrons pointing at the runway. Shelter pads: a yellow lead-in line.
 * - Aprons: concrete slabs with joints.
 *
 * Every marking is anti-aliased against the pixel footprint, so it fades out cleanly instead of
 * shimmering when it gets too thin to see. Lit like the ground (sun and cloud shadows, wet in rain).
 * One draw call, no depth writes (see pavementGeometry.ts for the draw order).
 */
import * as THREE from 'three';
import type { Vec3Like } from '../contracts/core';
import type { PavementGeometry } from '../airport/pavementGeometry';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';
import { CLOUD_SHADOW_GLSL, getCloudShadowUniforms } from './clouds';
import { SUN_SHADOW_GLSL, getSunShadowUniforms } from './sunShadows';
import { DETAIL_GLSL, getDetailTexture } from './detailTextures';

export const MAX_PAVEMENT_RUNWAYS = 8;

/** 5x7 glyphs, top row first, '1' = ink: digits 0-9, then L, R, C. */
const GLYPHS: readonly string[] = [
  '01110 10001 10011 10101 11001 10001 01110',
  '00100 01100 00100 00100 00100 00100 01110',
  '01110 10001 00001 00010 00100 01000 11111',
  '11111 00010 00100 00010 00001 10001 01110',
  '00010 00110 01010 10010 11111 00010 00010',
  '11111 10000 11110 00001 00001 10001 01110',
  '00110 01000 10000 11110 10001 10001 01110',
  '11111 00001 00010 00100 01000 01000 01000',
  '01110 10001 10001 01110 10001 10001 01110',
  '01110 10001 10001 01111 00001 00010 01100',
  '10000 10000 10000 10000 10000 10000 11111',
  '11110 10001 10001 11110 10100 10010 10001',
  '01110 10001 10000 10000 10000 10001 01110',
];
/** Each glyph as two exact-in-float integers: rows 0-3 (20 bits) and rows 4-6 (15 bits); bit (row, col) = 1 << ((rowInPart) * 5 + (4 - col)). */
function packGlyphs(): THREE.Vector2[] {
  return GLYPHS.map((g) => {
    const rows = g.split(' ');
    let a = 0;
    let b = 0;
    rows.forEach((r, i) => {
      const bits = parseInt(r, 2);
      if (i < 4) a += bits * Math.pow(32, 3 - i);
      else b += bits * Math.pow(32, 6 - i);
    });
    return new THREE.Vector2(a, b);
  });
}

const VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute vec4 aSurf;
  attribute vec4 aExtra;
  varying vec4 vSurf;
  varying vec4 vExtra;
  varying vec3 vWorld;
  void main() {
    vSurf = aSurf;
    vExtra = aExtra;
    vWorld = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(atmCurve(position), 1.0);
  }
`;

const FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  uniform vec3 uSunDir;
  ${CLOUD_SHADOW_GLSL}
  ${SUN_SHADOW_GLSL}
  ${DETAIL_GLSL}
  uniform vec2 uGlyphs[13];
  uniform vec4 uRwy[${MAX_PAVEMENT_RUNWAYS}];   // centre x, z, half length, half width
  uniform float uRwyHdg[${MAX_PAVEMENT_RUNWAYS}];
  uniform int uRwyCount;
  varying vec4 vSurf;
  varying vec4 vExtra;
  varying vec3 vWorld;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // Antialiased coverage of the interval [a, b] in x, for a pixel footprint pw.
  float span(float x, float a, float b, float pw) {
    return clamp((min(x + 0.5 * pw, b) - max(x - 0.5 * pw, a)) / pw, 0.0, 1.0);
  }
  // Box [u0,u1] x [v0,v1].
  float box(vec2 p, vec4 r, vec2 pw) { return span(p.x, r.x, r.y, pw.x) * span(p.y, r.z, r.w, pw.y); }

  float glyphBit(int g, int row, int col) {
    vec2 G = uGlyphs[g];
    float part = row < 4 ? G.x : G.y;
    int rr = row < 4 ? 3 - row : 6 - row;
    float bit = float(rr * 5 + (4 - col));
    return mod(floor(part / exp2(bit)), 2.0);
  }
  // Glyph g drawn in the box [u0, u0 + h] (reading towards +u) x [v0, v0 + w].
  float glyph(int g, vec2 p, float u0, float v0, float h, float w) {
    vec2 q = vec2((p.x - u0) / h, (p.y - v0) / w);
    if (q.x < 0.0 || q.x >= 1.0 || q.y < 0.0 || q.y >= 1.0) return 0.0;
    int row = int(floor((1.0 - q.x) * 7.0));
    int col = int(floor(q.y * 5.0));
    return glyphBit(g, row, col);
  }

  // White runway markings for one end: p = (metres from this threshold along the landing
  // direction, metres across, right +). code = designator number * 10 + letter.
  float runwayEnd(vec2 p, float len, float width, float code, vec2 pw) {
    float hw = width * 0.5;
    float m = 0.0;
    float av = abs(p.y);
    // Threshold bars: 30 m long from 6 m in; 1.8 m stripes 1.8 m apart, a 3.6 m gap at the centre.
    float n = width >= 44.0 ? 6.0 : width >= 29.0 ? 4.0 : 3.0;
    if (p.x > 5.0 && p.x < 37.0 && av < 1.8 + n * 3.6) {
      float k = floor((av - 1.8) / 3.6);
      float s0 = 1.8 + k * 3.6;
      m = max(m, span(p.x, 6.0, 36.0, pw.x) * span(av, s0, s0 + 1.8, pw.y) * step(0.0, k) * step(k, n - 1.0));
    }
    // Designator: letter (if any) then the number, 9 m tall, reading along the landing direction.
    float num = floor(code / 10.0);
    float letter = code - num * 10.0;
    float nu0 = letter > 0.5 ? 60.0 : 48.0;
    if (p.x > 46.0 && p.x < 70.0) {
      // Viewed from the approach, "right" is +v; digits left to right.
      float d1 = floor(num / 10.0);
      float d2 = num - d1 * 10.0;
      float gw = 3.0;
      m = max(m, glyph(int(d1), vec2(p.x, p.y), nu0, -gw - 0.75, 9.0, gw));
      m = max(m, glyph(int(d2), vec2(p.x, p.y), nu0, 0.75, 9.0, gw));
      if (letter > 0.5) m = max(m, glyph(9 + int(letter), vec2(p.x, p.y), 48.0, -gw * 0.5, 9.0, gw));
    }
    // Aiming point: two 45 m x 6 m bars from 400 m; touchdown zone stripes at 150, 300, 600, 750, 900 m.
    float ap = width >= 29.0 ? 1.0 : 0.0;
    m = max(m, ap * span(p.x, 400.0, 445.0, pw.x) * span(av, hw * 0.4, hw * 0.4 + 6.0, pw.y));
    for (int i = 0; i < 5; i++) {
      float u0 = i < 2 ? 150.0 + 150.0 * float(i) : 600.0 + 150.0 * float(i - 2);
      float cnt = i < 2 ? 3.0 : i < 4 ? 2.0 : 1.0;
      if (p.x > u0 - 1.0 && p.x < u0 + 23.5 && u0 < len * 0.5 - 50.0) {
        float k = floor((av - 3.0) / 3.0);
        m = max(m, span(p.x, u0, u0 + 22.5, pw.x) * span(av, 3.0 + k * 3.0, 4.8 + k * 3.0, pw.y) * step(0.0, k) * step(k, cnt - 1.0));
      }
    }
    return m;
  }

  // Tyre marks (rubber) in a touchdown zone, metres from its threshold.
  float rubber(vec2 p, float hw) {
    float z = smoothstep(200.0, 350.0, p.x) * (1.0 - smoothstep(700.0, 1100.0, p.x));
    float lanes = smoothstep(hw * 0.75, hw * 0.1, abs(abs(p.y) - hw * 0.18));
    return z * lanes;
  }

  void main() {
    int kind = int(vSurf.x + 0.5);
    vec2 p = vSurf.yz;
    vec2 pw = max(vec2(fwidth(p.x), fwidth(p.y)), vec2(0.01));
    float pwMax = max(pw.x, pw.y);
    float px = length(fwidth(vWorld.xz));
    vec3 asphalt = vec3(0.21, 0.21, 0.22) * mix(vec3(1.0), detailAt(vWorld.xz, 3.0, 6.0, px), 0.7);
    vec3 concrete = vec3(0.58, 0.57, 0.54) * mix(vec3(1.0), detailAt(vWorld.xz, 3.0, 9.0, px), 0.35);
    // Big, soft stains so large slabs of concrete never read as flat.
    concrete *= 0.9 + 0.2 * vnoise(vWorld.xz / 23.0) - 0.08 * vnoise(vWorld.xz / 7.0 + 3.0);
    vec3 white = vec3(0.9, 0.9, 0.88);
    vec3 yellow = vec3(0.86, 0.68, 0.16);
    vec3 col;

    if (kind == 4) {
      float len = vExtra.x;
      float width = vExtra.y;
      float hw = width * 0.5;
      col = asphalt * (0.95 + 0.1 * vnoise(vWorld.xz / 40.0));
      vec2 pa = p;
      vec2 pb = vec2(len - p.x, -p.y);
      col *= 1.0 - 0.45 * max(rubber(pa, hw), rubber(pb, hw)) * (0.7 + 0.3 * vnoise(vWorld.xz / 3.0));
      float m = max(runwayEnd(pa, len, width, vExtra.z, pw), runwayEnd(pb, len, width, vExtra.w, pw));
      // Centreline: 30 m dashes, 20 m gaps, 0.9 m wide, between the designators.
      if (p.x > 90.0 && p.x < len - 90.0) m = max(m, span(p.y, -0.45, 0.45, pw.y) * step(fract((p.x - 90.0) / 50.0), 0.6));
      // Side stripes.
      m = max(m, span(abs(p.y), hw - 1.4, hw - 0.5, pw.y));
      // Worn paint: the asphalt's own fine grain shows through a little.
      col = mix(col, white * mix(vec3(1.0), detailAt(vWorld.xz, 3.0, 4.0, px), 0.3), m);
    } else if (kind == 3) {
      col = concrete;
      // Slab joints across and along the lanes.
      float j = span(fract(p.x / 6.0) * 6.0, 0.0, 0.08, pw.x);
      col *= 1.0 - 0.18 * j * (1.0 - smoothstep(0.05, 0.3, pwMax));
      float m = 0.0;
      // Hold-short lines where the taxiway crosses a runway's holding distance (75 m from its
      // centreline): two solid lines on the taxiway side, two dashed on the runway side.
      for (int i = 0; i < ${MAX_PAVEMENT_RUNWAYS}; i++) {
        if (i >= uRwyCount) break;
        vec4 r = uRwy[i];
        float h = uRwyHdg[i];
        vec2 d = vWorld.xz - r.xy;
        float along = dot(d, vec2(sin(h), -cos(h)));
        float across = abs(dot(d, vec2(cos(h), sin(h))));
        // Only where the taxiway meets or crosses the runway at an angle (not one running alongside).
        if (abs(along) > r.z + 60.0 || abs(dot(normalize(vExtra.xy + vec2(1e-5, 0.0)), vec2(sin(h), -cos(h)))) > 0.85) continue;
        float hd = r.w + 52.5;
        float pa = max(fwidth(across), 0.01);
        float solid = span(across, hd + 1.8, hd + 2.1, pa) + span(across, hd + 1.2, hd + 1.5, pa);
        float dashed = (span(across, hd + 0.6, hd + 0.9, pa) + span(across, hd, hd + 0.3, pa)) * step(fract(along / 1.8), 0.5);
        m = max(m, clamp(solid + dashed, 0.0, 1.0));
      }
      col = mix(col, yellow, m);
    } else if (kind == 5) {
      // Taxiway centreline (its own strip over the taxiway surfaces): 0.4 m yellow, antialiased.
      float cover = span(p.y, -0.2, 0.2, pw.y);
      if (cover < 0.004) discard;
      col = yellow * (1.0 - 0.3 * uAtmWet);
      vec3 L = normalize(uSunDir);
      float diff = max(L.y, 0.0) * cloudShadow(vWorld) * sunShadow(vWorld, L.y);
      col *= uAtmAmbSky * 0.9 + uAtmAmbGround * 0.1 + uAtmSunCol * diff;
      gl_FragColor = vec4(atmApply(col, vWorld), cover);
      return;
    } else if (kind == 2) {
      // Blast pad / overrun: older asphalt, yellow chevrons pointing at the runway.
      float len = vExtra.x;
      col = asphalt * 1.12;
      float e = p.x < 0.0 ? -p.x : p.x - len;
      float c = fract((e - abs(p.y) * 0.5) / 30.0);
      float pc = max(fwidth(e - abs(p.y) * 0.5) / 30.0, 0.002);
      float m = span(c, 0.0, 0.1, pc) * step(3.0, e);
      col = mix(col, yellow, m * 0.9);
    } else if (kind == 1) {
      // Shelter pad: concrete, a yellow lead-in line out of the door.
      col = concrete * 0.96;
      float m = span(p.y, -0.15, 0.15, pw.y) * step(-2.0, p.x);
      col = mix(col, yellow, m);
    } else {
      // Apron: concrete in 5 m slabs.
      col = concrete;
      vec2 g = fract(p / 5.0) * 5.0;
      float j = max(span(g.x, 0.0, 0.08, pw.x), span(g.y, 0.0, 0.08, pw.y));
      col *= 1.0 - 0.2 * j * (1.0 - smoothstep(0.05, 0.3, pwMax));
      col *= 1.0 - 0.12 * smoothstep(0.55, 0.8, vnoise(vWorld.xz / 9.0)); // oil stains
    }

    // Wet in rain: darker, with a little sky sheen.
    col *= 1.0 - 0.3 * uAtmWet;
    vec3 n = vec3(0.0, 1.0, 0.0);
    vec3 L = normalize(uSunDir);
    float diff = max(L.y, 0.0) * cloudShadow(vWorld) * sunShadow(vWorld, L.y);
    col *= uAtmAmbSky * 0.9 + uAtmAmbGround * 0.1 + uAtmSunCol * diff;
    gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
  }
`;

export interface AirfieldPavement {
  /** Builds the mesh (null clears it) and the runway list used for hold-short lines. */
  setGeometry(g: PavementGeometry | null, runways: readonly { centerX: number; centerZ: number; headingRad: number; lengthM: number; widthM: number }[]): void;
  updateOrigin(originWorld: Readonly<Vec3Like>): void;
  setSunDirection(dir: Readonly<Vec3Like>): void;
  dispose(): void;
}

export function createAirfieldPavement(root: THREE.Object3D): AirfieldPavement {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  root.add(group);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...getAtmosphereUniforms(),
      ...getCloudShadowUniforms(),
      ...getSunShadowUniforms(),
      uDetail: { value: getDetailTexture() },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, -0.3) },
      uGlyphs: { value: packGlyphs() },
      uRwy: { value: Array.from({ length: MAX_PAVEMENT_RUNWAYS }, () => new THREE.Vector4()) },
      uRwyHdg: { value: new Array(MAX_PAVEMENT_RUNWAYS).fill(0) },
      uRwyCount: { value: 0 },
    },
    vertexShader: VS,
    fragmentShader: FS,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -6,
  });
  let mesh: THREE.Mesh | undefined;

  return {
    setGeometry(g, runways) {
      if (mesh) {
        group.remove(mesh);
        mesh.geometry.dispose();
        mesh = undefined;
      }
      const rw = mat.uniforms['uRwy']!.value as THREE.Vector4[];
      const hd = mat.uniforms['uRwyHdg']!.value as number[];
      const n = Math.min(runways.length, MAX_PAVEMENT_RUNWAYS);
      for (let i = 0; i < n; i++) {
        const r = runways[i]!;
        rw[i]!.set(r.centerX, r.centerZ, r.lengthM / 2, r.widthM / 2);
        hd[i] = r.headingRad;
      }
      mat.uniforms['uRwyCount']!.value = n;
      if (!g || g.indices.length === 0) return;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
      geom.setAttribute('aSurf', new THREE.BufferAttribute(g.surf, 4));
      geom.setAttribute('aExtra', new THREE.BufferAttribute(g.extra, 4));
      geom.setIndex(new THREE.BufferAttribute(g.indices, 1));
      geom.computeBoundingSphere();
      mesh = new THREE.Mesh(geom, mat);
      mesh.matrixAutoUpdate = false;
      // Just after the terrain, before road decals and tree shadows.
      mesh.renderOrder = 0;
      group.add(mesh);
    },
    updateOrigin(origin) {
      group.position.set(-origin.x, -origin.y, -origin.z);
      group.updateMatrix();
      group.updateMatrixWorld(true);
    },
    setSunDirection(dir) {
      (mat.uniforms['uSunDir']!.value as THREE.Vector3).set(dir.x, dir.y, dir.z);
    },
    dispose() {
      if (mesh) mesh.geometry.dispose();
      root.remove(group);
      mat.dispose();
    },
  };
}
