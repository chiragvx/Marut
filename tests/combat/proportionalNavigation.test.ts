import { describe, it, expect } from 'vitest';
import { computePnAccel } from '../../src/combat';
import { IR_PN_GAIN, IR_MAX_G } from '../../src/combat';
import { GRAVITY_MPS2 } from '../../src/contracts/core';

describe('computePnAccel', () => {
  it('matches the 07-combat.md section 4.7 worked example', () => {
    const out = { x: 0, y: 0, z: 0 };
    const missilePos = { x: 0, y: 0, z: 0 };
    const missileVel = { x: 200, y: 0, z: 0 };
    const targetPos = { x: 2000, y: 0, z: 500 };
    const targetVel = { x: 0, y: 0, z: 0 };
    const maxAccelMps2 = IR_MAX_G * GRAVITY_MPS2;

    computePnAccel(missilePos, missileVel, targetPos, targetVel, IR_PN_GAIN, maxAccelMps2, out);

    expect(out.x).toBeCloseTo(-3.874, 2);
    expect(out.y).toBeCloseTo(0, 2);
    expect(out.z).toBeCloseTo(15.505, 2);

    const mag = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
    expect(mag).toBeCloseTo(15.98, 2);
  });

  it('returns (0,0,0) when not closing (Vc <= 0)', () => {
    const out = { x: 1, y: 1, z: 1 };
    const missilePos = { x: 0, y: 0, z: 0 };
    const missileVel = { x: 0, y: 0, z: 0 };
    const targetPos = { x: 1000, y: 0, z: 0 };
    const targetVel = { x: 500, y: 0, z: 0 }; // receding faster than missile approaches (missile stationary)

    computePnAccel(missilePos, missileVel, targetPos, targetVel, IR_PN_GAIN, IR_MAX_G * GRAVITY_MPS2, out);

    expect(out).toEqual({ x: 0, y: 0, z: 0 });
  });
});
