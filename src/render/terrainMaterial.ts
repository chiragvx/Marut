/**
 * src/render/terrainMaterial.ts
 *
 * The one shared terrain ShaderMaterial (08-render.md section 4.5.1), with a surface style per
 * theatre:
 *   0 default  — flat single colour, unlit (the flight-model testing surface; see the note below)
 *   1 coastal  — Konkan: beaches, lush green plain with laterite patches and tree canopy, forested Ghats
 *   2 farmland — Punjab: a muted field patchwork (after an oblique satellite view) and sandy braided floodplains; roads,
 *                canals, settlements and trees are real geometry (chunkFeatureRenderer.ts)
 * plus water shading (fresnel sky reflection, sun glint, shallow-water colour and shore foam)
 * wherever the mesh sits at the terrain's water level, and runway asphalt with a grass strip
 * around it (the airport renderer only draws runway outlines).
 *
 * All detail is procedural: no textures, and no vertex data beyond position + normal. The normal's
 * LENGTH carries baked data from src/terrain/chunkGeometryBuilder.ts: on land the ring relief
 * (hollows -> sky occlusion; raised ground -> plateau tops and headlands), on water the depth
 * (shallows and foam).
 *
 * Cost is spent where it is visible. `px`, the ground footprint of one pixel in metres (from
 * screen-space derivatives), gates every detail layer: near-camera pixels get a per-pixel detail
 * normal (rock, soil and canopy relief the mesh is far too coarse for), tree canopy with sun-cast
 * shadows and tree rows; far pixels skip all of that and the small-scale colour
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
import { DETAIL_GLSL, getDetailTexture } from './detailTextures';
import { CLOUD_SHADOW_GLSL, getCloudShadowUniforms } from './clouds';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';
import { SUN_SHADOW_GLSL, getSunShadowUniforms } from './sunShadows';
import { MAX_RIVERS, RIVER_FLOATS, RIVER_GLSL } from '../terrain/riverMath';
import { ESTUARY_FLOATS, ESTUARY_GLSL, MAX_ESTUARIES } from '../terrain/coastMath';
import { AIRFIELD_MASK_SIZE } from '../airport/airfieldMask';

export const MAX_AIRFIELDS = 4;

export const MAX_TERRAIN_RUNWAYS = 4;
/** Shoreline samples the vertex shader can hold (packed four per vec4). 201 = the 200 km world at 1 km. */
export const MAX_COAST_SAMPLES = 204;
const COAST_VEC4S = MAX_COAST_SAMPLES / 4;

const STYLE_CODE: Readonly<Record<SceneEnvironment['surfaceStyle'], number>> = {
  default: 0,
  coastal: 1,
  farmland: 2,
};

/** Water body colour per style (display values; see skyFog.ts for the sky/fog side). */
const WATER_COLOR: Readonly<Record<SceneEnvironment['surfaceStyle'], [number, number, number]>> = {
  default: [0.1, 0.25, 0.35],
  coastal: [0.06, 0.2, 0.3], // Arabian Sea
  farmland: [0.45, 0.3, 0.29], // Sutlej/Beas: silt-laden, reddish brown
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
// Coastal: y = laterite-patch noise, z = distance inland from the shoreline (m, negative at sea),
// w = headland weight. The shoreline comes from a table of samples along Z (uShore/uHead, built
// from the same landform the terrain uses — src/terrain/terrainHeight.ts buildCoastProfile).
const VERTEX_SHADER = /* glsl */ `
  uniform int uStyle;
  uniform int uCoastCount;
  uniform vec2 uCoastZ; // z0, dz
  uniform vec4 uShore[${COAST_VEC4S}];
  uniform vec4 uHead[${COAST_VEC4S}];
  varying vec3 vViewPos;
  varying vec3 vWorld;
  varying vec3 vRel;
  varying vec3 vNormal;
  varying vec4 vMacro;
  varying float vLow;
  ${NOISE_GLSL}
  ${ATMOSPHERE_GLSL}
  void main() {
    vec2 p = position.xz;
    vMacro = vec4(vnoise(p / 7000.0), 0.0, 0.0, 0.0);
    vLow = 0.0;
    if (uStyle == 1) {
      // The two coarse octaves of the 600 m vegetation pattern (fbm3's first two terms); the fragment
      // shader adds the fine octave near the camera.
      vLow = 0.5 * vnoise(p / 600.0) + 0.3 * vnoise(p / 600.0 * 2.03 + 17.0);
      vMacro.y = fbm3(p / 1500.0 + 7.0); // laterite clearings
      vMacro.z = 1e5;
      if (uCoastCount > 1) {
        float fi = clamp((p.y - uCoastZ.x) / uCoastZ.y, 0.0, float(uCoastCount - 1) - 0.001);
        int i = int(fi);
        int j = i + 1;
        float t = fi - float(i);
        vMacro.z = p.x - mix(uShore[i >> 2][i & 3], uShore[j >> 2][j & 3], t);
        vMacro.w = mix(uHead[i >> 2][i & 3], uHead[j >> 2][j & 3], t);
      }
    }
    vec4 wp = modelMatrix * vec4(atmCurve(position), 1.0);
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
  uniform vec3 uCoastShape; // plain rise m/km, Ghats start m, Ghats ramp m (coast theatres)
  uniform int uRunwayCount;
  uniform vec4 uRunways[${MAX_TERRAIN_RUNWAYS}];
  uniform float uRunwayHeadings[${MAX_TERRAIN_RUNWAYS}];
  varying vec3 vViewPos;
  varying vec3 vWorld;
  varying vec3 vRel;
  varying vec3 vNormal;
  varying vec4 vMacro;
  varying float vLow;
  ${DETAIL_GLSL}
  // Airbases (src/airport/airfieldMask.ts): R = airfield weight, G = distance to pavement / 64 m.
  uniform highp sampler2DArray uAirfieldTex;
  uniform vec4 uAirfield[${MAX_AIRFIELDS}];
  uniform int uAirfieldCount;
  vec2 airfieldAt(vec2 p) {
    for (int i = 0; i < ${MAX_AIRFIELDS}; i++) {
      if (i >= uAirfieldCount) break;
      vec2 uv = (p - uAirfield[i].xy) * uAirfield[i].z;
      if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) return texture(uAirfieldTex, vec3(uv, float(i))).rg;
    }
    return vec2(0.0, 1.0);
  }
  ${CLOUD_SHADOW_GLSL}
  ${ATMOSPHERE_GLSL}
  ${SUN_SHADOW_GLSL}
  ${RIVER_GLSL}
  ${ESTUARY_GLSL}
  uniform float uTime;
  uniform int uCoastCount;
  uniform vec2 uCoastZ;
  uniform vec4 uShore[${COAST_VEC4S}];
  uniform vec4 uHead[${COAST_VEC4S}];
  float coastSample(int which, int i) {
    i = clamp(i, 0, uCoastCount - 1);
    return which == 0 ? uShore[i >> 2][i & 3] : uHead[i >> 2][i & 3];
  }
  // Per-pixel shoreline (same Catmull-Rom as coastMath.ts shoreAt): x = distance inland from the
  // shore (m, negative at sea), y = headland weight. Per pixel, so it is identical in every chunk.
  vec2 coastAt(vec2 p) {
    float fi = clamp((p.y - uCoastZ.x) / uCoastZ.y, 0.0, float(uCoastCount - 1) - 0.001);
    int i = int(fi);
    float f = fi - float(i);
    float f2 = f * f;
    float f3 = f2 * f;
    vec2 r;
    for (int k = 0; k < 2; k++) {
      float a = coastSample(k, i - 1);
      float b = coastSample(k, i);
      float c = coastSample(k, i + 1);
      float d = coastSample(k, i + 2);
      r[k] = 0.5 * (2.0 * b + (c - a) * f + (2.0 * a - 5.0 * b + 4.0 * c - d) * f2 + (3.0 * b - a - 3.0 * c + d) * f3);
    }
    return vec2(p.x - r.x, clamp(r.y, 0.0, 1.0));
  }
  // 0..1: how far this ground stands above its surroundings (set in main before the colour functions).
  float gRaised = 0.0;

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

  // Shared water shading (Goa sea and estuaries, Punjab rivers): animated ripples at two scales
  // drifting against each other, a long swell far out, fresnel sky reflection, sun glint, and
  // colour by depth. Each ripple layer fades once it is smaller than a pixel.
  // shoreDist: distance to the shore on the water side, m (sea only; large elsewhere). kind: 0 river,
  // 1 open sea, 2 estuary.
  // Surface slope of four travelling waves around heading dir (rad, the way they run), wavelengths
  // about lambda, each of steepness s, moving at deep-water speed. (Summed sines rather than noise:
  // value noise has zero slope along its cell edges, which shows as a grid in the reflections.)
  vec2 waveSet(vec2 p, float t, float dir, float lambda, float s, float warp) {
    vec2 g = vec2(0.0);
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float a = dir + (fi - 1.5) * 0.7 + 0.2 * sin(fi * 5.3);
      vec2 d = vec2(cos(a), sin(a));
      float k = 6.2832 / (lambda * (0.62 + 0.27 * fi));
      g += d * (s * cos(dot(d, p) * k - sqrt(9.81 * k) * t + fi * 1.9 + warp * (1.0 + 0.6 * fi)));
    }
    return g;
  }

  // sunVis = sun visibility at the surface (1 lit, 0 in the shadow of a cloud, the aircraft, a tree
  // or a house): shade takes away the sun glint and the sunlit glow of the water body and foam.
  vec3 waterShade(vec3 w, vec3 rel, float px, float depth, float shoreDist, float kind, float sunVis) {
    vec3 V = normalize(rel);
    float t = uTime;
    vec2 g = vec2(0.0);
    // Long swell rolling in from the west-south-west (sea only; faint on rivers), then wind ripples
    // across it. Each layer fades out once it is too fine for the pixel.
    float ampSwell = (kind > 0.5 && kind < 1.5 ? 1.0 : 0.3) * (1.0 - smoothstep(25.0, 90.0, px));
    // Phase warp so the wave trains wander and break up instead of running in straight bands. Built
    // from sines, which are smooth everywhere (a noise warp kinks the crests along its cell edges).
    vec2 q = w.xz;
    float warp = px < 90.0 ? 1.3 * sin(dot(q, vec2(0.0137, 0.0071))) + 0.9 * sin(dot(q, vec2(-0.0063, 0.0191)) + 1.3) : 0.0;
    if (ampSwell > 0.0) g += waveSet(w.xz, t, 0.25, 110.0, 0.03 * ampSwell, warp);
    float amp = (1.0 - smoothstep(1.5, 7.0, px)) * (1.0 + 0.8 * uAtmWet); // rain roughens the water
    if (amp > 0.0) {
      float warp2 = warp + 1.1 * sin(dot(q, vec2(0.0613, -0.0377)) + 0.4) + 0.8 * sin(dot(q, vec2(0.0291, 0.0719)) + 2.1);
      g += waveSet(w.xz, t, -0.6, 21.0, 0.032 * amp, warp2);
      g += waveSet(w.xz, t, 1.1, 7.0, 0.018 * amp * (1.0 - smoothstep(0.5, 2.5, px)), warp2 * 1.7);
    }
    vec3 n = normalize(vec3(g.x, 1.0, g.y));
    vec3 body;
    if (kind > 0.5 && kind < 1.5) {
      // Arabian Sea: sandy turquoise shallows -> green-blue -> deep blue with depth, and sand stirred
      // up in the surf zone.
      body = mix(vec3(0.22, 0.47, 0.44), vec3(0.10, 0.32, 0.36), smoothstep(0.3, 5.0, depth));
      body = mix(body, uWaterColor, smoothstep(5.0, 22.0, depth));
      body = mix(body, vec3(0.36, 0.42, 0.36), (1.0 - smoothstep(8.0, 45.0, shoreDist)) * 0.55);
    } else if (kind > 1.5) {
      // Estuaries: silt-laden olive green-brown, a little clearer in the middle.
      body = mix(vec3(0.27, 0.33, 0.24), vec3(0.19, 0.28, 0.24), smoothstep(0.5, 4.0, depth));
    } else {
      body = mix(uWaterColor * 1.35 + vec3(0.05, 0.05, 0.03), uWaterColor, smoothstep(0.5, 18.0, depth));
    }
    body *= mix(0.62, 1.0, sunVis) * atmLightLevel();
    float cosi = max(dot(-V, n), 0.0);
    float fres = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
    vec3 col = mix(body, atmSky(reflect(V, n)), fres * 0.85);
    // Surf on the open coast: breaker lines rolling in to the beach (~6 m/s), broken up along the
    // shore, and the swash line at the water's edge. Breaker lines fade out once they are sub-pixel;
    // the swash line stays as a thin white edge from afar.
    float foam = 0.0;
    if (kind > 0.5 && kind < 1.5 && shoreDist < 150.0) {
      float nA = vnoise(w.xz / 55.0 + vec2(t * 0.02, 0.0));
      float crest = smoothstep(0.8, 0.97, sin(shoreDist * 0.22 + t * 1.3 + nA * 5.0));
      crest *= (1.0 - smoothstep(25.0, 130.0, shoreDist)) * smoothstep(0.25, 0.55, nA + 0.25) * (1.0 - smoothstep(3.0, 10.0, px));
      float swash = 1.0 - smoothstep(0.0, 5.0 + 7.0 * nA + max(px, 0.0), shoreDist);
      foam = max(crest * 0.8, swash * 0.9);
      foam *= 0.6 + 0.4 * (px < 3.0 ? vnoise(w.xz / 2.5 + t * 0.2) : 0.5);
      col = mix(col, vec3(0.92, 0.94, 0.95) * mix(0.55, 1.0, sunVis) * atmLightLevel(), foam);
    }
    vec3 R = reflect(V, n);
    float spec = pow(max(dot(R, normalize(uSunDir)), 0.0), 160.0);
    return col + uAtmSunCol * (1.8 * spec) * (1.0 - foam) * sunVis;
  }


  // Tree crowns (~crownM wide) covering density of the ground, with the shadows they cast away
  // from the sun; near the camera only. Darkens col under crowns and returns the shadow factor.
  float treeCanopy(vec2 p, float density, float crownM, float heightM, vec3 L, float near, inout vec3 col, vec3 crownCol) {
    if (near <= 0.0 || density <= 0.0) return 1.0;
    float thr = 1.0 - density;
    vec2 toSun = L.xz / max(L.y, 0.25) * heightM;
    float crown = smoothstep(thr, thr + 0.12, vnoise(p / crownM));
    float caster = smoothstep(thr, thr + 0.12, vnoise((p + toSun) / crownM));
    col = mix(col, crownCol * (0.85 + 0.3 * (near > 0.8 ? vnoise(p / (crownM * 0.3)) : 0.5)), crown * near);
    return 1.0 - 0.6 * max(caster - crown, 0.0) * near;
  }

  // Goa in the dry season (Jan-Mar): straw and green paddy lowlands, a coconut-palm belt behind
  // the beaches, red-brown laterite plateaus and headlands, mangroves on estuary banks, red-tile
  // villages among palms, and dense forest on the Ghats escarpment.
  // 1 on and around any runway (the airfield: runway plus ~450 m along and ~400 m either side), so
  // no painted trees stand on an airport (the 3D trees are cleared the same way in chunkFeatures.ts).
  float airfieldClear(vec2 p) {
    float m = 0.0;
    for (int i = 0; i < ${MAX_TERRAIN_RUNWAYS}; i++) {
      if (i >= uRunwayCount) break;
      vec4 r = uRunways[i];
      float hd = uRunwayHeadings[i];
      vec2 d = p - r.xy;
      float along = abs(dot(d, vec2(sin(hd), -cos(hd))));
      float across = abs(dot(d, vec2(cos(hd), sin(hd))));
      m = max(m, (1.0 - smoothstep(r.z + 400.0, r.z + 500.0, along)) * (1.0 - smoothstep(r.w + 350.0, r.w + 450.0, across)));
    }
    return m;
  }

  // est = signed distance into the nearest estuary (coastMath), > 0 in its water.
  vec3 coastColor(vec3 w, vec3 n, float px, float near, vec3 L, inout float shadow, float est, vec2 coastPx) {
    float slope = 1.0 - n.y;
    float coastD = coastPx.x;
    float headland = coastPx.y;
    float hw = w.y - uWaterLevel;
    float toRiver = -est;
    float f1 = vLow + 0.2 * (px < 20.0 ? vnoise(w.xz / 600.0 * 4.01 + 41.0) : 0.5);

    // Lowland: mostly green (cashew, mango, scrub forest) with dry-season paddy (straw) in patches.
    vec3 col = mix(vec3(0.60, 0.54, 0.35), vec3(0.30, 0.40, 0.18), smoothstep(0.25, 0.5, f1));
    if (px < 30.0) col *= 0.93 + 0.14 * vnoise(w.xz / 70.0) * (1.0 - smoothstep(15.0, 30.0, px));
    // Laterite clearings: red soil.
    float soilAmt = smoothstep(0.70, 0.80, vMacro.y) * 0.5;
    col = mix(col, vec3(0.54, 0.36, 0.25), soilAmt);
    // Dense ground detail (canopy/grass, soil in the clearings), fading cleanly with distance.
    col *= mix(vec3(1.0), mix(detailAt(w.xz, 0.0, 16.0, px), detailAt(w.xz, 1.0, 12.0, px), soilAmt * 2.0), 0.6);

    // Ghats escarpment zone and the height the plain would have here (landform: rise per km inland).
    float ghatsZone = smoothstep(uCoastShape.y - 1500.0, uCoastShape.y + 1500.0, coastD);
    float aboveplain = w.y - (uCoastShape.x * coastD / 1000.0 + 20.0);
    // Laterite plateau tops: flat ground standing well above the plain, short of the Ghats.
    float plateau = smoothstep(28.0, 45.0, aboveplain) * smoothstep(0.92, 0.985, n.y) * (1.0 - ghatsZone) * smoothstep(800.0, 1500.0, coastD);
    if (plateau > 0.0) col = mix(col, mix(vec3(0.56, 0.38, 0.27), vec3(0.64, 0.56, 0.38), px < 40.0 ? vnoise(w.xz / 140.0) : 0.5), plateau * 0.85);

    // Ghats escarpment and foothills: dense dark forest; the Deccan top is drier grassland.
    float ghats = ghatsZone * (1.0 - plateau);
    vec3 forest = mix(vec3(0.11, 0.23, 0.09), vec3(0.16, 0.28, 0.11), f1);
    float deccanTop = smoothstep(780.0, 860.0, w.y) * smoothstep(0.97, 0.99, n.y);
    col = mix(col, mix(forest, vec3(0.58, 0.52, 0.34), deccanTop * 0.7), ghats);

    // Laterite rock: cliffs, plateau edges, headlands.
    float rock = max(smoothstep(0.22, 0.42, slope), headland * (1.0 - smoothstep(40.0, 140.0, coastD)));
    if (rock > 0.0) col = mix(col, vec3(0.44, 0.28, 0.20) * (0.85 + 0.3 * (px < 8.0 ? vnoise(w.xz / 25.0) : 0.5)), rock * (1.0 - ghats * 0.6));

    // Coconut-palm belt behind the beaches and along the estuaries.
    float palmBelt = (1.0 - smoothstep(1500.0, 3500.0, coastD)) * smoothstep(20.0, 120.0, coastD);
    float riverBank = smoothstep(1500.0, 2500.0, coastD) * (1.0 - smoothstep(60.0, 260.0, toRiver));
    float palms = max(palmBelt, riverBank) * (1.0 - rock) * (1.0 - plateau) * (1.0 - smoothstep(60.0, 120.0, w.y));
    col = mix(col, vec3(0.24, 0.35, 0.15), palms * 0.55);

    // Mangroves on the tidal banks of the estuaries (inland only), with a dark mud margin.
    float mangrove = smoothstep(800.0, 2000.0, coastD) * (1.0 - smoothstep(0.0, 55.0 + 35.0 * (px < 40.0 ? vnoise(w.xz / 90.0) : 0.5), toRiver));
    col = mix(col, vec3(0.09, 0.19, 0.10), mangrove);
    col = mix(col, vec3(0.28, 0.26, 0.20), (1.0 - smoothstep(0.0, 12.0, toRiver)) * smoothstep(300.0, 1200.0, coastD));

    // Beaches (open coast only, not at headlands): dry sand 50-90 m wide, and wet sand at the water's
    // edge that the swash runs up over and back.
    float beachW = 70.0 + 30.0 * (px < 60.0 ? vnoise(w.xz / 180.0) - 0.5 : 0.0);
    float beach = (1.0 - smoothstep(beachW - 15.0, beachW + 15.0, coastD)) * (1.0 - smoothstep(0.35, 0.65, headland));
    float wet = 1.0 - smoothstep(3.0, 9.0 + 5.0 * sin(uTime * 0.8 + w.z * 0.01), coastD);
    vec3 sand = mix(vec3(0.87, 0.81, 0.64), vec3(0.62, 0.55, 0.42), wet);
    col = mix(col, sand * mix(vec3(1.0), detailAt(w.xz, 2.0, 12.0, px), 0.7), beach);

    // Tree crowns and their shadows near the camera: palms along the coast and rivers, forest on
    // the Ghats, scattered cashew/mango trees elsewhere.
    float density = max(max(palms * 0.75, ghats * 0.9), 0.2 * (1.0 - plateau) * (1.0 - beach)) * (1.0 - rock) * (1.0 - beach) * (1.0 - mangrove * 0.5) * (1.0 - airfieldClear(w.xz));
    vec3 crownCol = mix(vec3(0.20, 0.33, 0.13), vec3(0.10, 0.21, 0.08), ghats);
    // Crowns are 8-12 m: unresolvable once a pixel covers ~5 m, so they get their own, tighter fade.
    float treeNear = 1.0 - smoothstep(1.5, 5.0, px);
    shadow *= treeCanopy(w.xz, density, mix(8.0, 12.0, ghats), mix(12.0, 18.0, ghats), L, treeNear, col, crownCol);
    return col;
  }

  // Punjab from the air (reference: an oblique satellite view near Jalandhar): a patchwork of
  // rectangular fields, mostly on one grid, in muted colours - about half beige/tan/brown (harvested
  // or bare), soft and mid greens, some dark green (sugarcane, orchards), the odd purple-brown - with
  // thin dirt field edges, faint rows or orchard dots in some fields, and the braided rivers' sandy
  // floodplain (khadar) a few metres below the plain.
  vec3 plainsColor(vec3 w, float px, vec3 L, inout float shadow, vec3 rv) {
    vec2 p = w.xz;
    // Field grid: ~760 m blocks on a slightly rotated grid, each split into 2-5 x 2-6 fields.
    vec2 q = vec2(0.993 * p.x - 0.12 * p.y, 0.12 * p.x + 0.993 * p.y);
    const float B = 760.0;
    vec2 bid = floor(q / B);
    vec2 n = vec2(2.0 + floor(hash12(bid + 1.3) * 4.0), 2.0 + floor(hash12(bid + 2.7) * 5.0));
    vec2 fl = fract(q / B) * n;
    vec2 fid = floor(fl);
    vec2 ff = fract(fl);
    vec2 fsize = B / n;
    vec2 id = bid * 8.0 + fid;
    // About a third of the fields are split again into 2-4 long narrow strips (typical of Punjab).
    float sp = hash12(id + 7.7);
    if (sp < 0.35) {
      float k = 2.0 + floor(sp / 0.35 * 3.0);
      if (fsize.x > fsize.y) { float s = floor(ff.x * k); ff.x = fract(ff.x * k); fsize.x /= k; id += vec2(s * 0.37, 0.0); }
      else { float s = floor(ff.y * k); ff.y = fract(ff.y * k); fsize.y /= k; id += vec2(0.0, s * 0.37); }
    }
    float h = hash12(id + 5.1);
    vec3 fieldCol;
    float soil; // 1 for bare/harvested fields (soil detail), 0 for crops (canopy detail)
    if (h < 0.20)      { fieldCol = vec3(0.66, 0.60, 0.49); soil = 1.0; }
    else if (h < 0.38) { fieldCol = vec3(0.58, 0.51, 0.40); soil = 1.0; }
    else if (h < 0.46) { fieldCol = vec3(0.48, 0.41, 0.33); soil = 1.0; }
    else if (h < 0.62) { fieldCol = vec3(0.40, 0.43, 0.31); soil = 0.3; }
    else if (h < 0.78) { fieldCol = vec3(0.29, 0.36, 0.23); soil = 0.0; }
    else if (h < 0.88) { fieldCol = vec3(0.18, 0.26, 0.16); soil = 0.0; }
    else if (h < 0.955) { fieldCol = vec3(0.50, 0.49, 0.37); soil = 0.5; }
    else if (h < 0.97) { fieldCol = vec3(0.47, 0.42, 0.39); soil = 1.0; }
    else               { fieldCol = vec3(0.52, 0.55, 0.45); soil = 0.4; }
    fieldCol *= 0.92 + 0.16 * hash12(id + 9.7);
    // Close up: faint rows along the field (or orchard dots on dark-green fields), fading by distance.
    float rowsW = 1.0 - smoothstep(0.6, 2.0, px);
    if (rowsW > 0.0 && hash12(id + 3.3) < 0.3) {
      vec2 fm = ff * fsize;
      float along = hash12(id + 4.4) < 0.5 ? fm.x : fm.y;
      if (h >= 0.78 && h < 0.88) {
        vec2 g = fract(fm / 6.0) - 0.5;
        fieldCol *= 1.0 - 0.3 * rowsW * (1.0 - smoothstep(0.15, 0.3, length(g)));
      } else {
        fieldCol *= 1.0 - 0.07 * rowsW * (0.5 + 0.5 * sin(along * 0.8));
      }
    }
    // The fields dissolve into their average only once they are a few pixels wide (no shimmer).
    vec3 avgCol = vec3(0.47, 0.47, 0.35) * (0.95 + 0.1 * vnoise(p / 3000.0));
    float farW = smoothstep(min(fsize.x, fsize.y) * 0.25, min(fsize.x, fsize.y) * 0.8, px);
    vec3 col = mix(fieldCol, avgCol, farW);
    // Thin dirt field edges (bunds).
    vec2 edge = min(ff, 1.0 - ff) * fsize;
    // Close up a crisp 2.4 m bund; further out a faint pale line (it still reads between fields from altitude).
    float bw = max(1.2, px * 0.6);
    float bund = (1.0 - smoothstep(bw, bw + px, min(edge.x, edge.y))) * mix(0.8, 0.35, smoothstep(4.0, 15.0, px)) * (1.0 - smoothstep(30.0, 60.0, px));
    col = mix(col, vec3(0.64, 0.60, 0.51), bund);
    // Dense surface detail: soil on bare fields, crop canopy on the rest.
    vec3 det = detailAt(p, 0.0, 16.0, px);
    if (soil > 0.01) det = mix(det, detailAt(p, 1.0, 12.0, px), soil * (1.0 - farW));
    col *= mix(vec3(1.0), det, 0.7 - 0.35 * soil);

    // The rivers' active belt (khadar), from riverMath: pale sand along and between the channels,
    // mottled grey-green scrub on the older ground, darker wet sand at the water's edge, bright
    // sandbars. (The water itself is drawn in main().)
    float belt = smoothstep(-90.0, 30.0, rv.y);
    if (belt > 0.0) {
      // Fresh sand only near the channels; further out the older khadar is dry grass and scrub
      // (fine-grained, so it never reads as cloud shadow), with sand showing through in streaks.
      float nearW = 1.0 - smoothstep(60.0, 320.0, -rv.x);
      float streak = vnoise(vec2(dot(p, vec2(0.8, 0.6)) / 900.0, dot(p, vec2(-0.6, 0.8)) / 120.0));
      float fine = px < 25.0 ? vnoise(p / 23.0) : 0.5;
      float scrubN = 0.45 * vnoise(p / 150.0) + 0.3 * fine + 0.25 * streak;
      vec3 grass = mix(vec3(0.62, 0.60, 0.46), vec3(0.45, 0.47, 0.34), smoothstep(0.4, 0.7, scrubN));
      vec3 sand = vec3(0.78, 0.73, 0.64);
      float sandy = max(nearW, smoothstep(0.62, 0.8, streak) * 0.7);
      vec3 bc = mix(grass, sand, sandy);
      bc = mix(bc, vec3(0.86, 0.81, 0.71), rv.z);
      bc = mix(bc, vec3(0.56, 0.48, 0.42), (1.0 - smoothstep(0.0, 22.0, -rv.x)) * 0.75);
      bc *= mix(vec3(1.0), detailAt(p, sandy > 0.5 ? 2.0 : 0.0, 12.0, px), 0.6);
      col = mix(col, bc, belt);
    }

    // Roads, canals, villages, towns and trees are real geometry now (chunkFeatureRenderer.ts).
    return col;
  }

  void main() {
    if (uStyle == 0) {
      gl_FragColor = vec4(atmApply(uGroundColor, vWorld), 1.0);
      return;
    }
    float nl = length(vNormal);
    vec3 n = vNormal / max(nl, 1e-4);
    float px = max(length(dFdx(vWorld.xz)), length(dFdy(vWorld.xz)));
    vec3 L = normalize(uSunDir);
    vec3 col;
    // Punjab rivers are analytic (riverMath), so their water is decided per pixel, not by the mesh.
    vec3 rv = vec3(-1e9, -1e9, 0.0);
    if (uStyle == 2 && uRiverCount > 0) rv = riversAt(vWorld.xz);
    float riverWater = uStyle == 2 ? smoothstep(-0.5 * px - 0.5, 0.5 * px + 0.5, rv.x) : 0.0;
    // Goa: the sea and estuaries are analytic too (coastMath): sea where the pixel is west of the
    // shoreline table (except island land, which only the mesh knows), estuaries by their field.
    float est = -1e9;
    float seaW = -1e9;
    float coastWater = 0.0;
    vec2 coastPx = vec2(1e5, 0.0);
    // Sea and estuaries are shaded where the view ray meets the water plane, not on the sea-floor
    // mesh, so LOD seams, skirts and the floor's facets never show through the water.
    vec3 wWater = vWorld;
    float pxWater = px;
    if (uStyle == 1) {
      float camY = vWorld.y - vRel.y;
      if (vRel.y < -1e-3 && camY > uWaterLevel) wWater = vWorld + vRel * (clamp((uWaterLevel - camY) / vRel.y, 0.0, 1.0) - 1.0);
      pxWater = max(length(dFdx(wWater.xz)), length(dFdy(wWater.xz)));
      if (uEstuaryCount > 0) est = estuariesAt(vWorld.xz);
      if (uCoastCount > 1) coastPx = coastAt(vWorld.xz);
      seaW = -coastPx.x;
      // Island land (only the mesh knows it). Islands sit well offshore, so this is never applied
      // near the shore, where mesh triangles straddling the waterline would otherwise read as land.
      float island = seaW > 1500.0 ? smoothstep(0.15, 0.6, vWorld.y - uWaterLevel) : 0.0;
      coastWater = smoothstep(-0.5 * px - 0.5, 0.5 * px + 0.5, max(seaW, est)) * (1.0 - island);
    }
    if (uStyle == 0 && uHasWater > 0.5 && vWorld.y <= uWaterLevel + 0.05) {
      col = waterShade(vWorld, vRel, px, max(nl - 1.0, 0.0) * 30.0, 1e9, 0.0, 1.0);
    } else {
      // Ring relief (chunkGeometryBuilder.ts LAND_LEN_*): > 0 in hollows, < 0 on raised ground.
      float relief = (0.62 - nl) / 0.6;
      float occ = clamp(1.0 - 1.6 * relief, 0.45, 1.0);
      gRaised = clamp(-relief / 0.12, 0.0, 1.0);
      // Near-camera detail weight: full below 3 m per pixel, gone by 12 m.
      float near = 1.0 - smoothstep(3.0, 12.0, px);
      // (Not on the Punjab plain: it is flat enough that per-pixel relief would not show.)
      if (near > 0.0 && uStyle != 2) {
        vec2 g = detailGrad(vWorld.xz, 22.0, 1.4, px);
        n = normalize(n - vec3(g.x, 0.0, g.y) * near);
      }
      float shadow = 1.0;
      if (uStyle == 1) col = coastColor(vWorld, n, px, near, L, shadow, est, coastPx);
      else col = plainsColor(vWorld, px, L, shadow, rv);
      // Airfield ground: mown, sun-dried grass with a little mowing texture, and bare, scuffed earth
      // along the pavement edges (instead of crops, groves or painted trees).
      vec2 af = airfieldAt(vWorld.xz);
      if (af.x > 0.004) {
        vec2 ap = vWorld.xz;
        vec3 grass = mix(vec3(0.52, 0.50, 0.33), vec3(0.42, 0.45, 0.27), vnoise(ap / 70.0));
        grass *= 0.93 + 0.1 * vnoise(ap / 9.0);
        grass *= mix(vec3(1.0), detailAt(ap, 0.0, 14.0, px), 0.5);
        vec3 earth = vec3(0.56, 0.49, 0.38) * mix(vec3(1.0), detailAt(ap, 1.0, 10.0, px), 0.6);
        float bare = (1.0 - smoothstep(0.03, 0.16, af.y + 0.06 * vnoise(ap / 11.0))) * 0.85;
        vec3 ground = mix(grass, earth, bare);
        col = mix(col, ground, af.x);
        shadow = mix(shadow, 1.0, af.x);
      }
      // Rain-soaked ground is darker.
      col *= 1.0 - 0.3 * uAtmWet;

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
        col = mix(col, vec3(0.46, 0.49, 0.30) * (0.92 + 0.16 * vnoise(vWorld.xz / 25.0)), strip);
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
      float ndlGeom = dot(normalize(vNormal), L);
      // Sun visibility taken on the water surface over the sea and estuaries (wWater = vWorld on land),
      // so the aircraft's, trees' and clouds' shadows fall on the water too.
      float sunVis = cloudShadow(wWater) * sunShadow(wWater, ndlGeom);
      float diff = max(dot(n, L), 0.0) * shadow * sunVis;
      vec3 ambient = mix(uAtmAmbGround, uAtmAmbSky, 0.5 + 0.5 * n.y);
      col *= ambient * occ + uAtmSunCol * diff * mix(1.0, occ, 0.35);
      if (riverWater > 0.0) col = mix(col, waterShade(vWorld, vRel, px, clamp(rv.x * 0.03, 0.0, 6.0), 1e9, 0.0, sunVis), riverWater);
      if (coastWater > 0.0) {
        bool estuary = est > 0.0 && est > seaW;
        float depth = estuary ? min(est * 0.02, 6.0) : min(seaW * (0.01 - 0.006 * coastPx.y), 60.0);
        col = mix(col, waterShade(wWater, wWater - vWorld + vRel, pxWater, depth, estuary ? 1e9 : seaW, estuary ? 2.0 : 1.0, sunVis), coastWater);
      }
    }
    gl_FragColor = vec4(atmApply(col, mix(vWorld, wWater, coastWater)), 1.0);
  }
`;

function emptyAirfieldTexture(): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(new Uint8Array(2), 1, 1, 1);
  t.format = THREE.RGFormat;
  t.needsUpdate = true;
  return t;
}

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
      uCoastCount: { value: 0 },
      uCoastZ: { value: new THREE.Vector2(0, 1) },
      uCoastShape: { value: new THREE.Vector3(0, 1e9, 1) },
      uDetail: { value: getDetailTexture() },
      uAirfieldTex: { value: emptyAirfieldTexture() },
      uAirfield: { value: Array.from({ length: MAX_AIRFIELDS }, () => new THREE.Vector4()) },
      uAirfieldCount: { value: 0 },
      uTime: { value: 0 },
      uRivers: { value: Array.from({ length: 4 * MAX_RIVERS }, () => new THREE.Vector4()) },
      uRiverCount: { value: 0 },
      uEstuaries: { value: Array.from({ length: 4 * MAX_ESTUARIES }, () => new THREE.Vector4()) },
      uEstuaryCount: { value: 0 },
      ...getCloudShadowUniforms(),
      ...getAtmosphereUniforms(),
      ...getSunShadowUniforms(),
      uShore: { value: Array.from({ length: COAST_VEC4S }, () => new THREE.Vector4()) },
      uHead: { value: Array.from({ length: COAST_VEC4S }, () => new THREE.Vector4()) },
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

  const rivers = u['uRivers']!.value as THREE.Vector4[];
  const nRiv = env.rivers ? Math.min(env.rivers.count, MAX_RIVERS) : 0;
  for (let i = 0; i < nRiv * 4; i++) {
    const o = Math.floor(i / 4) * RIVER_FLOATS + (i % 4) * 4;
    const pk = env.rivers!.packed;
    rivers[i]!.set(pk[o]!, pk[o + 1]!, pk[o + 2]!, pk[o + 3]!);
  }
  u['uRiverCount']!.value = nRiv;

  const ests = u['uEstuaries']!.value as THREE.Vector4[];
  const nEst = env.estuaries ? Math.min(env.estuaries.count, MAX_ESTUARIES) : 0;
  for (let i = 0; i < nEst * 4; i++) {
    const o = Math.floor(i / 4) * ESTUARY_FLOATS + (i % 4) * 4;
    const pk = env.estuaries!.packed;
    ests[i]!.set(pk[o]!, pk[o + 1]!, pk[o + 2]!, pk[o + 3]!);
  }
  u['uEstuaryCount']!.value = nEst;

  const coast = env.coast;
  const nCoast = coast ? Math.min(coast.shoreX.length, MAX_COAST_SAMPLES) : 0;
  const shore = u['uShore']!.value as THREE.Vector4[];
  const head = u['uHead']!.value as THREE.Vector4[];
  for (let i = 0; i < nCoast; i++) {
    shore[i >> 2]!.setComponent(i & 3, coast!.shoreX[i]!);
    head[i >> 2]!.setComponent(i & 3, coast!.headland[i]!);
  }
  if (coast) {
    (u['uCoastZ']!.value as THREE.Vector2).set(coast.z0, coast.dz);
    (u['uCoastShape']!.value as THREE.Vector3).set(coast.plainRiseMPerKm, coast.hillsStartM, coast.hillsRampM);
  }
  u['uCoastCount']!.value = nCoast;

  const masks = (env.airfieldMasks ?? []).slice(0, MAX_AIRFIELDS);
  const old = u['uAirfieldTex']!.value as THREE.DataArrayTexture;
  if (masks.length > 0) {
    const N = AIRFIELD_MASK_SIZE;
    const data = new Uint8Array(N * N * 2 * masks.length);
    masks.forEach((m, i) => data.set(m.data, i * N * N * 2));
    const tex = new THREE.DataArrayTexture(data, N, N, masks.length);
    tex.format = THREE.RGFormat;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    u['uAirfieldTex']!.value = tex;
    old.dispose();
  }
  const af = u['uAirfield']!.value as THREE.Vector4[];
  masks.forEach((m, i) => af[i]!.set(m.minX, m.minZ, 1 / m.sizeM, 0));
  u['uAirfieldCount']!.value = masks.length;
}
