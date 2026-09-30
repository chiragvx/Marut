/**
 * src/render/postGrade.ts — colour grading and camera/lens effects at (almost) no extra cost.
 *
 * The grade is FUSED into the anti-aliasing pass: the FXAA shader's output goes straight through
 * gradeColor() in the same fragment shader, so there is no extra full-screen pass (a separate pass
 * measured ~1 ms at 1080p on an Intel iGPU, mostly memory bandwidth). On tiers without FXAA, a
 * grade-only pass does the same with a single texture read.
 *
 * gradeColor(), in order:
 * 1. A slight de-haze: flat, bright, low-saturation tones (the haze band) get a little depth.
 * 2. A gentle filmic S-curve on luminance, with a soft highlight shoulder (mid-tones ~unchanged:
 *    colours in this app are display values).
 * 3. Saturation +10%, tapering to 0 in the brightest tones so clouds stay white.
 * 4. Split toning: cool shadows, warm highlights.
 * 5. Sun glare: a soft warm glow and two faint lens ghosts when the sun is on screen, scaled by how
 *    much of the sun is visible. That is sampled from the image once per vertex, not per pixel, so
 *    clouds and terrain in front of the sun dim it.
 * 6. A subtle vignette and fine animated film grain.
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

const GRADE_UNIFORMS_GLSL = /* glsl */ `
  uniform float uAspect;
  uniform float uTime;
  uniform vec3 uSun;
  uniform vec4 uAmount; // x thermal (0 off, 1 white-hot, 2 black-hot), y thermal gain, z grain, w glare
`;

const VERTEX = /* glsl */ `
  uniform sampler2D tDiffuse;
  ${GRADE_UNIFORMS_GLSL}
  varying vec2 vUv;
  varying float vSunVis;
  float lumaV(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  void main() {
    vUv = uv;
    vSunVis = 0.0;
    if (uAmount.w > 0.0 && uSun.z > 0.5) {
      vec2 sv = uSun.xy;
      float vis = smoothstep(0.78, 0.95, lumaV(textureLod(tDiffuse, sv, 0.0).rgb))
                + smoothstep(0.78, 0.95, lumaV(textureLod(tDiffuse, sv + vec2(0.006, 0.0), 0.0).rgb))
                + smoothstep(0.78, 0.95, lumaV(textureLod(tDiffuse, sv - vec2(0.006, 0.0), 0.0).rgb));
      vSunVis = vis / 3.0 * smoothstep(-0.1, 0.05, sv.x) * smoothstep(1.1, 0.95, sv.x) * smoothstep(-0.1, 0.05, sv.y) * smoothstep(1.1, 0.95, sv.y) * uAmount.w;
    }
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GRADE_GLSL = /* glsl */ `
  ${GRADE_UNIFORMS_GLSL}
  varying float vSunVis;
  float gLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  float gHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec3 gradeColor(vec3 c, vec2 uv) {
    if (uAmount.x > 0.5) {
      // Targeting pod FLIR: a grey heat picture. The scene's brightness (normalised to the light
      // level, so it works at night) stands in for the ground's temperature; heat sources are drawn
      // hot by their own shaders. Contrast stretch, polarity, sensor noise.
      float t = clamp((gLuma(c) * uAmount.y - 0.1) * 1.3, 0.0, 1.0);
      if (uAmount.x > 1.5) t = 1.0 - t;
      t += (gHash(gl_FragCoord.xy + fract(uTime * 7.13) * 419.0) - 0.5) * 0.06;
      return vec3(clamp(t, 0.0, 1.0));
    }
    float l = gLuma(c);
    float sat0 = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
    float haze = smoothstep(0.45, 0.7, l) * (1.0 - smoothstep(0.05, 0.18, sat0));
    c = mix(c, c * vec3(0.95, 0.97, 1.02), haze * 0.5);
    l = gLuma(c);
    // The S-curve covers 0..1 and runs straight on above it (the cubic alone turns negative past
    // ~1.5, which drew bright lamps, e.g. the PAPI, as black dots).
    float lc = min(l, 1.0);
    float s = lc * lc * (3.0 - 2.0 * lc) + max(l - 1.0, 0.0);
    float curved = mix(l, s, 0.28);
    curved = curved / (1.0 + max(curved - 0.85, 0.0) * 0.9);
    c *= curved / max(l, 1e-4);
    l = gLuma(c);
    c = mix(vec3(l), c, 1.0 + 0.10 * (1.0 - smoothstep(0.7, 0.95, l)));
    c *= mix(vec3(0.975, 0.99, 1.03), vec3(1.025, 1.0, 0.965), smoothstep(0.15, 0.75, l));
    if (vSunVis > 0.001) {
      vec2 sv = uSun.xy;
      float dist = length((uv - sv) * vec2(uAspect, 1.0));
      vec3 glow = vec3(1.0, 0.9, 0.72) * (exp(-dist * 9.0) * 0.28 + exp(-dist * 2.5) * 0.10);
      vec2 g1 = (uv - mix(sv, vec2(0.5), 1.4)) * vec2(uAspect, 1.0);
      vec2 g2 = (uv - mix(sv, vec2(0.5), 1.8)) * vec2(uAspect, 1.0);
      glow += vec3(0.55, 0.75, 1.0) * 0.035 * (1.0 - smoothstep(0.02, 0.05, length(g1)));
      glow += vec3(1.0, 0.8, 0.55) * 0.025 * (1.0 - smoothstep(0.05, 0.09, length(g2)));
      c += glow * vSunVis;
    }
    vec2 fc = (uv - 0.5) * vec2(uAspect, 1.0);
    c *= 1.0 - 0.18 * smoothstep(0.15, 0.9, dot(fc, fc));
    float g = gHash(gl_FragCoord.xy + fract(uTime * 7.13) * 419.0) - 0.5;
    c += g * 0.022 * uAmount.z * (1.0 - 0.5 * l);
    return clamp(c, 0.0, 1.0);
  }
`;

function gradeUniforms(): Record<string, THREE.IUniform> {
  return {
    tDiffuse: { value: null },
    uAspect: { value: 16 / 9 },
    uTime: { value: 0 },
    uSun: { value: new THREE.Vector3(0.5, 0.5, 0) },
    uAmount: { value: new THREE.Vector4(0, 0, 1, 1) },
  };
}

/** FXAA with the grade applied to its output, in one pass. */
function fxaaGradeShader(): THREE.ShaderMaterialParameters & { uniforms: Record<string, THREE.IUniform> } {
  const src = FXAAShader.fragmentShader;
  const at = src.lastIndexOf('void main()');
  const head = src.slice(0, at);
  return {
    uniforms: { ...gradeUniforms(), resolution: { value: new THREE.Vector2(1 / 1024, 1 / 512) } },
    vertexShader: VERTEX,
    fragmentShader: `${head}
      ${GRADE_GLSL}
      void main() {
        vec4 aa = FxaaPixelShader(vUv, tDiffuse, resolution, 0.2, 5.0);
        gl_FragColor = vec4(gradeColor(aa.rgb, vUv), 1.0);
      }`,
  };
}

function gradeOnlyShader(): THREE.ShaderMaterialParameters & { uniforms: Record<string, THREE.IUniform> } {
  return {
    uniforms: gradeUniforms(),
    vertexShader: VERTEX,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      varying vec2 vUv;
      ${GRADE_GLSL}
      void main() { gl_FragColor = vec4(gradeColor(texture2D(tDiffuse, vUv).rgb, vUv), 1.0); }`,
  };
}

export interface GradeController {
  /** FXAA + grade (used when the tier has anti-aliasing). */
  readonly fxaaPass: ShaderPass;
  /** Grade only (tiers without anti-aliasing). */
  readonly gradePass: ShaderPass;
  setSize(widthPx: number, heightPx: number): void;
  /** Per frame: time, and the sun's screen position from the camera. */
  update(nowMs: number, camera: THREE.PerspectiveCamera, sunDirWorld: THREE.Vector3): void;
  /** Sun glare strength, 0..1 (0 at night and under overcast). */
  setGlare(amount: number): void;
  setAntialias(on: boolean): void;
  setTier(tier: 'low' | 'medium' | 'high' | 'ultra'): void;
  /** Thermal picture: 0 off, 1 white-hot, 2 black-hot; gain = 1 / the scene's light level. */
  setThermal(mode: number, gain: number): void;
}

export function createGrade(): GradeController {
  const fxaaPass = new ShaderPass(fxaaGradeShader());
  const gradePass = new ShaderPass(gradeOnlyShader());
  const all = [fxaaPass, gradePass].map((p) => (p.material as THREE.ShaderMaterial).uniforms);
  const scratch = new THREE.Vector3();
  const setAll = (name: string, f: (u: THREE.IUniform) => void): void => {
    for (const u of all) f(u[name]!);
  };
  gradePass.enabled = false;
  return {
    fxaaPass,
    gradePass,
    setSize(w, h) {
      setAll('uAspect', (u) => (u.value = w / Math.max(h, 1)));
      ((fxaaPass.material as THREE.ShaderMaterial).uniforms['resolution']!.value as THREE.Vector2).set(1 / Math.max(w, 1), 1 / Math.max(h, 1));
    },
    update(nowMs, camera, sunDir) {
      setAll('uTime', (u) => (u.value = nowMs / 1000));
      scratch.copy(sunDir).normalize().multiplyScalar(100000).add(camera.position).project(camera);
      const inFront = scratch.z < 1 && scratch.z > -1 ? 1 : 0;
      setAll('uSun', (u) => (u.value as THREE.Vector3).set(scratch.x * 0.5 + 0.5, scratch.y * 0.5 + 0.5, inFront));
    },
    setAntialias(on) {
      fxaaPass.enabled = on;
      gradePass.enabled = !on;
    },
    setTier(tier) {
      setAll('uAmount', (u) => ((u.value as THREE.Vector4).z = tier === 'low' ? 0.6 : 1));
    },
    setThermal(mode, gain) {
      setAll('uAmount', (u) => {
        (u.value as THREE.Vector4).x = mode;
        (u.value as THREE.Vector4).y = gain;
      });
    },
    setGlare(amount) {
      setAll('uAmount', (u) => ((u.value as THREE.Vector4).w = amount));
    },
  };
}
