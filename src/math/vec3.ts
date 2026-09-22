/**
 * src/math/vec3.ts — mutable Vec3 implementation.
 * Implements contracts/math.ts's Vec3Static. See docs/spec/01-math.md section 4.1.
 */
import type { Vec3Like } from '../contracts/core';
import type { Vec3Static, CreateVec3 } from '../contracts/math';
import { DEFAULT_EPSILON } from '../contracts/math';

export const Vec3: Vec3Static = {
  set(out, x, y, z) {
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  },
  copy(out, src) {
    out.x = src.x;
    out.y = src.y;
    out.z = src.z;
    return out;
  },
  add(a, b, out) {
    out.x = a.x + b.x;
    out.y = a.y + b.y;
    out.z = a.z + b.z;
    return out;
  },
  sub(a, b, out) {
    out.x = a.x - b.x;
    out.y = a.y - b.y;
    out.z = a.z - b.z;
    return out;
  },
  scale(a, s, out) {
    out.x = a.x * s;
    out.y = a.y * s;
    out.z = a.z * s;
    return out;
  },
  addScaled(a, b, s, out) {
    out.x = a.x + b.x * s;
    out.y = a.y + b.y * s;
    out.z = a.z + b.z * s;
    return out;
  },
  negate(a, out) {
    out.x = -a.x;
    out.y = -a.y;
    out.z = -a.z;
    return out;
  },
  dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  },
  cross(a, b, out) {
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    out.x = ay * bz - az * by;
    out.y = az * bx - ax * bz;
    out.z = ax * by - ay * bx;
    return out;
  },
  length(a) {
    return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  },
  lengthSq(a) {
    return a.x * a.x + a.y * a.y + a.z * a.z;
  },
  normalize(a, out) {
    const l2 = a.x * a.x + a.y * a.y + a.z * a.z;
    if (l2 === 0) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      return out;
    }
    const invL = 1 / Math.sqrt(l2);
    out.x = a.x * invL;
    out.y = a.y * invL;
    out.z = a.z * invL;
    return out;
  },
  distance(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  },
  distanceSq(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  },
  lerp(a, b, t, out) {
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    return out;
  },
  equals(a, b, epsilon = DEFAULT_EPSILON) {
    return (
      Math.abs(a.x - b.x) <= epsilon &&
      Math.abs(a.y - b.y) <= epsilon &&
      Math.abs(a.z - b.z) <= epsilon
    );
  },
};

export const createVec3: CreateVec3 = (x = 0, y = 0, z = 0): Vec3Like => ({ x, y, z });
