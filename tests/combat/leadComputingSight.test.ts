import { describe, it, expect } from 'vitest';
import { computeLeadSolution, GUN_MUZZLE_VELOCITY_MPS } from '../../src/combat';
import { GRAVITY_MPS2 } from '../../src/contracts/core';

describe('computeLeadSolution', () => {
  it('matches the 07-combat.md section 4.3 worked example', () => {
    const out = { x: 0, y: 0, z: 0 };
    const shooterPos = { x: 0, y: 0, z: 0 };
    const shooterVel = { x: 0, y: 0, z: 0 };
    const targetPos = { x: 1000, y: 0, z: 0 };
    const targetVel = { x: 0, y: 0, z: 50 };

    const result = computeLeadSolution(shooterPos, shooterVel, targetPos, targetVel, GUN_MUZZLE_VELOCITY_MPS, GRAVITY_MPS2, out);

    expect(result.valid).toBe(true);
    expect(result.timeOfFlightSec).toBeCloseTo(1.40203, 4);
    expect(out.x).toBeCloseTo(1000.0, 1);
    expect(out.y).toBeCloseTo(9.638, 1);
    expect(out.z).toBeCloseTo(70.10, 1);
  });

  it('is invalid when the target outruns a slow simulated muzzle velocity', () => {
    const out = { x: 0, y: 0, z: 0 };
    const shooterPos = { x: 0, y: 0, z: 0 };
    const shooterVel = { x: 0, y: 0, z: 0 };
    const targetPos = { x: 1000, y: 0, z: 0 };
    const targetVel = { x: 2000, y: 0, z: 0 };

    const result = computeLeadSolution(shooterPos, shooterVel, targetPos, targetVel, 100, GRAVITY_MPS2, out);

    expect(result.valid).toBe(false);
  });
});
