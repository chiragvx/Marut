/**
 * src/render/rain.ts — falling rain as thin streaks around the camera.
 *
 * Drops sit on a fixed world lattice (a box that repeats every BOX_M), falling at ~9 m/s. The
 * vertex shader wraps them into the box around the camera, so they stay put in the world as the
 * aircraft flies through them, and draws each as a short line along the drop's motion relative to
 * the camera during a camera "exposure": straight down when still, long streaks rushing at the
 * windscreen at speed. One draw of line segments; no CPU work per frame beyond uniforms.
 */
import * as THREE from 'three';
import type { Vec3Like } from '../contracts/core';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';

const COUNT = 6000;
const BOX_M = 70;
const FALL_MPS = 9;
const EXPOSURE_S = 0.03;

const VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute vec4 aSeed;  // lattice position 0..1 (xyz), intensity threshold (w)
  attribute float aEnd;  // 0 = head, 1 = tail of the streak
  uniform vec3 uCamWorld;
  uniform vec3 uOrigin;
  uniform vec3 uRelVel;  // drop velocity relative to the camera, m/s
  uniform float uTime;
  uniform float uRain;
  varying float vFade;
  void main() {
    if (aSeed.w > uRain) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vFade = 0.0;
      return;
    }
    const float B = ${BOX_M.toFixed(1)};
    vec3 p = aSeed.xyz * B + vec3(1.5, -${FALL_MPS.toFixed(1)}, 0.8) * uTime;
    // The drop nearest the camera in its lattice column, relative to the camera.
    vec3 local = mod(p - uCamWorld, B) - 0.5 * B;
    local -= uRelVel * (${EXPOSURE_S} * aEnd);
    vec3 w = uCamWorld + local;
    float d = length(local);
    vFade = smoothstep(1.5, 4.0, d) * (1.0 - smoothstep(0.3 * B, 0.5 * B, d));
    gl_Position = projectionMatrix * viewMatrix * vec4(w - uOrigin, 1.0);
  }
`;

const FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  varying float vFade;
  void main() {
    if (vFade <= 0.01) discard;
    gl_FragColor = vec4(vec3(0.8, 0.83, 0.87) * atmLightLevel(), 0.5 * vFade);
  }
`;

export interface RainSystem {
  /** Per frame: intensity 0..1 (0 hides it), camera position and velocity (m/s). */
  update(intensity: number, camWorld: Readonly<Vec3Like>, camVel: Readonly<Vec3Like>, originWorld: Readonly<Vec3Like>, timeSec: number): void;
  dispose(): void;
}

export function createRain(scene: THREE.Scene): RainSystem {
  const seed = new Float32Array(COUNT * 2 * 4);
  const end = new Float32Array(COUNT * 2);
  let h = 12345;
  const rnd = (): number => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h / 4294967296;
  };
  for (let i = 0; i < COUNT; i++) {
    const s = [rnd(), rnd(), rnd(), rnd()];
    for (let e = 0; e < 2; e++) {
      seed.set(s, (i * 2 + e) * 4);
      end[i * 2 + e] = e;
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 2 * 3), 3));
  geom.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geom.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...getAtmosphereUniforms(),
      uCamWorld: { value: new THREE.Vector3() },
      uOrigin: { value: new THREE.Vector3() },
      uRelVel: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uRain: { value: 0 },
    },
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geom, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 20;
  lines.visible = false;
  scene.add(lines);

  return {
    update(intensity, cam, vel, origin, t) {
      lines.visible = intensity > 0.01;
      if (!lines.visible) return;
      mat.uniforms['uRain']!.value = intensity;
      (mat.uniforms['uCamWorld']!.value as THREE.Vector3).set(cam.x, cam.y, cam.z);
      (mat.uniforms['uOrigin']!.value as THREE.Vector3).set(origin.x, origin.y, origin.z);
      // Drops fall at FALL_MPS (slanted a little); the camera's own motion adds the rest.
      (mat.uniforms['uRelVel']!.value as THREE.Vector3).set(1.5 - vel.x, -FALL_MPS - vel.y, 0.8 - vel.z);
      mat.uniforms['uTime']!.value = t % 3600;
    },
    dispose() {
      scene.remove(lines);
      geom.dispose();
      mat.dispose();
    },
  };
}
