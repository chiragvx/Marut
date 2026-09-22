/**
 * src/math/index.ts — barrel re-export for the whole math module.
 * Consumers should `import { Vec3, Quat, Mat3, ... } from '../math'` (never a
 * value-import of Vec3/Quat/Mat3 from '../contracts/math' — see
 * docs/spec/01-math.md section 3's critical usage note).
 *
 * Vec3/Quat/Mat3 are re-exported as BOTH a value (the namespace object with
 * the static methods) and a type (structurally `{x,y,z}` / `{x,y,z,w}` /
 * 3x3 matrix fields) under the same bare name, mirroring the local
 * type+value declaration-merge pattern contracts/math.ts itself uses — a
 * plain `export {...} from` (value) alongside `export type {...} from`
 * (type) of the same name, from two different source modules, is not
 * accepted by tsc, so each is assembled locally here instead.
 */

import { Vec3 as Vec3Value, createVec3 } from './vec3';
import { Quat as QuatValue, createQuat, bodyRateP, bodyRateQ, bodyRateR } from './quat';
import { Mat3 as Mat3Value, createMat3 } from './mat3';
import type {
  Vec3 as Vec3Type,
  Quat as QuatType,
  Mat3 as Mat3Type,
} from '../contracts/math';

export type Vec3 = Vec3Type;
export const Vec3 = Vec3Value;
export type Quat = QuatType;
export const Quat = QuatValue;
export type Mat3 = Mat3Type;
export const Mat3 = Mat3Value;

export { createVec3, createQuat, createMat3, bodyRateP, bodyRateQ, bodyRateR };

export {
  clamp,
  clamp01,
  lerp,
  inverseLerp,
  smoothstep,
  wrapAngleSigned,
  wrapAngleUnsigned,
  degToRad,
  radToDeg,
  sign,
  approxEqual,
} from './scalar';
export { interpolate1D } from './table1d';
export { interpolate2D } from './table2d';
export { createPrng, nextFloat01, nextRange, nextInt, deriveSubSeed } from './prng';
export { lowPassStep, rateLimitStep } from './filters';

// Re-export every remaining type from contracts/math so consumers need only this barrel.
export type {
  Vec3Static,
  CreateVec3,
  QuatStatic,
  CreateQuat,
  YawPitchRoll,
  BodyRateP,
  BodyRateQ,
  BodyRateR,
  Mat3Static,
  CreateMat3,
  InertiaComponents,
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
  Table1D,
  Table2D,
  Interpolate1D,
  Interpolate2D,
  PrngState,
  CreatePrng,
  PrngNextFloat01,
  PrngNextRange,
  PrngNextInt,
  DeriveSubSeed,
  LowPassStep,
  RateLimitStep,
} from '../contracts/math';

export {
  DEFAULT_EPSILON,
  MAT3_INVERT_EPSILON,
  SLERP_DOT_THRESHOLD,
  FNV_OFFSET_BASIS_32,
  FNV_PRIME_32,
  SEED_MIX_MULTIPLIER_32,
  MULBERRY32_INCREMENT,
} from '../contracts/math';
