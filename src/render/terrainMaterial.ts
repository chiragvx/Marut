/**
 * src/render/terrainMaterial.ts
 *
 * The one shared terrain ShaderMaterial (08-render.md section 4.5.1), with a surface style per
 * theatre:
 *   0 default  — flat single colour, unlit (the flight-model testing surface; see the note below)
 *   1 coastal  — Konkan: beaches, lush green plain with laterite patches and tree canopy, forested Ghats
 *   2 farmland — Punjab: field patchwork with crop rows, canals with tree lines, villages, sandy river banks
 * plus water shading (fresnel sky reflection, sun glint, shallow-water colour and shore foam)
 * wherever the mesh sits at the terrain's water level, and runway asphalt with a grass strip
 * around it (the airport renderer only draws runway outlines).
 *
 * All detail is procedural: no textures, and no vertex data beyond position + normal. The normal's
 * LENGTH carries baked data from src/terrain/chunkGeometryBuilder.ts: sky occlusion on land (valley
 * floors and gullies darker) and water depth on water (shallows and foam).
 *
 * Cost is spent where it is visible. `px`, the ground footprint of one pixel in metres (from
 * screen-space derivatives), gates every detail layer: near-camera pixels get a per-pixel detail
 * normal (rock, soil and canopy relief the mesh is far too coarse for), tree canopy with sun-cast
 * shadows and crop rows; far pixels skip all of that and the small-scale colour
 * noise, and fall back to the average colour those patterns would blend to at that distance.
 * Distant terrain is most of the screen, so this keeps the per-frame cost near the previous
 * shader's (see the commit for measurements).
 *
 * Mesh positions are absolute world coordinates (the chunk's group carries the floating-origin
 * offset), so `position` is used directly for every world-space pattern.
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
};

/** Water body colour per style (display values; see skyFog.ts for the sky/fog side). */
const WATER_COLOR: Readonly<Record<SceneEnvironment['surfaceStyle'], [number, number, number]>> = {
  default: [0.1, 0.25, 0.35],
  coastal: [0.06, 0.2, 0.3], // Arabian Sea
  farmland: [0.22, 0.3, 0.26], // silty river water
};

/** hash12 / vnoise / fbm3, shared by the vertex and fragment shaders. */
const NOISE_GLSL = /* glsl */ `
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
`;

// Large-scale patterns (>= ~500 m) are evaluated per vertex and interpolated: far fewer vertices
// than pixels, and the patterns are much larger than the vertex spacing, so nothing is lost.
// vMacro: x = broad tonal variation (7 km), y/z/w = style-specific (see each colour function).
const VERTEX_SHADER = /* glsl */ `
  uniform int uStyle;
  varying vec3 vViewPos;
  varying vec3 vWorld;
  varying vec3 vRel;
  varying vec3 vNormal;
  varying vec4 vMacro;
  ${NOISE_GLSL}
  void main() {
    vec2 p = position.xz;
    vMacro = vec4(vnoise(p / 7000.0), 0.0, 0.0, 0.0);
    if (uStyle == 1) {
      vMacro.y = fbm3(p / 1500.0 + 7.0); // laterite clearings
    }
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
  varying vec4 vMacro;

  ${NOISE_GLSL}
  // Value noise and its analytic gradient (x = value, yz = d/dp), for detail normals.
  vec3 vnoised(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    vec2 du = 6.0 * f * (1.0 - f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    float k1 = b - a;
    float k2 = c - a;
    float k4 = a - b - c + d;
    return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
  }
  // Height gradient (dh/dx, dh/dz) of two octaves of bumps, scaleM wide and ampM tall.
  // The second, finer octave is only evaluated where a pixel covers under ~1.5 m.
  vec2 detailGrad(vec2 p, float scaleM, float ampM, float px) {
    vec2 g = vnoised(p / scaleM).yz * (ampM / scaleM);
    if (px < 1.5) g += vnoised(p / (scaleM * 0.37) + 17.0).yz * (ampM * 0.4 / (scaleM * 0.37));
    return g;
  }

  vec3 waterShade(vec3 w, vec3 rel, float px, float depth) {
    vec3 V = normalize(rel);
    float amp = 1.0 - smoothstep(1.5, 10.0, px);
    vec3 n = vec3(0.0, 1.0, 0.0);
    if (amp > 0.0) {
      vec2 g = (vnoised(w.xz / 31.0).yz * 0.16 + vnoised(w.xz / 7.0 + 3.0).yz * 0.05) * amp;
      n = normalize(vec3(g.x, 1.0, g.y));
    }
    // Shallows show the bottom (turquoise over coastal sand, brighter silt in rivers).
    vec3 shallow = uStyle == 1 ? vec3(0.10, 0.42, 0.44) : uWaterColor * 1.35 + vec3(0.05, 0.05, 0.03);
    vec3 body = mix(shallow, uWaterColor, smoothstep(0.5, 18.0, depth));
    float cosi = max(dot(-V, n), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
    vec3 col = mix(body, uFogColor, fres * 0.85);
    // Surf: a broken foam band along the shore, widest on the open coast.
    float foam = 0.0;
    if (depth < 2.5) {
      float surfWidth = uStyle == 1 ? 1.6 : 0.6;
      foam = 1.0 - smoothstep(0.15, surfWidth, depth + 0.9 * (vnoise(w.xz / 12.0) - 0.5));
      foam *= 0.55 + 0.45 * vnoise(w.xz / 3.0 + 5.0) * (1.0 - smoothstep(1.0, 6.0, px));
      col = mix(col, vec3(0.92, 0.94, 0.95), foam * 0.85);
    }
    vec3 R = reflect(V, n);
    float spec = pow(max(dot(R, normalize(uSunDir)), 0.0), 160.0);
    return col + vec3(1.0, 0.95, 0.85) * spec * 1.1 * (1.0 - foam);
  }

  vec3 coastColor(vec3 w, vec3 n, float px, float near, vec3 L, inout float shadow) {
    float slope = 1.0 - n.y;
    float f1 = fbm3(w.xz / 600.0);
    vec3 col = mix(vec3(0.24, 0.40, 0.16), vec3(0.15, 0.30, 0.11), f1);
    // Laterite (red soil) clearings.
    col = mix(col, vec3(0.50, 0.36, 0.24), smoothstep(0.66, 0.76, vMacro.y) * 0.55);
    // Paddy fields on the low flat land (90 m pattern: skipped once a pixel covers 30 m).
    if (px < 30.0) {
      col = mix(col, vec3(0.40, 0.54, 0.22), smoothstep(0.55, 0.7, vnoise(w.xz / 90.0)) * (1.0 - smoothstep(20.0, 60.0, w.y)) * 0.6 * (1.0 - smoothstep(15.0, 30.0, px)));
    }
    // Denser forest up in the Ghats.
    col = mix(col, vec3(0.11, 0.24, 0.09), smoothstep(250.0, 600.0, w.y));
    float rock = smoothstep(0.25, 0.45, slope);
    col = mix(col, vec3(0.42, 0.33, 0.26), rock);
    float beach = 1.0 - smoothstep(1.5, 4.5, w.y - uWaterLevel);
    // Tree canopy (palms and forest clumps, ~9 m crowns) with the shadows they cast, near the camera only.
    if (near > 0.0) {
      float forest = smoothstep(0.35, 0.55, f1 + 0.3 * smoothstep(250.0, 600.0, w.y)) * (1.0 - rock) * (1.0 - beach);
      vec2 toSun = L.xz / max(L.y, 0.25) * 11.0;
      float canopy = smoothstep(0.52, 0.68, vnoise(w.xz / 9.0)) * forest;
      float caster = smoothstep(0.52, 0.68, vnoise((w.xz + toSun) / 9.0)) * forest;
      col = mix(col, col * vec3(0.62, 0.72, 0.60), canopy * near);
      shadow *= 1.0 - 0.65 * max(caster - canopy, 0.0) * near;
    }
    return mix(col, vec3(0.86, 0.80, 0.62), beach);
  }

  vec3 farmColor(vec3 w, float px) {
    vec2 p = w.xz;
    vec3 col = vec3(0.50, 0.52, 0.27);
    float fade = smoothstep(40.0, 150.0, px);
    // Field and canal grid, rotated off the world axes.
    vec2 q = vec2(0.978 * p.x - 0.208 * p.y, 0.208 * p.x + 0.978 * p.y);
    // Fields, staggered row by row (skipped once fully faded).
    if (fade < 1.0) {
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
      // Crop rows (or plough furrows) ~3 m apart, each field along or across its long side.
      if (px < 1.2) {
        float rows = 0.5 + 0.5 * sin((hash12(id + 29.0) < 0.5 ? q.x : q.y) * 2.094);
        crop *= 1.0 - 0.14 * rows * (1.0 - smoothstep(0.4, 1.2, px));
      }
      vec2 edge = min(f, 1.0 - f) * cell;
      float bund = 1.0 - smoothstep(2.5, 2.5 + px, min(edge.x, edge.y));
      col = mix(mix(crop, vec3(0.45, 0.40, 0.30), bund * 0.6), col, fade);
    }
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
      // Ragged edge (80 m) and rooftop/courtyard pattern (18 m), each skipped once too small to see.
      float edge = px < 25.0 ? 60.0 * vnoise(p / 80.0) : 30.0;
      float v = 1.0 - smoothstep(r * 0.7, r, length(p - c) + edge);
      vec3 vcol = vec3(0.58, 0.52, 0.42);
      if (px < 6.0) vcol = mix(mix(vec3(0.62, 0.55, 0.45), vec3(0.45, 0.38, 0.32), step(0.5, vnoise(p / 18.0))), vcol, smoothstep(2.0, 6.0, px));
      col = mix(col, vcol, v);
    }
    // Sandy river banks and sandbars.
    float sand = 1.0 - smoothstep(1.5, 3.0, w.y - uWaterLevel);
    return mix(col, vec3(0.78, 0.72, 0.57), sand * uHasWater);
  }

  void main() {
    float fogT = clamp((length(vViewPos) - uFogStart) / max(uFogEnd - uFogStart, 1.0), 0.0, 1.0);
    if (uStyle == 0) {
      gl_FragColor = vec4(mix(uGroundColor, uFogColor, fogT), 1.0);
      return;
    }
    float nl = length(vNormal);
    vec3 n = vNormal / max(nl, 1e-4);
    float px = max(length(dFdx(vWorld.xz)), length(dFdy(vWorld.xz)));
    vec3 L = normalize(uSunDir);
    vec3 col;
    if (uHasWater > 0.5 && vWorld.y <= uWaterLevel + 0.05) {
      col = waterShade(vWorld, vRel, px, max(nl - 1.0, 0.0) * 30.0);
    } else {
      float occ = min(nl, 1.0);
      // Near-camera detail weight: full below 3 m per pixel, gone by 12 m.
      float near = 1.0 - smoothstep(3.0, 12.0, px);
      // (Not on farmland: flat fields show no visible relief at this scale; crop rows carry the detail.)
      if (near > 0.0 && uStyle != 2) {
        vec2 g = detailGrad(vWorld.xz, 22.0, 1.4, px);
        n = normalize(n - vec3(g.x, 0.0, g.y) * near);
      }
      float shadow = 1.0;
      if (uStyle == 1) col = coastColor(vWorld, n, px, near, L, shadow);
      else col = farmColor(vWorld, px);

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
        if (strip <= 0.0) continue;
        col = mix(col, vec3(0.42, 0.50, 0.27) * (0.92 + 0.16 * vnoise(vWorld.xz / 25.0)), strip);
        shadow = mix(shadow, 1.0, strip); // the airfield is cleared: no tree shadows on it
        float onRwy = (1.0 - smoothstep(r.z, r.z + px, along)) * (1.0 - smoothstep(r.w, r.w + px, across));
        // Centreline dashes and threshold bars, fading out when too small to resolve.
        float detail = 1.0 - smoothstep(0.5, 2.0, px);
        float centre = (1.0 - smoothstep(0.45, 0.45 + px, across)) * step(0.5, fract(along / 60.0)) * step(along, r.z - 60.0);
        float bars = step(r.z - 50.0, along) * step(along, r.z - 10.0) * step(0.5, fract(across / 3.6)) * step(across, r.w - 3.0);
        vec3 asphalt = vec3(0.23, 0.23, 0.24) * (0.92 + 0.12 * vnoise(vWorld.xz / 4.0));
        asphalt = mix(asphalt, vec3(0.85), max(centre, bars) * detail);
        col = mix(col, asphalt, onRwy);
      }

      // Broad tonal variation so large areas never read as one flat swatch.
      col *= 0.92 + 0.16 * vMacro.x;

      // Lighting: sun (with canopy shadows) plus a hemisphere sky/ground-bounce ambient, both
      // darkened by the baked valley occlusion.
      float diff = max(dot(n, L), 0.0) * shadow;
      vec3 ambient = mix(vec3(0.30, 0.27, 0.22), vec3(0.44, 0.47, 0.52), 0.5 + 0.5 * n.y);
      col *= ambient * occ + vec3(1.0, 0.97, 0.9) * 0.62 * diff * mix(1.0, occ, 0.35);
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
