/**
 * src/render/groundLamps.ts — aircraft lamps that light the ground: the navigation lights' red,
 * green and white wash on the concrete under a jet at night, and the landing light's beam on the
 * runway ahead. They are real lights in the terrain and pavement shaders (the surface's own colour
 * times the light falling on it), not decals, so the runway's texture, markings and stains show
 * through, the light falls off with the square of the distance and with the angle it strikes at,
 * and a landing light at a grazing angle stretches into a long pool ahead.
 *
 * Up to MAX_GROUND_LAMPS lamps per frame (aircraftLights.ts fills them), in world coordinates:
 * - uGLampPos[i]: xyz position, w intensity (0 = unused);
 * - uGLampCol[i]: rgb colour, w = cos of a spot's half-angle (-2: not a spot);
 * - uGLampDir[i]: xyz spot axis, or the centre of a horizontal sector (navigation lights);
 *   w = cos of the sector's half-angle (-2: all round).
 */
import * as THREE from 'three';

export const MAX_GROUND_LAMPS = 8;

export interface GroundLampUniforms {
  [name: string]: { value: unknown };
  uGLampPos: { value: THREE.Vector4[] };
  uGLampCol: { value: THREE.Vector4[] };
  uGLampDir: { value: THREE.Vector4[] };
  uGLampN: { value: number };
}

let shared: GroundLampUniforms | undefined;

export function getGroundLampUniforms(): GroundLampUniforms {
  if (!shared) {
    const v = (): THREE.Vector4[] => Array.from({ length: MAX_GROUND_LAMPS }, () => new THREE.Vector4());
    shared = { uGLampPos: { value: v() }, uGLampCol: { value: v() }, uGLampDir: { value: v() }, uGLampN: { value: 0 } };
  }
  return shared;
}

/** `vec3 groundLamps(vec3 worldPos, vec3 normal)`: light falling on a surface from the lamps. */
export const GROUND_LAMPS_GLSL = /* glsl */ `
  uniform vec4 uGLampPos[${MAX_GROUND_LAMPS}];
  uniform vec4 uGLampCol[${MAX_GROUND_LAMPS}];
  uniform vec4 uGLampDir[${MAX_GROUND_LAMPS}];
  uniform int uGLampN;
  vec3 groundLamps(vec3 w, vec3 n) {
    vec3 e = vec3(0.0);
    for (int i = 0; i < ${MAX_GROUND_LAMPS}; i++) {
      if (i >= uGLampN) break;
      vec4 lp = uGLampPos[i];
      vec3 d = lp.xyz - w;
      float d2 = dot(d, d);
      vec3 L = d * inversesqrt(max(d2, 1e-4));
      float ndl = dot(n, L);
      if (ndl <= 0.0) continue;
      vec4 lc = uGLampCol[i];
      vec4 ld = uGLampDir[i];
      float k = 1.0;
      if (lc.w > -1.5) {
        // Spot: a smooth (Gaussian) fall-off off the beam's axis, the half-angle at ~40%, so the
        // pool has no hard edge.
        float ang = acos(clamp(dot(-L, ld.xyz), -1.0, 1.0));
        float halfA = acos(lc.w);
        k = exp(-(ang * ang) / (halfA * halfA));
      } else if (ld.w > -1.5) {
        // Horizontal sector: the bearing decides; straight down the lens lights all round.
        vec2 h = -L.xz;
        float hl = length(h);
        k = mix(1.0, smoothstep(ld.w - 0.1, ld.w + 0.05, dot(h / max(hl, 1e-4), ld.xz)), smoothstep(0.15, 0.5, hl));
      }
      // Inverse square (softened inside ~0.4 m so the lamp's own spot is not a singularity).
      e += lc.rgb * (lp.w * k * ndl / (d2 + 0.16));
    }
    // A bright patch rolls off towards its colour's full strength instead of clipping to white
    // (as the eye and a camera see a lamp-lit patch of concrete).
    float m = max(max(e.r, e.g), e.b);
    return e / (1.0 + 0.5 * m);
  }
`;
