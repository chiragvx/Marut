/**
 * src/render/urbanLayer.ts — the urban sprawl (NetworkSpec.urban) in the terrain shader.
 *
 * The streets, lots and buildings come from src/terrain/urbanMath.ts, with the same integer hashes
 * the terrain worker uses to place the 3D buildings, so the flat roofs seen from afar sit exactly
 * where the 3D houses stand up close. Evaluating that network per pixel every frame was the single
 * biggest cost of the layer, so it is baked instead (urbanCache.ts): urbanParts.ts's
 * uDetailParts renders it into camera-centred cache textures at three resolutions, updated in thin
 * strips as the camera moves, and the terrain shader (URBAN_GLSL) only reads them.
 *
 * The layer is reduced to "parts" that are linear in the underlying ground colour, so they can be
 * cached, filtered and blended between resolutions:
 *   ground' = ground * T + B          (yards, streets; country lanes let some ground through)
 *   final   = mix(ground', roofColour, roof)
 * stored as A = (B, T) and R = (roofColour * roof, roof). Each cache level is filtered by its own
 * texel (streets box-filtered, lots averaged when unresolved), and beyond the finest levels the
 * expected cover of an area (uMeanParts) takes over. Main roads come straight from the field's
 * signed distance, at every distance. Near the camera, where 3D buildings stand, footprints are
 * plinths instead of roofs; flat roofs take over as the buildings shrink away.
 */
import * as THREE from 'three';
import type { UrbanLayer } from '../contracts/terrain';
import { URBAN_ARTERIAL_HW_M } from '../terrain/urbanMath';
import { TOWN_3D_FADE_END_M, TOWN_3D_FADE_START_M } from './townLayer';
import { URBAN_CACHE_GLSL, getUrbanCacheUniforms } from './urbanCache';
import { URBAN_PARTS_GLSL } from './urbanParts';

/** The terrain side: needs gTownGlow/gTownGlowCol (TOWN_GLSL) declared before it. */
export const URBAN_GLSL = /* glsl */ `
  ${URBAN_PARTS_GLSL}
  ${URBAN_CACHE_GLSL}
  uniform float uUrban3D; // 1 = 3D buildings stand on the lots near the camera

  vec3 urbanLayer(vec3 col, vec2 p, vec2 gX, vec2 gY, float px, float dist, inout float shadow) {
    // One filtered read of the field: urbanity and the main roads' signed distance.
    vec4 f = texture(uUrbanTex, (p - uUrbanInfo.xy) / (uUrbanInfo.z * vec2(uUrbanSize)));
    float sdf = uSdfDec(f.w);
    // (Derivatives before any branch.) Pixel width across the main road, and the field's world
    // gradient: a real road's distance field slopes 1 m/m, the false zero crossings interpolated
    // between two far texels of opposite sign about 3.
    float dsx = dFdx(sdf);
    float dsy = dFdy(sdf);
    float artW = abs(dsx) + abs(dsy) + 1e-3;
    float det = gX.x * gY.y - gX.y * gY.x;
    vec2 grad = vec2(gY.y * dsx - gX.y * dsy, gX.x * dsy - gY.x * dsx) / (abs(det) > 1e-9 ? det : 1e-9);
    bool road = dot(grad, grad) < 2.9 && abs(sdf) < 140.0;
    // Close in, the main roads are real geometry (the road decals, on every tier that builds
    // scenery). The field is far too coarse (100 m) to follow their bends there, so it only draws
    // them beyond, where the decals end and a road is a pixel or two wide.
    float artNear = uUrban3D > 0.5 ? smoothstep(6000.0, 9000.0, dist) : 1.0;
    float art = road ? uBand(abs(sdf), ${URBAN_ARTERIAL_HW_M.toFixed(1)}, artW) * artNear : 0.0;
    float verge = road ? uBand(abs(sdf), ${(URBAN_ARTERIAL_HW_M + 2).toFixed(1)}, artW) * artNear : 0.0;
    float U = f.x;
    if (U < 0.004 && verge <= 0.0) return col;

    vec4 A;
    vec4 R;
    uMeanParts(U, A, R);
    vec2 Lg = uAtmLights > 0.01 ? uMeanLights(U) : vec2(0.0);
    if (uUrbCacheOn > 0.5) uCacheParts(p, px, A, R, Lg);
    float roof = R.a;
    vec3 rc = R.rgb / max(roof, 1e-3);
    // Where 3D buildings stand (close in), footprints are plinths; flat roofs take over as they shrink away.
    float w2d = uUrban3D > 0.5 ? smoothstep(${TOWN_3D_FADE_START_M.toFixed(1)}, ${TOWN_3D_FADE_END_M.toFixed(1)}, dist) : 1.0;
    vec3 c = col * A.a + A.rgb;
    c = mix(c, mix(vec3(0.30, 0.28, 0.25), rc, w2d), roof);
    // Main roads on top, with a pale verge.
    c = mix(c, vec3(0.6, 0.56, 0.48), max(verge - art, 0.0) * 0.6);
    c = mix(c, vec3(0.31, 0.31, 0.32), art);
    float built = 1.0 - A.a;
    // No painted tree shadows on roofs and streets.
    shadow = mix(shadow, 1.0, max(max(built, art), roof));
    // Night: lit windows over the roofs (where the 3D houses' own lights have gone), the main
    // roads' lights far off, and the street lights (sodium orange, some white LED).
    vec3 glow = vec3(0.98, 0.7, 0.4) * (0.3 * roof * w2d + 0.3 * art) + 0.9 * (vec3(1.0, 0.58, 0.24) * (Lg.x - Lg.y) + vec3(0.85, 0.9, 1.0) * Lg.y);
    float gl = max(max(glow.r, glow.g), glow.b);
    gTownGlow = max(gTownGlow, gl);
    gTownGlowCol = glow / max(gl, 1e-4);
    return c;
  }
`;

export function createUrbanUniforms(): Record<string, THREE.IUniform> {
  return {
    uUrbanTex: { value: emptyTexture() },
    uUrbanInfo: { value: new THREE.Vector4(0, 0, 1, 0) },
    uUrbanSize: { value: new THREE.Vector2(1, 1) },
    uUrbanSeed: { value: 0 },
    uUrban3D: { value: 1 },
    ...getUrbanCacheUniforms(),
  };
}

function emptyTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

/** Loads a theatre's urban field into a material with the urban uniforms (null = none). */
export function applyUrbanLayer(material: THREE.ShaderMaterial, layer: UrbanLayer | null | undefined): void {
  const u = material.uniforms;
  const info = u['uUrbanInfo']!.value as THREE.Vector4;
  const old = u['uUrbanTex']!.value as THREE.DataTexture;
  if (!layer) {
    info.w = 0;
    return;
  }
  const tex = new THREE.DataTexture(layer.data as Uint8Array<ArrayBuffer>, layer.nx, layer.nz, THREE.RGBAFormat, THREE.UnsignedByteType);
  // Filtered for the terrain's one read (texelFetch, used by the bake, ignores filtering).
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  u['uUrbanTex']!.value = tex;
  old.dispose();
  info.set(layer.originX, layer.originZ, layer.resM, 1);
  (u['uUrbanSize']!.value as THREE.Vector2).set(layer.nx, layer.nz);
  u['uUrbanSeed']!.value = layer.seed;
}

/** Quality: whether 3D buildings exist near the camera (else footprints are drawn as roofs close in too). */
export function setUrbanQuality(material: THREE.ShaderMaterial, has3dBuildings: boolean): void {
  material.uniforms['uUrban3D']!.value = has3dBuildings ? 1 : 0;
}
