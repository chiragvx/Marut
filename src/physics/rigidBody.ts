/**
 * src/physics/rigidBody.ts — semi-implicit (symplectic) Euler translational
 * and rotational integration given a total body-frame moment and world-frame
 * force. See docs/spec/02-flight-model.md section 4.10.
 *
 * Allocation-free: all scratch Vec3s are module-level, reused every call.
 */
import type { EntityState, Vec3Like } from '../contracts/core';
import type { Mat3 as Mat3Type } from '../contracts/math';
import { Vec3, Mat3, Quat } from '../math';

const scratchAccelWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchIOmega: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchGyroTerm: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchNetMoment: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchOmegaDot: Vec3Like = { x: 0, y: 0, z: 0 };

/**
 * Integrates `out`'s vel/pos/omega/rot in place by `dtSub`, given this
 * substep's total world-frame force and total body-frame moment.
 * `inertiaBody`/`inertiaBodyInverse` are the aircraft's precomputed (once
 * per distinct AircraftDefinition) body-frame inertia tensor and its
 * inverse — see `integrator.ts`'s cache.
 */
export function integrateRigidBody(
  out: EntityState,
  totalForceWorld: Readonly<Vec3Like>,
  totalMomentBody: Readonly<Vec3Like>,
  massKg: number,
  inertiaBody: Readonly<Mat3Type>,
  inertiaBodyInverse: Readonly<Mat3Type>,
  dtSub: number
): void {
  // Translational: velocity first, then position from the NEW velocity.
  Vec3.scale(totalForceWorld, 1 / massKg, scratchAccelWorld);
  Vec3.addScaled(out.vel, scratchAccelWorld, dtSub, out.vel);
  Vec3.addScaled(out.pos, out.vel, dtSub, out.pos);

  // Rotational: Euler's equation, I*omegaDot = M - omega x (I*omega).
  Mat3.transformVec3(inertiaBody, out.omega, scratchIOmega);
  Vec3.cross(out.omega, scratchIOmega, scratchGyroTerm);
  Vec3.sub(totalMomentBody, scratchGyroTerm, scratchNetMoment);
  Mat3.transformVec3(inertiaBodyInverse, scratchNetMoment, scratchOmegaDot);
  Vec3.addScaled(out.omega, scratchOmegaDot, dtSub, out.omega);

  // Orientation from the NEW omega, renormalized.
  Quat.integrate(out.rot, out.omega, dtSub, out.rot);
}
