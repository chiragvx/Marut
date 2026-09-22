import { describe, it, expect } from 'vitest';
import { Vec3, createVec3 } from '../../src/math';

describe('Vec3', () => {
  it('cross: bodyX x bodyY = bodyZ (right-handed body frame check)', () => {
    const out = createVec3();
    Vec3.cross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, out);
    expect(out).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('add', () => {
    const out = createVec3();
    Vec3.add({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, out);
    expect(out).toEqual({ x: 5, y: 7, z: 9 });
  });

  it('dot', () => {
    expect(Vec3.dot({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 })).toBe(32);
  });

  it('normalize', () => {
    const out = createVec3();
    Vec3.normalize({ x: 3, y: 4, z: 0 }, out);
    expect(out.x).toBeCloseTo(0.6, 9);
    expect(out.y).toBeCloseTo(0.8, 9);
    expect(out.z).toBeCloseTo(0, 9);
  });

  it('normalize of zero vector returns zero, not NaN', () => {
    const out = createVec3(1, 1, 1);
    Vec3.normalize({ x: 0, y: 0, z: 0 }, out);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('lerp', () => {
    const out = createVec3();
    Vec3.lerp({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0.25, out);
    expect(out).toEqual({ x: 2.5, y: 0, z: 0 });
  });

  it('cross is safe when out aliases a', () => {
    const v = { x: 1, y: 0, z: 0 };
    Vec3.cross(v, { x: 0, y: 1, z: 0 }, v);
    expect(v).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('addScaled fuses scale+add', () => {
    const out = createVec3();
    Vec3.addScaled({ x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }, 3, out);
    expect(out).toEqual({ x: 7, y: 7, z: 7 });
  });

  it('length / lengthSq', () => {
    expect(Vec3.length({ x: 3, y: 4, z: 0 })).toBeCloseTo(5, 9);
    expect(Vec3.lengthSq({ x: 3, y: 4, z: 0 })).toBe(25);
  });

  it('equals default epsilon', () => {
    expect(Vec3.equals({ x: 1, y: 2, z: 3 }, { x: 1.0000001, y: 2, z: 3 })).toBe(true);
    expect(Vec3.equals({ x: 1, y: 2, z: 3 }, { x: 1.1, y: 2, z: 3 })).toBe(false);
  });
});
