/**
 * src/render/effects.ts
 *
 * The weapons' effects driven by SimEvents (08-render.md section 4.12): the gun (muzzle flash, gun
 * smoke, tracers), missiles' and rockets' motors and smoke trails, explosions in the air, flares
 * and chaff, all drawn by src/render/weaponFx.ts on the aircraft as drawn (the interpolated
 * snapshot, or a cinematic shot's frame).
 */

import * as THREE from 'three';
import type { SimEvent, Vec3Like } from '../contracts/core';
import type { ShowcaseFrame } from '../contracts/render';
import type { SnapshotDoubleBuffer } from './snapshotInterpolation';
import { createWeaponFx, showcasePoses, snapshotPoses } from './weaponFx';

export interface EffectsSystem {
  /** Kept for the quality tiers (the effects are fixed-size pools). */
  setBudget(effectBudget: number): void;
  ingestEvents(events: readonly SimEvent[]): void;
  /** Ages and redraws the effects. Call once per rendered frame. */
  tick(dtSec: number, originWorld: Readonly<Vec3Like>): void;
  /** The flight as drawn this frame (the interpolated snapshot). */
  syncFromSnapshot(buf: SnapshotDoubleBuffer, f: number, originWorld: Readonly<Vec3Like>): void;
  /** A cinematic shot's frame as drawn. */
  syncShowcase(frame: ShowcaseFrame, originWorld: Readonly<Vec3Like>): void;
  /** Clears every effect. */
  reset(): void;
  /** The drawing buffer's size, px (sizes on screen). */
  setView(widthPx: number, heightPx: number): void;
  dispose(): void;
}

export function createEffectsSystem(root: THREE.Object3D): EffectsSystem {
  const weaponFx = createWeaponFx(root);
  return {
    setBudget() {},
    ingestEvents(events) {
      for (const ev of events) {
        if (ev.type === 'explosion' || ev.type === 'gunFire' || ev.type === 'countermeasure' || ev.type === 'missileLaunch') weaponFx.ingest(ev);
      }
    },
    tick(dtSec, originWorld) {
      weaponFx.tick(dtSec, originWorld);
    },
    syncFromSnapshot(buf, f, originWorld) {
      weaponFx.sync(snapshotPoses(buf, f), originWorld);
    },
    syncShowcase(frame, originWorld) {
      weaponFx.sync(showcasePoses(frame), originWorld);
    },
    reset() {
      weaponFx.reset();
    },
    setView(w, h) {
      weaponFx.setView(w, h);
    },
    dispose() {
      weaponFx.dispose();
    },
  };
}
