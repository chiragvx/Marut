/**
 * src/aircraft/tejasEngineTables.ts — the `EngineTables` object for the GE F404-GE-IN20:
 * thrust/fuel-flow `Table2D`s indexed (mach, altitudeM) — every consumer calls
 * `interpolate2D(table, mach, altitudeM)`.
 *
 * Mach breakpoints (xs): [0, 0.3, 0.6, 0.9, 1.2, 1.6]
 * Altitude breakpoints (ys, m): [0, 5000, 11000, 15000]
 *
 * DERIVATION (regenerated from published ratings; replaces earlier hand-tuned tables whose dry
 * rating was 53.9 kN and whose afterburner thrust ROSE to 112 kN at Mach 1.6 / 11 km -- inflated
 * to offset a supersonic drag table ~2x typical fighter values, see tejasAeroTables.ts):
 *
 * - Sea-level static ratings: 84.0 kN with afterburner (GE F404 family datasheet, IN20 "19,000 lb
 *   thrust class"), 48.9 kN dry (11,000 lbf, the F404 family's dry rating; GE does not publish a
 *   separate IN20 dry figure).
 * - Mach/altitude lapse: Mattingly's installed-thrust model for a low-bypass mixed-flow
 *   afterburning turbofan ("Aircraft Engine Design", 2nd ed., eq. 2.54), throttle ratio TR = 1.07:
 *     theta0 = (T/T_sl)(1 + 0.2 M^2),  delta0 = (P/P_sl)(1 + 0.2 M^2)^3.5
 *     wet: delta0 * (1 - 3.5 (theta0 - TR)/theta0)   (theta0 > TR; else delta0)
 *     dry: delta0 * (1 - 3.8 (theta0 - TR)/theta0)   (theta0 > TR; else delta0)
 *   so thrust rises with ram at low Mach, falls with density at altitude, and at high Mach LOW
 *   DOWN is capped by compressor-inlet temperature -- which is why the Mach 1.2/1.6 rows peak at
 *   5-11 km rather than at sea level (real; tests/aircraft/tejasEngineTables.test.ts only asserts
 *   altitude-monotonicity for the subsonic rows). The Mach 1.6 sea-level cell, where the model goes
 *   negative (far outside the airframe's flyable envelope), is floored at 25% of static.
 * - Fuel flow = thrust x TSFC, TSFC in lb/(lbf h) = (base + slope*M) * sqrt(T/T_sl) (Mattingly
 *   eq. 3.55a form) with F404-GE-402 published sea-level static bases: dry 0.81, afterburner 1.74
 *   (slopes 0.27 / 0.25). The earlier military fuel-flow table was ~half of this (0.566 kg/s vs
 *   1.12 kg/s sea-level static), giving roughly double a real Tejas's endurance.
 */
import type { EngineTables } from '../contracts/aircraft';

const MACH = [0, 0.3, 0.6, 0.9, 1.2, 1.6] as const;
const ALT_M = [0, 5000, 11000, 15000] as const;

export const engine: EngineTables = {
  militaryThrustN: {
    xs: MACH,
    ys: ALT_M,
    zs: [
      [48900, 26100, 10900, 5800],
      [52100, 27800, 11600, 6200],
      [61900, 33300, 13900, 7400],
      [57800, 44100, 18500, 9800],
      [42300, 47900, 26500, 14100],
      [12200, 25600, 36100, 19200],
    ],
  },
  afterburnerThrustN: {
    xs: MACH,
    ys: ALT_M,
    zs: [
      [84000, 44800, 18800, 10000],
      [89400, 47700, 20000, 10600],
      [106400, 57100, 23900, 12700],
      [102700, 75700, 31700, 16900],
      [83000, 84400, 45500, 24200],
      [21000, 55500, 63300, 33700],
    ],
  },
  militaryFuelFlowKgS: {
    xs: MACH,
    ys: ALT_M,
    zs: [
      [1.122, 0.564, 0.217, 0.115],
      [1.315, 0.661, 0.254, 0.136],
      [1.704, 0.864, 0.332, 0.177],
      [1.724, 1.239, 0.478, 0.253],
      [1.359, 1.449, 0.738, 0.393],
      [0.429, 0.848, 1.101, 0.586],
    ],
  },
  afterburnerFuelFlowKgS: {
    xs: MACH,
    ys: ALT_M,
    zs: [
      [4.14, 2.08, 0.803, 0.427],
      [4.596, 2.31, 0.892, 0.473],
      [5.696, 2.879, 1.109, 0.59],
      [5.716, 3.969, 1.53, 0.816],
      [4.796, 4.594, 2.28, 1.213],
      [1.273, 3.169, 3.327, 1.771],
    ],
  },
  idleFuelFlowKgS: 0.09,
  spoolTimeConstantSec: 2.5,
};
