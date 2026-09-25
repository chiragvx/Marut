/**
 * src/render/farGround.ts — the ground beyond the streamed terrain, out to the horizon.
 *
 * One flat disc (radius FAR_GROUND_RADIUS_M, dense rings near the middle, sparse far out) that
 * follows the camera, at the theatre's ground level, drawn BEFORE the terrain with depth writes off.
 * Wherever streamed terrain exists it simply draws over it, so there is no z-fighting and no seam
 * logic; the disc only shows past the terrain's reach and beyond the edge of the 200 km world.
 * It uses the same earth curvature and aerial perspective as the terrain, and a colour that
 * matches the terrain's far-distance average (sea west of the coastline on the Konkan coast).
 */

import * as THREE from 'three';
import type { Vec3Like } from '../contracts/core';
import type { SceneEnvironment } from '../contracts/render';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';

export const FAR_GROUND_RADIUS_M = 320000;

const VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  uniform float uLevel;
  uniform vec3 uOrigin;
  varying vec3 vWorld;
  void main() {
    // position is relative to the camera's horizontal position.
    vec3 w = vec3(position.x + uAtmCamPos.x, uLevel, position.z + uAtmCamPos.z);
    vWorld = w;
    gl_Position = projectionMatrix * viewMatrix * vec4(atmCurve(w) - uOrigin, 1.0);
  }
`;

const FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  uniform vec3 uLand;
  uniform vec3 uSea;
  uniform float uShoreX;
  varying vec3 vWorld;
  void main() {
    vec3 col = vWorld.x < uShoreX ? uSea : uLand;
    float diff = max(normalize(uAtmSunDir).y, 0.0);
    col *= vec3(0.44, 0.47, 0.52) + vec3(1.0, 0.97, 0.9) * 0.62 * diff;
    gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
  }
`;

const LAND: Readonly<Record<SceneEnvironment['surfaceStyle'], [number, number, number]>> = {
  default: [0.29, 0.42, 0.23],
  coastal: [0.24, 0.36, 0.17],
  farmland: [0.47, 0.47, 0.35],
};

export interface FarGround {
  setEnvironment(env: Readonly<SceneEnvironment>, groundLevelM: number, shoreX: number | undefined): void;
  update(originWorld: Readonly<Vec3Like>): void;
  dispose(): void;
}

function makeDisc(): THREE.BufferGeometry {
  // Radii grow geometrically: fine near the camera (hidden under terrain anyway), coarse far out.
  const rings: number[] = [0];
  for (let r = 500; r < FAR_GROUND_RADIUS_M; r *= 1.35) rings.push(r);
  rings.push(FAR_GROUND_RADIUS_M);
  const seg = 96;
  const pos: number[] = [];
  const idx: number[] = [];
  pos.push(0, 0, 0);
  for (let i = 1; i < rings.length; i++) {
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * rings[i]!, 0, Math.sin(a) * rings[i]!);
    }
  }
  for (let k = 0; k < seg; k++) idx.push(0, 1 + ((k + 1) % seg), 1 + k);
  for (let i = 1; i < rings.length - 1; i++) {
    const a0 = 1 + (i - 1) * seg;
    const b0 = 1 + i * seg;
    for (let k = 0; k < seg; k++) {
      const k1 = (k + 1) % seg;
      idx.push(a0 + k, a0 + k1, b0 + k, a0 + k1, b0 + k1, b0 + k);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export function createFarGround(scene: THREE.Scene): FarGround {
  const geom = makeDisc();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...getAtmosphereUniforms(),
      uLevel: { value: 0 },
      uOrigin: { value: new THREE.Vector3() },
      uLand: { value: new THREE.Vector3(...LAND.default) },
      uSea: { value: new THREE.Vector3(0.06, 0.2, 0.3) },
      uShoreX: { value: -1e9 },
    },
    vertexShader: VS,
    fragmentShader: FS,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -500;
  scene.add(mesh);
  return {
    setEnvironment(env, groundLevelM, shoreX) {
      mat.uniforms['uLevel']!.value = groundLevelM;
      (mat.uniforms['uLand']!.value as THREE.Vector3).set(...LAND[env.surfaceStyle]);
      mat.uniforms['uShoreX']!.value = shoreX ?? -1e9;
    },
    update(origin) {
      (mat.uniforms['uOrigin']!.value as THREE.Vector3).set(origin.x, origin.y, origin.z);
    },
    dispose() {
      scene.remove(mesh);
      geom.dispose();
      mat.dispose();
    },
  };
}
