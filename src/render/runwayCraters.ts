/**
 * src/render/runwayCraters.ts — craters left on runways (SimEvent 'runwayCrater'): a dark scorched
 * pit with a lighter lip, inside a ring of scattered slab debris twice its radius (the unusable
 * patch the sim counts). Flat decals on the pavement, one instanced draw, positions kept in world
 * doubles and placed relative to the floating origin each frame. Cleared on each mission load.
 */
import * as THREE from 'three';
import type { SimEvent, Vec3Like } from '../contracts/core';

const MAX_CRATERS = 96;

const VS = /* glsl */ `
  attribute float aSeed;
  varying vec2 vUv;
  varying float vSeed;
  void main() {
    vUv = uv * 2.0 - 1.0;
    vSeed = aSeed;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;
const FS = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying float vSeed;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + vSeed) * 43758.5453); }
  void main() {
    float r = length(vUv);
    if (r > 1.0) discard;
    // Debris field: chunks of slab and soil scattered out to the edge, thinning with distance.
    vec2 cell = floor(vUv * 14.0);
    float chunk = step(0.55 + 0.4 * r, hash(cell));
    float debrisA = chunk * (1.0 - smoothstep(0.55, 1.0, r)) * 0.85;
    vec3 col = mix(vec3(0.42, 0.40, 0.37), vec3(0.30, 0.26, 0.21), hash(cell + 7.0));
    float a = debrisA;
    // Spoil: earth and broken concrete thrown out round the pit, patchy towards its edge.
    float n = hash(floor(vUv * 22.0) + 3.0);
    float spoil = (1.0 - smoothstep(0.5, 0.8, r + 0.12 * n)) * 0.9;
    vec3 soil = mix(vec3(0.36, 0.29, 0.21), vec3(0.47, 0.44, 0.40), step(0.7, n));
    col = mix(col, soil, spoil / max(a + spoil, 1e-3));
    a = max(a, spoil);
    // Soot right round the pit.
    float scorch = (1.0 - smoothstep(0.4, 0.58, r)) * 0.8;
    col = mix(col, vec3(0.09, 0.08, 0.07), scorch);
    a = max(a, scorch);
    // The pit (half the decal's radius) and its broken lip.
    float lip = smoothstep(0.38, 0.46, r) * (1.0 - smoothstep(0.46, 0.54, r));
    float pit = 1.0 - smoothstep(0.42, 0.48, r);
    col = mix(col, vec3(0.06, 0.05, 0.045) + 0.05 * hash(floor(vUv * 30.0)), pit);
    col = mix(col, vec3(0.38, 0.35, 0.31), lip * 0.8);
    a = max(a, max(pit, lip * 0.9));
    gl_FragColor = vec4(col, a);
  }
`;

export interface RunwayCraters {
  readonly object: THREE.Object3D;
  ingestEvents(events: readonly SimEvent[]): void;
  /** Places the craters relative to the floating origin. */
  tick(originWorld: Readonly<Vec3Like>): void;
  clear(): void;
  dispose(): void;
}

export function createRunwayCraters(): RunwayCraters {
  const geom = new THREE.PlaneGeometry(2, 2);
  geom.rotateX(-Math.PI / 2);
  const seeds = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CRATERS), 1);
  geom.setAttribute('aSeed', seeds);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -12,
  });
  const mesh = new THREE.InstancedMesh(geom, mat, MAX_CRATERS);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 0.6;
  const craters: { x: number; y: number; z: number; r: number; rot: number }[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  return {
    object: mesh,
    ingestEvents(events) {
      for (const ev of events) {
        if (ev.type !== 'runwayCrater') continue;
        if (craters.length >= MAX_CRATERS) craters.shift();
        craters.push({ x: ev.pos.x, y: ev.pos.y, z: ev.pos.z, r: ev.radiusM, rot: (ev.pos.x * 0.731 + ev.pos.z * 0.413) % (Math.PI * 2) });
      }
    },
    tick(origin) {
      for (let i = 0; i < craters.length; i++) {
        const c = craters[i]!;
        // The decal spans the debris ring: twice the crater's radius.
        s.set(c.r * 2, 1, c.r * 2);
        q.setFromAxisAngle(up, c.rot);
        p.set(c.x - origin.x, c.y - origin.y + 0.15, c.z - origin.z);
        m.compose(p, q, s);
        mesh.setMatrixAt(i, m);
        seeds.setX(i, c.rot * 13.7);
      }
      mesh.count = craters.length;
      mesh.instanceMatrix.needsUpdate = true;
      seeds.needsUpdate = true;
    },
    clear() {
      craters.length = 0;
      mesh.count = 0;
    },
    dispose() {
      geom.dispose();
      mat.dispose();
      mesh.dispose();
    },
  };
}
