/**
 * src/math/mat3.ts — mutable row-major 3x3 matrix (body-frame inertia tensor ops).
 * Implements contracts/math.ts's Mat3Static. See docs/spec/01-math.md section 4.6.
 */
import type { Mat3 as Mat3Type, Mat3Static, CreateMat3 } from '../contracts/math';
import { MAT3_INVERT_EPSILON, DEFAULT_EPSILON } from '../contracts/math';

export const Mat3: Mat3Static = {
  identity(out) {
    out.m00 = 1; out.m01 = 0; out.m02 = 0;
    out.m10 = 0; out.m11 = 1; out.m12 = 0;
    out.m20 = 0; out.m21 = 0; out.m22 = 1;
    return out;
  },
  set(out, m00, m01, m02, m10, m11, m12, m20, m21, m22) {
    out.m00 = m00; out.m01 = m01; out.m02 = m02;
    out.m10 = m10; out.m11 = m11; out.m12 = m12;
    out.m20 = m20; out.m21 = m21; out.m22 = m22;
    return out;
  },
  copy(out, src) {
    out.m00 = src.m00; out.m01 = src.m01; out.m02 = src.m02;
    out.m10 = src.m10; out.m11 = src.m11; out.m12 = src.m12;
    out.m20 = src.m20; out.m21 = src.m21; out.m22 = src.m22;
    return out;
  },
  fromInertia(i, out) {
    const xx = i.xx, yy = i.yy, zz = i.zz, xy = i.xy, xz = i.xz, yz = i.yz;
    out.m00 = xx; out.m01 = xy; out.m02 = xz;
    out.m10 = xy; out.m11 = yy; out.m12 = yz;
    out.m20 = xz; out.m21 = yz; out.m22 = zz;
    return out;
  },
  multiply(a, b, out) {
    const a00 = a.m00, a01 = a.m01, a02 = a.m02;
    const a10 = a.m10, a11 = a.m11, a12 = a.m12;
    const a20 = a.m20, a21 = a.m21, a22 = a.m22;
    const b00 = b.m00, b01 = b.m01, b02 = b.m02;
    const b10 = b.m10, b11 = b.m11, b12 = b.m12;
    const b20 = b.m20, b21 = b.m21, b22 = b.m22;

    out.m00 = a00 * b00 + a01 * b10 + a02 * b20;
    out.m01 = a00 * b01 + a01 * b11 + a02 * b21;
    out.m02 = a00 * b02 + a01 * b12 + a02 * b22;

    out.m10 = a10 * b00 + a11 * b10 + a12 * b20;
    out.m11 = a10 * b01 + a11 * b11 + a12 * b21;
    out.m12 = a10 * b02 + a11 * b12 + a12 * b22;

    out.m20 = a20 * b00 + a21 * b10 + a22 * b20;
    out.m21 = a20 * b01 + a21 * b11 + a22 * b21;
    out.m22 = a20 * b02 + a21 * b12 + a22 * b22;
    return out;
  },
  transpose(m, out) {
    const m01 = m.m01, m02 = m.m02, m12 = m.m12;
    const m10 = m.m10, m20 = m.m20, m21 = m.m21;
    const m00 = m.m00, m11 = m.m11, m22 = m.m22;
    out.m00 = m00; out.m11 = m11; out.m22 = m22;
    out.m01 = m10; out.m10 = m01;
    out.m02 = m20; out.m20 = m02;
    out.m12 = m21; out.m21 = m12;
    return out;
  },
  determinant(m) {
    const a = m.m00, b = m.m01, c = m.m02;
    const d = m.m10, e = m.m11, f = m.m12;
    const g = m.m20, h = m.m21, i = m.m22;
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  },
  invert(m, out) {
    const a = m.m00, b = m.m01, c = m.m02;
    const d = m.m10, e = m.m11, f = m.m12;
    const g = m.m20, h = m.m21, i = m.m22;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < MAT3_INVERT_EPSILON) {
      Mat3.identity(out);
      return false;
    }
    const invDet = 1 / det;
    out.m00 = (e * i - f * h) * invDet;
    out.m01 = -(b * i - c * h) * invDet;
    out.m02 = (b * f - c * e) * invDet;
    out.m10 = -(d * i - f * g) * invDet;
    out.m11 = (a * i - c * g) * invDet;
    out.m12 = -(a * f - c * d) * invDet;
    out.m20 = (d * h - e * g) * invDet;
    out.m21 = -(a * h - b * g) * invDet;
    out.m22 = (a * e - b * d) * invDet;
    return true;
  },
  transformVec3(m, v, out) {
    const vx = v.x, vy = v.y, vz = v.z;
    out.x = m.m00 * vx + m.m01 * vy + m.m02 * vz;
    out.y = m.m10 * vx + m.m11 * vy + m.m12 * vz;
    out.z = m.m20 * vx + m.m21 * vy + m.m22 * vz;
    return out;
  },
  equals(a, b, epsilon = DEFAULT_EPSILON) {
    return (
      Math.abs(a.m00 - b.m00) <= epsilon &&
      Math.abs(a.m01 - b.m01) <= epsilon &&
      Math.abs(a.m02 - b.m02) <= epsilon &&
      Math.abs(a.m10 - b.m10) <= epsilon &&
      Math.abs(a.m11 - b.m11) <= epsilon &&
      Math.abs(a.m12 - b.m12) <= epsilon &&
      Math.abs(a.m20 - b.m20) <= epsilon &&
      Math.abs(a.m21 - b.m21) <= epsilon &&
      Math.abs(a.m22 - b.m22) <= epsilon
    );
  },
};

export const createMat3: CreateMat3 = (): Mat3Type => ({
  m00: 1, m01: 0, m02: 0,
  m10: 0, m11: 1, m12: 0,
  m20: 0, m21: 0, m22: 1,
});
