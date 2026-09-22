/**
 * src/ai/formation.ts — formation-keeping geometry utilities.
 * See docs/spec/06-ai.md section 4.10.
 */
import type { Vec3Like } from '../contracts/core';
import type { HeadingFromVelocity, ComputeAspectAngleRad, ComputeFormationTargetPos, AiFormationSlot } from '../contracts/ai';
import { ThreatWeights } from '../contracts/ai';
import { wrapAngleSigned } from '../math';

export const headingFromVelocity: HeadingFromVelocity = (velWorld) => {
  const speedSq = velWorld.x * velWorld.x + velWorld.z * velWorld.z;
  const minSpeed = ThreatWeights.MIN_SPEED_FOR_HEADING_MPS;
  if (speedSq < minSpeed * minSpeed) return 0;
  return Math.atan2(velWorld.x, -velWorld.z);
};

export const computeAspectAngleRad: ComputeAspectAngleRad = (observedHeadingRad, observedPos, observerPos) => {
  const dx = observerPos.x - observedPos.x;
  const dz = observerPos.z - observedPos.z;
  const bearingObservedToObserverRad = Math.atan2(dx, -dz);
  return wrapAngleSigned(bearingObservedToObserverRad - observedHeadingRad);
};

export const computeFormationTargetPos: ComputeFormationTargetPos = (leaderPos, leaderVelWorld, slot, out) => {
  const h = headingFromVelocity(leaderVelWorld);
  const forwardX = Math.sin(h);
  const forwardZ = -Math.cos(h);
  const rightX = Math.cos(h);
  const rightZ = Math.sin(h);
  out.x = leaderPos.x + rightX * slot.slotRightM - forwardX * slot.slotBackM;
  out.y = leaderPos.y + slot.slotUpM;
  out.z = leaderPos.z + rightZ * slot.slotRightM - forwardZ * slot.slotBackM;
  return out;
};

/** World heading (rad) of a relative world-frame delta (dx, dz), same formula as HeadingFromVelocity's atan2 branch. Used by weaponEmployment's gun lead bearing and by the formation-follow bank formula. */
export function headingOfDelta(dx: number, dz: number): number {
  return Math.atan2(dx, -dz);
}

/** Bearing (rad, [-PI,PI], + = right of nose) from `selfPos`/`selfHeadingRad` to `pointWorld`. */
export function bearingToPointRad(selfPos: Readonly<Vec3Like>, selfHeadingRad: number, pointWorld: Readonly<Vec3Like>): number {
  const dx = pointWorld.x - selfPos.x;
  const dz = pointWorld.z - selfPos.z;
  return wrapAngleSigned(headingOfDelta(dx, dz) - selfHeadingRad);
}

/** Box-Muller Gaussian sample (mean 0, std 1) drawn from a mulberry32 PrngState, with the second sample of each pair cached. `cache` is a one-slot, caller-owned holder (`{ value: undefined }` initially) so no closure/allocation is needed per call. */
export interface GaussianCache {
  value: number | undefined;
}
export function nextGaussian(rng: { s: number }, cache: GaussianCache, nextFloat01: (s: { s: number }) => number): number {
  if (cache.value !== undefined) {
    const v = cache.value;
    cache.value = undefined;
    return v;
  }
  let u1 = nextFloat01(rng);
  if (u1 < 1e-12) u1 = 1e-12;
  const u2 = nextFloat01(rng);
  const radius = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  cache.value = radius * Math.sin(theta);
  return radius * Math.cos(theta);
}

export type { AiFormationSlot };
