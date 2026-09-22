/**
 * src/math/quat.ts — mutable Quat implementation (unit quaternion, body->world rotation).
 * Implements contracts/math.ts's QuatStatic + bodyRateP/Q/R.
 * See docs/spec/00-architecture.md section 3.3/3.4 and docs/spec/01-math.md section 4.2-4.5.
 */
import type { QuatLike, Vec3Like } from '../contracts/core';
import type { QuatStatic, CreateQuat, BodyRateP, BodyRateQ, BodyRateR } from '../contracts/math';
import { DEFAULT_EPSILON, SLERP_DOT_THRESHOLD } from '../contracts/math';

export const Quat: QuatStatic = {
  set(out, x, y, z, w) {
    out.x = x;
    out.y = y;
    out.z = z;
    out.w = w;
    return out;
  },
  copy(out, src) {
    out.x = src.x;
    out.y = src.y;
    out.z = src.z;
    out.w = src.w;
    return out;
  },
  identity(out) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
    return out;
  },
  multiply(a, b, out) {
    const ax = a.x, ay = a.y, az = a.z, aw = a.w;
    const bx = b.x, by = b.y, bz = b.z, bw = b.w;
    out.w = aw * bw - ax * bx - ay * by - az * bz;
    out.x = aw * bx + ax * bw + ay * bz - az * by;
    out.y = aw * by - ax * bz + ay * bw + az * bx;
    out.z = aw * bz + ax * by - ay * bx + az * bw;
    return out;
  },
  conjugate(q, out) {
    const x = q.x, y = q.y, z = q.z, w = q.w;
    out.x = -x;
    out.y = -y;
    out.z = -z;
    out.w = w;
    return out;
  },
  length(q) {
    return Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  },
  normalize(q, out) {
    const l2 = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
    if (l2 === 0) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      out.w = 1;
      return out;
    }
    const invL = 1 / Math.sqrt(l2);
    out.x = q.x * invL;
    out.y = q.y * invL;
    out.z = q.z * invL;
    out.w = q.w * invL;
    return out;
  },
  dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  },
  axisAngle(axis, angleRad, out) {
    const h = angleRad / 2;
    const s = Math.sin(h);
    const c = Math.cos(h);
    out.x = axis.x * s;
    out.y = axis.y * s;
    out.z = axis.z * s;
    out.w = c;
    return out;
  },
  rotate(q, v, out) {
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const vx = v.x, vy = v.y, vz = v.z;
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    out.x = vx + qw * tx + (qy * tz - qz * ty);
    out.y = vy + qw * ty + (qz * tx - qx * tz);
    out.z = vz + qw * tz + (qx * ty - qy * tx);
    return out;
  },
  rotateInverse(q, v, out) {
    const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
    const vx = v.x, vy = v.y, vz = v.z;
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    out.x = vx + qw * tx + (qy * tz - qz * ty);
    out.y = vy + qw * ty + (qz * tx - qx * tz);
    out.z = vz + qw * tz + (qx * ty - qy * tx);
    return out;
  },
  fromYawPitchRoll(headingRad, pitchRad, rollRad, out) {
    const phi = Math.PI / 2 - headingRad;
    const sPhi = Math.sin(phi / 2), cPhi = Math.cos(phi / 2);
    const sTheta = Math.sin(pitchRad / 2), cTheta = Math.cos(pitchRad / 2);
    const sRho = Math.sin(rollRad / 2), cRho = Math.cos(rollRad / 2);

    const x = cPhi * cTheta * sRho + sPhi * sTheta * cRho;
    const y = sPhi * cTheta * cRho + cPhi * sTheta * sRho;
    const z = cPhi * sTheta * cRho - sPhi * cTheta * sRho;
    const w = cPhi * cTheta * cRho - sPhi * sTheta * sRho;

    const l2 = x * x + y * y + z * z + w * w;
    if (l2 === 0) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      out.w = 1;
      return out;
    }
    const invL = 1 / Math.sqrt(l2);
    out.x = x * invL;
    out.y = y * invL;
    out.z = z * invL;
    out.w = w * invL;
    return out;
  },
  toYawPitchRoll(q, out) {
    const x = q.x, y = q.y, z = q.z, w = q.w;
    const sinPitch = clampUnit(2 * (x * y + w * z));
    const pitchRad = Math.asin(sinPitch);
    const phi = Math.atan2(2 * (w * y - x * z), 1 - 2 * (y * y + z * z));
    let headingRad = Math.PI / 2 - phi;
    // wrapAngleUnsigned inline (avoid a cross-file dependency inside this hot-ish extraction fn)
    const twoPi = Math.PI * 2;
    headingRad = headingRad % twoPi;
    if (headingRad < 0) headingRad += twoPi;
    const rollRad = Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + z * z));
    out.headingRad = headingRad;
    out.pitchRad = pitchRad;
    out.rollRad = rollRad;
    return out;
  },
  integrate(q, omegaBody, dtSec, out) {
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    const ox = omegaBody.x, oy = omegaBody.y, oz = omegaBody.z;

    const px = qw * ox + qy * oz - qz * oy;
    const py = qw * oy - qx * oz + qz * ox;
    const pz = qw * oz + qx * oy - qy * ox;
    const pw = -qx * ox - qy * oy - qz * oz;

    const sx = qx + 0.5 * px * dtSec;
    const sy = qy + 0.5 * py * dtSec;
    const sz = qz + 0.5 * pz * dtSec;
    const sw = qw + 0.5 * pw * dtSec;

    const l2 = sx * sx + sy * sy + sz * sz + sw * sw;
    if (l2 === 0) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      out.w = 1;
      return out;
    }
    const invL = 1 / Math.sqrt(l2);
    out.x = sx * invL;
    out.y = sy * invL;
    out.z = sz * invL;
    out.w = sw * invL;
    return out;
  },
  slerp(a, b, t, out) {
    const tc = t < 0 ? 0 : t > 1 ? 1 : t;
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    let d = a.x * bx + a.y * by + a.z * bz + a.w * bw;
    if (d < 0) {
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
      d = -d;
    }
    if (d >= SLERP_DOT_THRESHOLD) {
      const x = a.x + (bx - a.x) * tc;
      const y = a.y + (by - a.y) * tc;
      const z = a.z + (bz - a.z) * tc;
      const w = a.w + (bw - a.w) * tc;
      const l2 = x * x + y * y + z * z + w * w;
      if (l2 === 0) {
        out.x = 0;
        out.y = 0;
        out.z = 0;
        out.w = 1;
        return out;
      }
      const invL = 1 / Math.sqrt(l2);
      out.x = x * invL;
      out.y = y * invL;
      out.z = z * invL;
      out.w = w * invL;
      return out;
    }
    const dc = d < -1 ? -1 : d > 1 ? 1 : d;
    const angle = Math.acos(dc);
    const s = Math.sin(angle);
    const wa = Math.sin((1 - tc) * angle) / s;
    const wb = Math.sin(tc * angle) / s;
    out.x = a.x * wa + bx * wb;
    out.y = a.y * wa + by * wb;
    out.z = a.z * wa + bz * wb;
    out.w = a.w * wa + bw * wb;
    return out;
  },
  nlerp(a, b, t, out) {
    const tc = t < 0 ? 0 : t > 1 ? 1 : t;
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    const d = a.x * bx + a.y * by + a.z * bz + a.w * bw;
    if (d < 0) {
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    const x = a.x + (bx - a.x) * tc;
    const y = a.y + (by - a.y) * tc;
    const z = a.z + (bz - a.z) * tc;
    const w = a.w + (bw - a.w) * tc;
    const l2 = x * x + y * y + z * z + w * w;
    if (l2 === 0) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      out.w = 1;
      return out;
    }
    const invL = 1 / Math.sqrt(l2);
    out.x = x * invL;
    out.y = y * invL;
    out.z = z * invL;
    out.w = w * invL;
    return out;
  },
  equals(a, b, epsilon = DEFAULT_EPSILON) {
    return (
      Math.abs(a.x - b.x) <= epsilon &&
      Math.abs(a.y - b.y) <= epsilon &&
      Math.abs(a.z - b.z) <= epsilon &&
      Math.abs(a.w - b.w) <= epsilon
    );
  },
};

function clampUnit(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

export const createQuat: CreateQuat = (x = 0, y = 0, z = 0, w = 1): QuatLike => ({ x, y, z, w });

export const bodyRateP: BodyRateP = (omega: Readonly<Vec3Like>) => omega.x;
export const bodyRateQ: BodyRateQ = (omega: Readonly<Vec3Like>) => omega.z;
export const bodyRateR: BodyRateR = (omega: Readonly<Vec3Like>) => -omega.y;
