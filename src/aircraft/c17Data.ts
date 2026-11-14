/**
 * src/aircraft/c17Data.ts — the flight data of the Boeing C-17A Globemaster III (IAF fit: ER
 * centre-wing tanks): mass, fuel, geometry, four F117-PW-100s, clean aero, slats/flaps, externally
 * blown flaps, spoilers, stability derivatives, FCS limits, gear and airframe contact points.
 * c17Definition.ts assembles the AircraftDefinition from these.
 *
 * Every number comes from docs/spec/c17-data.md (the "pack"); its section is given with each one,
 * with the pack's confidence tag: [P] primary, [S] secondary, [U] unofficial (crew flashcards
 * quoting T.O. 1C-17A-1), [E] ESTIMATE (method given here or in the pack). Re-check [U] limits
 * against a controlled source before relying on them.
 *
 *   quantity                    value                          source
 *   wing area / span / MAC      353.0 m^2 / 51.755 m / 7.727 m  [S] WIKI, VT09 (pack 1.1)
 *   empty (basic) mass          128,140 kg                     [S] WIKI (pack 1.2)
 *   max take-off mass           265,352 kg (585,000 lb)        [P] USAF fact sheet
 *   usable fuel (ER tanks)      110,949 kg (244,600 lb)        [U] FC3; IAF aircraft modelled as ER [E]
 *   max payload                 77,519 kg (170,900 lb)         [P] AF, FAS
 *   engines                     4 x F117-PW-100, 179.9 kN SLS  [P] AF, BOE
 *   thrust lapse                Bartel & Young high-BPR model  [E] pack 2.2 table
 *   g limits                    +2.25/-1 flaps up (brief; the pack's estimate was +2.5), 0..+2 flaps/slats out [U] FC1
 *   bank                        70 deg max, <= 10 deg/s roll beyond 60 deg   [U] FC1
 *   Vmo / Mmo                   350 KCAS / M0.825              [U] FC1
 */
import type { AeroTables, EngineTables, FcsLimits, FlapDetentDefinition, GearDefinition, HighLiftDefinition, MassModelDefinition, PlacardDefinition, SpoilerDefinition, EngineInstanceDefinition } from '../contracts/aircraft';
import type { Vec3Like } from '../contracts/core';
import type { Table2D } from '../contracts/math';

const DEG = Math.PI / 180;
const KT = 0.514444;

// --- Mass and geometry (pack 1.1, 1.2). ---
export const c17EmptyMassKg = 128140;
export const c17MaxFuelKg = 110949;
export const c17MaxTakeoffMassKg = 265352;
export const c17MaxPayloadKg = 77519;
/** Reference mass (a mid-mission weight); the mass model does the real bookkeeping. */
export const c17MassKg = 200000;
export const c17WingAreaM2 = 353.0;
export const c17WingSpanM = 51.755;
/** Mean aerodynamic chord [S] VT09: the pitching-moment reference length. */
export const c17MeanChordM = 7.727;

/**
 * Empty-aircraft inertia, body axes (x roll, y yaw, z pitch), kg m^2 [E]: the pack's Roskam
 * radii-of-gyration estimate at OEW (pack 1.4: Ixx 8.90e6, Iyy 1.04e7 pitch, Izz 1.89e7 yaw; the
 * method is within 8% on the B-747). Fuel and cargo add their own (c17MassModel).
 */
export const c17InertiaBodyKgM2 = { xx: 8.9e6, yy: 1.89e7, zz: 1.04e7, xy: 0, xz: 0, yz: 0 } as const;

/**
 * Mass model [E] (pack 1.4 "refinements"): the empty airframe's inertia plus strip/box masses.
 *   fuel: wing tanks from ~3 to ~20 m span, weighted to the deeper inboard tanks: k^2 ~110 m^2 in
 *     roll; swept 25 deg, so it spreads ~+3..-9 m fore and aft: ~25 m^2 in pitch; yaw = sum.
 *     Its centroid sits ~0.07 MAC behind the reference CG (wing box mid-chord): -0.5 m.
 *   cargo: on the floor of the 26.8 x 5.5 m cargo box, ~2.5 m below the CG: roll 2.5 + 6 = 8.5,
 *     pitch 26.8^2/12 + 6 = 62, yaw 56 + 2.5 = 58.5 m^2 (uniformly spread load); centroid at the
 *     reference CG (loaded to the CG) unless EntityState.cargoCgBodyX moves it (airdrop hook).
 *   At MTOW (full ER fuel + 26 t cargo) this gives Ixx 2.1e7, pitch 1.5e7, yaw 3.5e7 kg m^2,
 *   against Roskam's 1.84e7 / 2.15e7 / 3.92e7 for the whole aircraft at that mass: lower in pitch
 *   because fuel and cargo sit nearer the CG than the airframe's own mass does.
 * Reference CG (the body origin) = 0.30 MAC, the pack's nominal CG (1.3). The pack's Cm tables
 * are built for a 10% static margin (it gives 10-15% as the plausible range).
 */
export const c17MassModel: MassModelDefinition = {
  fuelInertiaM2: { xx: 110, yy: 135, zz: 25 },
  cargoInertiaM2: { xx: 8.5, yy: 58.5, zz: 62 },
  emptyCgBodyX: 0,
  fuelCgBodyX: -0.5,
  cargoCgBodyX: 0,
  maxCargoKg: c17MaxPayloadKg,
};

// --- Engines: 4 x F117-PW-100 (PW2040), per-engine tables (pack 2.2). ---
const ENG_MACH = [0, 0.2, 0.4, 0.6, 0.7, 0.8, 0.85] as const;
const ENG_ALT_M = [0, 3000, 6000, 9000, 11000, 13000] as const;
/** Thrust per engine at throttle 1 (TOGA below 3 km, MCT/max climb above), kN [E] Bartel & Young lapse on the 179.9 kN [P] rating. */
const THRUST_KN: readonly (readonly number[])[] = [
  [179.9, 143.7, 107.7, 76.9, 60.3, 47.0],
  [147.7, 119.8, 88.9, 62.9, 49.1, 38.4],
  [125.5, 103.2, 75.4, 52.4, 40.6, 31.7],
  [113.2, 94.0, 67.1, 45.4, 34.8, 27.1],
  [110.8, 92.1, 64.9, 43.3, 32.9, 25.5],
  [110.8, 92.0, 64.0, 42.0, 31.7, 24.4],
  [111.8, 92.7, 64.1, 41.7, 31.3, 24.0],
];
/** Fuel flow per engine at throttle 1, kg/s [E]: TSFC 0.34 (1 + 1.21 M) sqrt(theta); SLS cell within 1% of ICAO EDB [P]. */
const FUEL_KGS: readonly (readonly number[])[] = [
  [1.733, 1.336, 0.964, 0.662, 0.503, 0.393],
  [1.767, 1.383, 0.989, 0.671, 0.509, 0.398],
  [1.793, 1.424, 1.002, 0.668, 0.503, 0.393],
  [1.881, 1.508, 1.038, 0.674, 0.501, 0.39],
  [1.97, 1.582, 1.074, 0.687, 0.507, 0.393],
  [2.101, 1.684, 1.129, 0.711, 0.52, 0.401],
  [2.184, 1.749, 1.164, 0.728, 0.53, 0.407],
];
const thrustTable: Table2D = { xs: ENG_MACH, ys: ENG_ALT_M, zs: THRUST_KN.map((r) => r.map((v) => v * 1000)) };
const fuelTable: Table2D = { xs: ENG_MACH, ys: ENG_ALT_M, zs: FUEL_KGS };

export const c17Engine: EngineTables = {
  militaryThrustN: thrustTable,
  // No afterburner (pack 2.2): the tables are set equal to dry and hasAfterburner is false.
  afterburnerThrustN: thrustTable,
  militaryFuelFlowKgS: fuelTable,
  afterburnerFuelFlowKgS: fuelTable,
  /** ICAO LTO idle point: 0.159 kg/s at 7% thrust [P] EDB. */
  idleFuelFlowKgS: 0.159,
  /** Single-value fallback (pack 2.3: 1.8 s); the two-rate `spool` model below is what runs. */
  spoolTimeConstantSec: 1.8,
  hasAfterburner: false,
  /** Flight idle 7% of rated thrust [P] EDB idle point (ground idle is ~3-5% [E]; one value used). */
  idleThrustFrac: 0.07,
  /**
   * [E] pack 2.3: tau 2.5 s below 60% N1, 1.2 s above, 1.5 s down. With thrust = N1^2 this takes
   * flight idle to 95% thrust in ~4.9 s, inside the 5 s of 14 CFR 33.73 [P].
   */
  spool: { upLowTauSec: 2.5, upHighTauSec: 1.2, breakN1Frac: 0.6, downTauSec: 1.5 },
  reverser: {
    /** [E] typical cascade reverser, 0.40 of forward thrust at the same N1 (pack 2.4; not published). */
    thrustFrac: 0.4,
    /** [E] pack 2.4: ram drag D = c rho V^2 A_fan, c = 0.8, A_fan = 3.12 m^2 (78.5 in fan [S] AC). */
    ramDragCoeff: 0.8,
    fanAreaM2: 3.12,
    /** [E] no published figure; typical cascade deploy time. */
    transitSec: 2.0,
    /** Engine logic holds reverse idle in flight [U] AGC; [S] TWZ. */
    idleOnlyInFlight: true,
    /** Ground reverser limit 182 KCAS [U] FC1, FC3. */
    maxGroundIasMps: 182 * KT,
  },
  /** [E] pack 2.2: -0.75%/K above an assumed ISA+15 flat-rate temperature (Raymer via [SCH]). */
  hotDay: { flatRateIsaDevK: 15, thrustLossPerK: 0.0075 },
};

/**
 * Engine positions, body frame relative to the reference CG [E] (pack 2.5): spanwise +-7.0 m
 * inboard and +-13.5 m outboard (scaled off the imported C-17 model, +-1 m). Thrust line 0.8 m
 * above the CG [E]: nacelles hang ~1.8 m under a wing that sits on top of the fuselage, the CG near
 * mid-fuselage. Fore-aft position does not enter the moments of an axial thrust.
 */
export const c17Engines: readonly EngineInstanceDefinition[] = [
  { id: 'eng1', posBodyM: { x: 1.5, y: 0.8, z: -13.5 } },
  { id: 'eng2', posBodyM: { x: 4.0, y: 0.8, z: -7.0 } },
  { id: 'eng3', posBodyM: { x: 4.0, y: 0.8, z: 7.0 } },
  { id: 'eng4', posBodyM: { x: 1.5, y: 0.8, z: 13.5 } },
];

// --- Clean aero (pack 3.1): tables transcribed from the pack, alpha deg x Mach. ---
const ALPHA_DEG = [-6, -3, 0, 3, 6, 9, 12, 14, 16, 18, 22, 30, 40] as const;
const MACH = [0.2, 0.5, 0.7, 0.78, 0.85] as const;
/** [E] DATCOM/Helmbold CLalpha x 1.11 body+tail, CL0 0.20, CLmax 1.40 -> 0.80 with Mach (pack 3.1). */
const CL_ROWS: readonly (readonly number[])[] = [
  [-0.313, -0.355, -0.419, -0.462, -0.514],
  [-0.057, -0.077, -0.11, -0.131, -0.157],
  [0.2, 0.2, 0.2, 0.2, 0.2],
  [0.457, 0.477, 0.51, 0.531, 0.557],
  [0.713, 0.755, 0.819, 0.862, 0.774],
  [0.97, 1.032, 1.09, 0.88, 0.694],
  [1.226, 1.296, 0.98, 0.785, 0.64],
  [1.397, 1.209, 0.906, 0.76, 0.64],
  [1.308, 1.122, 0.88, 0.76, 0.64],
  [1.215, 1.04, 0.88, 0.76, 0.64],
  [1.12, 1.04, 0.88, 0.76, 0.64],
  [1.12, 1.04, 0.88, 0.76, 0.64],
  [1.12, 1.04, 0.88, 0.76, 0.64],
];
/** [E] CD0 0.021 (Raymer Cfe x Swet) + K CL^2 (e 0.80 on AR 7.67) + Lock wave drag + post-stall 0.6 sin^2 alpha (pack 3.1). */
const CD_ROWS: readonly (readonly number[])[] = [
  [0.0261, 0.0275, 0.0301, 0.0322, 0.0405],
  [0.0212, 0.0213, 0.0216, 0.0219, 0.0232],
  [0.0231, 0.0231, 0.0231, 0.0231, 0.0243],
  [0.0318, 0.0328, 0.0345, 0.0359, 0.044],
  [0.0474, 0.0506, 0.0558, 0.0622, 0.0737],
  [0.0698, 0.0762, 0.0975, 0.0788, 0.0722],
  [0.099, 0.1341, 0.0968, 0.0807, 0.0777],
  [0.1222, 0.1319, 0.0987, 0.0876, 0.0869],
  [0.1553, 0.1319, 0.1068, 0.0981, 0.0973],
  [0.1549, 0.1344, 0.1185, 0.1098, 0.1091],
  [0.1703, 0.1613, 0.1454, 0.1367, 0.136],
  [0.2361, 0.2271, 0.2112, 0.2025, 0.2018],
  [0.334, 0.325, 0.3091, 0.3004, 0.2997],
];
/**
 * [E] Cm about 0.30 MAC: static margin 10% (Cmalpha = -0.10 CLalpha; C-5A power approach 13.6%
 * [P] CR2144), then the T-tail pitch-up past the stall (+0.30 over 8 deg, held to 30 deg, restoring
 * beyond 32): a stable deep-stall trim near 35-40 deg, the failure the AoA limiter exists for (pack 3.1, 3.6).
 */
const CM_ROWS: readonly (readonly number[])[] = [
  [0.071, 0.075, 0.082, 0.086, 0.091],
  [0.046, 0.048, 0.051, 0.053, 0.056],
  [0.02, 0.02, 0.02, 0.02, 0.02],
  [-0.006, -0.008, -0.011, -0.013, -0.016],
  [-0.031, -0.035, -0.042, -0.046, -0.001],
  [-0.057, -0.063, -0.059, 0.035, 0.119],
  [-0.083, -0.086, 0.065, 0.157, 0.237],
  [-0.1, -0.002, 0.147, 0.234, 0.276],
  [-0.017, 0.082, 0.225, 0.264, 0.276],
  [0.067, 0.165, 0.252, 0.264, 0.276],
  [0.227, 0.236, 0.252, 0.264, 0.276],
  [0.228, 0.236, 0.252, 0.264, 0.276],
  [-0.052, -0.044, -0.028, -0.016, -0.004],
];
const ALPHA_RAD = ALPHA_DEG.map((a) => a * DEG);

/**
 * Stability and control derivatives (pack 3.7): the C-5A power-approach set ([P] NASA CR-2144
 * table X-I, OCR'd; same class of aircraft) adjusted as the pack recommends, all [E] for the C-17.
 * Mapped to this sim's sign rules: +elevon (trailing edge down) nose-down, +rudder (trailing edge
 * left) nose-left with a side force to the right, rates non-dimensional on b/2V and c/2V.
 */
export const c17Aero: AeroTables = {
  CL: { xs: ALPHA_RAD, ys: MACH, zs: CL_ROWS },
  CD: { xs: ALPHA_RAD, ys: MACH, zs: CD_ROWS },
  Cm: { xs: ALPHA_RAD, ys: MACH, zs: CM_ROWS },
  CY_beta: -0.8,
  Cl_beta: -0.12,
  /** [E] C-5A 0.075 raised: the C-17 fin is sized for engine-out [S] VT07. */
  Cn_beta: 0.1,
  /** CLde 0.38/rad [P] C-5A. */
  CL_elevon: 0.38,
  /** [E] trim drag of the elevators. */
  CD_elevon: 0.05,
  /** [E] Torenbeek gear-drag build-up for podded tandem mains, 0.012-0.018 on 353 m^2 (pack 3.5). */
  CD_gear: 0.015,
  /** Ramp + door open [E] pack 3.5: ~22 m^2 aperture x base-drag Cd 0.15 / 353 m^2, slight nose-up. */
  CD_ramp: 0.009,
  Cm_ramp: 0.01,
  /** Cmde -1.5/rad [E] (C-5A -1.6 [P]). */
  Cm_elevon: -1.5,
  /**
   * Per rad of (elevonL - elevonR). [E] C-5A Clda 0.089/rad includes spoilers [P]; with the roll
   * spoilers (pack 3.4: ~0.04 at one side full) lumped in, 0.12 per rad of differential. Gives ~15
   * deg/s steady roll rate at 115 KCAS with the differential at its limit.
   */
  Cl_elevon: 0.12,
  /** [E] small adverse yaw (ailerons) partly cancelled by proverse spoilers. */
  Cn_elevon: -0.004,
  /** CYdr 0.21 [P] C-5A (rudder trailing edge left pushes the tail right). */
  CY_rudder: 0.21,
  Cl_rudder: 0.02,
  /** Cndr -0.11 [E] (C-5A -0.106 [P]): ~120 KCAS V_MCA with an outboard engine out (pack 2.5). */
  Cn_rudder: -0.11,
  Cl_p: -0.45,
  Cl_r: 0.25,
  /** Cmq -25/rad [E] (C-5A -23.2 [P]; larger tail, shorter arm). */
  Cm_q: -25,
  Cn_p: -0.08,
  Cn_r: -0.3,
  /** [E] pack 3.7: h/b ~0.09 at touchdown; 0.10 unpowered, faded by Cmu (highLift.ebf). */
  groundEffectMaxDeltaCL: 0.1,
  /** Clean stall at Mach 0.2 (the CL table's peak); flaps/slats/power move it (highLift). */
  stallAlphaRad: 14 * DEG,
};

/** The clean CL table's lift-curve slope at Mach 0.2, per rad (0.257 per 3 deg). */
const CLA_LOW = 0.257 / (3 * DEG);

function detent(name: string, slats: boolean, flapDeg: number, dCL0: number, dClMaxTotal: number, dCD0: number, dCm0: number, ebfEta: number, maxKcas: number, maxMach: number): FlapDetentDefinition {
  // The stall-alpha shift that gives the pack's total CLmax increment: dClMax = dCL0 + CLalpha dA.
  return { name, slats, flapDeg, dCL0, dAlphaStallRad: (dClMaxTotal - dCL0) / CLA_LOW, dCD0, dCm0, ebfEta, maxIasMps: maxKcas * KT, maxMach };
}

/**
 * Slats and flaps (pack 3.2). Lever detents and placards [U] FC1/FC3; flap angles are not public:
 * increments [E] from NASA TN D-6058 (EBF transport model, flaps 30/60, CLmax ~2.1 at Cmu 0 [P])
 * and the YC-15 lineage, unpowered CLmax UP 1.40 / SLATS 1.85 / 1/2 2.25 / 3/4 2.55 / FULL 2.70.
 * ebfEta: [E] pack 3.3 (0 / 0.25 / 0.35 / 0.40), calibrated so FULL at 160 t trims near the
 * published 115-kt approach speed at approach power (Cmu ~0.3).
 */
export const c17Detents: readonly FlapDetentDefinition[] = [
  detent('UP', false, 0, 0, 0, 0, 0, 0, 350, 0.825),
  // Slats: extend 280 KCAS (retract 270); stall alpha +~5 deg.
  detent('SLATS', true, 0, 0, 0.45, 0.004, 0, 0, 280, 0.62),
  detent('1/2', true, 25, 0.45, 0.85, 0.02, -0.08, 0.25, 250, 0.62),
  detent('3/4', true, 40, 0.8, 1.15, 0.045, -0.15, 0.35, 190, 0.62),
  detent('FULL', true, 60, 1.0, 1.3, 0.08, -0.22, 0.4, 175, 0.62),
];

export const c17HighLift: HighLiftDefinition = {
  detents: c17Detents,
  /** [E] no published flap times: ~6 s per detent, slats ~5 s (typical large transport). */
  flapSecPerDetent: 6,
  slatTransitSec: 5,
  /** K = 1/(pi 7.67 0.80) [E] pack 3.1. */
  inducedDragK: 0.0519,
  staticMargin: 0.1,
  /** The clean CL table's peaks (pack 3.1). */
  cleanStallAlpha: { xs: MACH, ys: [14 * DEG, 12 * DEG, 9 * DEG, 9 * DEG, 6 * DEG] },
  ebf: {
    /** F(Cmu) = D6058 "CL at alpha 0" minus its unblown 1.2 [P] read off figures +-0.15 (pack 3.3). */
    lift: { xs: [0, 0.25, 0.5, 1.0, 2.0], ys: [0, 1.0, 1.8, 2.8, 3.9] },
    /** CLmax rises 1.1 x dCL_EBF [E] pack 3.3 (D6058: stall alpha 17 -> 21 deg at high Cmu). */
    stallAlphaRadPerDCL: 0.1 / CLA_LOW,
    /** dCm = -0.16 dCL_EBF [E] (D6058 ratio -0.45/2.8, tail off). */
    cmPerDCL: -0.16,
    /** [E] D6058: outboard engine out at Cmu 2.9 rolls with Cl ~0.20 for a CL loss of ~1.0 -> arm ~0.2 b. */
    rollArmM: 0.2 * c17WingSpanM,
    /** Jet turning ~0.35 x aft-flap angle [E] pack 3.3. */
    turnFrac: 0.35,
    /** [E] pack 3.3: powered-lift ground effect fades to zero at Cmu 0.8. */
    groundEffectZeroCmu: 0.8,
  },
};

/** Spoilers (pack 3.4, [E] Roskam spoiler charts for panels over 15-68% semispan). */
export const c17Spoilers: SpoilerDefinition = {
  /** In-flight speedbrake ~36 deg of the 60 deg lift-dump travel. */
  speedbrakeFrac: 0.6,
  speedbrake: { dCL: -0.1, dCD: 0.025, dCm: 0.02 },
  liftDump: { dCLClean: -0.4, dCLFlaps: -0.8, dCD: 0.06, dCm: 0.05, liftDumpFlapsFromDetent: 3 },
  extendSec: 1.5,
  retractSec: 2.0,
};

/** Placards [U] FC1: gear 250 KCAS, Vmo 350 KCAS / Mmo 0.825, ramp/door 250 KCAS. */
export const c17Placards: PlacardDefinition = {
  gearMaxIasMps: 250 * KT,
  vmoIasMps: 350 * KT,
  mmo: 0.825,
  rampMaxIasMps: 250 * KT,
};

/**
 * FCS (pack 4): pitch-rate command / attitude hold up and away (the shared g-command law with its
 * flight-path-hold neutral, held to a transport's rates), roll-rate command, sideslip-command yaw
 * with a yaw damper, alpha limiting at 0.9 of the configured stall alpha.
 */
export const c17FcsLimits: FcsLimits = {
  /** Clean fallback only: the live limit is alphaLimitStallFrac x the configured stall alpha. */
  maxAlphaRad: 0.9 * 14 * DEG,
  minAlphaRad: -6 * DEG,
  /** +2.25 / -1.0 g flaps up (brief), 0 .. +2.0 g with flaps/slats out [U] FC1. */
  maxGLoadPos: 2.25,
  maxGLoadNeg: -1.0,
  flapsDownMaxGLoadPos: 2.0,
  flapsDownMaxGLoadNeg: 0,
  /** 15 deg/s roll-rate command [E] pack 4.2; 10 deg/s past 60 deg bank, 70 deg max [U] FC1. */
  maxRollRateRadS: 15 * DEG,
  maxBankRad: 70 * DEG,
  bankRateReduceAboveRad: 60 * DEG,
  highBankRollRateRadS: 10 * DEG,
  /** Elevator +-25 deg, rudder +-30 deg [E] typical transport limits (pack 4.3, 11 #5). */
  maxElevonRad: 25 * DEG,
  maxRudderRad: 30 * DEG,
  /** 40 deg/s surface rates [E] (the original FCS software limited them to 60 deg/s [P] SW). */
  maxElevonRateRadS: 40 * DEG,
  maxRudderRateRadS: 40 * DEG,
  /** [E] tuned for a ~1 s pitch-rate rise without overshoot (pack 11 #5). */
  pitchRateGain: -1.2,
  rollRateGain: 2.5,
  yawRateGain: -1.2,
  alphaLimitGain: 3.0,
  /** Sign carrier for the trim integral (statically stable airframe: more nose-down elevator, less g). */
  gLoadGain: -0.3,
  /** [E] ~3 deg/s rotation, a heavy transport's (fighters: 10 deg/s). */
  groundRotationRateRadS: 3 * DEG,
  /** [E] the rotation integral that brings in the elevator a heavy nose-gear load needs (~2 s to full). */
  groundRotationIntegralGain: 2.0,
  /** Elevator plus the auto-trimmed stabiliser [E]. */
  trimIntegralMaxRad: 25 * DEG,
  /** ~5-6 deg/s at full stick [E] pack 4.2 sketch. */
  maxPitchRateCmdRadS: 6 * DEG,
  /** ALS: alpha limit 0.9 x the configured stall alpha [E] pack 3.6. */
  alphaLimitStallFrac: 0.9,
  /** No published attitude limit; +25 / -15 deg pitch [E] pack 4.4. */
  maxPitchAttitudeRad: 25 * DEG,
  minPitchAttitudeRad: -15 * DEG,
  /**
   * [E] the limiter may pitch at 10 deg/s to follow a falling flight path at low speed (the g path's
   * own ceiling there is ~2 deg/s, sized against elevator saturation).
   */
  alphaPathMaxPitchRateRadS: 10 * DEG,
  /** Sideslip-command yaw (pack 4.2) [E]. */
  sideslipIntegralGain: 0.4,
  /** Roll-rate command / attitude hold (pack 4.2) [E]: an integral on the rate error. */
  rollIntegralGain: 1.5,
};

/**
 * Gear: three equivalent legs (pack 9.4) — nose (2 wheels) and two lumped main bogies (2 legs x 3
 * wheels each side, in the sponsons). Track 10.26 m, wheelbase ~20 m [E] (sponson width [S] VT07,
 * the GLB model, docs/spec/himalaya-theatre.md 3.3). Mains 1.8 m behind the reference CG (~9% of
 * the weight on the nose wheel) [E]; CG 4.5 m above the ground on the gear [E].
 * Springs [E]: static compression ~0.3 m at MTOW on the mains, ~0.25 m on the nose; dampers ~half
 * critical. Brakes: a mean anti-skid braking coefficient of 0.38 on dry pavement [E] (the theatre
 * study used 0.35; a modulated anti-skid system keeps the tyres near the peak of the slip curve).
 */
const GEAR_Y = -4.5;
export const c17Gear: readonly GearDefinition[] = [
  {
    id: 'nose',
    posBodyM: { x: 18.2, y: GEAR_Y, z: 0 },
    maxCompressionM: 0.45,
    springNPerM: 950000,
    damperNPerMPerS: 150000,
    kineticFrictionCoefficient: 0.38,
    steerable: true,
    /** [E] tiller authority ~60 deg (star turns in < 80 ft [S] AVN). */
    maxSteerAngleRad: 60 * DEG,
    steeringWheelbaseM: 20.0,
    brakeCapable: false,
  },
  {
    id: 'mainLeft',
    posBodyM: { x: -1.8, y: GEAR_Y, z: -5.13 },
    maxCompressionM: 0.5,
    springNPerM: 3.9e6,
    damperNPerMPerS: 7.0e5,
    kineticFrictionCoefficient: 0.38,
    steerable: false,
    maxSteerAngleRad: 0,
    brakeCapable: true,
  },
  {
    id: 'mainRight',
    posBodyM: { x: -1.8, y: GEAR_Y, z: 5.13 },
    maxCompressionM: 0.5,
    springNPerM: 3.9e6,
    damperNPerMPerS: 7.0e5,
    kineticFrictionCoefficient: 0.38,
    steerable: false,
    maxSteerAngleRad: 0,
    brakeCapable: true,
  },
];

/**
 * Airframe hard points, body frame [E] (pack 1.1 dimensions, CG 4.5 m above the ground, 0.30 MAC
 * ~27 m behind the nose): nose, belly, the upswept tail cone (a tail strike at ~12 deg on the main
 * wheels), nacelle bottoms, anhedral wing tips (51.755 m span), tailplane tips and the fin top
 * (16.79 m height).
 */
export const c17ContactPoints: readonly Vec3Like[] = [
  { x: 26.0, y: -1.5, z: 0 },
  { x: 20.0, y: -3.1, z: 0 },
  { x: 10.0, y: -3.2, z: 0 },
  { x: 0.0, y: -3.2, z: 0 },
  { x: -8.0, y: -3.0, z: 0 },
  { x: -14.0, y: -1.8, z: 0 },
  { x: -20.0, y: -0.5, z: 0 },
  { x: -26.0, y: 1.0, z: 0 },
  { x: 1.5, y: -0.4, z: -13.5 },
  { x: 1.5, y: -0.4, z: 13.5 },
  { x: 4.0, y: -0.4, z: -7.0 },
  { x: 4.0, y: -0.4, z: 7.0 },
  { x: -7.5, y: 2.0, z: -25.9 },
  { x: -7.5, y: 2.0, z: 25.9 },
  { x: -25.0, y: 12.3, z: -9.9 },
  { x: -25.0, y: 12.3, z: 9.9 },
  { x: -23.0, y: 12.2, z: 0 },
];
