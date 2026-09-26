/**
 * src/render/urbanParts.ts — the urban layer as "parts" linear in the ground colour (see
 * urbanLayer.ts): the far-view expectation (uMeanParts) and the full street and lot detail
 * (uDetailParts), which urbanCache.ts bakes into the camera-centred cache textures.
 */
import { URBAN_ARTERIAL_HW_M, URBAN_DISTRICT_M, URBAN_MATH_GLSL } from '../terrain/urbanMath';

export const URBAN_PARTS_GLSL = /* glsl */ `
  ${URBAN_MATH_GLSL}

  // Coverage of the band |d| < hw by a pixel w wide across it (box filter).
  float uBand(float d, float hw, float w) {
    w = max(w, 1e-3);
    return clamp((min(d + 0.5 * w, hw) - max(d - 0.5 * w, -hw)) / w, 0.0, 1.0);
  }
  // Coverage of [lo, hi] by a pixel w wide centred at x.
  float uSpan(float x, float lo, float hi, float w) {
    w = max(w, 1e-3);
    return clamp((min(x + 0.5 * w, hi) - max(x - 0.5 * w, lo)) / w, 0.0, 1.0);
  }
  // Pixel width along unit direction e on the ground.
  float uWidth(vec2 e, vec2 gX, vec2 gY) { return abs(dot(e, gX)) + abs(dot(e, gY)); }

  // Flat roofs: weathered concrete with a little wall colour (as the 3D flat roofs).
  vec3 uFlatRoof(float h) {
    vec3 tint = h < 0.3 ? vec3(0.9, 0.89, 0.85) : h < 0.55 ? vec3(0.88, 0.84, 0.72) : h < 0.7 ? vec3(0.72, 0.78, 0.82) : h < 0.85 ? vec3(0.86, 0.72, 0.66) : vec3(0.7, 0.69, 0.66);
    return mix(vec3(0.46, 0.44, 0.41), tint, 0.25) * (1.05 + 0.25 * fract(h * 13.7));
  }
  // Mangalore tiles: terracotta, some weathered darker (as the 3D tiled roofs).
  vec3 uTileRoof(float h) { return mix(vec3(0.66, 0.31, 0.19), vec3(0.42, 0.24, 0.18), h * 0.8); }

  const vec3 U_LANE = vec3(0.40, 0.39, 0.37);
  const vec3 U_ASPHALT = vec3(0.38, 0.38, 0.39);
  vec3 uYardCol(float U) { return mix(vec3(0.58, 0.51, 0.42), vec3(0.62, 0.60, 0.57), smoothstep(0.4, 0.85, U)); }

  // Yards y, streets s whose surface is asphalt for share q (else country lanes: tar under trees,
  // with 40% of the ground showing through): A = (B, T).
  vec4 uGroundParts(vec3 yardCol, float y, float s, float q) {
    float T = (1.0 - y) * (1.0 - s) + s * 0.4 * (1.0 - q);
    vec3 B = yardCol * y * (1.0 - s) + s * mix(0.6 * U_LANE, U_ASPHALT, q);
    return vec4(B, T);
  }

  // The expected cover of an area of urbanity U (the far view).
  void uMeanParts(float U, out vec4 A, out vec4 R) {
    vec4 m = uUrbanMean(U);
    float y = m.w * mix(0.35, 0.8, smoothstep(0.4, 0.85, U)) * smoothstep(0.04, 0.25, U);
    A = uGroundParts(uYardCol(U), y, m.y, smoothstep(0.15, 0.6, U));
    vec3 rc = mix(vec3(0.56, 0.29, 0.19), vec3(0.62, 0.60, 0.56), m.z);
    R = vec4(rc * m.x, m.x);
  }

  // Full detail at p for a pixel (or cache texel) with ground footprint gX, gY (px = its size).
  void uDetailParts(vec2 p, vec2 gX, vec2 gY, float px, out vec4 A, out vec4 R) {
    float minAbs;
    vec4 smp = uSample(p, minAbs);
    float U = smp.x;
    uMeanParts(U, A, R);
    if (U < 0.004) return;
    vec4 m = uUrbanMean(U);
    float yardGate = smoothstep(0.04, 0.25, U);
    float yardMean = m.w * mix(0.35, 0.8, smoothstep(0.4, 0.85, U)) * yardGate;
    float hwbM = mix(3.0, 4.6, smoothstep(0.1, 0.6, U));
    float borderM = mix(0.35, 0.75, smoothstep(0.03, 0.3, U)) * 4.0 * hwbM / ${URBAN_DISTRICT_M.toFixed(1)} * smoothstep(0.004, 0.02, U);

    bool lotDetail = px < 8.0;
    UPx o = uUrbanPixel(p, smp, minAbs, lotDetail);
    vec2 ex = o.dirX;
    vec2 ez = vec2(-ex.y, ex.x);
    float wX = uWidth(ex, gX, gY);
    float wZ = uWidth(ez, gX, gY);
    float wB = uWidth(o.nB, gX, gY);
    // Grid streets and the collector along the district border, as lines.
    float st = 0.0;
    if (o.keep.x > 0.5) st = max(st, uBand(o.ab.x, o.hw, wX));
    if (o.keep.y > 0.5) st = max(st, uBand(o.S.x - o.ab.x, o.hw, wX));
    if (o.keep.z > 0.5) st = max(st, uBand(o.ab.y, o.hw, wZ));
    if (o.keep.w > 0.5) st = max(st, uBand(o.S.y - o.ab.y, o.hw, wZ));
    st *= o.gate;
    float bst = o.hwb > 0.0 ? uBand(o.border, o.hwb, wB) * o.gate : 0.0;
    float rBlk = 1.0 - smoothstep(0.2, 0.45, px / min(o.S.x, o.S.y));
    float rBor = 1.0 - smoothstep(0.2, 0.45, px / ${URBAN_DISTRICT_M.toFixed(1)});
    float stGrid = mix(max(m.y - borderM, 0.0), st, rBlk);
    float stBor = mix(borderM, bst, rBor);
    float stD = 1.0 - (1.0 - stGrid) * (1.0 - stBor);
    float q = 1.0 - (1.0 - smoothstep(0.3, 0.7, o.Ud)) * (1.0 - stBor / max(stD, 1e-3));

    // Lot rows: mean building cover across the row while lots are unresolved, single lots after.
    float wA = o.side == 4 ? wB : o.side >= 2 ? wZ : wX;
    float wT = o.side == 4 ? uWidth(vec2(-o.nB.y, o.nB.x), gX, gY) : o.side >= 2 ? wX : wZ;
    float front = o.region >= 2 ? 1.0 : 0.0;
    float hwRow = o.side == 4 ? o.hwb : o.hw;
    float sbM = hwRow + mix(4.0, 1.75, o.core);
    float dpM = mix(11.0, o.D - sbM - 1.5, o.core);
    float gM = mix(3.0, 1.3, o.core);
    float rowRoof = front * min(1.0, uOccupancy(U) * o.dens) * ((o.Lw - 2.0 * gM) / o.Lw) * uSpan(o.across, sbM, sbM + dpM, wA);
    rowRoof *= step(${(URBAN_ARTERIAL_HW_M + 3).toFixed(1)}, abs(o.sdf));
    float roof = rowRoof;
    vec3 rc = mix(vec3(0.56, 0.29, 0.19), vec3(0.62, 0.60, 0.56), mix(0.12, 0.7, smoothstep(0.25, 0.75, o.Ud)));
    if (lotDetail && o.region >= 2) {
      float rLot = 1.0 - smoothstep(0.15, 0.35, px / o.Lw);
      float bld = o.built * uSpan(o.across, o.shape.x, o.shape.x + o.shape.y, wA) * uSpan(o.t, o.shape.z, o.Lw - o.shape.z, wT);
      roof = mix(rowRoof, bld, rLot);
      float hc = uLotHash(o.lot, 6);
      bool flatRoof = uLotHash(o.lot, 4) < mix(0.12, 0.7, smoothstep(0.25, 0.75, o.Ud));
      rc = mix(rc, flatRoof ? uFlatRoof(hc) : uTileRoof(hc), rLot);
    }
    // Yards: packed earth or paving in the lot rows, gardens (mostly the vegetation) behind them.
    float yard = (o.region >= 2 ? mix(0.35, 0.85, o.core) : o.region == 1 ? 0.12 : 0.0) * o.gate * yardGate;
    yard = mix(yardMean, yard, rBlk);
    roof = mix(m.x, roof, rBlk);
    A = uGroundParts(uYardCol(U), yard, stD, q);
    R = vec4(rc * roof, roof);
  }
  // --- street lights ------------------------------------------------------------------------
  // Lamps every U_LAMP_M along lit streets, hung over the road: a bright head and a soft pool of
  // light on the road. Lit: most town streets and collectors, few country lanes; mostly sodium,
  // about a quarter white LED. Returned as (glow, white glow); glow peaks at ~2 on a lamp head.
  const float U_LAMP_M = 32.0;

  // One lamp at offset d (m) seen through a texel w wide: pool and head as gaussians, each widened
  // by the texel's box (variance w^2 / 12), energy kept, so distant lamps average out correctly.
  float uLampGlow(vec2 d, float w) {
    float r2 = dot(d, d);
    float wb = w * w / 12.0;
    float sPool = 36.0 + wb;
    float sHead = 0.36 + wb;
    return 0.35 * 36.0 / sPool * exp(-0.5 * r2 / sPool) + 1.6 * 0.36 / sHead * exp(-0.5 * r2 / sHead);
  }

  // Lamps along one street: across = distance from its centreline, along = position on it; the
  // lamp nearest along is kept or not by its hash (keyed by the street's ids a, b).
  vec2 uLampRow(float across, float along, int a, int b, float lit, float w) {
    float k = floor(along / U_LAMP_M + 0.5);
    int kid = int(k) + 4096;
    float h = uh(a, b, kid);
    if (h >= lit) return vec2(0.0);
    float g = uLampGlow(vec2(across, along - k * U_LAMP_M), w);
    return vec2(g, g * step(h, 0.25 * lit));
  }

  // Share of the lamps that are lit on grid streets of a district of urbanity Ud, and on collectors.
  float uLitGrid(float Ud) { return 0.9 * smoothstep(0.12, 0.45, Ud); }
  float uLitCollector(float Ud) { return 0.1 + 0.8 * smoothstep(0.05, 0.3, Ud); }

  vec2 uStreetLights(vec2 p, float w) {
    float minAbs;
    vec4 smp = uSample(p, minAbs);
    if (smp.x < 0.004) return vec2(0.0);
    UPx o = uUrbanPixel(p, smp, minAbs, false);
    if (o.region == 0) return vec2(0.0);
    vec2 g = vec2(0.0);
    float lg = uLitGrid(o.Ud) * o.gate;
    if (lg > 0.0 && o.keep != vec4(0.0)) {
      int i = int(floor(o.l.x / o.S.x));
      int j = int(floor(o.l.y / o.S.y));
      int ax = (o.cell.x + ${1024}) * 128 + 64;
      int by = (o.cell.y + ${1024}) * 4;
      // Grid lines i, i + 1 run along local z; lines j, j + 1 along local x.
      if (o.keep.x > 0.5) g += uLampRow(o.ab.x, o.l.y, ax + i, by + 8, lg, w);
      if (o.keep.y > 0.5) g += uLampRow(o.S.x - o.ab.x, o.l.y, ax + i + 1, by + 8, lg, w);
      if (o.keep.z > 0.5) g += uLampRow(o.ab.y, o.l.x, ax + j, by + 9, lg, w);
      if (o.keep.w > 0.5) g += uLampRow(o.S.y - o.ab.y, o.l.x, ax + j + 1, by + 9, lg, w);
    }
    if (o.hwb > 0.0) g += uLampRow(o.border, o.tB, (o.lo.x + ${1024}) * 4 + 3, (o.lo.y + ${1024}) * 4 + 10, uLitCollector(o.Ud) * o.gate, w);
    return g;
  }

  // The same on average over an area of urbanity U (the far view): lamp energy per metre of lit
  // street, spread over the street area (uUrbanMean's street share).
  vec2 uMeanLights(float U) {
    vec4 m = uUrbanMean(U);
    float hw = mix(2.6, 3.6, smoothstep(0.1, 0.6, U));
    float perArea = (0.35 * 6.2832 * 36.0 + 1.6 * 6.2832 * 0.36) / (U_LAMP_M * 2.0 * hw);
    float g = m.y * perArea * mix(uLitCollector(U), uLitGrid(U), 0.8);
    return vec2(g, 0.25 * g);
  }
`;
