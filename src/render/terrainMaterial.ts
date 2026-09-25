/**
 * src/render/terrainMaterial.ts
 *
 * The one shared terrain ShaderMaterial (08-render.md section 4.5.1), with a surface style per
 * theatre:
 *   0 default  — flat single colour, unlit (the flight-model testing surface; see the note below)
 *   1 coastal  — Konkan: beaches, lush green plain with laterite patches, forested Ghats
 *   2 farmland — Punjab: field patchwork, canals with tree lines, villages, sandy river banks
 *   3 alpine   — Ladakh: khaki valley floors, grey rock on steep faces, snow above ~5,600 m
 * plus water shading (fresnel sky reflection and sun glint) wherever the mesh sits at the
 * terrain's water level, and runway asphalt with a grass strip around it (the airport renderer
 * only draws runway outlines).
 *
 * Mesh positions are absolute world coordinates (the chunk's group carries the floating-origin
 * offset), so `position` is used directly for every world-space pattern. Detail that would alias
 * (field borders, canals, ripples) fades by the pixel footprint from screen-space derivatives.
 *
 * Default style: flat `uGroundColor`, kept exactly as before. It was requested so terrain reads as
 * one clean, uniform reference surface while verifying flight-model/collision fixes (a solid colour
 * makes aircraft-vs-ground clipping or mesh artefacts easy to spot).
 */

import * as THREE from 'three';
import type { SceneEnvironment } from '../contracts/render';

export const MAX_TERRAIN_RUNWAYS = 4;

const STYLE_CODE: Readonly<Record<SceneEnvironment['surfaceStyle'], number>> = {
  default: 0,
  coastal: 1,
  farmland: 2,
  alpine: 3,
};

/** Water body colour per style (display values; see skyFog.ts for the sky/fog side). */
const WATER_COLOR: Readonly<Record<SceneEnvironment['surfaceStyle'], [number, number, number]>> = {
  default: [0.1, 0.25, 0.35],
  coastal: [0.06, 0.2, 0.3], // Arabian Sea
  farmland: [0.22, 0.3, 0.26], // silty river water
  alpine: [0.1, 0.3, 0.38],
};

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vViewPos;
  varying vec3 vWorld;
  varying vec3 vRel;
  varying vec3 vNormal;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = position;
    vRel = wp.xyz - cameraPosition;
    vNormal = normal;
    vec4 viewPos4 = viewMatrix * wp;
    vViewPos = viewPos4.xyz;
    gl_Position = projectionMatrix * viewPos4;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform int uStyle;
  uniform vec3 uFogColor;
  uniform vec3 uGroundColor;
  uniform float uFogStart;
  uniform float uFogEnd;
  uniform float uHasWater;
  uniform float uWaterLevel;
  uniform vec3 uWaterColor;
  uniform vec3 uSunDir;
  uniform int uRunwayCount;
  uniform vec4 uRunways[${MAX_TERRAIN_RUNWAYS}];
  uniform float uRunwayHeadings[${MAX_TERRAIN_RUNWAYS}];
  varying vec3 vViewPos;
  varying vec3 vWorld;
  varying vec3 vRel;
  varying vec3 vNormal;

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
  float fbm3(vec2 p) {
    return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 17.0) + 0.2 * vnoise(p * 4.01 + 41.0);
  }

  vec3 waterShade(vec3 w, vec3 rel, float px) {
    vec3 V = normalize(rel);
    float amp = 1.0 - smoothstep(1.5, 10.0, px);
    vec3 n = normalize(vec3((vnoise(w.xz / 31.0) - 0.5) * 0.16 * amp + (vnoise(w.xz / 7.0) - 0.5) * 0.05 * amp, 1.0,
                            (vnoise(w.xz / 29.0 + 9.0) - 0.5) * 0.16 * amp + (vnoise(w.xz / 6.0 + 3.0) - 0.5) * 0.05 * amp));
    float cosi = max(dot(-V, n), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
    vec3 col = mix(uWaterColor, uFogColor, fres * 0.85);
    vec3 R = reflect(V, n);
    float spec = pow(max(dot(R, normalize(uSunDir)), 0.0), 160.0);
    return col + vec3(1.0, 0.95, 0.85) * spec * 1.1;
  }

  vec3 coastColor(vec3 w, vec3 n) {
    float slope = 1.0 - n.y;
    vec3 col = mix(vec3(0.24, 0.40, 0.16), vec3(0.15, 0.30, 0.11), fbm3(w.xz / 600.0));
    // Laterite (red soil) clearings.
    col = mix(col, vec3(0.50, 0.36, 0.24), smoothstep(0.66, 0.76, fbm3(w.xz / 1500.0 + 7.0)) * 0.55);
    // Paddy fields on the low flat land.
    col = mix(col, vec3(0.40, 0.54, 0.22), smoothstep(0.55, 0.7, vnoise(w.xz / 90.0)) * (1.0 - smoothstep(20.0, 60.0, w.y)) * 0.6);
    // Denser forest up in the Ghats.
    col = mix(col, vec3(0.11, 0.24, 0.09), smoothstep(250.0, 600.0, w.y));
    col = mix(col, vec3(0.42, 0.33, 0.26), smoothstep(0.25, 0.45, slope));
    float beach = 1.0 - smoothstep(1.5, 4.5, w.y - uWaterLevel);
    return mix(col, vec3(0.86, 0.80, 0.62), beach);
  }

  vec3 farmColor(vec3 w, float px) {
    vec2 p = w.xz;
    // Field grid, rotated off the world axes and staggered row by row.
    vec2 q = vec2(0.978 * p.x - 0.208 * p.y, 0.208 * p.x + 0.978 * p.y);
    vec2 cell = vec2(210.0, 150.0);
    vec2 g = q / cell;
    g.x += hash12(vec2(floor(g.y), 7.0)) * 3.0;
    vec2 id = floor(g);
    vec2 f = fract(g);
    float h = hash12(id);
    vec3 crop = h < 0.33 ? vec3(0.66, 0.58, 0.36)
              : h < 0.43 ? vec3(0.74, 0.68, 0.30)
              : h < 0.75 ? vec3(0.33, 0.47, 0.19)
              : h < 0.88 ? vec3(0.24, 0.36, 0.15)
              : vec3(0.52, 0.42, 0.30);
    crop *= 0.9 + 0.2 * hash12(id + 13.1);
    vec2 edge = min(f, 1.0 - f) * cell;
    float bund = 1.0 - smoothstep(2.5, 2.5 + px, min(edge.x, edge.y));
    vec3 col = mix(crop, vec3(0.45, 0.40, 0.30), bund * 0.6);
    float fade = smoothstep(40.0, 150.0, px);
    col = mix(col, vec3(0.50, 0.52, 0.27), fade);
    // Irrigation canals lined with trees.
    vec2 cs = vec2(4100.0, 3300.0);
    vec2 cq = abs(fract(q / cs + 0.5) - 0.5) * cs;
    float cd = min(cq.x, cq.y);
    float trees = 1.0 - smoothstep(23.0, 23.0 + px, cd);
    col = mix(col, vec3(0.18, 0.28, 0.12), trees * 0.8 * (1.0 - 0.5 * fade));
    float canal = 1.0 - smoothstep(9.0, 9.0 + px, cd);
    col = mix(col, uWaterColor, canal * (1.0 - smoothstep(20.0, 60.0, px)));
    // Villages: roughly one in five 1.9 km cells.
    vec2 vid = floor(p / 1900.0);
    if (hash12(vid + 91.0) < 0.22) {
      vec2 c = (vid + 0.2 + 0.6 * vec2(hash12(vid + 3.0), hash12(vid + 5.0))) * 1900.0;
      float r = 140.0 + 260.0 * hash12(vid + 8.0);
      float v = 1.0 - smoothstep(r * 0.7, r, length(p - c) + 60.0 * vnoise(p / 80.0));
      vec3 vcol = mix(vec3(0.62, 0.55, 0.45), vec3(0.45, 0.38, 0.32), step(0.5, vnoise(p / 18.0)));
      col = mix(col, mix(vcol, vec3(0.58, 0.52, 0.42), fade), v);
    }
    // Sandy river banks and sandbars.
    float sand = 1.0 - smoothstep(1.5, 3.0, w.y - uWaterLevel);
    return mix(col, vec3(0.78, 0.72, 0.57), sand * uHasWater);
  }

  vec3 alpineColor(vec3 w, vec3 n) {
    float slope = 1.0 - n.y;
    vec3 ground = mix(vec3(0.66, 0.58, 0.45), vec3(0.54, 0.46, 0.36), fbm3(w.xz / 700.0));
    ground = mix(ground, vec3(0.50, 0.45, 0.41), smoothstep(4000.0, 4600.0, w.y));
    vec3 rock = mix(vec3(0.40, 0.36, 0.34), vec3(0.29, 0.26, 0.25), vnoise(w.xz / 120.0));
    vec3 col = mix(ground, rock, smoothstep(0.30, 0.50, slope));
    // Snow line ~5,600 m (summer), lower on north-facing slopes (north is -Z), shed from steep faces.
    float snowline = 5600.0 + 500.0 * (fbm3(w.xz / 2000.0) - 0.5) - 400.0 * max(0.0, -n.z);
    float snow = smoothstep(snowline - 120.0, snowline + 120.0, w.y) * (1.0 - smoothstep(0.55, 0.75, slope));
    return mix(col, vec3(0.93, 0.95, 0.98), snow);
  }

  void main() {
    float fogT = clamp((length(vViewPos) - uFogStart) / max(uFogEnd - uFogStart, 1.0), 0.0, 1.0);
    if (uStyle == 0) {
      gl_FragColor = vec4(mix(uGroundColor, uFogColor, fogT), 1.0);
      return;
    }
    vec3 n = normalize(vNormal);
    float px = max(length(dFdx(vWorld.xz)), length(dFdy(vWorld.xz)));
    vec3 col;
    if (uHasWater > 0.5 && vWorld.y <= uWaterLevel + 0.05) {
      col = waterShade(vWorld, vRel, px);
    } else {
      if (uStyle == 1) col = coastColor(vWorld, n);
      else if (uStyle == 2) col = farmColor(vWorld, px);
      else col = alpineColor(vWorld, n);

      for (int i = 0; i < ${MAX_TERRAIN_RUNWAYS}; i++) {
        if (i >= uRunwayCount) break;
        vec4 r = uRunways[i];
        float hd = uRunwayHeadings[i];
        vec2 d = vWorld.xz - r.xy;
        vec2 fwd = vec2(sin(hd), -cos(hd));
        vec2 lat = vec2(cos(hd), sin(hd));
        float along = abs(dot(d, fwd));
        float across = abs(dot(d, lat));
        // Mown grass strip around the runway, then the asphalt.
        float strip = (1.0 - smoothstep(r.z + 250.0, r.z + 300.0, along)) * (1.0 - smoothstep(r.w + 130.0, r.w + 170.0, across));
        col = mix(col, vec3(0.42, 0.50, 0.27) * (0.92 + 0.16 * vnoise(vWorld.xz / 25.0)), strip);
        float onRwy = (1.0 - smoothstep(r.z, r.z + px, along)) * (1.0 - smoothstep(r.w, r.w + px, across));
        // Centreline dashes and threshold bars, fading out when too small to resolve.
        float detail = 1.0 - smoothstep(0.5, 2.0, px);
        float centre = (1.0 - smoothstep(0.45, 0.45 + px, across)) * step(0.5, fract(along / 60.0)) * step(along, r.z - 60.0);
        float bars = step(r.z - 50.0, along) * step(along, r.z - 10.0) * step(0.5, fract(across / 3.6)) * step(across, r.w - 3.0);
        vec3 asphalt = vec3(0.23, 0.23, 0.24) * (0.92 + 0.12 * vnoise(vWorld.xz / 4.0));
        asphalt = mix(asphalt, vec3(0.85), max(centre, bars) * detail);
        col = mix(col, asphalt, onRwy);
      }

      float diff = max(dot(n, normalize(uSunDir)), 0.0);
      col *= 0.50 + 0.62 * diff;
    }
    gl_FragColor = vec4(mix(col, uFogColor, fogT), 1.0);
  }
`;

export function createTerrainMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uStyle: { value: 0 },
      uFogColor: { value: new THREE.Color(0xbcd4e8) },
      uGroundColor: { value: new THREE.Color(0x4a6b3a) },
      uFogStart: { value: 1500 },
      uFogEnd: { value: 5000 },
      uHasWater: { value: 0 },
      uWaterLevel: { value: 0 },
      uWaterColor: { value: new THREE.Vector3(...WATER_COLOR.default) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, -0.3) },
      uRunwayCount: { value: 0 },
      uRunways: { value: Array.from({ length: MAX_TERRAIN_RUNWAYS }, () => new THREE.Vector4()) },
      uRunwayHeadings: { value: new Array<number>(MAX_TERRAIN_RUNWAYS).fill(0) },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
  });
}

/** Writes a theatre's style, water and runways into the material's uniforms. */
export function applyTerrainEnvironment(material: THREE.ShaderMaterial, env: Readonly<SceneEnvironment>): void {
  const u = material.uniforms;
  u['uStyle']!.value = STYLE_CODE[env.surfaceStyle];
  u['uHasWater']!.value = env.waterLevelM !== undefined ? 1 : 0;
  u['uWaterLevel']!.value = env.waterLevelM ?? 0;
  (u['uWaterColor']!.value as THREE.Vector3).set(...WATER_COLOR[env.surfaceStyle]);

  const runways = u['uRunways']!.value as THREE.Vector4[];
  const headings = u['uRunwayHeadings']!.value as number[];
  const nRwy = Math.min(env.runways.length, MAX_TERRAIN_RUNWAYS);
  for (let i = 0; i < nRwy; i++) {
    const r = env.runways[i]!;
    runways[i]!.set(r.centerX, r.centerZ, r.lengthM / 2, r.widthM / 2);
    headings[i] = r.headingRad;
  }
  u['uRunwayCount']!.value = nRwy;
}
