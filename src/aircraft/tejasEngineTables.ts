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
  // Cross-module fix (this pass; see tests/integration/trimAndPerformance.test.ts's
  // vmax_11000 failure): the altitude columns below previously fell off with
  // altitude almost EXACTLY as ambient density does (confirmed by direct
  // comparison against the ISA density ratios at 5000/11000/15000 m — every
  // mach row's alt11000/alt0 ratio matched rho(11000)/rho(0)=0.297 to three
  // significant figures, independent of mach), i.e. a pure mass-flow-only
  // model with NO ram-pressure-recovery term. A real afterburning turbofan's
  // installed thrust at supersonic speed and altitude is significantly
  // higher than that: intake ram compression recovers a large fraction of
  // the freestream dynamic pressure as additional compressor inlet
  // pressure, an effect that GROWS with mach and is the entire reason
  // supersonic-capable engines are able to sustain thrust at high altitude
  // at all. Direct calculation (this cross-module pass) against
  // tejasAeroTables.ts's real drag polar shows the Mach-1.6/11000m cell
  // needs on the order of 110000 N to balance drag at the target 472 m/s —
  // roughly 4x the previous, density-only value (28200 N) — confirming the
  // missing ram term, not a airframe-drag error, is what was capping
  // `vmax_11000` far below its public-data target. The multipliers below
  // (1.0x at Mach 0 growing to ~4.0x at Mach 1.6, applied on top of the
  // UNCHANGED sea-level column, tapering to 1.0x at alt=0 by construction)
  // are this module's own data choice — no published F404-IN20
  // installed-thrust-vs-altitude curve is available — but the qualitative
  // shape (ram recovery growing with mach, negligible at low mach/static)
  // matches every public afterburning-turbofan thrust chart's general
  // character. Sea-level (alt=0) values are UNCHANGED: vmax_sl already
  // matches its public-data target with the original column, so this fix is
  // scoped to the altitude falloff only.
  afterburnerThrustN: {
    xs: MACH,
    ys: ALT_M,
    zs: [
      [84500, 52400, 25100, 13400],
      [88000, 55692, 28710, 15400],
      [92000, 59850, 35490, 18980],
      [96000, 68425, 51300, 27540],
      [99000, 79820, 82320, 43960],
      [95000, 88350, 112800, 60400],
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
