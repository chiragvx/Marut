/**
 * src/render/groundEffects.ts — what happens on the ground when weapons hit it, driven by SimEvents:
 *   - groundImpact: a fireball and a burst of dust sized by the charge (cube root of its mass);
 *     explosiveKg 0 (a gun round) kicks up a small spurt of dust.
 *   - groundKill: the target burns for its burnSec: flickering flames at its base and a column of
 *     dark smoke that rises, spreads and drifts.
 * Particles are soft round point sprites (one draw call per layer: dust, smoke, fire), positions kept
 * in world doubles and written relative to the floating origin each frame. Fixed capacity; the
 * oldest particles are recycled when full.
 */
import * as THREE from 'three';
import type { SimEvent, Vec3Like } from '../contracts/core';

const VS = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(1.0, -mv.z);
    vAlpha = aAlpha;
    vColor = aColor;
    gl_Position = projectionMatrix * mv;
  }
`;
const FS = /* glsl */ `
  precision mediump float;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    float a = vAlpha * smoothstep(1.0, 0.25, r);
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

interface Layer {
  points: THREE.Points;
  cap: number;
  n: number;
  next: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  age: Float32Array;
  life: Float32Array;
  size0: Float32Array;
  size1: Float32Array;
  alpha: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  /** Rising particles slow their climb (smoke); falling ones feel gravity (debris dust). */
  drag: number;
}

function createLayer(root: THREE.Object3D, cap: number, additive: boolean, drag: number): Layer {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geom.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage));
  geom.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage));
  geom.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geom.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 800 } },
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  points.renderOrder = additive ? 3 : 2;
  root.add(points);
  const f32 = () => new Float32Array(cap);
  return { points, cap, n: 0, next: 0, x: new Float64Array(cap), y: new Float64Array(cap), z: new Float64Array(cap), vx: f32(), vy: f32(), vz: f32(), age: f32(), life: f32(), size0: f32(), size1: f32(), alpha: f32(), r: f32(), g: f32(), b: f32(), drag };
}

function emit(l: Layer, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size0: number, size1: number, alpha: number, r: number, g: number, b: number): void {
  // Reuse a dead slot, else overwrite the oldest (round robin).
  let i = -1;
  if (l.n < l.cap) i = l.n++;
  else {
    for (let k = 0; k < l.cap; k++) {
      const j = (l.next + k) % l.cap;
      if (l.age[j]! >= l.life[j]!) {
        i = j;
        break;
      }
    }
    if (i < 0) i = l.next;
    l.next = (i + 1) % l.cap;
  }
  l.x[i] = x; l.y[i] = y; l.z[i] = z;
  l.vx[i] = vx; l.vy[i] = vy; l.vz[i] = vz;
  l.age[i] = 0; l.life[i] = life;
  l.size0[i] = size0; l.size1[i] = size1; l.alpha[i] = alpha;
  l.r[i] = r; l.g[i] = g; l.b[i] = b;
}

function stepLayer(l: Layer, dt: number, origin: Readonly<Vec3Like>, gravity: number): void {
  const pos = (l.points.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  const size = (l.points.geometry.getAttribute('aSize') as THREE.BufferAttribute).array as Float32Array;
  const alpha = (l.points.geometry.getAttribute('aAlpha') as THREE.BufferAttribute).array as Float32Array;
  const col = (l.points.geometry.getAttribute('aColor') as THREE.BufferAttribute).array as Float32Array;
  const k = Math.min(1, dt * l.drag);
  for (let i = 0; i < l.n; i++) {
    const age = (l.age[i]! += dt);
    const t = Math.min(1, age / l.life[i]!);
    if (t >= 1) {
      alpha[i] = 0;
      size[i] = 0;
      continue;
    }
    l.vx[i]! -= l.vx[i]! * k;
    l.vz[i]! -= l.vz[i]! * k;
    l.vy[i]! += (-gravity - l.vy[i]! * l.drag) * dt;
    l.x[i]! += l.vx[i]! * dt;
    l.y[i]! += l.vy[i]! * dt;
    l.z[i]! += l.vz[i]! * dt;
    pos[i * 3] = l.x[i]! - origin.x;
    pos[i * 3 + 1] = l.y[i]! - origin.y;
    pos[i * 3 + 2] = l.z[i]! - origin.z;
    size[i] = l.size0[i]! + (l.size1[i]! - l.size0[i]!) * Math.sqrt(t);
    // Fade in fast, out slowly.
    alpha[i] = l.alpha[i]! * Math.min(1, t * 8) * (1 - t) * (1 - t * 0.3);
    col[i * 3] = l.r[i]!;
    col[i * 3 + 1] = l.g[i]!;
    col[i * 3 + 2] = l.b[i]!;
  }
  const g = l.points.geometry;
  g.setDrawRange(0, l.n);
  g.getAttribute('position').needsUpdate = true;
  g.getAttribute('aSize').needsUpdate = true;
  g.getAttribute('aAlpha').needsUpdate = true;
  g.getAttribute('aColor').needsUpdate = true;
}

interface Fire {
  x: number;
  y: number;
  z: number;
  endSec: number;
  /** 1 = a vehicle; bigger for fuel/large structures. */
  scale: number;
  smokeAcc: number;
  flameAcc: number;
}

export interface GroundEffects {
  ingestEvents(events: readonly SimEvent[]): void;
  tick(dtSec: number, originWorld: Readonly<Vec3Like>, viewportHeightPx: number, fovDeg: number): void;
  dispose(): void;
}

const MAX_FIRES = 48;

export function createGroundEffects(root: THREE.Object3D): GroundEffects {
  const dust = createLayer(root, 700, false, 0.9);
  const smoke = createLayer(root, 1400, false, 0.25);
  const fire = createLayer(root, 500, true, 1.5);
  const fires: Fire[] = [];
  let clock = 0;
  let seed = 1;
  const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

  return {
    ingestEvents(events) {
      for (const ev of events) {
        if (ev.type === 'groundImpact') {
          const { x, y, z } = ev.pos;
          if (ev.explosiveKg <= 0) {
            // Gun round: a spurt of dust.
            for (let k = 0; k < 2; k++) emit(dust, x, y + 0.3, z, (rnd() - 0.5) * 4, 4 + rnd() * 5, (rnd() - 0.5) * 4, 1.0 + rnd() * 0.6, 0.8, 3.5, 0.55, 0.55, 0.49, 0.40);
            continue;
          }
          const c = Math.cbrt(ev.explosiveKg);
          // Fireball (a few hot blobs), then a dust/smoke burst thrown out and up.
          for (let k = 0; k < 6; k++) emit(fire, x + (rnd() - 0.5) * c, y + c * 0.8, z + (rnd() - 0.5) * c, (rnd() - 0.5) * 8 * c, (4 + rnd() * 6) * c, (rnd() - 0.5) * 8 * c, 0.5 + rnd() * 0.5, 2 * c, 7 * c, 0.9, 1.0, 0.55 + rnd() * 0.2, 0.2);
          for (let k = 0; k < 14; k++) {
            const a = rnd() * Math.PI * 2;
            const sp = (3 + rnd() * 9) * c * 0.5;
            emit(dust, x, y + 1, z, Math.cos(a) * sp, (2 + rnd() * 7) * c * 0.6, Math.sin(a) * sp, 3 + rnd() * 3, 2 * c, 10 * c, 0.7, 0.42, 0.37, 0.31);
          }
          for (let k = 0; k < 5; k++) emit(smoke, x + (rnd() - 0.5) * 2 * c, y + c, z + (rnd() - 0.5) * 2 * c, (rnd() - 0.5) * 2, 4 + rnd() * 3, (rnd() - 0.5) * 2, 6 + rnd() * 4, 4 * c, 14 * c, 0.5, 0.18, 0.17, 0.16);
        } else if (ev.type === 'groundKill') {
          if (ev.burnSec <= 0) continue;
          if (fires.length >= MAX_FIRES) fires.shift();
          const big = ev.typeId === 'fuel_tank' || ev.typeId === 'truck-fuel' || ev.typeId === 'hangar' || ev.typeId === 'magazine';
          fires.push({ x: ev.pos.x, y: ev.pos.y, z: ev.pos.z, endSec: clock + ev.burnSec, scale: big ? 2.2 : 1, smokeAcc: 0, flameAcc: 0 });
          // The kill itself: a secondary explosion.
          const c = big ? 4 : 2.5;
          for (let k = 0; k < 8; k++) emit(fire, ev.pos.x, ev.pos.y + 1, ev.pos.z, (rnd() - 0.5) * 12 * c, (3 + rnd() * 8) * c, (rnd() - 0.5) * 12 * c, 0.6 + rnd() * 0.6, 2 * c, 6 * c, 0.9, 1.0, 0.6, 0.25);
        }
      }
    },

    tick(dt, origin, viewportHeightPx, fovDeg) {
      clock += dt;
      for (let i = fires.length - 1; i >= 0; i--) {
        const f = fires[i]!;
        const left = f.endSec - clock;
        if (left <= 0) {
          fires.splice(i, 1);
          continue;
        }
        // Dying down over its last 20 s.
        const s = f.scale * Math.min(1, 0.3 + left / 20);
        f.smokeAcc += dt;
        f.flameAcc += dt;
        while (f.smokeAcc >= 0.22) {
          f.smokeAcc -= 0.22;
          emit(smoke, f.x + (rnd() - 0.5) * 2 * s, f.y + 1.5 * s, f.z + (rnd() - 0.5) * 2 * s, 1.5 + (rnd() - 0.5), 5 + rnd() * 3 * s, 0.6 + (rnd() - 0.5), 12 + rnd() * 6, 4 * s, 22 * s, 0.6, 0.12, 0.115, 0.11);
        }
        while (f.flameAcc >= 0.07) {
          f.flameAcc -= 0.07;
          emit(fire, f.x + (rnd() - 0.5) * 3 * s, f.y + 0.5, f.z + (rnd() - 0.5) * 3 * s, 0, 3 + rnd() * 3, 0, 0.5 + rnd() * 0.4, 2.5 * s, 1 * s, 0.85, 1.0, 0.45 + rnd() * 0.25, 0.12);
        }
      }
      // Point size in pixels = world size * (viewport height / (2 tan(fov/2))) / distance.
      const scale = viewportHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
      for (const l of [dust, smoke, fire]) (l.points.material as THREE.ShaderMaterial).uniforms['uScale']!.value = scale;
      stepLayer(dust, dt, origin, 3);
      stepLayer(smoke, dt, origin, -0.4);
      stepLayer(fire, dt, origin, -2);
    },

    dispose() {
      for (const l of [dust, smoke, fire]) {
        root.remove(l.points);
        l.points.geometry.dispose();
        (l.points.material as THREE.Material).dispose();
      }
    },
  };
}
