import { describe, it, expect } from 'vitest';
import { Mat3, createMat3 } from '../../src/math';

describe('Mat3', () => {
  it('fromInertia + invert + multiply -> identity (worked example)', () => {
    const I = createMat3();
    Mat3.fromInertia({ xx: 12874, yy: 71265, zz: 61948, xy: 0, xz: 1015, yz: 0 }, I);
    expect(I.m00).toBe(12874);
    expect(I.m11).toBe(71265);
    expect(I.m22).toBe(61948);
    expect(I.m02).toBe(1015);
    expect(I.m20).toBe(1015);
    expect(I.m01).toBe(0);
    expect(I.m10).toBe(0);
    expect(I.m12).toBe(0);
    expect(I.m21).toBe(0);

    const inv = createMat3();
    const ok = Mat3.invert(I, inv);
    expect(ok).toBe(true);

    const prod = createMat3();
    Mat3.multiply(I, inv, prod);
    expect(prod.m00).toBeCloseTo(1, 9);
    expect(prod.m11).toBeCloseTo(1, 9);
    expect(prod.m22).toBeCloseTo(1, 9);
    expect(prod.m01).toBeCloseTo(0, 9);
    expect(prod.m02).toBeCloseTo(0, 9);
    expect(prod.m10).toBeCloseTo(0, 9);
    expect(prod.m12).toBeCloseTo(0, 9);
    expect(prod.m20).toBeCloseTo(0, 9);
    expect(prod.m21).toBeCloseTo(0, 9);
  });

  it('invert returns false for a singular matrix and writes identity', () => {
    const m = { m00: 1, m01: 2, m02: 3, m10: 2, m11: 4, m12: 6, m20: 1, m21: 1, m22: 1 };
    const out = createMat3();
    const ok = Mat3.invert(m, out);
    expect(ok).toBe(false);
    expect(out).toEqual({ m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0, m20: 0, m21: 0, m22: 1 });
  });

  it('transformVec3 with identity is a no-op', () => {
    const id = createMat3();
    Mat3.identity(id);
    const out = { x: 0, y: 0, z: 0 };
    Mat3.transformVec3(id, { x: 7, y: 8, z: 9 }, out);
    expect(out).toEqual({ x: 7, y: 8, z: 9 });
  });

  it('determinant of the worked-example inertia tensor', () => {
    const I = createMat3();
    Mat3.fromInertia({ xx: 12874, yy: 71265, zz: 61948, xy: 0, xz: 1015, yz: 0 }, I);
    expect(Mat3.determinant(I)).toBe(56761740623655);
  });

  it('multiply/transpose are safe when out aliases an input', () => {
    const a = { m00: 1, m01: 2, m02: 3, m10: 4, m11: 5, m12: 6, m20: 7, m21: 8, m22: 9 };
    const b = { m00: 9, m01: 8, m02: 7, m10: 6, m11: 5, m12: 4, m20: 3, m21: 2, m22: 1 };
    const expected = createMat3();
    Mat3.multiply(a, b, expected);

    const aCopy = { ...a };
    Mat3.multiply(aCopy, b, aCopy);
    expect(aCopy).toEqual(expected);

    const t = createMat3();
    Mat3.transpose(a, t);
    const aCopy2 = { ...a };
    Mat3.transpose(aCopy2, aCopy2);
    expect(aCopy2).toEqual(t);
  });
});
