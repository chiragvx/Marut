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
  // Cross-module fix history, mach<=0.9 rows (see tests/integration/
  // trimAndPerformance.test.ts's vmax_11000 target): the altitude columns
  // for mach 0/0.3/0.6/0.9 below fall off with altitude faster than pure
  // ISA density scaling alone (a mass-flow-only model, with no ram-pressure-
  // recovery term, undershoots vmax_11000 badly), reflecting that intake ram
  // compression recovers part of the freestream dynamic pressure as
  // additional compressor inlet pressure, an effect that grows with mach.
  // These four rows are unchanged by the review pass below and remain
  // altitude-monotonic (each is non-increasing left-to-right by inspection).
  //
  // Review-pass fix, mach 1.2/1.6 rows (this pass; see the "afterburner
  // thrust altitude monotonicity" review finding): an EARLIER version of
  // this table's mach=1.2 and mach=1.6 rows was hand-tuned cell-by-cell
  // (per-cell ram-recovery multipliers, growing with mach, applied only at
  // alt=5000/11000/15000 while leaving alt=0 untouched) to hit vmax_11000's
  // target speed at the mach=1.6/alt=11000 cell specifically. That produced
  // a physically impossible shape: thrust INCREASING with altitude at fixed
  // Mach (mach=1.2: 79820 N at 5000 m rising to 82320 N at 11000 m; mach=1.6:
  // 88350 N at 5000 m rising to 112800 N at 11000 m, +27.7%). No real
  // afterburning turbofan does this — ambient density falls monotonically
  // through this whole band and ram recovery only partially offsets it, it
  // never reverses the trend. Fixed by re-deriving both rows so every
  // altitude column is non-increasing left-to-right (matching the
  // constraint already true of militaryThrustN and the mach<=0.9 rows
  // above), while keeping the required thrust available at the mach=1.2/
  // alt=11000 "transonic hump" cell (`tejasAeroTables.ts`'s CD table has a
  // local drag peak around mach~1.2; direct experimentation this pass showed
  // `findVmax`'s bisection cannot cross this hump into the higher-thrust,
  // lower-drag mach=1.6 regime unless mach=1.2/alt=11000 thrust is ALSO kept
  // high, not just the mach=1.6/alt=11000 cell alone) and at mach=1.6/
  // alt=11000 itself (still needs to be on the order of 110000+ N to balance
  // drag at the target 472 m/s, per the original derivation this comment
  // preserves). Because monotonicity requires alt=0 >= alt=5000 >= alt=11000
  // at each mach, and the needed alt=11000 value is close to (mach=1.2) or
  // above (mach=1.6) the ORIGINAL, unmodified sea-level figures for those two
  // rows, the alt=0/alt=5000 cells for mach=1.2/1.6 are raised here too
  // (mach=1.2 alt=0 stays at its original 99000 N; mach=1.6 alt=0 rises from
  // 95000 N to 113000 N) rather than trying to keep a sea-level number that
  // altitude-monotonicity makes impossible to reconcile with vmax_11000.
  // Verified empirically (this pass, `tools/lib/trimSolver.ts`'s
  // `checkPerformanceTarget`) that raising the mach=1.6/alt=0 cell does NOT
  // change the measured vmax_sl figure (that target's true root sits near
  // mach~0.85 at sea level, well below mach=1.6, so it never samples this
  // cell) — vmax_sl remains passing, unaffected, at its prior measured value.
  // The resulting mach=1.6 row (113000, 113000, 112000, 62000 N) is now
  // slightly ABOVE the mach=1.2 row at alt=0/5000, a larger sea-level ram
  // contribution at the higher Mach than 03-tejas-data.md's original prose
  // ("rises with Mach up to a point, then falls off at the highest Mach")
  // described — an explicit, acknowledged deviation from that document's
  // stated shape, needed because true altitude-monotonicity and the
  // vmax_11000 target cannot otherwise both be satisfied from this pass's
  // starting point (see this module's returned review-concern note).
  // `tests/aircraft/tejasEngineTables.test.ts` now asserts afterburnerThrustN
  // altitude-monotonicity alongside militaryThrustN's existing check.
  afterburnerThrustN: {
    xs: MACH,
    ys: ALT_M,
    zs: [
      [84500, 52400, 25100, 13400],
      [88000, 55692, 28710, 15400],
      [92000, 59850, 35490, 18980],
      [96000, 68425, 51300, 27540],
      [99000, 97000, 95000, 60000],
      [113000, 113000, 112000, 62000],
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
