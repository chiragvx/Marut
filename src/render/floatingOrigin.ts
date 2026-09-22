/**
 * src/render/floatingOrigin.ts
 *
 * `renderOriginWorld` rebase logic. 08-render.md section 4.3 /
 * 00-architecture.md section 7. Pure, allocation-free.
 */

import type { Vec3Like } from '../contracts/core';
import { FLOATING_ORIGIN_REBASE_DISTANCE_M } from '../contracts/core';

/** Mutable floating-origin state, owned by SceneRenderer (one instance). */
export interface FloatingOriginState {
  originWorld: Vec3Like;
  initialized: boolean;
}

export function createFloatingOriginState(): FloatingOriginState {
  return { originWorld: { x: 0, y: 0, z: 0 }, initialized: false };
}

/**
 * True iff `camPos` is strictly more than `FLOATING_ORIGIN_REBASE_DISTANCE_M`
 * from `originWorld`. Strict `>` — exactly 4000 does NOT rebase.
 */
export function shouldRebase(originWorld: Readonly<Vec3Like>, camPos: Readonly<Vec3Like>): boolean {
  const dx = camPos.x - originWorld.x;
  const dy = camPos.y - originWorld.y;
  const dz = camPos.z - originWorld.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) > FLOATING_ORIGIN_REBASE_DISTANCE_M;
}

/** Copies `camPos` into `originWorld` (a rebase). */
export function rebaseOrigin(originWorld: Vec3Like, camPos: Readonly<Vec3Like>): void {
  originWorld.x = camPos.x;
  originWorld.y = camPos.y;
  originWorld.z = camPos.z;
}

/**
 * Call once per `renderFrame`, AFTER this frame's camera world position is
 * known. Initializes the origin to `camPos` on the very first call, then
 * rebases only when `shouldRebase` is true.
 */
export function updateFloatingOrigin(state: FloatingOriginState, camPos: Readonly<Vec3Like>): void {
  if (!state.initialized) {
    rebaseOrigin(state.originWorld, camPos);
    state.initialized = true;
    return;
  }
  if (shouldRebase(state.originWorld, camPos)) {
    rebaseOrigin(state.originWorld, camPos);
  }
}

/**
 * `out = worldPos - originWorld` (a float64 subtraction of two numbers close
 * in magnitude by construction, hence safe to hand to Three.js's float32
 * storage). `originWorld` first, `worldPos` second — matches this file's
 * `shouldRebase`/`rebaseOrigin` argument order (reference frame first).
 */
export function localPos(originWorld: Readonly<Vec3Like>, worldPos: Readonly<Vec3Like>, out: Vec3Like): Vec3Like {
  out.x = worldPos.x - originWorld.x;
  out.y = worldPos.y - originWorld.y;
  out.z = worldPos.z - originWorld.z;
  return out;
}
