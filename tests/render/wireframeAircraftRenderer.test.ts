import { describe, expect, it } from 'vitest';
import { rotateVecByAxisAngle } from '../../src/render/mathInternal';
import { GEAR_TRAVEL_RAD } from '../../src/contracts/render';
import { articulateVertex, computeGroupTheta } from '../../src/render/wireframeAircraftRenderer';

describe('wireframeAircraftRenderer', () => {
  it('rotateVecByAxisAngle: 90deg about Y takes +X to -Z', () => {
    const out = { x: 0, y: 0, z: 0 };
    rotateVecByAxisAngle({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, Math.PI / 2, out);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(out.z).toBeCloseTo(-1, 9);
  });

  it('elevon group: rotates the vertex about the pivot/axis by theta', () => {
    const out = { x: 0, y: 0, z: 0 };
    const theta = 0.1745329; // 10 deg, == elevonL
    articulateVertex({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, theta, out);
    expect(out.x).toBeCloseTo(0.9848078, 6);
    expect(out.y).toBeCloseTo(0.1736482, 6);
    expect(out.z).toBeCloseTo(0, 6);
  });

  it('gear group at gearPos=0 has theta exactly 0', () => {
    expect(computeGroupTheta('mainGearL', { elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0 })).toBe(0);
  });

  it('gear group at gearPos=1 has theta exactly GEAR_TRAVEL_RAD', () => {
    const theta = computeGroupTheta('noseGear', { elevonL: 0, elevonR: 0, rudder: 0, gearPos: 1 });
    expect(theta).toBeCloseTo(GEAR_TRAVEL_RAD, 7);
  });

  it('unknown group name yields theta=0 regardless of field values', () => {
    const theta = computeGroupTheta('flap', { elevonL: 0.5, elevonR: 0.5, rudder: 0.5, gearPos: 1 });
    expect(theta).toBe(0);
  });
});
