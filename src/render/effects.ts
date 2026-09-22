/**
 * src/render/effects.ts
 *
 * Pooled, instanced explosion/muzzle-flash/smoke-trail visuals driven by
 * SimEvents (08-render.md section 4.12), plus bullet tracers drawn directly
 * from snapshot `kind==='bullet'` entities every frame (kept here since
 * bullets have no WireframeModel).
 */

import * as THREE from 'three';
import { EntityKindCode, type SimEvent, type Vec3Like } from '../contracts/core';
import { vec3Normalize } from './mathInternal';
import { createInterpolatedEntity, interpolateEntity, type SnapshotDoubleBuffer } from './snapshotInterpolation';

// Table 5.7.
export const EXPLOSION_LIFETIME_SEC = 1.2;
export const EXPLOSION_VISUAL_SCALE = 1.0;
export const MUZZLE_FLASH_LIFETIME_SEC = 0.05;
export const BULLET_TRACER_LENGTH_M = 15;
export const SMOKE_TRAIL_EMIT_INTERVAL_SEC = 0.05;
export const SMOKE_TRAIL_PARTICLE_LIFETIME_SEC = 2.5;

const MAX_BULLET_TRACERS = 128;
const MAX_SMOKE_EMITTERS = 32;
const MUZZLE_FLASH_SCALE_M = 1.2;
const SMOKE_PARTICLE_PEAK_SCALE_M = 2.5;

// -----------------------------------------------------------------------------
// Generic fixed-capacity instanced pool (explosion / muzzleFlash / smokeTrail).
// -----------------------------------------------------------------------------

interface InstancePool {
  mesh: THREE.InstancedMesh;
  absX: Float64Array;
  absY: Float64Array;
  absZ: Float64Array;
  ageSec: Float32Array;
  lifetimeSec: Float32Array;
  peakScale: Float32Array;
  active: Uint8Array;
  capacity: number;
}

function createPool(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, root: THREE.Object3D): InstancePool {
  const cap = Math.max(capacity, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, cap);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  root.add(mesh);
  return {
    mesh,
    absX: new Float64Array(cap),
    absY: new Float64Array(cap),
    absZ: new Float64Array(cap),
    ageSec: new Float32Array(cap),
    lifetimeSec: new Float32Array(cap),
    peakScale: new Float32Array(cap),
    active: new Uint8Array(cap),
    capacity: cap,
  };
}

function acquireSlot(pool: InstancePool): number {
  for (let i = 0; i < pool.capacity; i++) {
    if (!pool.active[i]) return i;
  }
  return -1;
}

function spawnInPool(pool: InstancePool, pos: Readonly<Vec3Like>, lifetimeSec: number, peakScale: number): void {
  const slot = acquireSlot(pool);
  if (slot === -1) return; // pool exhausted — drop silently, never grow.
  pool.absX[slot] = pos.x;
  pool.absY[slot] = pos.y;
  pool.absZ[slot] = pos.z;
  pool.ageSec[slot] = 0;
  pool.lifetimeSec[slot] = lifetimeSec;
  pool.peakScale[slot] = peakScale;
  pool.active[slot] = 1;
}

const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchMat = new THREE.Matrix4();

/** Grow-then-fade radius curve over the instance's lifetime, 0..1 fraction. */
function radiusFraction(lifeFrac: number): number {
  const grow = Math.min(lifeFrac * 4, 1);
  const fade = 1 - lifeFrac * 0.3;
  return Math.max(grow * fade, 0.001);
}

function tickPool(pool: InstancePool, dtSec: number, originWorld: Readonly<Vec3Like>): void {
  let highestActive = -1;
  for (let i = 0; i < pool.capacity; i++) {
    if (!pool.active[i]) continue;
    pool.ageSec[i]! += dtSec;
    if (pool.ageSec[i]! >= pool.lifetimeSec[i]!) {
      pool.active[i] = 0;
      continue;
    }
    const lifeFrac = pool.ageSec[i]! / pool.lifetimeSec[i]!;
    const scale = pool.peakScale[i]! * radiusFraction(lifeFrac);
    scratchPos.set(pool.absX[i]! - originWorld.x, pool.absY[i]! - originWorld.y, pool.absZ[i]! - originWorld.z);
    scratchQuat.identity();
    scratchScale.set(scale, scale, scale);
    scratchMat.compose(scratchPos, scratchQuat, scratchScale);
    pool.mesh.setMatrixAt(i, scratchMat);
    if (i > highestActive) highestActive = i;
  }
  pool.mesh.count = highestActive + 1;
  pool.mesh.instanceMatrix.needsUpdate = true;
}

function disposePool(pool: InstancePool, root: THREE.Object3D): void {
  root.remove(pool.mesh);
  pool.mesh.geometry.dispose();
  (pool.mesh.material as THREE.Material).dispose();
}

// -----------------------------------------------------------------------------
// Smoke-trail emitters (one per in-flight missile, tracked by EntityId).
// -----------------------------------------------------------------------------

interface SmokeEmitter {
  missileId: number;
  active: boolean;
  lastEmitSec: number;
}

// -----------------------------------------------------------------------------
// Bullet tracers: drawn directly from snapshot entities every frame, not a
// pooled EffectKind (08-render.md section 4.12).
// -----------------------------------------------------------------------------

function createTracerLineSegments(): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(MAX_BULLET_TRACERS * 2 * 3);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setDrawRange(0, 0);
  const material = new THREE.LineBasicMaterial({ color: 0xfff2b0 });
  const seg = new THREE.LineSegments(geometry, material);
  seg.frustumCulled = false;
  return seg;
}

export interface EffectsSystem {
  /** Reallocates pools to match a new tier's effectBudget (rare, tier-change-only — see 08-render.md section 4.12). */
  setBudget(effectBudget: number): void;
  ingestEvents(events: readonly SimEvent[]): void;
  /** Ages/repositions all resident pooled effect instances. Call once per rendered frame. */
  tick(dtSec: number, originWorld: Readonly<Vec3Like>): void;
  /** Redraws bullet tracers and deposits smoke-trail particles from this frame's interpolated snapshot. */
  syncFromSnapshot(buf: SnapshotDoubleBuffer, f: number, originWorld: Readonly<Vec3Like>): void;
  dispose(): void;
}

export function createEffectsSystem(root: THREE.Object3D): EffectsSystem {
  let explosionPool: InstancePool;
  let muzzlePool: InstancePool;
  let smokePool: InstancePool;

  const explosionGeometry = new THREE.SphereGeometry(1, 10, 6);
  const explosionMaterial = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85 });
  const muzzleGeometry = new THREE.SphereGeometry(1, 6, 4);
  const muzzleMaterial = new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.9 });
  const smokeGeometry = new THREE.SphereGeometry(1, 6, 4);
  const smokeMaterial = new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.4 });

  function allocatePools(effectBudget: number): void {
    if (explosionPool) disposePool(explosionPool, root);
    if (muzzlePool) disposePool(muzzlePool, root);
    if (smokePool) disposePool(smokePool, root);
    const explosionCap = Math.floor(effectBudget * 0.4);
    const muzzleCap = Math.floor(effectBudget * 0.2);
    const smokeCap = Math.floor(effectBudget * 0.4);
    explosionPool = createPool(explosionGeometry, explosionMaterial, explosionCap, root);
    muzzlePool = createPool(muzzleGeometry, muzzleMaterial, muzzleCap, root);
    smokePool = createPool(smokeGeometry, smokeMaterial, smokeCap, root);
  }
  allocatePools(32);

  const tracers = createTracerLineSegments();
  root.add(tracers);

  const emitters: SmokeEmitter[] = [];
  let simClockSec = 0;
  const scratchInterp = createInterpolatedEntity();
  const scratchTailDir: Vec3Like = { x: 0, y: 0, z: 0 };

  function findEntitySlot(buf: SnapshotDoubleBuffer, entityId: number): number {
    const curr = buf.curr;
    for (let i = 0; i < curr.entityCount; i++) {
      if (curr.id[i] === entityId) return i;
    }
    return -1;
  }

  return {
    setBudget(effectBudget) {
      allocatePools(effectBudget);
    },

    ingestEvents(events) {
      for (let i = 0; i < events.length; i++) {
        const ev = events[i]!;
        if (ev.type === 'explosion') {
          spawnInPool(explosionPool, ev.pos, EXPLOSION_LIFETIME_SEC, ev.radiusM * EXPLOSION_VISUAL_SCALE);
        } else if (ev.type === 'gunFire') {
          spawnInPool(muzzlePool, ev.pos, MUZZLE_FLASH_LIFETIME_SEC, MUZZLE_FLASH_SCALE_M);
        } else if (ev.type === 'missileLaunch') {
          let emitter = emitters.find((e) => e.missileId === ev.missileId);
          if (!emitter) {
            if (emitters.length < MAX_SMOKE_EMITTERS) {
              emitter = { missileId: ev.missileId, active: true, lastEmitSec: -Infinity };
              emitters.push(emitter);
            }
          } else {
            emitter.active = true;
            emitter.lastEmitSec = -Infinity;
          }
        }
      }
    },

    tick(dtSec, originWorld) {
      simClockSec += dtSec;
      tickPool(explosionPool, dtSec, originWorld);
      tickPool(muzzlePool, dtSec, originWorld);
      tickPool(smokePool, dtSec, originWorld);
    },

    syncFromSnapshot(buf, f, originWorld) {
      // Bullet tracers.
      const curr = buf.curr;
      let tracerCount = 0;
      const posArr = (tracers.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      for (let i = 0; i < curr.entityCount && tracerCount < MAX_BULLET_TRACERS; i++) {
        if (curr.alive[i] !== 1 || curr.kind[i] !== EntityKindCode.bullet) continue;
        interpolateEntity(buf, i, f, scratchInterp);
        vec3Normalize(scratchInterp.vel, scratchTailDir);
        const headX = scratchInterp.pos.x - originWorld.x;
        const headY = scratchInterp.pos.y - originWorld.y;
        const headZ = scratchInterp.pos.z - originWorld.z;
        const tailX = headX - scratchTailDir.x * BULLET_TRACER_LENGTH_M;
        const tailY = headY - scratchTailDir.y * BULLET_TRACER_LENGTH_M;
        const tailZ = headZ - scratchTailDir.z * BULLET_TRACER_LENGTH_M;
        const base = tracerCount * 6;
        posArr[base] = headX;
        posArr[base + 1] = headY;
        posArr[base + 2] = headZ;
        posArr[base + 3] = tailX;
        posArr[base + 4] = tailY;
        posArr[base + 5] = tailZ;
        tracerCount++;
      }
      (tracers.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      tracers.geometry.setDrawRange(0, tracerCount * 2);

      // Smoke-trail emitters.
      for (let e = 0; e < emitters.length; e++) {
        const emitter = emitters[e]!;
        if (!emitter.active) continue;
        const slot = findEntitySlot(buf, emitter.missileId);
        if (slot === -1 || curr.alive[slot] !== 1) {
          emitter.active = false;
          continue;
        }
        if (simClockSec - emitter.lastEmitSec >= SMOKE_TRAIL_EMIT_INTERVAL_SEC) {
          interpolateEntity(buf, slot, f, scratchInterp);
          spawnInPool(smokePool, scratchInterp.pos, SMOKE_TRAIL_PARTICLE_LIFETIME_SEC, SMOKE_PARTICLE_PEAK_SCALE_M);
          emitter.lastEmitSec = simClockSec;
        }
      }
    },

    dispose() {
      disposePool(explosionPool, root);
      disposePool(muzzlePool, root);
      disposePool(smokePool, root);
      root.remove(tracers);
      tracers.geometry.dispose();
      (tracers.material as THREE.Material).dispose();
      explosionGeometry.dispose();
      muzzleGeometry.dispose();
      smokeGeometry.dispose();
    },
  };
}
