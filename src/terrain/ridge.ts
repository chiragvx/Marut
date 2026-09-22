/**
 * src/terrain/ridge.ts — ridged-multifractal noise (module 04).
 * Algorithm: docs/spec/04-terrain.md section 4.3.4.
 */
import type { Noise2D, CreateRidgeNoise2D, RidgeParams } from '../contracts/terrain';

/** Output range [0, ridgeConservativeMaxAmplitude]; always >= 0 ("mountains poke up"). */
export const createRidgeNoise2D: CreateRidgeNoise2D = (base: Noise2D, p: RidgeParams): Noise2D => {
  return (x: number, z: number): number => {
    let sum = 0;
    let amp = p.baseAmplitudeM;
    let freq = p.baseFrequency;
    let weight = 1;
    for (let o = 0; o < p.octaves; o++) {
      const n = base(x * freq, z * freq);
      let s = Math.pow(1 - Math.abs(n), p.sharpness);
      s *= weight;
      weight = Math.min(1, Math.max(0, s * p.gain));
      sum += s * amp;
      freq *= p.lacunarity;
      amp *= p.persistence;
    }
    return sum;
  };
};
