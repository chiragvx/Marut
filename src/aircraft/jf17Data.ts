/**
 * src/aircraft/jf17Data.ts — the flight data of the PAC/CAC JF-17 Thunder (Block II, the PAF's
 * standard fit): mass, fuel, MTOW, wing, the Klimov RD-93's thrust and fuel flow, aero tables, FCS
 * limits and airframe contact points. aggressors.ts assembles jf17Definition from these.
 *
 * PUBLISHED FIGURES (S = sourced, E = estimated here, method given):
 *
 *   quantity                  JF-17 Block II                 Tejas (this sim, tejasGeometry.ts)
 *   empty mass                6,586 kg (S1)                  6,560 kg
 *   internal fuel             2,330 kg (S2)                  2,458 kg
 *   max take-off mass         12,474 kg (S3)                 13,500 kg
 *   wing area                 24.43 m^2 (S4)                 38.4 m^2
 *   span (over rails)         9.45 m (S3, S4)                8.2 m
 *   length                    14.93 m (S3: 14.97)            13.2 m
 *   engine                    1x Klimov RD-93 (S5)           1x GE F404-GE-IN20
 *   static thrust dry / wet   49.4 / 84.4 kN (S5)            48.9 / 84.0 kN
 *   TSFC dry / full AB        0.77 / ~1.95 lb/(lbf h) (S6)   0.81 / 1.74
 *   g limits                  +8 / -3 (FCS; S4) (+8.5 S3)    +8 / -3
 *   max speed                 Mach 1.6 clean at altitude (S3, S7)   Mach 1.6
 *   service ceiling           15,240 m (S3) - 16,920 m (S4)
 *   combat radius / ferry     1,352 km / 3,482 km with tanks (S3, S4)
 *   climb rate                no credible public figure (S4's 300 m/s is not physical) -- E only
 *
 *   S1 PAC Kamra JF-17 detailed specifications (Block II), via Wikipedia "CAC/PAC JF-17 Thunder" and
 *      secondary listings (an earlier 2003-07 figure was 6,320-6,411 kg; it grew in development).
 *   S2 PAC Kamra "JF-17 Thunder Detailed Specifications", cited by Wikipedia: 2,330 kg internal.
 *   S3 MILAVIA FC-1/JF-17 specifications (2007, from the PAC/CAC brochure): MTOW 12,474 kg
 *      (27,500 lb), normal take-off 9,072 kg, 49.4/84.4 kN, Mach 1.6, 15,240 m, +8.5 g, 1,352 km.
 *      The Block III marketing figure is 13,500 kg; the PAF Block II fit modelled here is 12,474.
 *   S4 Wikipedia "CAC/PAC JF-17 Thunder" specifications (PAC brochure and website): 24.43 m^2, 9.44 m
 *      span, +8/-3 g "limited by flight control system", 16,916 m ceiling.
 *   S5 Klimov poster, Zhuhai 2010 (RD-93: 49.4 kN dry, 84.4 kN wet), cited by Wikipedia "Klimov RD-33".
 *   S6 RD-33 family: 0.77 lb/(lbf h) dry (consistently cited: Jane's Aero Engines, Klimov); full
 *      afterburner is cited as 1.85 (Wikipedia) or 2.05 (Klimov data via older references). 1.95,
 *      the midpoint, is used. Either way it is well above the F404's 1.74, the afterburner being the
 *      RD-33 family's known weak point.
 *   S7 The Diplomat (2019), cited by Wikipedia: Mach 1.6.
 *
 * ENGINE TABLES: the RD-93 is the same class of engine as the F404-IN20 (low-bypass, mixed-flow,
 * afterburning, ~84 kN wet, near-identical static ratings), so its Mach/altitude lapse is taken
 * from the same Mattingly installed-thrust model tejasEngineTables.ts uses, normalised to the RD-93's
 * own static ratings (dry x 49.4/48.9, wet x 84.4/84.0). Fuel flow = thrust x TSFC with the RD-33
 * family's TSFC bases (dry x 0.77/0.81, afterburner x 1.95/1.74 on top of the thrust ratio).
 *
 * AERO TABLES (E): a conventional, moderately swept trapezoidal wing (aspect ratio 9.45^2/24.43 =
 * 3.65, ~33 deg half-chord sweep) with leading-edge root extensions, not a delta.
 *   - Lift-curve slope from the Helmbold/DATCOM finite-wing formula,
 *     a = 2 pi A / (2 + sqrt(4 + A^2 beta^2 (1 + tan^2 L/beta^2) / eta^2)), eta = 0.95:
 *     3.3 / 3.6 / 4.1 per rad at Mach 0.2 / 0.6 / 0.9, plus ~5% for the LERX and body -> 0.060 /
 *     0.064 / 0.072 per deg; supersonic falling as 1/sqrt(M^2-1) to 0.058 / 0.045 per deg.
 *   - The LERX vortex keeps lift linear to ~15 deg and peaks at CLmax ~1.45 near 28 deg at low
 *     speed (F-16-class LERX configuration, NASA TP-1538 low-speed data: CLmax ~1.5 at ~30 deg),
 *     falling with Mach (buffet/shock-limited) to ~1.25 / 1.05 / 0.90 / 0.75.
 *   - Drag: zero-lift CD 0.021 subsonic (drag area ~0.51 m^2: an F-16-class clean airframe, with a
 *     fixed DSI intake and no area ruling), 0.025 at Mach 0.9, a transonic peak of 0.058 at Mach 1.2
 *     and 0.054 at Mach 1.6 (drag area ~1.3 m^2): set so that, with the RD-93 table, full afterburner
 *     balances drag at the published Mach 1.6 at 11 km (the harness measures Mach 1.64; 0.050 gave
 *     Mach 1.71, 0.061 gave 1.44; a 0.070 peak at Mach 1.2 left it unable to pass the transonic hump).
 *     Lift-dependent drag: K = 1/(pi e A), e ~0.8 -> 0.11 (0.115 / 0.13 towards Mach 0.9) at low
 *     alpha, blending above ~8 deg into the no-leading-edge-suction limit CL tan(alpha), and
 *     CL tan(alpha) throughout supersonically.
 *   - Moments: no JF-17 stability derivatives are public. Both jets are fly-by-wire (the JF-17's
 *     pitch channel is FBW; the Tejas is full-authority quadruplex), and the sim's FCS shapes the
 *     handling, so the JF-17's pitch/roll/yaw moment coefficients are the Tejas's rescaled per axis
 *     to give the same angular acceleration per unit coefficient (S c / Iyy, S b / Ixx, S b / Izz;
 *     damping derivatives by S c^2 / I and S b^2 / I). Its manoeuvrability differs where the
 *     airframes really differ: lift per alpha (wing area and slope), CLmax, alpha limit and drag.
 *
 * MASS PROPERTIES (E): the Tejas's inertias scaled by length^2 (pitch, yaw: 14.93 vs 13.2 m) and
 * span^2 (roll, a little less: more of the JF-17's mass sits in its fuselage than in a delta's wing).
 */
import type { AeroTables, EngineTables, FcsLimits } from '../contracts/aircraft';
import type { Vec3Like } from '../contracts/core';
import type { Table2D } from '../contracts/math';
import { aero as tejasAero } from './tejasAeroTables';
import { engine as tejasEngine } from './tejasEngineTables';
import { fcsLimits as tejasFcs, inertiaBodyKgM2 as tejasInertia, wingAreaM2 as tejasS, wingSpanM as tejasB, meanChordM as tejasC } from './tejasGeometry';

const DEG = Math.PI / 180;

export const jf17EmptyMassKg = 6586;
export const jf17MaxFuelKg = 2330;
export const jf17MaxTakeoffMassKg = 12474;
/** Reference combat mass (empty + full internal fuel, a pilot and gun ammunition). */
export const jf17MassKg = 8600;
export const jf17WingAreaM2 = 24.43;
export const jf17WingSpanM = 9.45;
/** The same simplified rectangular-reference chord the Tejas uses (area / span). */
export const jf17MeanChordM = jf17WingAreaM2 / jf17WingSpanM;

export const jf17InertiaBodyKgM2 = {
  xx: 6800,
  yy: 48600,
  zz: 42200,
  xy: -300,
  xz: 0,
  yz: 0,
} as const;

// --- Engine: the RD-93. ---
const scaleTable = (t: Table2D, k: number, digits = 1): Table2D => {
  const f = 10 ** digits;
  return { xs: t.xs, ys: t.ys, zs: t.zs.map((row) => row.map((v) => Math.round(v * k * f) / f)) };
};
const DRY_THRUST_K = 49.4 / 48.9;
const WET_THRUST_K = 84.4 / 84.0;
export const RD93_TSFC_DRY = 0.77;
export const RD93_TSFC_AB = 1.95;

export const jf17Engine: EngineTables = {
  militaryThrustN: scaleTable(tejasEngine.militaryThrustN, DRY_THRUST_K, 0),
  afterburnerThrustN: scaleTable(tejasEngine.afterburnerThrustN, WET_THRUST_K, 0),
  militaryFuelFlowKgS: scaleTable(tejasEngine.militaryFuelFlowKgS, DRY_THRUST_K * (RD93_TSFC_DRY / 0.81), 4),
  afterburnerFuelFlowKgS: scaleTable(tejasEngine.afterburnerFuelFlowKgS, WET_THRUST_K * (RD93_TSFC_AB / 1.74), 4),
  idleFuelFlowKgS: tejasEngine.idleFuelFlowKgS,
  spoolTimeConstantSec: tejasEngine.spoolTimeConstantSec,
};

// --- Aero. ---
/** Alpha breakpoints, deg: to 28 (the LERX keeps lift building past the Tejas's 22). */
const ALPHA_DEG = [-10, -5, 0, 5, 10, 15, 20, 24, 28] as const;
const ALPHA_RAD = ALPHA_DEG.map((a) => a * DEG);
const MACH = [0.2, 0.6, 0.9, 1.2, 1.6] as const;

/** CL by alpha row (ALPHA_DEG) and Mach column (MACH); see the header for the derivation. */
const CL_ROWS: readonly (readonly number[])[] = [
  [-0.58, -0.62, -0.7, -0.56, -0.43],
  [-0.28, -0.3, -0.34, -0.27, -0.21],
  [0.02, 0.02, 0.02, 0.02, 0.02],
  [0.32, 0.34, 0.38, 0.31, 0.24],
  [0.62, 0.66, 0.74, 0.6, 0.46],
  [0.92, 0.96, 0.95, 0.78, 0.62],
  [1.18, 1.16, 1.03, 0.86, 0.7],
  [1.36, 1.24, 1.05, 0.89, 0.74],
  [1.45, 1.25, 1.04, 0.9, 0.75],
];
const CD0 = [0.021, 0.021, 0.025, 0.058, 0.054] as const;
const K_SUB = [0.11, 0.115, 0.13] as const;

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** CD from CD0 and the lift polar (header): K CL^2 at low alpha, blending to CL tan(alpha). */
function buildCd(): Table2D {
  const zs = ALPHA_DEG.map((a, i) =>
    MACH.map((m, j) => {
      const cl = CL_ROWS[i]![j]!;
      const noSuction = Math.abs(cl * Math.tan(Math.abs(a) * DEG));
      if (m > 1) return Math.round((CD0[j]! + noSuction) * 10000) / 10000;
      const w = smooth(8, 20, Math.abs(a));
      const polar = K_SUB[j]! * (cl - 0.02) ** 2;
      return Math.round((CD0[j]! + (1 - w) * polar + w * Math.max(polar, noSuction)) * 10000) / 10000;
    })
  );
  return { xs: ALPHA_RAD, ys: MACH, zs };
}

// Per-axis moment rescaling (header): the same angular response per unit coefficient as the Tejas.
const kPitch = (tejasS * tejasC) / tejasInertia.yy / ((jf17WingAreaM2 * jf17MeanChordM) / jf17InertiaBodyKgM2.yy);
const kPitchDamp = (tejasS * tejasC * tejasC) / tejasInertia.yy / ((jf17WingAreaM2 * jf17MeanChordM * jf17MeanChordM) / jf17InertiaBodyKgM2.yy);
const kRoll = (tejasS * tejasB) / tejasInertia.xx / ((jf17WingAreaM2 * jf17WingSpanM) / jf17InertiaBodyKgM2.xx);
const kRollDamp = (tejasS * tejasB * tejasB) / tejasInertia.xx / ((jf17WingAreaM2 * jf17WingSpanM * jf17WingSpanM) / jf17InertiaBodyKgM2.xx);
const kYaw = (tejasS * tejasB) / tejasInertia.zz / ((jf17WingAreaM2 * jf17WingSpanM) / jf17InertiaBodyKgM2.zz);
const kYawDamp = (tejasS * tejasB * tejasB) / tejasInertia.zz / ((jf17WingAreaM2 * jf17WingSpanM * jf17WingSpanM) / jf17InertiaBodyKgM2.zz);
/** Side force per unit mass kept as the Tejas's. */
const kSide = tejasS / jf17WingAreaM2;

/** Cm: the Tejas's rows rescaled, plus 24 and 28 deg rows continuing its pitch-break trend. */
function buildCm(): Table2D {
  const t = tejasAero.Cm;
  const last = t.zs[t.zs.length - 1]!;
  const rows = [...t.zs, last.map((v) => v * 0.8), last.map((v) => v * 0.5)];
  const xs = [...t.xs, 24 * DEG, 28 * DEG];
  return { xs, ys: t.ys, zs: rows.map((r) => r.map((v) => Math.round(v * kPitch * 10000) / 10000)) };
}

export const jf17Aero: AeroTables = {
  CL: { xs: ALPHA_RAD, ys: MACH, zs: CL_ROWS },
  CD: buildCd(),
  Cm: buildCm(),
  CY_beta: tejasAero.CY_beta * kSide,
  Cl_beta: tejasAero.Cl_beta * kRoll,
  Cn_beta: tejasAero.Cn_beta * kYaw,
  // All-moving tailplanes: a little less direct lift per radian than the Tejas's big elevons (E).
  CL_elevon: 0.35,
  CD_elevon: 0.12,
  // Gear (~0.5 m^2) and the two aft-fuselage airbrakes (~2.4 m^2), referenced to 24.43 m^2 (E).
  CD_gear: 0.02,
  CD_airbrake: 0.1,
  Cm_elevon: tejasAero.Cm_elevon * kPitch,
  Cl_elevon: tejasAero.Cl_elevon * kRoll,
  Cn_elevon: tejasAero.Cn_elevon * kYaw,
  CY_rudder: tejasAero.CY_rudder * kSide,
  Cl_rudder: tejasAero.Cl_rudder * kRoll,
  Cn_rudder: tejasAero.Cn_rudder * kYaw,
  Cl_p: tejasAero.Cl_p * kRollDamp,
  Cl_r: tejasAero.Cl_r * kRollDamp,
  Cm_q: tejasAero.Cm_q * kPitchDamp,
  Cn_p: tejasAero.Cn_p * kYawDamp,
  Cn_r: tejasAero.Cn_r * kYawDamp,
  // A higher-aspect-ratio wing, further above the ground than a delta's: a little less ground effect.
  groundEffectMaxDeltaCL: 0.12,
  stallAlphaRad: 26 * DEG,
};

/** +8/-3 g (FCS-limited, S4); a 26 deg alpha limiter (E: F-16-class LERX fighter, ~25-26 deg). */
export const jf17FcsLimits: FcsLimits = {
  ...tejasFcs,
  maxAlphaRad: 26 * DEG,
  maxGLoadPos: 8.0,
  maxGLoadNeg: -3.0,
  // Conventional ailerons/flaperons and a smaller roll inertia than a delta: the Tejas's FCS roll-rate
  // cap is kept (~220 deg/s); no public JF-17 figure.
};

/**
 * Airframe contact points, body frame (x fwd, y up, z right), measured off public/models/jf17.glb
 * (whose datums match the physics': main wheels on the Tejas's main legs). The JF-17's nose reaches
 * x 8.26 (the Tejas's 7.55), its wingtip launchers z 4.46, its tailplanes z 2.92, its fin y 3.1.
 */
export const jf17ContactPoints: readonly Vec3Like[] = [
  { x: 8.2, y: -0.25, z: 0 },
  { x: 6.5, y: -0.65, z: 0 },
  { x: 4.5, y: -0.72, z: 0 },
  { x: 2.5, y: -0.77, z: 0 },
  { x: 0, y: -0.76, z: 0 },
  { x: -2, y: -0.7, z: 0 },
  { x: -4, y: -0.55, z: 0 },
  { x: -5.5, y: -0.2, z: 0 },
  { x: 1.5, y: -0.78, z: -0.5 },
  { x: 1.5, y: -0.78, z: 0.5 },
  { x: -2.5, y: -0.28, z: -4.45 },
  { x: -2.5, y: -0.28, z: 4.45 },
  { x: -0.1, y: -0.2, z: -4.45 },
  { x: -0.1, y: -0.2, z: 4.45 },
  { x: -5.3, y: -0.18, z: -2.92 },
  { x: -5.3, y: -0.18, z: 2.92 },
  { x: 3.6, y: 1.05, z: 0 },
  { x: -1.5, y: 0.96, z: 0 },
  { x: -4.58, y: 3.11, z: 0 },
];
