/**
 * src/physics/wind.ts — steady wind + low-pass-filtered PRNG gust.
 * Implements `CreateGustState`/`SampleWind` (contracts/flight.ts).
 * See docs/spec/02-flight-model.md section 4.6.
 */
import type { GustState, CreateGustState, SampleWind } from '../contracts/flight';

/** Gust filter time constant, s (fixed; ~0.1-2 Hz gust content). */
const GUST_TAU_SEC = 2.0;

export const createGustState: CreateGustState = (): GustState => ({ filteredGustWorld: { x: 0, y: 0, z: 0 } });

export const sampleWind: SampleWind = (weather, state, rngNext, dtSec, out) => {
  const alphaFilt = 1 - Math.exp(-dtSec / GUST_TAU_SEC);
  const amplitude = weather.gustMps * (1 + 2 * weather.turbulence);
  const g = state.filteredGustWorld;

  const wx = (rngNext() * 2 - 1) * amplitude;
  g.x += (wx - g.x) * alphaFilt;
  const wy = (rngNext() * 2 - 1) * amplitude;
  g.y += (wy - g.y) * alphaFilt;
  const wz = (rngNext() * 2 - 1) * amplitude;
  g.z += (wz - g.z) * alphaFilt;

  out.x = weather.windWorldMps.x + g.x;
  out.y = weather.windWorldMps.y + g.y;
  out.z = weather.windWorldMps.z + g.z;
  return out;
};
