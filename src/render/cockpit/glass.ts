/**
 * src/render/cockpit/glass.ts — transparent glass seen from the cockpit (canopy, windscreen, HUD
 * combiner): Fresnel reflection of the sky and of the dark cockpit, sharp sun glints, a slight tint
 * over the world behind it, and faint wear that lights up when the sun shines through it.
 * Premultiplied-alpha blending, display-referred output (like the world's shaders).
 */

import * as THREE from 'three';

/** Shared per-frame lighting for the cockpit's custom shaders (cockpit frame, display colours). */
export interface GlassUniforms {
  [k: string]: THREE.IUniform;
  uEye: THREE.IUniform<THREE.Vector3>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunCol: THREE.IUniform<THREE.Color>;
  uSky: THREE.IUniform<THREE.Color>;
  uGround: THREE.IUniform<THREE.Color>;
}

export function createGlassUniforms(): GlassUniforms {
  return {
    uEye: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(1, 1, 1) },
    uSky: { value: new THREE.Color(0.5, 0.6, 0.7) },
    uGround: { value: new THREE.Color(0.2, 0.2, 0.2) },
  };
}

export interface GlassOptions {
  /** Glass tint (display colour) and how much of it is added over the world, 0..1. */
  tint: THREE.ColorRepresentation;
  base: number;
  /** Reflection strength multiplier. */
  reflect: number;
  /** Wear/scratch visibility in sunlight. */
  wear: number;
}

export function createGlassMaterial(shared: GlassUniforms, opts: GlassOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uTint: { value: new THREE.Color(opts.tint) }, uBase: { value: opts.base }, uReflect: { value: opts.reflect }, uWear: { value: opts.wear } },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      varying vec3 vN;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPos = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uEye;
      uniform vec3 uSunDir;
      uniform vec3 uSunCol;
      uniform vec3 uSky;
      uniform vec3 uGround;
      uniform vec3 uTint;
      uniform float uBase;
      uniform float uReflect;
      uniform float uWear;
      varying vec3 vPos;
      varying vec3 vN;
      float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0)), f.x), f.y);
      }
      void main() {
        vec3 V = normalize(uEye - vPos);
        vec3 N = normalize(vN);
        if (dot(N, V) < 0.0) N = -N;
        float c = clamp(dot(N, V), 0.0, 1.0);
        float F = 0.04 + 0.96 * pow(1.0 - c, 5.0);
        vec3 R = reflect(-V, N);
        // Seen from inside, the glass mostly reflects the dark cockpit, and the sky above.
        vec3 env = mix(uGround * 0.35, uSky * 0.8, smoothstep(-0.1, 0.6, R.y));
        vec3 L = normalize(uSunDir);
        float rl = max(dot(R, L), 0.0);
        float spec = pow(rl, 1200.0) * 6.0 + pow(rl, 80.0) * 0.12;
        // Sunlight through the glass shows smears and fine scratches.
        float through = pow(max(dot(-V, L), 0.0), 6.0) * uWear;
        vec3 wear = vec3(0.0);
        // The noise only where it shows (looking towards the sun).
        if (through > 0.004) {
          float smear = vnoise(vPos.xz * 18.0 + vPos.y * 7.0) * vnoise(vPos.xy * 45.0);
          float scratch = smoothstep(0.97, 0.995, vnoise(vec2(dot(vPos, vec3(40.0, 13.0, 90.0)), dot(vPos, vec3(2.0, 3.0, 1.5)) * 3.0)));
          wear = uSunCol * (smear * 0.05 + scratch * 0.04) * through;
        }
        vec3 col = env * F * uReflect + uSunCol * spec + uTint * uBase * (uSky * 0.6 + uSunCol * 0.2) + wear;
        float a = clamp(uBase + F * uReflect * 0.6, 0.0, 1.0);
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}
