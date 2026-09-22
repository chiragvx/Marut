/**
 * src/math/prng.ts — mulberry32 seeded PRNG + FNV-1a based deterministic sub-seed derivation.
 * The ONE PRNG for this entire project. See docs/spec/01-math.md section 4.10-4.11.
 */
import type {
  CreatePrng,
  PrngNextFloat01,
  PrngNextRange,
  PrngNextInt,
  DeriveSubSeed,
} from '../contracts/math';
import {
  MULBERRY32_INCREMENT,
  FNV_OFFSET_BASIS_32,
  FNV_PRIME_32,
  SEED_MIX_MULTIPLIER_32,
} from '../contracts/math';

export const createPrng: CreatePrng = (seed) => ({ s: seed >>> 0 });

export const nextFloat01: PrngNextFloat01 = (state) => {
  state.s = (state.s + MULBERRY32_INCREMENT) | 0;
  let t = state.s;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const nextRange: PrngNextRange = (state, min, max) => min + nextFloat01(state) * (max - min);

export const nextInt: PrngNextInt = (state, minIncl, maxExcl) =>
  minIncl + Math.floor(nextFloat01(state) * (maxExcl - minIncl));

function fnv1a32(str: string): number {
  let h = FNV_OFFSET_BASIS_32;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), FNV_PRIME_32) >>> 0;
  }
  return h >>> 0;
}

export const deriveSubSeed: DeriveSubSeed = (rootSeed, tag) => {
  const h = fnv1a32(tag);
  const mixed = Math.imul(rootSeed >>> 0, SEED_MIX_MULTIPLIER_32) >>> 0;
  return (h ^ mixed) >>> 0;
};
