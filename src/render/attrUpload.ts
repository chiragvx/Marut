/**
 * src/render/attrUpload.ts — upload only the part of a per-frame buffer that is drawn.
 *
 * Dynamic batches (store and ground-unit instances, light sprites, vapour, gun and blast effects)
 * are sized for the worst case and refilled every frame. Flagging the whole attribute dirty sent the
 * whole buffer to the GPU each frame, drawn or not: ~0.9 MB per frame, mostly empty store batches,
 * and most of the main thread's time in bufferSubData on a light frame.
 */
import type * as THREE from 'three';

/** Marks the first `items` items of `attr` for upload this frame; nothing when `items` is 0. */
export function uploadFirst(attr: THREE.BufferAttribute, items: number): void {
  const n = Math.min(items, attr.count);
  if (n <= 0) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, n * attr.itemSize);
  attr.needsUpdate = true;
}
