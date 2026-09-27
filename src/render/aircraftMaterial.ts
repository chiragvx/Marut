/**
 * src/render/aircraftMaterial.ts — shaders for the aircraft mesh (meshAircraftRenderer.ts).
 *
 * The body shader picks each surface's finish from the model's part code (aircraftModels/
 * tejasTestModel.ts PART) and its rest-pose position: IAF light grey with a darker radome and an
 * anti-glare panel, roundels on the wings and intakes, the tricolour fin flash, gold-tinted canopy
 * glass, heat-tinted nozzle petals, and the engine's glow. Hostile aircraft are a darker grey with
 * no markings. Lit like the world (sun, sky ambient, cloud and sun shadows, haze), with a semi-gloss
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
}

export function createAircraftSharedUniforms(): AircraftSharedUniforms {
  return { uOrigin: { value: new THREE.Vector3() }, uCamRel: { value: new THREE.Vector3() }, uTime: { value: 0 } };
}

const VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute float aPart;
  attribute float aNoz;
  uniform vec3 uOrigin;
  uniform vec3 uCamRel;
  uniform float uNozzle;
  uniform float uNozzleY;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vPos;
  varying float vPart;
  varying float vNoz;
  void main() {
    vec3 p = position;
    if (aNoz > 0.0) {
      // Petals swing open about their hinge ring: up to +30% radius at the exit.
      vec2 c = vec2(uNozzleY, 0.0);
      p.yz = c + (p.yz - c) * (1.0 + uNozzle * 0.3 * aNoz);
    }
    vec4 wr = modelMatrix * vec4(p, 1.0);
    vWorld = wr.xyz + uOrigin;
    vNormalW = normalize(mat3(modelMatrix) * normal);
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
  uniform float uThrottle;
  uniform float uAB;
  uniform float uNozzleY;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vPos;
  varying float vPart;
  varying float vNoz;

  const vec3 SAFFRON = vec3(1.0, 0.52, 0.12);
  const vec3 WHITE = vec3(0.92, 0.92, 0.9);
  const vec3 GREEN = vec3(0.07, 0.45, 0.1);

  // IAF roundel: saffron ring, white ring, green centre; d = distance / radius.
  vec3 roundel(float d, vec3 base) {
    float aa = fwidth(d) * 0.75;
    vec3 c = mix(GREEN, WHITE, smoothstep(0.333 - aa, 0.333 + aa, d));
    c = mix(c, SAFFRON, smoothstep(0.667 - aa, 0.667 + aa, d));
    return mix(c, base, smoothstep(1.0 - aa, 1.0 + aa, d));
  }

  // Thin darker panel seam every 'period' m along coordinate c.
  float seam(float c, float period) {
    // Distance to the nearest seam, m (fades out once a seam is thinner than a pixel).
    float f = abs(fract(c / period + 0.5) - 0.5) * period;
    float aa = fwidth(c);
    return 1.0 - 0.09 * (1.0 - smoothstep(0.005, 0.005 + aa, f)) * (1.0 - smoothstep(0.01, 0.03, aa));
  }

  void main() {
    int part = int(vPart + 0.5);
    vec3 n = normalize(vNormalW);
    vec3 V = normalize(uAtmCamPos - vWorld);
    vec3 p = vPos;
    bool friendly = uTeam < 0.5;
    vec3 paint = friendly ? vec3(0.58, 0.61, 0.645) : vec3(0.42, 0.45, 0.47);
    vec3 col = paint;
    float ks = 0.18;
    float shin = 30.0;
    float refl = 0.05;
    vec3 glow = vec3(0.0);

    if (part == 0 || part == 13) {
      // Fuselage: radome, anti-glare panel ahead of the windscreen, panel seams.
      if (p.x > 4.0) {
        col = paint * 0.66;
        ks = 0.1;
      } else if (p.x > 3.5 && p.y > 0.62 && abs(p.z) < 0.34) {
        col = vec3(0.17, 0.18, 0.19);
        ks = 0.04;
      } else {
        col *= seam(p.x + 0.4, 1.3);
      }
    } else if (part == 1) {
      // Canopy glass (gold-tinted), its frame, and the dorsal spine behind it.
      if (p.x > 1.02 && p.x < 3.6) {
        bool frame = abs(p.x - 3.33) < 0.035 || p.x < 1.1;
        if (frame) {
          col = paint * 0.8;
        } else {
          float fres = pow(1.0 - max(dot(n, V), 0.0), 4.0);
          vec3 env = atmSky(reflect(-V, n)) * vec3(1.0, 0.9, 0.62);
          vec3 inside = vec3(0.035, 0.04, 0.045);
          col = inside * (uAtmAmbSky + uAtmSunCol * 0.3);
          vec3 L = normalize(uAtmSunDir);
          float spec = pow(max(dot(n, normalize(L + V)), 0.0), 400.0) * 3.0 * cloudShadow(vWorld);
          col += env * (0.2 + 0.7 * fres) + uAtmSunCol * spec * vec3(1.0, 0.92, 0.7);
          gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
          return;
        }
      } else {
        col *= seam(p.x + 0.4, 1.3);
      }
    } else if (part == 2) {
      // Intake sides carry the fuselage roundel.
      if (friendly && abs(p.z) > 0.8) col = roundel(length(vec2(p.x - 0.25, p.y - 0.04)) / 0.27, col);
      col *= seam(p.x + 0.4, 1.3);
    } else if (part == 3) {
      // Wings: roundels above and below, outboard.
      if (friendly) col = roundel(length(vec2(p.x + 3.35, abs(p.z) - 2.95)) / 0.44, col);
    } else if (part == 4) {
      // Fin flash: saffron, white, green, forward to aft.
      if (friendly && p.y > 1.55 && p.y < 2.15 && p.x < -4.55 && p.x > -5.4) {
        col = p.x > -4.83 ? SAFFRON : p.x > -5.12 ? WHITE : GREEN;
      }
    } else if (part == 5) {
      col = vec3(0.04, 0.045, 0.05);
      ks = 0.02;
      refl = 0.0;
    } else if (part == 6) {
      // Nozzle: bare metal, heat-blued towards the exit, petal seams.
      col = mix(vec3(0.36, 0.34, 0.31), vec3(0.24, 0.22, 0.27), vNoz);
      float a = atan(p.z, p.y - uNozzleY) / 6.2831853 * 14.0;
      float s = abs(fract(a) - 0.5) * 2.0;
      col *= vNoz > 0.0 ? 0.75 + 0.25 * smoothstep(0.02, 0.12, s) : 1.0;
      ks = 0.4;
      shin = 45.0;
    } else if (part == 7) {
      // Engine interior: dark, glowing with heat; bright in afterburner.
      col = vec3(0.05);
      ks = 0.05;
      refl = 0.0;
      float heat = mix(0.1 * uThrottle * uThrottle, 1.0, uAB);
      float depth = 1.0 - vNoz;
      glow = vec3(1.0, 0.42, 0.12) * heat * (0.35 + 0.65 * depth) * (0.6 + 0.8 * uAtmLights) + vec3(1.0, 0.85, 0.6) * uAB * depth * 0.8;
    } else if (part == 8) {
      col = vec3(0.8, 0.8, 0.78);
      ks = 0.25;
    } else if (part == 9) {
      col = vec3(0.06);
      ks = 0.05;
      shin = 8.0;
      refl = 0.0;
    } else if (part >= 10 && part <= 12) {
      vec3 lc = part == 10 ? vec3(1.0, 0.12, 0.08) : part == 11 ? vec3(0.1, 1.0, 0.3) : vec3(1.0);
      col = lc * 0.4;
      glow = lc * (0.25 + 2.5 * uAtmLights);
    }

    vec3 L = normalize(uAtmSunDir);
    float ndl = dot(n, L);
    float sh = cloudShadow(vWorld) * sunShadow(vWorld, ndl);
    float diff = max(ndl, 0.0) * sh;
    vec3 amb = mix(uAtmAmbGround, uAtmAmbSky, 0.5 + 0.5 * n.y);
    float spec = ndl > 0.0 ? pow(max(dot(n, normalize(L + V)), 0.0), shin) * ks * sh : 0.0;
    float fres = pow(1.0 - max(dot(n, V), 0.0), 5.0);
    vec3 env = atmSky(reflect(-V, n));
    col = col * (amb + uAtmSunCol * diff) + uAtmSunCol * spec + env * refl * (0.4 + 3.0 * fres) + glow;
    gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
  }
`;

export interface AircraftBodyUniforms {
  uTeam: { value: number };
  uThrottle: { value: number };
  uAB: { value: number };
  uNozzle: { value: number };
}

/** One per aircraft (its own team/engine/nozzle state); the program itself is shared. */
export function createAircraftBodyMaterial(shared: AircraftSharedUniforms, nozzleAxisY: number): THREE.ShaderMaterial & { uniforms: AircraftBodyUniforms } {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...getAtmosphereUniforms(),
      ...getCloudShadowUniforms(),
      ...getSunShadowUniforms(),
      ...shared,
      uNozzleY: { value: nozzleAxisY },
      uTeam: { value: 0 },
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
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying float vU;
  void main() {
    vec3 p = position;
    // Flicker in length; the root widens with the nozzle.
    float flick = 0.92 + 0.05 * sin(uTime * 31.0 + uSeed) + 0.03 * sin(uTime * 57.0 + uSeed * 2.3);
    float x0 = ${(-6.57).toFixed(2)};
    p.x = x0 + (p.x - x0) * flick;
    vec2 c = vec2(uNozzleY, 0.0);
    p.yz = c + (p.yz - c) * (1.0 + uNozzle * 0.3 * (1.0 - aU));
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

export function createAircraftFlameMaterial(shared: AircraftSharedUniforms, nozzleAxisY: number): THREE.ShaderMaterial & { uniforms: AircraftFlameUniforms } {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...getAtmosphereUniforms(),
      ...shared,
      uNozzleY: { value: nozzleAxisY },
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
