/**
 * src/render/aircraftMaterial.ts — shaders for the aircraft mesh (meshAircraftRenderer.ts).
 *
 * The body shader picks each surface's finish from the model's part code (aircraftModels/
 * meshBuild.ts PART): IAF Mk1A grey with a light radome, sapphire-tinted canopy glass, heat-tinted
 * nozzle petals and the engine's glow; markings and panel lines come from the livery texture
 * (aircraftModels/tejasLivery.ts), projected by the rest-pose normal. Hostile aircraft are a
 * darker grey with the panel lines only. Lit like the world (sun, sky ambient, cloud and sun shadows, haze), with a semi-gloss
 * highlight and sky reflection. The nozzle petals open with uNozzle (vertex shader).
 *
 * The afterburner flame is a separate additive material.
 */
import * as THREE from 'three';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';
import { CLOUD_SHADOW_GLSL, getCloudShadowUniforms } from './clouds';
import { SUN_SHADOW_GLSL, getSunShadowUniforms } from './sunShadows';

/** Uniforms shared by every aircraft (same objects in every material). */
export interface AircraftSharedUniforms {
  [name: string]: { value: unknown };
  /** Absolute world position of render-space zero (the floating origin). */
  uOrigin: { value: THREE.Vector3 };
  /** Camera position in render space, for the Earth-curvature drop. */
  uCamRel: { value: THREE.Vector3 };
  uTime: { value: number };
  /** Overhead lamplight on the airframe (a hangar's lamps, the loadout view), linear RGB; 0 outdoors. */
  uFill: { value: THREE.Vector3 };
}

export function createAircraftSharedUniforms(): AircraftSharedUniforms {
  return { uOrigin: { value: new THREE.Vector3() }, uCamRel: { value: new THREE.Vector3() }, uTime: { value: 0 }, uFill: { value: new THREE.Vector3() } };
}

const VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute float aPart;
  attribute float aNoz;
  /** Imported (textured) models: tangent (xyz) and handedness (w) for the normal map. */
  attribute vec4 aTangent;
  uniform vec3 uOrigin;
  uniform vec3 uCamRel;
  uniform float uNozzle;
  uniform float uNozzleY;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vPos;
  varying float vPart;
  varying float vNoz;
  varying vec3 vNormalL;
  varying vec2 vUv;
  varying vec4 vTangentW;
  varying vec3 vViewL;
  void main() {
    vec3 p = position;
    vNormalL = normal;
    vUv = uv;
    if (aNoz > 0.0) {
      // Petals swing open about their hinge ring: up to +15% radius at the exit.
      vec2 c = vec2(uNozzleY, 0.0);
      p.yz = c + (p.yz - c) * (1.0 + uNozzle * 0.15 * aNoz);
    }
    vec4 lp = vec4(p, 1.0);
    vec3 nl = normal;
    #ifdef USE_INSTANCING
      // Stores: one instanced mesh per store type (rigid transforms).
      lp = instanceMatrix * lp;
      nl = mat3(instanceMatrix) * nl;
    #endif
    vec4 wr = modelMatrix * lp;
    vWorld = wr.xyz + uOrigin;
    // Towards the camera, in the model's own frame (the navigation lights' arcs).
    vViewL = transpose(mat3(modelMatrix)) * (cameraPosition - wr.xyz);
    vNormalW = normalize(mat3(modelMatrix) * nl);
    vTangentW = vec4(mat3(modelMatrix) * aTangent.xyz, aTangent.w);
    vPos = position;
    vPart = aPart;
    vNoz = aNoz;
    vec2 d = wr.xz - uCamRel.xz;
    wr.y -= dot(d, d) * uAtmCurv;
    gl_Position = projectionMatrix * viewMatrix * wr;
  }
`;

const FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  // The key light (sun, or moon at night) for the cloud-shadow lookup.
  #define uSunDir uAtmSunDir
  ${CLOUD_SHADOW_GLSL}
  ${SUN_SHADOW_GLSL}
  uniform float uTeam;
  /** Exterior lights: x nav, y strobe flash (0..1), z landing, w formation. */
  uniform vec4 uLightState;
  uniform float uThrottle;
  uniform float uAB;
  uniform float uNozzleY;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vPos;
  varying float vPart;
  varying float vNoz;
  varying vec3 vNormalL;
  varying vec3 vViewL;
  /** Markings and panel lines (tejasLivery.ts): 4 tiles, starboard | port over top | bottom. */
  uniform vec3 uFill;
  uniform sampler2D uLivery;
  uniform vec4 uLiveryMap; // x0, x1, y0, y1 (body m)
  uniform float uLiveryHalfZ;
  uniform float uLiveryOn;
  /** 1 when the camera is inside this aircraft's canopy (the 3D cockpit): skip the exterior canopy frame. */
  uniform float uInterior;
  /** Imported models (PART.textured / texturedCockpit): base colour (sRGB), metal-roughness (G rough,
   *  B metal, glTF), tangent-space normal map; uHotX = body x aft of which the airframe is engine-hot (FLIR). */
  uniform sampler2D uBaseMap;
  uniform sampler2D uMrMap;
  uniform sampler2D uNormalMap;
  uniform float uHotX;
  /** Exterior lamps, body frame: left (red) and right (green) navigation, tail (white), left and
   *  right strobes. They light the airframe round them (uLightState: x nav, y strobe flash). */
  uniform vec3 uLampNavL;
  uniform vec3 uLampNavR;
  uniform vec3 uLampTail;
  uniform vec3 uLampStrobeL;
  uniform vec3 uLampStrobeR;
  /** Imported models: the navigation lights' lens, the wingtip's own leading-edge fairing, as a
   *  triangle in the wing's plane (body x, |z|) on the starboard tip (mirrored to port); w: on. */
  uniform vec2 uNavLensA;
  uniform vec2 uNavLensB;
  uniform vec2 uNavLensC;
  uniform float uNavLensOn;
  varying vec2 vUv;
  // A navigation light seen from the eye: 1 inside its sector (axis, cos of the half-angle), which
  // is horizontal (in the wing's plane): from above or below, every lamp shows.
  float navArc(vec3 axis, float cosHalf) {
    vec3 vh = vec3(vViewL.x, 0.0, vViewL.z);
    float h = length(vh);
    float inArc = h < 1e-4 * length(vViewL) ? 1.0 : smoothstep(cosHalf - 0.06, cosHalf + 0.04, dot(vh / h, axis));
    return max(inArc, smoothstep(0.45, 0.8, abs(normalize(vViewL).y)));
  }
  // Inside the triangle abc (soft-edged over a few mm): 0..1.
  float triMask(vec2 p, vec2 a, vec2 b, vec2 c) {
    float s = sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    float d = 1e9;
    vec2 v[3];
    v[0] = a; v[1] = b; v[2] = c;
    for (int i = 0; i < 3; i++) {
      vec2 e = v[(i + 1) % 3] - v[i];
      vec2 q = p - v[i];
      d = min(d, s * (e.x * q.y - e.y * q.x) / max(length(e), 1e-6));
    }
    return smoothstep(-0.002, 0.004, d);
  }
  // Light from a small lamp at body point lp on the surface at body point p with body normal nb:
  // inverse-square past radius r0 (soft inside it), half-Lambert so the lens's own mounting glows.
  vec3 lampLight(vec3 lp, vec3 p, vec3 nb, vec3 c, float r0) {
    vec3 d = lp - p;
    float d2 = dot(d, d);
    float ndl = dot(nb, d * inversesqrt(max(d2, 1e-6)));
    return c * clamp(ndl * 0.75 + 0.25, 0.0, 1.0) / (1.0 + d2 / (r0 * r0));
  }
  varying vec4 vTangentW;
  vec4 livery(vec3 p, vec3 nl) {
    float u = (p.x - uLiveryMap.x) / (uLiveryMap.y - uLiveryMap.x);
    vec2 uv;
    if (abs(nl.z) > 0.5) {
      float v = (p.y - uLiveryMap.z) / (uLiveryMap.w - uLiveryMap.z);
      // Port tile is painted mirrored (nose on the left) so its text reads the right way.
      uv = nl.z > 0.0 ? vec2(u * 0.5, 0.5 + v * 0.5) : vec2(0.5 + (1.0 - u) * 0.5, 0.5 + v * 0.5);
    } else {
      float v = (p.z + uLiveryHalfZ) / (2.0 * uLiveryHalfZ);
      uv = vec2((nl.y >= 0.0 ? 0.0 : 0.5) + u * 0.5, v * 0.5);
    }
    return texture2D(uLivery, uv);
  }

  void main() {
    int part = int(vPart + 0.5);
    vec3 n = normalize(vNormalW);
    vec3 V = normalize(uAtmCamPos - vWorld);
    vec3 p = vPos;
    bool friendly = uTeam < 0.5;
    vec3 paint = friendly ? vec3(0.52, 0.56, 0.595) : vec3(0.4, 0.43, 0.45);
    vec3 col = paint;
    float ks = 0.18;
    float shin = 30.0;
    float refl = 0.05;
    vec3 glow = vec3(0.0);

    bool painted = part == 0 || part == 2 || part == 3 || part == 4 || part == 22 || part == 25;
    bool textured = part == 27 || part == 28;
    if (textured) {
      // Imported model: its own paint, markings, panel lines and normal map.
      if (part == 28 && uInterior > 0.5) discard;
      vec3 base = pow(texture2D(uBaseMap, vUv).rgb, vec3(2.2));
      vec3 mr = texture2D(uMrMap, vUv).rgb;
      vec3 tn = texture2D(uNormalMap, vUv).rgb * 2.0 - 1.0;
      vec3 t = vTangentW.xyz - n * dot(n, vTangentW.xyz);
      if (dot(t, t) > 1e-8) {
        t = normalize(t);
        vec3 b = cross(n, t) * (vTangentW.w < 0.0 ? -1.0 : 1.0);
        n = normalize(t * tn.x + b * tn.y + n * tn.z);
      }
      if (friendly) {
        col = base;
      } else {
        // Hostile: plain dark grey; keep the panel lines, drop coloured markings.
        float lum = dot(base, vec3(0.2126, 0.7152, 0.0722));
        float sat = max(max(base.r, base.g), base.b) - min(min(base.r, base.g), base.b);
        col = paint * (sat > 0.08 ? 1.0 : clamp(lum / 0.3, 0.0, 1.25));
      }
      ks = mix(0.4, 0.04, mr.g);
      shin = mix(90.0, 10.0, mr.g);
      refl = mix(0.03, 0.3, mr.b) * (1.0 - 0.7 * mr.g);
      // The wingtips' leading-edge fairings are the navigation lights' lenses: red port, green
      // starboard, glossy coloured glass when off, lit inside their sectors.
      if (uNavLensOn > 0.5 && part == 27 && abs(vPos.z) > 2.5) {
        float m = triMask(vec2(vPos.x, abs(vPos.z)), uNavLensA, uNavLensB, uNavLensC);
        if (m > 0.0) {
          bool port = vPos.z < 0.0;
          vec3 lc = port ? vec3(1.0, 0.12, 0.08) : vec3(0.1, 1.0, 0.3);
          col = mix(col, lc * 0.35, m);
          ks = mix(ks, 1.0, m);
          shin = mix(shin, 120.0, m);
          refl = mix(refl, 0.3, m);
          glow = lc * uLightState.x * (0.6 + 2.5 * uAtmLights) * navArc(vec3(0.574, 0.0, port ? -0.819 : 0.819), 0.5) * m;
        }
      }
    } else if (part == 22) {
      // Radome: lighter grey dielectric.
      col = friendly ? vec3(0.74, 0.76, 0.76) : vec3(0.5, 0.52, 0.53);
      ks = 0.12;
    } else if (part == 13) {
      col = paint * 0.95;
    } else if (part == 23) {
      if (uInterior > 0.5) discard;
      // Canopy and windscreen frames: painted, a little darker than the airframe.
      col = paint * 0.72;
      ks = 0.1;
    } else if (part == 24) {
      // Antennas and fairings: dark grey dielectric.
      col = vec3(0.16, 0.17, 0.18);
      ks = 0.06;
    } else if (part == 1) {
      // Canopy glass: polished, coated acrylic with a very slight sapphire cast. From outside it
      // reads as opaque (the dark cockpit behind it, deep blue-black), and what you see is its
      // reflection: the sky, mirror-sharp, stronger towards grazing angles (Fresnel), the sun as a
      // sharp glint with a softer sheen round it. The tint is on the glass itself (what comes
      // through it) and, less, on the reflection (the coating), so it never turns cartoon blue.
      float ndv = max(dot(n, V), 0.0);
      float fres = 0.22 + 0.78 * pow(1.0 - ndv, 4.0);
      vec3 sapphire = vec3(0.84, 0.91, 1.0);
      vec3 env = atmSky(reflect(-V, n)) * sapphire;
      vec3 inside = vec3(0.026, 0.034, 0.05);
      col = inside * (uAtmAmbSky + uAtmSunCol * 0.3);
      vec3 L = normalize(uAtmSunDir);
      float nh = max(dot(n, normalize(L + V)), 0.0);
      float spec = (pow(nh, 900.0) * 4.0 + pow(nh, 70.0) * 0.18) * cloudShadow(vWorld);
      col += env * fres + uAtmSunCol * spec * mix(vec3(1.0), sapphire, 0.4);
      gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
      return;
    } else if (part == 5) {
      col = vec3(0.04, 0.045, 0.05);
      ks = 0.02;
      refl = 0.0;
    } else if (part == 6) {
      // Bare metal. Nozzle petals (vNoz > 0, 0 at the hinge .. 1 at the exit): titanium, heat-tinted
      // straw -> bronze -> blue towards the exit, 16 overlapping petals with dark seams and streaks.
      col = vec3(0.36, 0.34, 0.31);
      ks = 0.4;
      shin = 45.0;
      if (vNoz > 0.0) {
        float a = atan(p.z, p.y - uNozzleY) / 6.2831853 * 16.0;
        float f = fract(a);
        vec3 ti = vec3(0.46, 0.45, 0.43);
        vec3 bronze = vec3(0.42, 0.33, 0.22);
        vec3 blue = vec3(0.24, 0.25, 0.34);
        col = vNoz < 0.55 ? mix(ti, bronze, vNoz / 0.55) : mix(bronze, blue, (vNoz - 0.55) / 0.45);
        // Each petal overlaps the next: brighter at its leading edge, a dark seam where it tucks under.
        col *= 0.8 + 0.2 * f;
        col *= mix(0.45, 1.0, smoothstep(0.0, 0.06, f) * smoothstep(1.0, 0.94, f));
        col *= 0.93 + 0.07 * sin(a * 23.0 + vNoz * 9.0) * sin(a * 7.0);
        // Soot at the lip.
        col *= 1.0 - 0.45 * smoothstep(0.82, 1.0, vNoz);
        ks = 0.55;
        shin = 30.0;
        refl = 0.12;
      }
    } else if (part == 7) {
      // Engine interior (vNoz 1 at the exit .. 0 deep inside): a ribbed liner and, at the back, the
      // turbine face behind the flameholder rings; dull red with power, white-hot in afterburner.
      float depth = 1.0 - vNoz;
      float r = length(vec2(p.y - uNozzleY, p.z));
      bool face = abs(normalize(vNormalL).x) > 0.9;
      float rib = face ? 0.0 : smoothstep(0.75, 0.95, abs(fract(p.x * 8.0) - 0.5) * 2.0);
      float ring = 0.0;
      if (face) {
        float ang = atan(p.z, p.y - uNozzleY) / 6.2831853 * 28.0;
        float spoke = smoothstep(0.8, 0.95, abs(fract(ang) - 0.5) * 2.0);
        ring = max(smoothstep(0.85, 0.97, abs(fract(r * 9.0) - 0.5) * 2.0), spoke * step(0.06, r));
      }
      col = vec3(0.2, 0.19, 0.18) * (1.0 - 0.7 * depth) * (1.0 - 0.6 * rib);
      if (face) col = vec3(0.05) * (1.0 + 1.5 * ring);
      ks = 0.08;
      shin = 20.0;
      refl = 0.0;
      float heat = mix(0.05 + 0.25 * uThrottle * uThrottle, 1.0, uAB);
      vec3 dull = vec3(1.0, 0.33, 0.08) * heat * pow(depth, 1.5) * (0.5 + 0.8 * uAtmLights);
      vec3 hotc = mix(vec3(1.0, 0.5, 0.16), vec3(1.0, 0.9, 0.68), depth) * uAB * (0.35 + 0.9 * depth);
      glow = (dull + hotc) * (1.0 - 0.55 * rib) * (1.0 - 0.7 * ring);
    } else if (part == 8) {
      col = vec3(0.8, 0.8, 0.78);
      ks = 0.25;
    } else if (part == 9) {
      col = vec3(0.06);
      ks = 0.05;
      shin = 8.0;
      refl = 0.0;
    } else if (part == 14) {
      // Missile body.
      col = vec3(0.8, 0.81, 0.8);
      ks = 0.22;
    } else if (part == 15) {
      // IR seeker dome: dark glass.
      col = vec3(0.05, 0.06, 0.07);
      ks = 1.0;
      shin = 120.0;
      refl = 0.3;
    } else if (part == 16) {
      col = vec3(0.85, 0.66, 0.1);
    } else if (part == 17) {
      col = vec3(0.45, 0.3, 0.16);
    } else if (part == 18) {
      // Radar missile radome.
      col = vec3(0.5, 0.51, 0.5);
      ks = 0.12;
    } else if (part == 26) {
      // Bombs: olive drab paint.
      col = vec3(0.26, 0.28, 0.19);
      ks = 0.1;
    } else if (part == 29) {
      // Store fittings: dark gunmetal, a little worn.
      col = vec3(0.17, 0.175, 0.18);
      ks = 0.35;
      shin = 40.0;
    } else if (part == 30) {
      // Store paint: medium grey.
      col = vec3(0.46, 0.48, 0.49);
      ks = 0.14;
    } else if (part >= 10 && part <= 12) {
      // Navigation lights (uLightState.x).
      vec3 lc = part == 10 ? vec3(1.0, 0.12, 0.08) : part == 11 ? vec3(0.1, 1.0, 0.3) : vec3(1.0);
      col = lc * 0.3;
      // Seen lit only from inside the light's sector (red/green: from dead ahead round to 110 deg
      // out to their side; white: 140 deg astern), as the glow (aircraftLights.ts NAV_ARC_*): outside
      // it the lamp is behind its shield.
      vec3 arcAxis = part == 10 ? vec3(0.574, 0.0, -0.819) : part == 11 ? vec3(0.574, 0.0, 0.819) : vec3(-1.0, 0.0, 0.0);
      glow = lc * uLightState.x * (0.6 + 2.5 * uAtmLights) * navArc(arcAxis, part == 12 ? 0.309 : 0.5);
    } else if (part == 19) {
      // Formation strips (uLightState.w): electroluminescent panels, pale yellow-green when off; lit,
      // a soft green that is barely noticeable by day and plain at night (kept dim for night vision
      // goggles in real life, so never dazzling).
      col = vec3(0.4, 0.45, 0.33);
      ks = 0.25;
      glow = vec3(0.55, 1.0, 0.4) * uLightState.w * (0.04 + 0.4 * uAtmLights);
    } else if (part == 20) {
      // Anti-collision strobes (uLightState.y = the flash).
      col = vec3(0.55);
      glow = vec3(1.0, 0.97, 0.92) * uLightState.y * 6.0;
    } else if (part == 21) {
      // Landing/taxi light (uLightState.z).
      col = vec3(0.5);
      glow = vec3(1.0, 0.95, 0.85) * uLightState.z * 5.0;
    }

    if (painted && uLiveryOn > 0.5) {
      vec4 lv = livery(vPos, normalize(vNormalL));
      // Hostile aircraft carry no markings: only the (near-black) panel lines.
      float isLine = 1.0 - step(0.08, max(max(lv.r, lv.g), lv.b));
      float k = friendly ? lv.a : lv.a * isLine;
      col = mix(col, lv.rgb, k);
    }
    vec3 L = normalize(uAtmSunDir);
    float ndl = dot(n, L);
    float sh = cloudShadow(vWorld) * sunShadow(vWorld, ndl);
    float diff = max(ndl, 0.0) * sh;
    vec3 amb = mix(uAtmAmbGround, uAtmAmbSky, 0.5 + 0.5 * n.y);
    float spec = ndl > 0.0 ? pow(max(dot(n, normalize(L + V)), 0.0), shin) * ks * sh : 0.0;
    float fres = pow(1.0 - max(dot(n, V), 0.0), 5.0);
    vec3 env = atmSky(reflect(-V, n));
    // The aircraft's own lamps on its skin: the navigation lights tint the wingtips and fin at night,
    // a strobe flash lights up the wing round it (a little even by day).
    vec3 lamps = vec3(0.0);
    if (uLightState.x + uLightState.y > 0.0) {
      vec3 nb = normalize(vNormalL);
      float navK = uLightState.x * (0.08 + 3.5 * uAtmLights);
      lamps += lampLight(uLampNavL, vPos, nb, vec3(1.0, 0.1, 0.06) * navK, 0.8);
      lamps += lampLight(uLampNavR, vPos, nb, vec3(0.08, 1.0, 0.3) * navK, 0.8);
      lamps += lampLight(uLampTail, vPos, nb, vec3(1.0, 0.97, 0.9) * navK * 0.7, 0.6);
      float strobeK = uLightState.y * (1.2 + 5.0 * uAtmLights);
      lamps += lampLight(uLampStrobeL, vPos, nb, vec3(1.0, 0.98, 0.95) * strobeK, 1.1);
      lamps += lampLight(uLampStrobeR, vPos, nb, vec3(1.0, 0.98, 0.95) * strobeK, 1.1);
    }
    // Overhead lamps (in a hangar): a soft light from above, and their sheen on the skin.
    vec3 fill = uFill * (0.45 + 0.55 * max(n.y, 0.0));
    vec3 fillSpec = uFill * pow(max(dot(n, normalize(vec3(0.0, 1.0, 0.0) + V)), 0.0), shin) * ks;
    col = col * (amb + uAtmSunCol * diff + lamps + fill) + fillSpec + uAtmSunCol * spec + env * refl * (0.4 + 3.0 * fres) + glow;
    // FLIR: a warm airframe; the nozzle and engine white-hot, more so with power.
    bool hot = part == 6 || part == 7 || (textured && vPos.x < uHotX);
    if (uAtmThermal > 0.5) col = vec3(hot ? 1.6 : 0.8 + 0.3 * uThrottle);
    gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
  }
`;

/** Lamp positions in the model's body frame (the template's LIGHTS). */
export interface AircraftLampPositions {
  navLeft: readonly number[];
  navRight: readonly number[];
  navTail: readonly number[];
  strobeLeft: readonly number[];
  strobeRight: readonly number[];
  /** Imported models: the navigation lights' lens (starboard wingtip fairing) as a triangle of body (x, z) points. */
  navLens?: readonly (readonly number[])[];
}

export interface AircraftBodyUniforms {
  uInterior: { value: number };
  uTeam: { value: number };
  uLightState: { value: THREE.Vector4 };
  uThrottle: { value: number };
  uAB: { value: number };
  uNozzle: { value: number };
}

/** One per aircraft (its own team/engine/nozzle state); the program itself is shared. */
/** The airframe's livery texture and how body positions map onto it (tejasLivery.ts). */
export interface AircraftLivery {
  texture: THREE.Texture | null;
  map: { x0: number; x1: number; y0: number; y1: number; halfZ: number };
}

/** An imported model's texture set (glTF PBR). */
export interface AircraftTextures {
  base: THREE.Texture;
  metalRough: THREE.Texture;
  normal: THREE.Texture;
}

export function createAircraftBodyMaterial(
  shared: AircraftSharedUniforms,
  nozzleAxisY: number,
  livery?: AircraftLivery,
  textures?: AircraftTextures,
  hotX = -1e9,
  lamps?: AircraftLampPositions,
): THREE.ShaderMaterial & { uniforms: AircraftBodyUniforms } {
  const far = new THREE.Vector3(0, -1e4, 0);
  const lamp = (p: readonly number[] | undefined): THREE.Vector3 => (p ? new THREE.Vector3(p[0]!, p[1]!, p[2]!) : far.clone());
  return new THREE.ShaderMaterial({
    uniforms: {
      ...getAtmosphereUniforms(),
      ...getCloudShadowUniforms(),
      ...getSunShadowUniforms(),
      ...shared,
      uNozzleY: { value: nozzleAxisY },
      uLivery: { value: livery?.texture ?? null },
      uLiveryMap: { value: new THREE.Vector4(livery?.map.x0 ?? 0, livery?.map.x1 ?? 1, livery?.map.y0 ?? 0, livery?.map.y1 ?? 1) },
      uLiveryHalfZ: { value: livery?.map.halfZ ?? 1 },
      uLiveryOn: { value: livery?.texture ? 1 : 0 },
      uInterior: { value: 0 },
      uBaseMap: { value: textures?.base ?? null },
      uMrMap: { value: textures?.metalRough ?? null },
      uNormalMap: { value: textures?.normal ?? null },
      uHotX: { value: hotX },
      uLampNavL: { value: lamp(lamps?.navLeft) },
      uLampNavR: { value: lamp(lamps?.navRight) },
      uLampTail: { value: lamp(lamps?.navTail) },
      uLampStrobeL: { value: lamp(lamps?.strobeLeft) },
      uLampStrobeR: { value: lamp(lamps?.strobeRight) },
      uNavLensA: { value: new THREE.Vector2(lamps?.navLens?.[0]?.[0] ?? 0, lamps?.navLens?.[0]?.[1] ?? 0) },
      uNavLensB: { value: new THREE.Vector2(lamps?.navLens?.[1]?.[0] ?? 0, lamps?.navLens?.[1]?.[1] ?? 0) },
      uNavLensC: { value: new THREE.Vector2(lamps?.navLens?.[2]?.[0] ?? 0, lamps?.navLens?.[2]?.[1] ?? 0) },
      uNavLensOn: { value: lamps?.navLens ? 1 : 0 },
      uTeam: { value: 0 },
      uLightState: { value: new THREE.Vector4(0, 0, 0, 0) },
      uThrottle: { value: 0 },
      uAB: { value: 0 },
      uNozzle: { value: 0 },
    },
    vertexShader: VS,
    fragmentShader: FS,
  }) as THREE.ShaderMaterial & { uniforms: AircraftBodyUniforms };
}

const FLAME_VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute float aU;
  uniform vec3 uOrigin;
  uniform vec3 uCamRel;
  uniform float uTime;
  uniform float uNozzle;
  uniform float uNozzleY;
  uniform float uSeed;
  uniform float uExitX;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vU;
  void main() {
    vec3 p = position;
    // Flicker in length; the root widens with the nozzle.
    float flick = 0.92 + 0.05 * sin(uTime * 31.0 + uSeed) + 0.03 * sin(uTime * 57.0 + uSeed * 2.3);
    float x0 = uExitX;
    p.x = x0 + (p.x - x0) * flick;
    vec2 c = vec2(uNozzleY, 0.0);
    p.yz = c + (p.yz - c) * (1.0 + uNozzle * 0.15 * (1.0 - aU));
    vec4 wr = modelMatrix * vec4(p, 1.0);
    vWorld = wr.xyz + uOrigin;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vU = aU;
    vec2 d = wr.xz - uCamRel.xz;
    wr.y -= dot(d, d) * uAtmCurv;
    gl_Position = projectionMatrix * viewMatrix * wr;
  }
`;

const FLAME_FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  uniform float uAB;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vU;
  void main() {
    vec3 V = normalize(uAtmCamPos - vWorld);
    float edge = pow(abs(dot(normalize(vNormalW), V)), 1.2);
    float u = vU;
    vec3 col = mix(vec3(1.0, 0.93, 0.78), vec3(1.0, 0.45, 0.12), smoothstep(0.05, 0.7, u));
    // Shock diamonds in the first half.
    float diamonds = 0.8 + 0.35 * max(0.0, cos(u * 34.0)) * (1.0 - smoothstep(0.2, 0.55, u));
    float k = pow(1.0 - u, 1.6) * diamonds * edge * uAB * 0.8;
    // Brighter against a dark sky.
    k *= 0.9 + 0.8 * uAtmLights;
    gl_FragColor = vec4(col * k * atmTransmittance(vWorld), 1.0);
  }
`;

export interface AircraftFlameUniforms {
  uAB: { value: number };
  uNozzle: { value: number };
  uSeed: { value: number };
}

export function createAircraftFlameMaterial(shared: AircraftSharedUniforms, nozzleAxisY: number, nozzleExitX: number): THREE.ShaderMaterial & { uniforms: AircraftFlameUniforms } {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...getAtmosphereUniforms(),
      ...shared,
      uNozzleY: { value: nozzleAxisY },
      uExitX: { value: nozzleExitX + 0.05 },
      uAB: { value: 0 },
      uNozzle: { value: 0 },
      uSeed: { value: 0 },
    },
    vertexShader: FLAME_VS,
    fragmentShader: FLAME_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }) as THREE.ShaderMaterial & { uniforms: AircraftFlameUniforms };
}
