/**
 * src/terrain/ridge.ts — ridged-multifractal noise (module 04).
 * Algorithm: docs/spec/04-terrain.md section 4.3.4.
 */
import type { Noise2D, CreateRidgeNoise2D, RidgeParams } from '../contracts/terrain';

/** Output range [0, ridgeConservativeMaxAmplitude]; always >= 0 ("mountains poke up"). */
export const createRidgeNoise2D: CreateRidgeNoise2D = (base: Noise2D, p: RidgeParams): Noise2D => {
  // Optional smooth |n| (see RidgeParams.crestSoftness): sqrt(n^2 + k^2) - k, rescaled so |n| = 1
  // still maps to 1. k grows by `lacunarity` per octave so every octave's crest has the same
  // width in metres (a fixed k would leave the fine octaves knife-edged).
  const k0 = p.crestSoftness ?? 0;
  return (x: number, z: number): number => {
    let sum = 0;
    let k = k0;
    let amp = p.baseAmplitudeM;
    let freq = p.baseFrequency;
    let weight = 1;
    for (let o = 0; o < p.octaves; o++) {
      const n = base(x * freq, z * freq);
      const an = k > 0 ? (Math.sqrt(n * n + k * k) - k) / (Math.sqrt(1 + k * k) - k) : Math.abs(n);
      k *= p.lacunarity;
      let s = Math.pow(1 - an, p.sharpness);
      s *= weight;
      weight = Math.min(1, Math.max(0, s * p.gain));
      sum += s * amp;
      freq *= p.lacunarity;
      amp *= p.persistence;
    }
    return sum;
  };
};
