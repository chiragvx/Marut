/**
 * src/render/groundUnits.ts — draws ground units (EntityKind 'ground' in the snapshot) from the
 * procedural models in groundModels.ts: one instanced mesh per model, filled each frame.
 *
 * Per instance: team (hostile units in desert camouflage, friendly in olive drab), state (intact,
 * damaged = smoke-stained, destroyed = burnt black and slumped), and whether its radar is
 * transmitting (the antenna turns). Lit like the airbase structures (sun, clouds, sun shadows,
 * haze, wet ground); casts sun shadows.
 */
import * as THREE from 'three';
import type { QuatLike, Vec3Like } from '../contracts/core';
import { GROUND_TYPE_IDS, GroundFlag } from '../contracts/ground';
import { GROUND_UNIT_TYPES } from '../catalog/groundUnits';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';
import { CLOUD_SHADOW_GLSL, getCloudShadowUniforms } from './clouds';
import { CASTER_LAYER, SUN_SHADOW_GLSL, getSunShadowUniforms } from './sunShadows';
import { buildGroundModels } from './groundModels';

/** Instances per model. */
const MAX_PER_MODEL = 64;

const VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute float aPart;
  attribute vec3 aPivot;
  attribute vec4 iState; // x: state (0 intact, 1 damaged, 2 destroyed), y: team, z: radar transmitting, w: heat (0..1; 2 = burning)
  uniform float uTime;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vLocal;
  varying float vPart;
  varying vec4 vState;
  varying float vSeed;
  void main() {
    vec3 p = position;
    vec3 n = normal;
    vSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
    if (aPart > 2.5 && aPart < 3.5 && iState.z > 0.5 && iState.x < 1.5) {
      // Radar antenna: turns about its mast, ~15 rpm.
      float a = uTime * 1.6 + vSeed * 6.2831;
      float c = cos(a);
      float s = sin(a);
      p.xz = aPivot.xz + mat2(c, s, -s, c) * (p.xz - aPivot.xz);
      n.xz = mat2(c, s, -s, c) * n.xz;
    }
    if (iState.x > 1.5) {
      // Wrecked: slumped and splayed.
      p.y *= 0.7;
      p.xz *= 1.04;
    }
    vec4 wp = instanceMatrix * vec4(p, 1.0);
    vWorld = wp.xyz;
    vNormalW = normalize(mat3(instanceMatrix) * n);
    vLocal = p;
    vPart = aPart;
    vState = iState;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(atmCurve(wp.xyz), 1.0);
  }
`;

const FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  uniform vec3 uSunDir;
  ${CLOUD_SHADOW_GLSL}
  ${SUN_SHADOW_GLSL}
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vLocal;
  varying float vPart;
  varying vec4 vState;
  varying float vSeed;
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  void main() {
    int part = int(vPart + 0.5);
    vec3 n = normalize(vNormalW);
    bool hostile = vState.y > 0.5;
    // Camouflage: hostile desert (sand, tan, brown), friendly olive drab with dark green.
    vec3 base = hostile ? vec3(0.62, 0.55, 0.40) : vec3(0.33, 0.36, 0.24);
    vec3 blotA = hostile ? vec3(0.50, 0.42, 0.30) : vec3(0.24, 0.28, 0.18);
    vec3 blotB = hostile ? vec3(0.70, 0.64, 0.50) : vec3(0.40, 0.38, 0.28);
    float b1 = vnoise(vLocal.xz * 0.9 + vLocal.y * 0.7 + vSeed * 31.0);
    float b2 = vnoise(vLocal.zx * 1.3 - vLocal.y + 7.0);
    vec3 col;
    if (part == 0) {
      col = mix(base, blotA, smoothstep(0.55, 0.6, b1));
      col = mix(col, blotB, smoothstep(0.62, 0.67, b2) * 0.8);
    } else if (part == 1) {
      col = vec3(0.07, 0.07, 0.07);
    } else if (part == 2) {
      col = vec3(0.34, 0.35, 0.34);
    } else if (part == 3) {
      col = hostile ? vec3(0.66, 0.64, 0.56) : vec3(0.52, 0.55, 0.46);
    } else if (part == 4) {
      col = hostile ? vec3(0.58, 0.52, 0.38) : vec3(0.36, 0.38, 0.27);
    } else if (part == 5) {
      col = vec3(0.60, 0.58, 0.54) * (0.85 + 0.2 * b1);
    } else if (part == 6) {
      col = base * 0.8;
    } else {
      col = vec3(0.08, 0.10, 0.12) + 0.2 * atmSky(reflect(normalize(vWorld - uAtmCamPos), n)) * 0.4;
    }
    col *= 0.9 + 0.15 * vnoise(vWorld.xz * 2.1 + vWorld.y);
    // Damage: smoke-stained, or burnt out (black with a little grey ash).
    if (vState.x > 1.5) col = mix(vec3(0.05, 0.045, 0.04), vec3(0.18, 0.17, 0.16), b2 * 0.6);
    else if (vState.x > 0.5) col *= mix(1.0, 0.45, smoothstep(0.3, 0.8, b1));
    col *= 1.0 - 0.25 * uAtmWet;
    vec3 L = normalize(uSunDir);
    float ndl = dot(n, L);
    float diff = max(ndl, 0.0) * cloudShadow(vWorld) * sunShadow(vWorld, ndl);
    vec3 ambient = mix(uAtmAmbGround, uAtmAmbSky, 0.5 + 0.5 * n.y);
    col = col * (ambient + uAtmSunCol * diff);
    if (uAtmThermal > 0.5) {
      // FLIR: the unit glows by its heat (engine, electronics); hottest where it burns; the engine
      // deck and exhaust (lower rear) hotter than the rest.
      float heat = vState.w > 1.5 ? 1.0 : mix(0.45, 0.95, vState.w) * (0.85 + 0.15 * smoothstep(1.2, 0.2, vLocal.y));
      if (vState.x > 1.5 && vState.w < 1.5) heat = 0.4;
      col = vec3(heat) * 1.4;
    }
    gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
  }
`;

interface Batch {
  mesh: THREE.InstancedMesh;
  state: THREE.InstancedBufferAttribute;
  n: number;
}

export interface GroundUnitRenderer {
  beginFrame(): void;
  /** One ground unit this frame: its type code (GROUND_TYPE_IDS), world position/attitude, EntityFlags, team. */
  update(code: number, pos: Readonly<Vec3Like>, rot: Readonly<QuatLike>, flags: number, team: number): void;
  endFrame(originWorld: Readonly<Vec3Like>, timeSec: number): void;
  setSunDirection(dir: Readonly<Vec3Like>): void;
  dispose(): void;
}

export function createGroundUnitRenderer(root: THREE.Object3D): GroundUnitRenderer {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  root.add(group);
  const models = buildGroundModels();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...getAtmosphereUniforms(),
      ...getCloudShadowUniforms(),
      ...getSunShadowUniforms(),
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, -0.3) },
      uTime: { value: 0 },
    },
    vertexShader: VS,
    fragmentShader: FS,
  });
  const batches = new Map<string, Batch>();
  /** Each unit type's heat (catalogue), by type code, for the thermal picture. */
  const heatByCode = GROUND_TYPE_IDS.map((id) => GROUND_UNIT_TYPES[id]?.heat ?? 0.4);
  const batchByCode: (Batch | undefined)[] = GROUND_TYPE_IDS.map((id) => {
    const model = GROUND_UNIT_TYPES[id]?.model;
    const geom = model ? models.byModel.get(model) : undefined;
    if (!model || !geom) return undefined;
    let b = batches.get(model);
    if (!b) {
      const g = geom.clone();
      const state = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_MODEL * 4), 4);
      state.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('iState', state);
      const mesh = new THREE.InstancedMesh(g, mat, MAX_PER_MODEL);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.layers.enable(CASTER_LAYER);
      group.add(mesh);
      b = { mesh, state, n: 0 };
      batches.set(model, b);
    }
    return b;
  });
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);

  return {
    beginFrame() {
      for (const b of batches.values()) b.n = 0;
    },
    update(code, pos, rot, flags, team) {
      const b = batchByCode[code];
      if (!b || b.n >= MAX_PER_MODEL) return;
      m4.compose(v.set(pos.x, pos.y, pos.z), q.set(rot.x, rot.y, rot.z, rot.w), one);
      b.mesh.setMatrixAt(b.n, m4);
      const state = flags & GroundFlag.Destroyed ? 2 : flags & GroundFlag.Damaged ? 1 : 0;
      b.state.setXYZW(b.n, state, team, flags & GroundFlag.Emitting ? 1 : 0, flags & GroundFlag.Burning ? 2 : (heatByCode[code] ?? 0.4));
      b.n++;
    },
    endFrame(origin, timeSec) {
      group.position.set(-origin.x, -origin.y, -origin.z);
      group.updateMatrix();
      group.updateMatrixWorld(true);
      mat.uniforms['uTime']!.value = timeSec % 3600;
      for (const b of batches.values()) {
        b.mesh.count = b.n;
        b.mesh.instanceMatrix.needsUpdate = true;
        b.state.needsUpdate = true;
      }
    },
    setSunDirection(dir) {
      (mat.uniforms['uSunDir']!.value as THREE.Vector3).set(dir.x, dir.y, dir.z);
    },
    dispose() {
      for (const b of batches.values()) {
        b.mesh.geometry.dispose();
        b.mesh.dispose();
      }
      for (const g of models.byModel.values()) g.dispose();
      root.remove(group);
      mat.dispose();
    },
  };
}
