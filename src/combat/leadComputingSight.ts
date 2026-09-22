/**
 * src/combat/leadComputingSight.ts — iterative constant-target-velocity
 * ballistic lead solution for the gunsight pipper.
 * See docs/spec/07-combat.md section 4.3 for the exact iteration and a
 * verified worked example.
 */
import type { Vec3Like } from '../contracts/core';
import type { ComputeLeadSolution, LeadSolutionResult } from '../contracts/combat';
import { LEAD_SOLVE_MAX_ITERATIONS, LEAD_SOLVE_MAX_RANGE_M } from '../contracts/combat';

/**
 * Deliberately ignores `shooterVelWorld` in the actual iteration: per
 * 07-combat.md section 4.3's formula block, T0 and every subsequent
 * iteration use only `|predictedPos - shooterPosWorld| / muzzleVelocityMps`
 * — the bullet's closing speed is modelled as muzzleVelocityMps relative to
 * the world, not shooter-relative. The parameter is kept for API symmetry
 * with the rest of this module's kinematic functions (and because a caller
 * with only snapshot data naturally has it on hand) but is not read here.
 */
export const computeLeadSolution: ComputeLeadSolution = (
  shooterPosWorld: Vec3Like,
  _shooterVelWorld: Vec3Like,
  targetPosWorld: Vec3Like,
  targetVelWorld: Vec3Like,
  muzzleVelocityMps: number,
  gravityMps2: number,
  outAimPointWorld: Vec3Like,
): LeadSolutionResult => {
  const rangeX0 = targetPosWorld.x - shooterPosWorld.x;
  const rangeY0 = targetPosWorld.y - shooterPosWorld.y;
  const rangeZ0 = targetPosWorld.z - shooterPosWorld.z;
  let range = Math.sqrt(rangeX0 * rangeX0 + rangeY0 * rangeY0 + rangeZ0 * rangeZ0);
  let T = range / muzzleVelocityMps;

  let predX = targetPosWorld.x;
  let predY = targetPosWorld.y;
  let predZ = targetPosWorld.z;

  for (let k = 0; k < LEAD_SOLVE_MAX_ITERATIONS; k++) {
    predX = targetPosWorld.x + targetVelWorld.x * T;
    predY = targetPosWorld.y + targetVelWorld.y * T;
    predZ = targetPosWorld.z + targetVelWorld.z * T;
    const dx = predX - shooterPosWorld.x;
    const dy = predY - shooterPosWorld.y;
    const dz = predZ - shooterPosWorld.z;
    range = Math.sqrt(dx * dx + dy * dy + dz * dz);
    T = range / muzzleVelocityMps;
  }

  const dropCompensationM = 0.5 * gravityMps2 * T * T;
  const valid = Number.isFinite(T) && T >= 0 && T < 10 && range <= LEAD_SOLVE_MAX_RANGE_M;

  if (valid) {
    outAimPointWorld.x = predX;
    outAimPointWorld.y = predY + dropCompensationM;
    outAimPointWorld.z = predZ;
  } else {
    outAimPointWorld.x = targetPosWorld.x;
    outAimPointWorld.y = targetPosWorld.y;
    outAimPointWorld.z = targetPosWorld.z;
  }

  return { valid, timeOfFlightSec: T, rangeM: range };
};
