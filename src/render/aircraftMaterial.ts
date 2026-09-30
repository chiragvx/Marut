/**
 * src/render/aircraftMaterial.ts — shaders for the aircraft mesh (meshAircraftRenderer.ts).
 *
 * The body shader picks each surface's finish from the model's part code (aircraftModels/
 * meshBuild.ts PART): IAF Mk1A grey with a light radome, gold-tinted canopy glass, heat-tinted
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
  varying vec3 vNormalL;
  void main() {
    vec3 p = position;
    vNormalL = normal;
    if (aNoz > 0.0) {
      // Petals swing open about their hinge ring: up to +30% radius at the exit.
      vec2 c = vec2(uNozzleY, 0.0);
      p.yz = c + (p.yz - c) * (1.0 + uNozzle * 0.3 * aNoz);
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
    vNormalW = normalize(mat3(modelMatrix) * nl);
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
  /** Markings and panel lines (tejasLivery.ts): 4 tiles, starboard | port over top | bottom. */
  uniform sampler2D uLivery;
  uniform vec4 uLiveryMap; // x0, x1, y0, y1 (body m)
  uniform float uLiveryHalfZ;
  uniform float uLiveryOn;
  /** 1 when the camera is inside this aircraft's canopy (the 3D cockpit): skip the exterior canopy frame. */
  uniform float uInterior;
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
    if (part == 22) {
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
      // Canopy glass (gold-tinted): the dark cockpit behind it, sky reflections, a sharp sun glint.
      float fres = pow(1.0 - max(dot(n, V), 0.0), 4.0);
      vec3 env = atmSky(reflect(-V, n)) * vec3(1.0, 0.9, 0.62);
      vec3 inside = vec3(0.035, 0.04, 0.045);
      col = inside * (uAtmAmbSky + uAtmSunCol * 0.3);
      vec3 L = normalize(uAtmSunDir);
      float spec = pow(max(dot(n, normalize(L + V)), 0.0), 400.0) * 3.0 * cloudShadow(vWorld);
      col += env * (0.2 + 0.7 * fres) + uAtmSunCol * spec * vec3(1.0, 0.92, 0.7);
      gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
      return;
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
    } else if (part >= 10 && part <= 12) {
      // Navigation lights (uLightState.x).
      vec3 lc = part == 10 ? vec3(1.0, 0.12, 0.08) : part == 11 ? vec3(0.1, 1.0, 0.3) : vec3(1.0);
      col = lc * 0.3;
      glow = lc * uLightState.x * (0.6 + 2.5 * uAtmLights);
    } else if (part == 19) {
      // Formation strips (uLightState.w): dim green electroluminescent.
      col = vec3(0.16, 0.2, 0.17);
      glow = vec3(0.35, 1.0, 0.45) * uLightState.w * (0.25 + 1.2 * uAtmLights);
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
    col = col * (amb + uAtmSunCol * diff) + uAtmSunCol * spec + env * refl * (0.4 + 3.0 * fres) + glow;
    // FLIR: a warm airframe; the nozzle and engine white-hot, more so with power.
    if (uAtmThermal > 0.5) col = vec3(part == 6 || part == 7 ? 1.6 : 0.8 + 0.3 * uThrottle);
    gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
  }
`;

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

export function createAircraftBodyMaterial(shared: AircraftSharedUniforms, nozzleAxisY: number, livery?: AircraftLivery): THREE.ShaderMaterial & { uniforms: AircraftBodyUniforms } {
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
