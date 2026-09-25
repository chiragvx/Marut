/**
 * src/render/atmosphere.ts — aerial perspective, sky colour and earth curvature, shared by every
 * world-geometry shader (terrain, far ground, roads, trees, buildings, clouds, sky).
 *
 * Haze is an exponential height fog: extinction sigma(h) = sigma0 * exp(-(h - h0) / H) near the
 * ground, plus a small clear-air term everywhere. The optical depth along the view ray is
 * integrated analytically, so visibility is long from altitude and shorter low down, and there is
 * no hard "fog wall". In-scattered light is the haze colour, brightened and warmed towards the
 * sun (a forward-scattering Mie lobe).
 *
 * Earth curvature is visual only (physics stays flat): world-geometry vertex shaders drop each
 * vertex by d^2 / 2R, d being its horizontal distance from the camera, so the horizon sits below
 * eye level from altitude and distant terrain curves away, as it does for real.
 *
 * One uniform object is shared by all materials; src/render/scene.ts updates it every frame
 * (camera position) and per theatre (colours and haze).
 */

import * as THREE from 'three';
import type { Vec3Like } from '../contracts/core';
import type { SceneEnvironment } from '../contracts/render';

export const EARTH_RADIUS_M = 6371000;

export interface AtmosphereUniforms {
  [name: string]: { value: unknown };
  uAtmCamPos: { value: THREE.Vector3 };
  uAtmSunDir: { value: THREE.Vector3 };
  /** Haze colour at the horizon, away from the sun. */
  uAtmHaze: { value: THREE.Color };
  /** Colour of sunlight scattered forward through the haze. */
  uAtmSunGlow: { value: THREE.Color };
  uAtmZenith: { value: THREE.Color };
  /** x = sigma0 (1/m) at ground level, y = scale height H (m), z = ground level h0 (m), w = clear-air sigma (1/m). */
  uAtmHazeParams: { value: THREE.Vector4 };
  /** 1 / (2 R): vertical drop per m^2 of horizontal distance. */
  uAtmCurv: { value: number };
}

let shared: AtmosphereUniforms | undefined;

export function getAtmosphereUniforms(): AtmosphereUniforms {
  if (!shared) {
    shared = {
      uAtmCamPos: { value: new THREE.Vector3() },
      uAtmSunDir: { value: new THREE.Vector3(0.4, 0.7, -0.3).normalize() },
      uAtmHaze: { value: new THREE.Color(0xbcd4e8) },
      uAtmSunGlow: { value: new THREE.Color(0xfff0d0) },
      uAtmZenith: { value: new THREE.Color(0x3a6ea8) },
      uAtmHazeParams: { value: new THREE.Vector4(1e-4, 1200, 0, 1.3e-5) },
      uAtmCurv: { value: 1 / (2 * EARTH_RADIUS_M) },
    };
  }
  return shared;
}

/** Haze per theatre: meteorological visibility at ground level (km), haze scale height (m), ground level (m). */
const HAZE_BY_STYLE: Readonly<Record<SceneEnvironment['surfaceStyle'], { visKm: number; scaleM: number; groundM: number }>> = {
  default: { visKm: 45, scaleM: 1200, groundM: 0 },
  coastal: { visKm: 60, scaleM: 1000, groundM: 0 },
  // Winter haze over the plains: shorter visibility low down, clearing quickly with height.
  farmland: { visKm: 70, scaleM: 1100, groundM: 234 },
};

/** Sets the theatre's haze. Colours come from skyFog.ts (horizon/zenith per style). */
export function setAtmosphereStyle(style: SceneEnvironment['surfaceStyle'], horizon: THREE.Color, zenith: THREE.Color): void {
  const u = getAtmosphereUniforms();
  const h = HAZE_BY_STYLE[style];
  // Koschmieder: visibility V = 3.912 / sigma.
  u.uAtmHazeParams.value.set(3.912 / (h.visKm * 1000), h.scaleM, h.groundM, 3.912 / 350000);
  u.uAtmHaze.value.copy(horizon);
  u.uAtmZenith.value.copy(zenith);
}

export function setAtmosphereCamera(camWorld: Readonly<Vec3Like>): void {
  getAtmosphereUniforms().uAtmCamPos.value.set(camWorld.x, camWorld.y, camWorld.z);
}

export function setAtmosphereSun(dir: Readonly<Vec3Like>): void {
  getAtmosphereUniforms().uAtmSunDir.value.set(dir.x, dir.y, dir.z).normalize();
}

/** Transmittance of the haze from the camera to a point `dist` metres away along `dir` (for CPU-side use). */
export function hazeTransmittance(camY: number, dirY: number, dist: number): number {
  const p = getAtmosphereUniforms().uAtmHazeParams.value;
  const a = p.x * Math.exp(-(camY - p.z) / p.y);
  const k = (dirY * dist) / p.y;
  const f = Math.abs(k) > 1e-4 ? (1 - Math.exp(-k)) / k : 1;
  return Math.exp(-(a * dist * f + p.w * dist));
}

/**
 * GLSL. Vertex shaders: `atmCurve(worldPos)` returns worldPos dropped for earth curvature.
 * Fragment shaders: `atmApply(col, worldPos)` applies aerial perspective to a surface colour;
 * `atmInscatter(dir)` is the haze colour looking along a unit direction.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
  uniform vec3 uAtmCamPos;
  uniform vec3 uAtmSunDir;
  uniform vec3 uAtmHaze;
  uniform vec3 uAtmSunGlow;
  uniform vec3 uAtmZenith;
  uniform vec4 uAtmHazeParams;
  uniform float uAtmCurv;

  vec3 atmCurve(vec3 w) {
    vec2 d = w.xz - uAtmCamPos.xz;
    w.y -= dot(d, d) * uAtmCurv;
    return w;
  }
  vec3 atmInscatter(vec3 dir) {
    float mu = dot(dir, normalize(uAtmSunDir));
    float glow = pow(max(mu, 0.0), 8.0) * 0.55 + pow(max(mu, 0.0), 64.0) * 0.6;
    // Slightly darker and bluer looking away from the sun.
    vec3 base = uAtmHaze * (0.93 + 0.07 * mu);
    return mix(base, uAtmSunGlow, clamp(glow, 0.0, 1.0));
  }
  float atmTransmittance(vec3 w) {
    vec3 d = w - uAtmCamPos;
    float dist = length(d);
    float a = uAtmHazeParams.x * exp(-(uAtmCamPos.y - uAtmHazeParams.z) / uAtmHazeParams.y);
    float k = d.y / uAtmHazeParams.y;
    float f = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0;
    return exp(-(a * dist * f + uAtmHazeParams.w * dist));
  }
  // Sky colour looking along dir: haze at the horizon, blending to the zenith colour overhead.
  vec3 atmSky(vec3 dir) {
    vec3 h = atmInscatter(dir);
    float up = clamp(dir.y, 0.0, 1.0);
    return mix(h, uAtmZenith, pow(smoothstep(0.0, 0.7, up), 0.7));
  }
  vec3 atmApply(vec3 col, vec3 w) {
    vec3 d = w - uAtmCamPos;
    float t = atmTransmittance(w);
    return mix(atmInscatter(d / max(length(d), 1e-3)), col, t);
  }
`;
