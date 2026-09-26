/**
 * src/render/townLayer.ts — villages and towns drawn flat into the terrain shader.
 *
 * The 3D houses (chunkFeatureRenderer.ts) exist only on the finest terrain chunks and are a few
 * pixels across beyond a few kilometres, where they shimmered (sub-pixel boxes and screen-door
 * dithered fades) and popped as chunks changed. Beyond TOWN_3D_FADE_* they now shrink away and the
 * terrain draws each settlement itself, at every LOD: built-up ground, the same lot grid of flat
 * roofs (Punjab) or scattered tiled roofs (Goa), and at night lit windows. Every pattern is
 * filtered by the pixel footprint: once a lot is under a few pixels it is replaced by its mean
 * cover and colour, so nothing aliases from altitude.
 *
 * Settlements come from the terrain worker (roadNetwork.ts packSettlementLayer): villages in a
 * grid texture (one per cell; a pixel checks the 2x2 cells around it), towns in a uniform list.
 */
import * as THREE from 'three';
import { SETTLEMENT_SLOTS, type SettlementLayer } from '../contracts/terrain';
import { SETTLEMENT_EDGE_REACH } from '../terrain/roadNetwork';

/** 3D houses (and their night lights) shrink away between these distances; the flat layer's roofs and lights take over. */
export const TOWN_3D_FADE_START_M = 3000;
export const TOWN_3D_FADE_END_M = 4500;

/** Needs hash12/vnoise (NOISE_GLSL), detailAt (DETAIL_GLSL) and `uStyle` (1 = Goa, 2 = Punjab). */
export const TOWN_GLSL = /* glsl */ `
  uniform sampler2D uTownGrid;
  uniform vec4 uTownGridInfo; // originM, spacingM, nCells, enabled

  // Night lights of the town layer, added after lighting (set by townLayer).
  float gTownGlow = 0.0;
  vec3 gTownGlowCol = vec3(0.0);

  // Keeps settlement s (x, z, radiusM, rotRad) in best if p lies further inside it than best.
  // best: xy = p in the settlement's lot frame (m), z = rim (0 centre .. 1 edge), w = seed.
  void townTest(inout vec4 best, inout float bestRot, vec2 p, vec4 s, float seed) {
    vec2 d = p - s.xy;
    float r = length(d);
    if (r > s.z * ${SETTLEMENT_EDGE_REACH.toFixed(2)}) return;
    // A ragged edge: the radius varies with direction (noise of the direction vector, so no seam).
    float rim = r / (s.z * (0.82 + 0.3 * vnoise(d / max(r, 1.0) * 2.2 + seed)));
    if (rim >= best.z) return;
    float c = cos(s.w);
    float sn = sin(s.w);
    best = vec4(c * d.x + sn * d.y, -sn * d.x + c * d.y, rim, seed);
    bestRot = s.w;
  }

  vec4 settlementAt(vec2 p, out float rot) {
    vec4 best = vec4(0.0, 0.0, 1.0, 0.0);
    rot = 0.0;
    int n = int(uTownGridInfo.z);
    ivec2 c = ivec2(floor((p - uTownGridInfo.x) / uTownGridInfo.y));
    if (c.x < 0 || c.y < 0 || c.x >= n || c.y >= n) return best;
    // The settlements reaching into p's cell, slot 0 first (an empty slot ends the list).
    for (int k = 0; k < ${SETTLEMENT_SLOTS}; k++) {
      vec4 s = texelFetch(uTownGrid, ivec2(c.x + k * n, c.y), 0);
      if (s.z <= 0.0) break;
      townTest(best, rot, p, s, fract(s.x * 0.0137 + s.y * 0.0071) * 97.0);
    }
    return best;
  }

  // A gaussian light (peak 1, variance sig2) seen through a pixel whose footprint has covariance
  // Sp: the two convolved, so the light's energy is kept however small or oblique the view.
  float lightFiltered(vec2 d, float sig2, mat2 Sp) {
    mat2 S = Sp + mat2(sig2, 0.0, 0.0, sig2);
    float det = S[0][0] * S[1][1] - S[0][1] * S[0][1];
    vec2 id = mat2(S[1][1], -S[0][1], -S[0][1], S[0][0]) * d / det;
    return exp(-0.5 * dot(d, id)) * sig2 / sqrt(det);
  }

  // The settlement (if any) over ground colour col; also sets gTownGlow/gTownGlowCol.
  // gX/gY: the pixel's footprint vectors on the ground (dFdx/dFdy of world xz, taken in main).
  vec3 townLayer(vec3 col, vec2 p, float px, float dist, vec2 gX, vec2 gY) {
    float rot;
    vec4 s = settlementAt(p, rot);
    if (s.z >= 1.0) return col;
    bool goa = uStyle == 1;
    float rim = s.z;
    float a = 1.0 - smoothstep(0.75, 1.0, rim);
    // Lot pattern resolved (lots over ~3 px) or replaced by its mean.
    vec2 L = goa ? vec2(20.0) : vec2(14.0, 13.0);
    float resolve = 1.0 - smoothstep(0.12, 0.3, px / L.x);
    // Middle level: blocks of lots vary smoothly in density (busy and quiet quarters), so a town
    // keeps its clustered look after single lots are unresolved; itself averaged away once blocks
    // are under a few pixels.
    vec2 B = goa ? L * 4.0 : L * vec2(5.0, 4.0);
    float blockV = 0.25 + 1.5 * smoothstep(0.25, 0.75, vnoise(s.xy / B + s.w * 7.0));
    float patch_ = mix(1.0, blockV, 1.0 - smoothstep(0.12, 0.35, px / B.x));

    if (!goa) {
      // Built-up ground: dusty yards and lanes, mottled with dark tree clumps.
      float fine = mix(vnoise(p / 14.0), 0.5, smoothstep(8.0, 20.0, px));
      vec3 g = vec3(0.52, 0.49, 0.43) * (0.88 + 0.24 * fine) * mix(vec3(1.0), detailAt(p, 1.0, 10.0, px), 0.7);
      float tn = vnoise(p / 45.0) * 0.75 + mix(vnoise(p / 15.0), 0.5, smoothstep(5.0, 12.0, px)) * 0.25;
      float trees = smoothstep(0.62, 0.75, mix(tn, 0.45, smoothstep(15.0, 35.0, px)) + 0.25 * rim);
      g = mix(g, vec3(0.17, 0.23, 0.13), trees * 0.8);
      col = mix(col, g, a);
    }

    // Roofs and lights, where the 3D houses have faded out.
    float w2d = smoothstep(${TOWN_3D_FADE_START_M.toFixed(1)}, ${TOWN_3D_FADE_END_M.toFixed(1)}, dist) * a;
    if (w2d <= 0.0) return col;
    vec2 q = s.xy / L;
    vec2 cell = floor(q + 0.5);
    vec2 e = abs(q - cell) * L; // metres from the lot centre
    float keep = goa ? 0.55 * (1.0 - 0.75 * rim * rim) : 0.88 - 0.4 * rim;
    float occ = step(hash12(cell + s.w * 17.0), keep);
    float laneFrac = 1.0;
    if (!goa) {
      // Lanes: every 5th column and 4th row, and the two main lanes through the centre.
      float lane = max(max(step(abs(mod(cell.x, 5.0) - 2.0), 0.5), step(abs(mod(cell.y, 4.0) - 1.0), 0.5)), max(step(abs(cell.x), 0.5), step(abs(cell.y), 0.5)));
      occ *= 1.0 - lane;
      laneFrac = 0.6;
    }
    vec2 hr = L * (goa ? 0.22 : 0.38);
    float aa = px * 0.7 + 0.1;
    float roof = (1.0 - smoothstep(hr.x - aa, hr.x + aa, e.x)) * (1.0 - smoothstep(hr.y - aa, hr.y + aa, e.y)) * occ;
    float roofMean = keep * laneFrac * 4.0 * hr.x * hr.y / (L.x * L.y) * patch_;
    float hv = hash12(cell + 3.1 + s.w);
    // Punjab: whitewash, cream and grey concrete, the odd brick house (as the 3D palette).
    vec3 roofMeanCol = goa ? vec3(0.56, 0.28, 0.19) : vec3(0.72, 0.70, 0.66);
    vec3 roofCol = goa ? mix(vec3(0.66, 0.31, 0.19), vec3(0.42, 0.24, 0.18), hv * 0.8)
      : hv < 0.12 ? vec3(0.58, 0.42, 0.34) : mix(vec3(0.64, 0.63, 0.60), vec3(0.84, 0.82, 0.78), fract(hv * 7.3));
    col = mix(col, mix(roofMeanCol, roofCol, resolve), mix(roofMean, roof, resolve) * w2d);

    // Night: a light at about 70% of the houses. Three levels, each energy-matched to the one it
    // replaces so a town's brightness never jumps: single lights, then one light cluster per block
    // of lots (at a random spot in it; the 3x3 blocks around are summed), then the mean glow. Each
    // light is filtered by the pixel's own (anisotropic) footprint, so none sparkles or vanishes.
    if (uAtmLights < 0.01) return col;
    float c = cos(rot);
    float sn = sin(rot);
    vec2 ga = vec2(c * gX.x + sn * gX.y, -sn * gX.x + c * gX.y);
    vec2 gb = vec2(c * gY.x + sn * gY.y, -sn * gY.x + c * gY.y);
    mat2 Sp = 0.25 * (outerProduct(ga, ga) + outerProduct(gb, gb));
    float tr = Sp[0][0] + Sp[1][1];
    float spread = sqrt(0.5 * (tr + sqrt(max(tr * tr - 4.0 * (Sp[0][0] * Sp[1][1] - Sp[0][1] * Sp[0][1]), 0.0))));
    float perM2 = keep * laneFrac * 0.7 * 3.14159 * 4.84 / (L.x * L.y);
    float res0 = 1.0 - smoothstep(0.15, 0.25, spread / L.y);
    float res1 = 1.0 - smoothstep(0.35, 0.6, spread / B.y);
    float glow = perM2;
    if (res1 > 0.0) {
      vec2 b0 = floor(s.xy / B);
      float cl = 0.0;
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec2 bc = b0 + vec2(float(i), float(j));
          float bv = 0.3 + 1.4 * hash12(bc + s.w * 3.1);
          vec2 ctr = (bc + 0.5 + (vec2(hash12(bc + s.w + 1.7), hash12(bc + s.w + 8.9)) - 0.5) * 0.4) * B;
          cl += lightFiltered(s.xy - ctr, perM2 * B.x * B.y * bv / 6.28318, Sp);
        }
      }
      glow = mix(perM2, cl, res1);
    }
    if (res0 > 0.0) {
      float lit = occ * step(hash12(cell + 11.3 + s.w), 0.7);
      glow = mix(glow, lit * lightFiltered(e, 2.42, Sp), res0);
    }
    gTownGlow = 12.0 * glow * w2d;
    vec3 warm = vec3(1.0, 0.66, 0.3);
    gTownGlowCol = mix(vec3(0.95, 0.72, 0.45), hash12(cell + 5.7 + s.w) < 0.75 ? warm : vec3(0.82, 0.88, 1.0), res0);
    return col;
  }
`;

export function createTownUniforms(): Record<string, THREE.IUniform> {
  return {
    uTownGrid: { value: emptyGrid() },
    uTownGridInfo: { value: new THREE.Vector4(0, 1, 0, 0) },
  };
}

function emptyGrid(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  t.needsUpdate = true;
  return t;
}

/** Loads a theatre's settlements into a material that has the town uniforms (null = none). */
export function applySettlementLayer(material: THREE.ShaderMaterial, layer: SettlementLayer | null): void {
  const u = material.uniforms;
  const old = u['uTownGrid']!.value as THREE.DataTexture;
  const info = u['uTownGridInfo']!.value as THREE.Vector4;
  if (!layer || layer.nCells <= 0) {
    info.set(0, 1, 0, 0);
    return;
  }
  const tex = new THREE.DataTexture(layer.grid as Float32Array<ArrayBuffer>, SETTLEMENT_SLOTS * layer.nCells, layer.nCells, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  u['uTownGrid']!.value = tex;
  old.dispose();
  info.set(layer.originM, layer.spacingM, layer.nCells, 1);
}
