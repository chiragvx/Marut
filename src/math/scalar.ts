/**
 * src/math/scalar.ts — scalar helpers: clamp, lerp, smoothstep, angle wrapping, etc.
 * See docs/spec/01-math.md section 4.7.
 */
import type {
  Clamp,
  Clamp01,
  Lerp,
  InverseLerp,
  Smoothstep,
  WrapAngleSigned,
  WrapAngleUnsigned,
  DegToRad,
  RadToDeg,
  Sign,
  ApproxEqual,
} from '../contracts/math';
import { DEFAULT_EPSILON } from '../contracts/math';

const TWO_PI = Math.PI * 2;

export const clamp: Clamp = (x, min, max) => (x < min ? min : x > max ? max : x);

export const clamp01: Clamp01 = (x) => clamp(x, 0, 1);

export const lerp: Lerp = (a, b, t) => a + (b - a) * t;

export const inverseLerp: InverseLerp = (a, b, v) => (a === b ? 0 : clamp01((v - a) / (b - a)));

export const smoothstep: Smoothstep = (edge0, edge1, x) => {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

export const wrapAngleSigned: WrapAngleSigned = (rad) => {
  let r = rad % TWO_PI;
  if (r < -Math.PI) r += TWO_PI;
  else if (r >= Math.PI) r -= TWO_PI;
  return r;
};

export const wrapAngleUnsigned: WrapAngleUnsigned = (rad) => {
  let r = rad % TWO_PI;
  if (r < 0) r += TWO_PI;
  return r;
};

export const degToRad: DegToRad = (deg) => (deg * Math.PI) / 180;

export const radToDeg: RadToDeg = (rad) => (rad * 180) / Math.PI;

export const sign: Sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

export const approxEqual: ApproxEqual = (a, b, epsilon = DEFAULT_EPSILON) => Math.abs(a - b) <= epsilon;
