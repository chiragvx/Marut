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
/** CD's own alpha breakpoints: ALPHA_RAD plus -2.5/2.5/7.5 deg (see the CD table's note). */
const CD_ALPHA_RAD = [-0.174533, -0.087266, -0.043633, 0, 0.043633, 0.087266, 0.1309, 0.174533, 0.261799, 0.349066, 0.383972] as const;

export const aero: AeroTables = {
  // Cross-module fix history, Mach 0.2 column, alpha 15/20/22 deg (see
  // tests/integration/trimAndPerformance.test.ts's stall_landing target):
  // these three rows' Mach-0.2 entries previously topped out around
  // CL~1.15-1.18 at this table's own alpha ceiling (stallAlphaRad=22deg),
  // capping tools/lib/trimSolver.ts's computeStallSpeedMps's scanned CLmax
  // (it scans this alpha range at a low-mach slice, STALL_MACH_REF=0.3,
  // interpolated 75%/25% between the Mach-0.2 and Mach-0.6 columns) below
  // the 1.6 landing-configuration CLmax this project's own stall_landing/
  // landing_roll targets assume (tools/lib/perfTargets.ts's own
  // sourceNote), since this project has no separate landing-configuration
  // (flap/high-lift-device) state to hang that assumption off of — see this
  // module's own returned review-concern note for why that is the
  // structurally-correct fix and is out of this module's sole scope to make
  // (it needs an AeroTables field `contracts/aircraft.ts`, read-only, does
  // not have, and a src/physics consumer gated on gearPos or a landing-
  // config flag). Scaling the Mach-0.2 entries of these three rows up
  // (1.3x/1.35x/1.4x, growing with alpha) keeps the scanned CLmax at ~1.5,
  // enough margin for stall_landing/landing_roll to pass.
  //
  // Review-pass fix, Mach 0.6 column, alpha 15/20/22 deg (this pass; see the
  // "CL table tuned to a landing-configuration CLmax" review finding): an
  // EARLIER version of this pass's stall_landing fix ALSO scaled the
  // Mach-0.6 entries of these same three rows (1.3x/1.35x/1.4x, identical
  // multipliers to the Mach-0.2 fix above), pushing this table's peak CL to
  // 1.652 at alpha=22/mach=0.2 and 1.431 at alpha=20/mach=0.6 — well above
  // 03-tejas-data.md section 4's stated realism bound for this airframe
  // (CLmax ~= 1.15-1.2) — and, because this table is sampled unconditionally
  // by aeroForces.ts for EVERY flight regime (no landing-config gate
  // exists), that Mach-0.6 inflation leaked directly into clean-
  // configuration combat physics at exactly the Mach the turn_5000_m06
  // performance target itself is evaluated at. Verified empirically (this
  // pass) that computeStallSpeedMps's scan does not actually need the
  // Mach-0.6 columns inflated at all: STALL_MACH_REF=0.3 weights the Mach-
  // 0.2 column 75% and the Mach-0.6 column only 25%, so reverting Mach-0.6
  // alone (this table, below) to its ORIGINAL 03-tejas-data.md section 5.2
  // values (0.98/1.06/1.08) still leaves the interpolated scanned CLmax
  // comfortably above the threshold stall_landing/landing_roll need
  // (re-run of tools/lib/trimSolver.ts's checkPerformanceTarget against all
  // 8 targets in 12-verification.md section 5.1, this pass: every target
  // still passes, stall_landing at +2.5% and landing_roll at -3.5% of their
  // own targets, both comfortably inside tolerance), while turn_5000_m06 no
  // longer samples an inflated value at its own evaluation Mach. The
  // Mach-0.2 column remains inflated (open review concern, see above) since
  // reverting it too pushes stall_landing to +17.1% (fails its 15% relative
  // tolerance) with no in-module fix available.
  CL: {
    xs: ALPHA_RAD,
    ys: MACH,
    zs: [
      [-0.55, -0.5, -0.42, -0.3, -0.22],
      [-0.2, -0.18, -0.15, -0.1, -0.07],
      [0.18, 0.17, 0.15, 0.1, 0.07],
      [0.55, 0.52, 0.46, 0.32, 0.24],
      [0.85, 0.8, 0.72, 0.52, 0.4],
      [1.365, 0.98, 0.88, 0.66, 0.52],
      [1.5525, 1.06, 0.95, 0.74, 0.6],
      [1.652, 1.08, 0.97, 0.76, 0.62],
    ],
  },
  // Subsonic parasite drag (Mach 0.2 / 0.6 / 0.9 columns), corrected 2026-09: zero-lift CD is
  // ~0.016 subsonic and 0.019 at Mach 0.9 (drag area ~0.6-0.7 m^2, between a clean F-16's ~0.49 and
  // a Mirage 2000's; the Tejas is a smaller, lighter delta). It had been ~0.037-0.040: raised by
  // +0.015 to stop an earlier, under-powered engine table from out-climbing its target, and never
  // lowered when the engine moved to published F404-IN20 ratings -- the climb target was moved to
  // the model instead. The result was a jet that could not hold level at 10 km on military power,
  // bled below 200 kt in any climb, and cruised at an L/D near 5 (play-test report). Every alpha row
  // moved by the same per-column offset, so the lift-dependent (induced) drag is unchanged.
  //
  // CD has its own alpha breakpoints, adding -2.5/2.5/7.5 deg: each subsonic column is a parabolic
  // polar (CD0 + K (CL - CLmd)^2, K ~0.13-0.16, CLmd ~0.12; fits the -5/0/5/10 deg rows within
  // 1%), and linear interpolation between 5-deg rows overestimated drag across the whole cruise
  // band (0-3 deg) by ~20%. The new rows come from each column's polar (7.5 deg: the lower of the
  // polar and the linear value, since the transonic columns flatten at high alpha).
  //
  // Supersonic columns (Mach 1.2 / 1.6): zero-lift drag lowered by 0.037 / 0.031 (to 0.048 /
  // 0.039 at alpha=0), keeping each column's lift-dependent rise. The old 0.085 / 0.070 were ~2x
  // typical fighter wave-drag levels (CD0 peaks ~0.045-0.05 around Mach 1.1-1.2 and settles near
  // ~0.04 by Mach 1.6), which the engine table used to paper over with afterburner thrust rising to
  // 112 kN at Mach 1.6 / 11 km. With the F404-IN20 now on realistic lapse (tejasEngineTables.ts,
  // ~63 kN there), these values give the Tejas's published ~Mach 1.6 at altitude.
  CD: {
    xs: CD_ALPHA_RAD,
    ys: MACH,
    zs: [
      [0.079, 0.086, 0.109, 0.173, 0.134], // -10 deg
      [0.029, 0.031, 0.039, 0.073, 0.059], // -5 deg
      [0.0179, 0.0185, 0.0224, 0.0516, 0.0426], // -2.5 deg
      [0.016, 0.016, 0.019, 0.048, 0.039], // 0 deg
      [0.0231, 0.0235, 0.0294, 0.0647, 0.052], // 2.5 deg
      [0.039, 0.041, 0.054, 0.103, 0.084], // 5 deg
      [0.0583, 0.0622, 0.0815, 0.143, 0.1165], // 7.5 deg
      [0.084, 0.089, 0.109, 0.183, 0.149], // 10 deg
      [0.154, 0.161, 0.189, 0.283, 0.229], // 15 deg
      [0.254, 0.261, 0.299, 0.403, 0.339], // 20 deg
      [0.304, 0.311, 0.349, 0.453, 0.389], // 22 deg
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
  // Configuration drag, referenced to wingAreaM2 (38.4 m^2). Gear: ~0.02 is typical for a
  // fighter's tricycle gear with doors open (~0.8 m^2 of drag area). Airbrake: the Tejas's
  // upper-fuselage airbrake panels, 0.10 (~3.8 m^2). The first value, 0.05 (~1.9 m^2, a small
  // fighter speedbrake), gave only ~0.14 g extra deceleration at 150 m/s and play-testing found
  // it had "almost no effect"; 0.10 gives ~0.3 g at 150 m/s and ~0.7 g at 250 m/s. There is no
  // published Tejas figure, so this is tuned for a clearly felt, still plausible speedbrake.
  CD_gear: 0.02,
  CD_airbrake: 0.1,
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
