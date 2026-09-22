/**
 * src/aircraft/tejasAeroTables.ts — the `AeroTables` object for the HAL
 * Tejas Mk1: `CL`/`CD`/`Cm` as `Table2D`s indexed (alphaRad, mach) — every
 * consumer calls `interpolate2D(table, alphaRad, mach)` — plus every scalar
 * derivative. See docs/spec/03-tejas-data.md section 5.2 for the full
 * derivation and every value's source/justification.
 *
 * Alpha breakpoints (deg -> rad, DEG2RAD = PI/180):
 *   [-10, -5, 0, 5, 10, 15, 20, 22] deg
 *   = [-0.174533, -0.087266, 0, 0.087266, 0.174533, 0.261799, 0.349066, 0.383972] rad
 * Mach breakpoints: [0.2, 0.6, 0.9, 1.2, 1.6]
 */
import type { AeroTables } from '../contracts/aircraft';

const ALPHA_RAD = [-0.174533, -0.087266, 0, 0.087266, 0.174533, 0.261799, 0.349066, 0.383972] as const;
const MACH = [0.2, 0.6, 0.9, 1.2, 1.6] as const;

export const aero: AeroTables = {
  CL: {
    xs: ALPHA_RAD,
    ys: MACH,
    zs: [
      [-0.55, -0.5, -0.42, -0.3, -0.22],
      [-0.2, -0.18, -0.15, -0.1, -0.07],
      [0.18, 0.17, 0.15, 0.1, 0.07],
      [0.55, 0.52, 0.46, 0.32, 0.24],
      [0.85, 0.8, 0.72, 0.52, 0.4],
      [1.05, 0.98, 0.88, 0.66, 0.52],
      [1.15, 1.06, 0.95, 0.74, 0.6],
      [1.18, 1.08, 0.97, 0.76, 0.62],
    ],
  },
  CD: {
    xs: ALPHA_RAD,
    ys: MACH,
    zs: [
      [0.085, 0.095, 0.13, 0.21, 0.165],
      [0.035, 0.04, 0.06, 0.11, 0.09],
      [0.022, 0.025, 0.04, 0.085, 0.07],
      [0.045, 0.05, 0.075, 0.14, 0.115],
      [0.09, 0.098, 0.13, 0.22, 0.18],
      [0.16, 0.17, 0.21, 0.32, 0.26],
      [0.26, 0.27, 0.32, 0.44, 0.37],
      [0.31, 0.32, 0.37, 0.49, 0.42],
    ],
  },
  Cm: {
    xs: ALPHA_RAD,
    ys: MACH,
    zs: [
      [-0.08, -0.07, -0.06, -0.05, -0.04],
      [-0.03, -0.025, -0.02, -0.015, -0.01],
      [0.01, 0.008, 0.006, 0.004, 0.002],
      [0.05, 0.045, 0.035, 0.02, 0.01],
      [0.09, 0.08, 0.065, 0.04, 0.022],
      [0.11, 0.098, 0.08, 0.05, 0.03],
      [0.1, 0.09, 0.075, 0.048, 0.028],
      [0.08, 0.072, 0.06, 0.04, 0.024],
    ],
  },
  CY_beta: -0.9,
  Cl_beta: -0.12,
  Cn_beta: 0.15,
  CL_elevon: 0.42,
  CD_elevon: 0.15,
  /** MUST be negative — 00-architecture.md section 6.2's elevon sign rule. */
  Cm_elevon: -0.85,
  Cl_elevon: 0.12,
  Cn_elevon: -0.015,
  CY_rudder: -0.35,
  Cl_rudder: 0.01,
  Cn_rudder: -0.09,
  Cl_p: -0.35,
  Cl_r: 0.18,
  Cm_q: -2.5,
  Cn_p: -0.05,
  Cn_r: -0.28,
  groundEffectMaxDeltaCL: 0.15,
  stallAlphaRad: 0.383972,
};
