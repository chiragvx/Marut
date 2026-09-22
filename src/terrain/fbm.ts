/**
 * src/terrain/fbm.ts — fractal Brownian motion octave-summing (module 04).
 * Algorithm: docs/spec/04-terrain.md section 4.3.3.
 */
import type { Noise2D, CreateFbmNoise2D, FbmParams } from '../contracts/terrain';

/** Output range approximately [-fbmMaxAmplitude, +fbmMaxAmplitude] where fbmMaxAmplitude = Sum(baseAmplitudeM * persistence^i). NOT clamped. */
export const createFbmNoise2D: CreateFbmNoise2D = (base: Noise2D, p: FbmParams): Noise2D => {
  return (x: number, z: number): number => {
    let sum = 0;
    let amp = p.baseAmplitudeM;
    let freq = p.baseFrequency;
    for (let o = 0; o < p.octaves; o++) {
      sum += base(x * freq, z * freq) * amp;
      amp *= p.persistence;
      freq *= p.lacunarity;
    }
    return sum;
  };
};
