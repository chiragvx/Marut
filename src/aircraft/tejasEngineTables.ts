/**
 * src/aircraft/tejasEngineTables.ts — the `EngineTables` object for the GE
 * F404-IN20: thrust/fuel-flow `Table2D`s indexed (mach, altitudeM) — every
 * consumer calls `interpolate2D(table, mach, altitudeM)`. See
 * docs/spec/03-tejas-data.md section 5.3 for full derivation.
 *
 * Mach breakpoints (xs): [0, 0.3, 0.6, 0.9, 1.2, 1.6]
 * Altitude breakpoints (ys, m): [0, 5000, 11000, 15000]
 */
import type { EngineTables } from '../contracts/aircraft';

const MACH = [0, 0.3, 0.6, 0.9, 1.2, 1.6] as const;
const ALT_M = [0, 5000, 11000, 15000] as const;

export const engine: EngineTables = {
  militaryThrustN: {
    xs: MACH,
    ys: ALT_M,
    zs: [
      [53900, 33400, 16000, 8600],
      [50000, 31000, 14850, 7950],
      [46000, 28500, 13650, 7300],
      [42000, 26000, 12500, 6700],
      [39000, 24200, 11600, 6200],
      [34000, 21100, 10100, 5400],
    ],
  },
  afterburnerThrustN: {
    xs: MACH,
    ys: ALT_M,
    zs: [
      [84500, 52400, 25100, 13400],
      [88000, 54600, 26100, 14000],
      [92000, 57000, 27300, 14600],
      [96000, 59500, 28500, 15300],
      [99000, 61400, 29400, 15700],
      [95000, 58900, 28200, 15100],
    ],
  },
  militaryFuelFlowKgS: {
    xs: MACH,
    ys: ALT_M,
    zs: [
      [0.566, 0.351, 0.168, 0.09],
      [0.525, 0.326, 0.156, 0.083],
      [0.483, 0.299, 0.143, 0.077],
      [0.441, 0.273, 0.131, 0.07],
      [0.41, 0.254, 0.122, 0.065],
      [0.357, 0.222, 0.106, 0.057],
    ],
  },
  afterburnerFuelFlowKgS: {
    xs: MACH,
    ys: ALT_M,
    zs: [
      [4.48, 2.78, 1.33, 0.71],
      [4.66, 2.89, 1.38, 0.74],
      [4.88, 3.02, 1.45, 0.77],
      [5.09, 3.15, 1.51, 0.81],
      [5.25, 3.25, 1.56, 0.83],
      [5.04, 3.12, 1.49, 0.8],
    ],
  },
  idleFuelFlowKgS: 0.09,
  spoolTimeConstantSec: 2.5,
};
