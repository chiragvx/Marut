/**
 * src/core/wind.ts — one world-frame wind vector per tick (spatially
 * uniform). See 10-core-worker.md section 4.5. Real src/core code (not a
 * contract), so it is free to import '../math' directly.
 */

import { SIM_DT_SEC } from '../contracts/core';
import type { Vec3Like, WeatherConfig } from '../contracts/core';
import { createPrng, nextFloat01 } from '../math';
import type { PrngState } from '../math';

/** Ticks between drawing a new target gust vector (~2 s at SIM_HZ=120). */
const GUST_PERIOD_TICKS = Math.round(2.0 / SIM_DT_SEC);
/** Gust low-pass filter time constant, seconds. */
const GUST_FILTER_TAU_SEC = 1.5;

export interface WindState {
  prng: PrngState;
  tickCounter: number;
  gustTarget: Vec3Like;
  gustCurrent: Vec3Like;
}

export function createWindState(seed: number): WindState {
  return {
    prng: createPrng(seed),
    tickCounter: 0,
    gustTarget: { x: 0, y: 0, z: 0 },
    gustCurrent: { x: 0, y: 0, z: 0 },
  };
}

/** Advances `state` by one tick and writes the resulting world-frame wind (steady + gust + jitter) into `out`. Allocation-free. */
export function stepWind(state: WindState, weather: WeatherConfig, out: Vec3Like): Vec3Like {
  if (state.tickCounter % GUST_PERIOD_TICKS === 0) {
    const azimuth = nextFloat01(state.prng) * 2 * Math.PI;
    const magnitude = weather.gustMps;
    const vertical = (nextFloat01(state.prng) - 0.5) * weather.gustMps * 0.3;
    state.gustTarget.x = magnitude * Math.sin(azimuth);
    state.gustTarget.y = vertical;
    state.gustTarget.z = -magnitude * Math.cos(azimuth);
  }
  const alpha = SIM_DT_SEC / GUST_FILTER_TAU_SEC;
  state.gustCurrent.x += (state.gustTarget.x - state.gustCurrent.x) * alpha;
  state.gustCurrent.y += (state.gustTarget.y - state.gustCurrent.y) * alpha;
  state.gustCurrent.z += (state.gustTarget.z - state.gustCurrent.z) * alpha;

  const jx = (nextFloat01(state.prng) - 0.5) * weather.turbulence * 2.0;
  const jy = (nextFloat01(state.prng) - 0.5) * 0.3 * weather.turbulence * 2.0;
  const jz = (nextFloat01(state.prng) - 0.5) * weather.turbulence * 2.0;

  out.x = weather.windWorldMps.x + state.gustCurrent.x + jx;
  out.y = weather.windWorldMps.y + state.gustCurrent.y + jy;
  out.z = weather.windWorldMps.z + state.gustCurrent.z + jz;

  state.tickCounter += 1;
  return out;
}
