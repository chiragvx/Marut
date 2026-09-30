/**
 * src/render/effects.ts
 *
 * Pooled, instanced explosion/muzzle-flash/smoke-trail visuals driven by
 * SimEvents (08-render.md section 4.12), plus bullet tracers drawn directly
 * from snapshot `kind==='bullet'` entities every frame (kept here since
 * bullets have no WireframeModel), and countermeasures: a burning flare (bright,
 * flickering, trailing smoke as it falls) and a chaff bloom (a silver-grey puff).
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
/** Flares / chaff drawn at once, and how they look (they fly on here as the sim flies them: see src/combat/countermeasures.ts). */
const MAX_DECOY_VISUALS = 64;
const FLARE_VISUAL_LIFE_SEC = 4;
const CHAFF_VISUAL_LIFE_SEC = 3.5;
const FLARE_GLOW_M = 3;
/** Soft halo round each flare, times the core, and its opacity. */
const FLARE_HALO_SCALE = 4;
const FLARE_SMOKE_INTERVAL_SEC = 0.07;
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
const scratchSmokePos = { x: 0, y: 0, z: 0 };

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

interface DecoyVisual {
  active: boolean;
  flare: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ageSec: number;
  lastSmokeSec: number;
}

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

/** A soft round glow (radial falloff) for additive sprites. */
function createGlowTexture(): THREE.Texture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const a = Math.max(0, 1 - r);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(255 * a * a * a);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

/** Up to MAX_DECOY_VISUALS additive glow sprites `sizeM` across, one per point (positions filled per frame). */
function createGlowPoints(texture: THREE.Texture, color: number, sizeM: number, opacity: number): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_DECOY_VISUALS * 3), 3));
  geometry.setDrawRange(0, 0);
  const material = new THREE.PointsMaterial({ map: texture, color, size: sizeM, sizeAttenuation: true, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
  const pts = new THREE.Points(geometry, material);
  pts.frustumCulled = false;
  return pts;
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
  let chaffPool: InstancePool;

  const explosionGeometry = new THREE.SphereGeometry(1, 10, 6);
  const explosionMaterial = new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85 });
  const muzzleGeometry = new THREE.SphereGeometry(1, 6, 4);
  const muzzleMaterial = new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.9 });
  const smokeGeometry = new THREE.SphereGeometry(1, 6, 4);
  const smokeMaterial = new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.4 });
  const chaffMaterial = new THREE.MeshBasicMaterial({ color: 0xc8ccd4, transparent: true, opacity: 0.35, depthWrite: false });
  // Burning flares: a white-hot core and a soft orange halo, both additive soft-edged sprites.
  const glowTexture = createGlowTexture();
  const flarePoints = createGlowPoints(glowTexture, 0xffffff, FLARE_GLOW_M * 2, 1);
  const haloPoints = createGlowPoints(glowTexture, 0xffb060, FLARE_GLOW_M * 2 * FLARE_HALO_SCALE, 0.45);
  root.add(flarePoints);
  root.add(haloPoints);
  const decoys: DecoyVisual[] = Array.from({ length: MAX_DECOY_VISUALS }, () => ({ active: false, flare: true, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ageSec: 0, lastSmokeSec: 0 }));

  function allocatePools(effectBudget: number): void {
    if (explosionPool) disposePool(explosionPool, root);
    if (muzzlePool) disposePool(muzzlePool, root);
    if (smokePool) disposePool(smokePool, root);
    if (chaffPool) disposePool(chaffPool, root);
    const explosionCap = Math.floor(effectBudget * 0.4);
    const muzzleCap = Math.floor(effectBudget * 0.2);
    const smokeCap = Math.floor(effectBudget * 0.4);
    explosionPool = createPool(explosionGeometry, explosionMaterial, explosionCap, root);
    muzzlePool = createPool(muzzleGeometry, muzzleMaterial, muzzleCap, root);
    smokePool = createPool(smokeGeometry, smokeMaterial, smokeCap, root);
    chaffPool = createPool(new THREE.SphereGeometry(1, 6, 4), chaffMaterial, Math.max(8, Math.floor(effectBudget * 0.25)), root);
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
        } else if (ev.type === 'countermeasure') {
          const d = decoys.find((x) => !x.active);
          if (d) {
            d.active = true;
            d.flare = ev.kind === 'flare';
            d.x = ev.pos.x; d.y = ev.pos.y; d.z = ev.pos.z;
            d.vx = ev.vel.x; d.vy = ev.vel.y; d.vz = ev.vel.z;
            d.ageSec = 0;
            d.lastSmokeSec = -1;
          }
          if (ev.kind === 'chaff') spawnInPool(chaffPool, ev.pos, CHAFF_VISUAL_LIFE_SEC, 7);
        } else if (ev.type === 'missileLaunch') {
          // Bombs fall without a smoke trail.
          if (ev.weapon === 'bomb' || ev.weapon === 'guided_bomb') continue;
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
      tickPool(chaffPool, dtSec, originWorld);
      // Flares fall (slowing to ~40 m/s) and burn out; chaff drifts (its bloom is the chaff pool).
      let n = 0;
      for (const d of decoys) {
        if (!d.active) continue;
        d.ageSec += dtSec;
        const life = d.flare ? FLARE_VISUAL_LIFE_SEC : CHAFF_VISUAL_LIFE_SEC;
        if (d.ageSec >= life) {
          d.active = false;
          continue;
        }
        const k = Math.min(1, dtSec / (d.flare ? 1.5 : 0.2));
        d.vx -= d.vx * k;
        d.vy += ((d.flare ? -40 : -2) - d.vy) * k;
        d.vz -= d.vz * k;
        d.x += d.vx * dtSec;
        d.y += d.vy * dtSec;
        d.z += d.vz * dtSec;
        if (!d.flare) continue;
        if (d.ageSec - d.lastSmokeSec >= FLARE_SMOKE_INTERVAL_SEC) {
          scratchSmokePos.x = d.x; scratchSmokePos.y = d.y; scratchSmokePos.z = d.z;
          spawnInPool(smokePool, scratchSmokePos, 2.2, 2.6);
          d.lastSmokeSec = d.ageSec;
        }
        const fp = (flarePoints.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
        fp[n * 3] = d.x - originWorld.x;
        fp[n * 3 + 1] = d.y - originWorld.y;
        fp[n * 3 + 2] = d.z - originWorld.z;
        n++;
      }
      // Flicker and burn-down, shared by all flares (one material): fine at this size.
      (flarePoints.material as THREE.PointsMaterial).opacity = 0.85 + 0.15 * Math.sin(simClockSec * 47);
      for (const pts of [flarePoints, haloPoints]) {
        if (pts === haloPoints) {
          const src = (flarePoints.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
          ((haloPoints.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array).set(src.subarray(0, n * 3));
        }
        pts.geometry.getAttribute('position').needsUpdate = true;
        pts.geometry.setDrawRange(0, n);
      }
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
      disposePool(chaffPool, root);
      for (const pts of [flarePoints, haloPoints]) {
        root.remove(pts);
        pts.geometry.dispose();
        (pts.material as THREE.Material).dispose();
      }
      glowTexture.dispose();
      root.remove(tracers);
      tracers.geometry.dispose();
      (tracers.material as THREE.Material).dispose();
      explosionGeometry.dispose();
      muzzleGeometry.dispose();
      smokeGeometry.dispose();
    },
  };
}
