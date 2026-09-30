/**
 * src/catalog/weapons.ts — the weapon catalogue: one WeaponProfile per store type, and the drop
 * tanks. Pure data (depends on src/contracts only), shared by every aircraft definition.
 *
 * The GSh-23, R-73 and Derby entries are built from the tuned constants in contracts/combat.ts
 * (they are also the generic defaults, src/combat/weaponProfiles.ts). Values are public-source
 * approximations; tune them here.
 */
import { WeaponKind } from '../contracts/core';
import {
  GUN_ARM_DISTANCE_M,
  GUN_BULLET_MAX_LIFETIME_SEC,
  GUN_DISPERSION_MRAD,
  GUN_HIT_DAMAGE_FRAC,
  GUN_MUZZLE_VELOCITY_MPS,
  GUN_ROUND_CROSS_SECTION_M2,
  GUN_ROUND_DRAG_COEFF,
  GUN_ROUND_INTERVAL_SEC,
  GUN_ROUND_MASS_KG,
  IR_AFTERBURNER_RANGE_MULT,
  IR_ARM_DISTANCE_M,
  IR_BASE_DETECT_RANGE_HEAD_ON_M,
  IR_BASE_DETECT_RANGE_TAIL_ON_M,
  IR_EJECTION_SPEED_MPS,
  IR_LOCK_TIME_SEC,
  IR_MAX_FLIGHT_TIME_SEC,
  IR_MAX_G,
  IR_MIN_LAUNCH_RANGE_M,
  IR_MISSILE_CROSS_SECTION_M2,
  IR_MISSILE_DRAG_COEFF,
  IR_MISSILE_MASS_KG,
  IR_MOTOR_BURN_TIME_SEC,
  IR_MOTOR_THRUST_N,
  IR_PN_GAIN,
  IR_PROXIMITY_FUSE_RADIUS_M,
  IR_SEEKER_ACQUIRE_HALF_ANGLE_RAD,
  IR_SEEKER_GIMBAL_RATE_MAX_RAD_S,
  IR_SEEKER_TRACK_HALF_ANGLE_RAD,
  IR_WARHEAD_DAMAGE_FRAC,
  RADAR_LOCK_BREAK_GRACE_SEC,
  RADAR_LOCK_TIME_SEC,
  RADAR_MAX_RANGE_M,
  RADAR_MISSILE_ACTIVE_SEEKER_HALF_ANGLE_RAD,
  RADAR_MISSILE_ACTIVE_SEEKER_RANGE_M,
  RADAR_MISSILE_ARM_DISTANCE_M,
  RADAR_MISSILE_CROSS_SECTION_M2,
  RADAR_MISSILE_DRAG_COEFF,
  RADAR_MISSILE_EJECTION_SPEED_MPS,
  RADAR_MISSILE_G_SATURATION_LOST_SEC,
  RADAR_MISSILE_MASS_KG,
  RADAR_MISSILE_MAX_FLIGHT_TIME_SEC,
  RADAR_MISSILE_MAX_G,
  RADAR_MISSILE_MAX_RANGE_M,
  RADAR_MISSILE_MOTOR_BURN_TIME_SEC,
  RADAR_MISSILE_MOTOR_THRUST_N,
  RADAR_MISSILE_PN_GAIN,
  RADAR_MISSILE_PROXIMITY_FUSE_RADIUS_M,
  RADAR_MISSILE_WARHEAD_DAMAGE_FRAC,
  RADAR_NOTCH_CLOSURE_MPS,
  RADAR_NOTCH_MAX_RANGE_M,
  RADAR_REFERENCE_RANGE_M,
  RADAR_REFERENCE_RCS_M2,
  RADAR_SCAN_AZ_HALF_ANGLE_RAD,
  RADAR_SCAN_EL_HALF_ANGLE_RAD,
  RADAR_TRACK_HALF_ANGLE_RAD,
  type RadarProfile,
  type WeaponProfile,
} from '../contracts/combat';

const NO_MISSILE = { motorBurnSec: 0, motorThrustN: 0, pnGain: 0, maxG: 0, proximityFuseRadiusM: 0, minLaunchRangeM: 0 } as const;
const NO_GUN = { roundIntervalSec: 0, dispersionMrad: 0 } as const;

/** GSh-23 twin-barrel 23 mm cannon (one 23x115 round ~0.34 kg carried, internal). */
export const GENERIC_GUN_PROFILE: WeaponProfile = {
  id: 'gsh-23',
  name: 'GSh-23',
  label: 'GUN',
  short: 'GUN',
  kind: WeaponKind.Gun,
  carriageMassKg: 0.34,
  carriageDragAreaM2: 0,
  projectileMassKg: GUN_ROUND_MASS_KG,
  dragCoeff: GUN_ROUND_DRAG_COEFF,
  crossSectionM2: GUN_ROUND_CROSS_SECTION_M2,
  maxLifetimeSec: GUN_BULLET_MAX_LIFETIME_SEC,
  armDistanceM: GUN_ARM_DISTANCE_M,
  launchSpeedMps: GUN_MUZZLE_VELOCITY_MPS,
  roundIntervalSec: GUN_ROUND_INTERVAL_SEC,
  dispersionMrad: GUN_DISPERSION_MRAD,
  ...NO_MISSILE,
  damageFrac: GUN_HIT_DAMAGE_FRAC,
};

/** R-73-class short-range IR missile (105 kg; drag area incl. its rail). */
export const GENERIC_IR_MISSILE_PROFILE: WeaponProfile = {
  id: 'r-73',
  name: 'R-73',
  label: 'R-73',
  short: 'R73',
  kind: WeaponKind.IrMissile,
  carriageMassKg: IR_MISSILE_MASS_KG,
  carriageDragAreaM2: 0.03,
  projectileMassKg: IR_MISSILE_MASS_KG,
  dragCoeff: IR_MISSILE_DRAG_COEFF,
  crossSectionM2: IR_MISSILE_CROSS_SECTION_M2,
  maxLifetimeSec: IR_MAX_FLIGHT_TIME_SEC,
  armDistanceM: IR_ARM_DISTANCE_M,
  launchSpeedMps: IR_EJECTION_SPEED_MPS,
  ...NO_GUN,
  motorBurnSec: IR_MOTOR_BURN_TIME_SEC,
  motorThrustN: IR_MOTOR_THRUST_N,
  pnGain: IR_PN_GAIN,
  maxG: IR_MAX_G,
  proximityFuseRadiusM: IR_PROXIMITY_FUSE_RADIUS_M,
  damageFrac: IR_WARHEAD_DAMAGE_FRAC,
  minLaunchRangeM: IR_MIN_LAUNCH_RANGE_M,
  ir: {
    acquireHalfAngleRad: IR_SEEKER_ACQUIRE_HALF_ANGLE_RAD,
    trackHalfAngleRad: IR_SEEKER_TRACK_HALF_ANGLE_RAD,
    gimbalRateRadS: IR_SEEKER_GIMBAL_RATE_MAX_RAD_S,
    lockTimeSec: IR_LOCK_TIME_SEC,
    detectRangeTailOnM: IR_BASE_DETECT_RANGE_TAIL_ON_M,
    detectRangeHeadOnM: IR_BASE_DETECT_RANGE_HEAD_ON_M,
    afterburnerRangeMult: IR_AFTERBURNER_RANGE_MULT,
  },
};

/** Derby-class active-radar missile (118 kg). */
export const GENERIC_RADAR_MISSILE_PROFILE: WeaponProfile = {
  id: 'derby',
  name: 'Derby',
  label: 'DERBY',
  short: 'DBY',
  kind: WeaponKind.RadarMissile,
  carriageMassKg: RADAR_MISSILE_MASS_KG,
  carriageDragAreaM2: 0.04,
  projectileMassKg: RADAR_MISSILE_MASS_KG,
  dragCoeff: RADAR_MISSILE_DRAG_COEFF,
  crossSectionM2: RADAR_MISSILE_CROSS_SECTION_M2,
  maxLifetimeSec: RADAR_MISSILE_MAX_FLIGHT_TIME_SEC,
  armDistanceM: RADAR_MISSILE_ARM_DISTANCE_M,
  launchSpeedMps: RADAR_MISSILE_EJECTION_SPEED_MPS,
  ...NO_GUN,
  motorBurnSec: RADAR_MISSILE_MOTOR_BURN_TIME_SEC,
  motorThrustN: RADAR_MISSILE_MOTOR_THRUST_N,
  pnGain: RADAR_MISSILE_PN_GAIN,
  maxG: RADAR_MISSILE_MAX_G,
  proximityFuseRadiusM: RADAR_MISSILE_PROXIMITY_FUSE_RADIUS_M,
  damageFrac: RADAR_MISSILE_WARHEAD_DAMAGE_FRAC,
  minLaunchRangeM: 0,
  radar: {
    maxRangeM: RADAR_MISSILE_MAX_RANGE_M,
    activeSeekerRangeM: RADAR_MISSILE_ACTIVE_SEEKER_RANGE_M,
    activeSeekerHalfAngleRad: RADAR_MISSILE_ACTIVE_SEEKER_HALF_ANGLE_RAD,
    gSaturationLostSec: RADAR_MISSILE_G_SATURATION_LOST_SEC,
  },
};

/** The original generic fire-control radar. */
export const GENERIC_RADAR_PROFILE: RadarProfile = {
  id: 'generic',
  name: 'Generic FCR',
  referenceRangeM: RADAR_REFERENCE_RANGE_M,
  referenceRcsM2: RADAR_REFERENCE_RCS_M2,
  maxRangeM: RADAR_MAX_RANGE_M,
  scanAzHalfAngleRad: RADAR_SCAN_AZ_HALF_ANGLE_RAD,
  scanElHalfAngleRad: RADAR_SCAN_EL_HALF_ANGLE_RAD,
  trackHalfAngleRad: RADAR_TRACK_HALF_ANGLE_RAD,
  lockTimeSec: RADAR_LOCK_TIME_SEC,
  lockBreakGraceSec: RADAR_LOCK_BREAK_GRACE_SEC,
  notchClosureMps: RADAR_NOTCH_CLOSURE_MPS,
  notchMaxRangeM: RADAR_NOTCH_MAX_RANGE_M,
  maxTracks: 10,
  iffRangeM: 100000,
  nctrRangeM: 40000,
  acmRangeM: 15000,
  trackMemorySec: 4,
};

const D2R = Math.PI / 180;

/**
 * MBDA ASRAAM (AIM-132), the Tejas Mk1A's close-combat missile (twin rails on the outboard
 * pylons). Public data: 88 kg, 166 mm, 2.9 m; a large 166 mm motor for Mach 3+; 128x128 imaging IR
 * seeker with lock-on-after-launch and very high off-boresight; blast-fragmentation warhead with a
 * laser proximity fuze; "25+ km" operational range. Motor, lift and noise values are estimates
 * tuned so the modelled envelope matches (see tests/combat/missileEnvelope.test.ts).
 */
export const ASRAAM: WeaponProfile = {
  id: 'asraam',
  name: 'ASRAAM',
  label: 'ASRAAM',
  short: 'ASR',
  kind: 'ir_missile',
  carriageMassKg: 88,
  carriageDragAreaM2: 0.025,
  projectileMassKg: 88,
  dragCoeff: 0.45,
  crossSectionM2: 0.02164,
  maxLifetimeSec: 45,
  armDistanceM: 150,
  launchSpeedMps: 20,
  roundIntervalSec: 0,
  dispersionMrad: 0,
  motorBurnSec: 3.0,
  motorThrustN: 29000,
  pnGain: 4,
  maxG: 50,
  proximityFuseRadiusM: 9,
  damageFrac: 0.6,
  minLaunchRangeM: 300,
  ir: {
    // Seeker cued by the radar/helmet sight: acquires +-40 deg off the nose, tracks to +-90 deg.
    acquireHalfAngleRad: 40 * D2R,
    trackHalfAngleRad: 90 * D2R,
    gimbalRateRadS: 15,
    lockTimeSec: 0.5,
    detectRangeTailOnM: 20000,
    detectRangeHeadOnM: 9000,
    afterburnerRangeMult: 1.3,
    // Imaging seeker: sees shape, not just a hot point.
    flareResistance: 0.85,
  },
  flight: {
    sustainBurnSec: 0,
    sustainThrustN: 0,
    propellantMassKg: 36,
    liftAreaM2: 0.2,
    clMax: 3,
    inducedDragK: 0.25,
    waveDragRise: 0.6,
    autopilotTauSec: 0.12,
    seekerNoiseMrad: 0.3,
    seekerUpdateSec: 0.02,
    minSpeedMps: 400,
  },
  lethality: { fuzeReliability: 0.96, pkDirect: 0.95, pkAtLethalRadius: 0.4, lethalRadiusM: 9 },
  // Measured (.scratch/tune.ts): 35 km head-on / 16 km tail at 10 km; 14 / 6.5 km at 1 km.
  warhead: { explosiveKg: 10 },
  envelope: { rMaxHeadOnM: 35000, rMaxTailM: 16000, rNoEscapeM: 14000 },
};

/**
 * Vympel R-73 (AA-11), the legacy close-combat missile. Public data: 105 kg, 170 mm, 2.9 m; a
 * 2.5 s motor; cooled IR seeker +-45 deg (cued by radar/helmet sight); 30 km head-on (R-73E).
 */
export const R73: WeaponProfile = {
  ...GENERIC_IR_MISSILE_PROFILE,
  id: 'r-73',
  name: 'R-73',
  label: 'R-73',
  short: 'R73',
  dragCoeff: 0.5,
  maxLifetimeSec: 35,
  motorBurnSec: 2.5,
  motorThrustN: 28000,
  maxG: 40,
  proximityFuseRadiusM: 8,
  ir: {
    acquireHalfAngleRad: 15 * D2R,
    trackHalfAngleRad: 45 * D2R,
    gimbalRateRadS: 10,
    lockTimeSec: 1.0,
    detectRangeTailOnM: 12000,
    detectRangeHeadOnM: 4500,
    afterburnerRangeMult: 1.5,
    flareResistance: 0.5,
  },
  flight: {
    sustainBurnSec: 0,
    sustainThrustN: 0,
    propellantMassKg: 30,
    liftAreaM2: 0.22,
    clMax: 2.8,
    inducedDragK: 0.3,
    waveDragRise: 0.6,
    autopilotTauSec: 0.15,
    seekerNoiseMrad: 0.6,
    seekerUpdateSec: 0.02,
    minSpeedMps: 400,
  },
  lethality: { fuzeReliability: 0.93, pkDirect: 0.9, pkAtLethalRadius: 0.3, lethalRadiusM: 8 },
  // Measured: 30 km head-on / 12 km tail at 10 km; 12 / 4.8 km at 1 km.
  warhead: { explosiveKg: 7.4 },
  envelope: { rMaxHeadOnM: 30000, rMaxTailM: 12000, rNoEscapeM: 10000 },
};

/**
 * DRDO Astra Mk1, the Tejas Mk1A's beyond-visual-range missile. Public data: 154 kg, 178 mm,
 * 3.6 m; smokeless solid motor to Mach 4.5; mid-course inertial with a two-way datalink from the
 * launcher's radar, then a Ku-band active radar seeker; 15 kg pre-fragmented warhead with an RF
 * proximity fuze. Range: 110 km originally, extended to ~160 km in 2026 (same airframe, better
 * propulsion and energy management, i.e. a lofted profile). Motor/lift/noise are estimates tuned to
 * that envelope (tests/combat/missileEnvelope.test.ts).
 */
export const ASTRA_MK1: WeaponProfile = {
  id: 'astra-mk1',
  name: 'Astra Mk1',
  label: 'ASTRA',
  short: 'AST',
  kind: 'radar_missile',
  carriageMassKg: 154,
  carriageDragAreaM2: 0.045,
  projectileMassKg: 154,
  dragCoeff: 0.25,
  crossSectionM2: 0.0249,
  maxLifetimeSec: 180,
  armDistanceM: 300,
  launchSpeedMps: 25,
  roundIntervalSec: 0,
  dispersionMrad: 0,
  motorBurnSec: 4.5,
  motorThrustN: 25000,
  pnGain: 4,
  maxG: 40,
  proximityFuseRadiusM: 12,
  damageFrac: 0.65,
  minLaunchRangeM: 1000,
  radar: { maxRangeM: 160000, activeSeekerRangeM: 20000, activeSeekerHalfAngleRad: 20 * D2R, gSaturationLostSec: 2.5, chaffResistance: 0.7 },
  flight: {
    // Long low-thrust sustain (dual-pulse-like energy management): ~250 kN s total, Isp ~300 s.
    sustainBurnSec: 32,
    sustainThrustN: 4200,
    propellantMassKg: 84,
    liftAreaM2: 0.3,
    clMax: 2.5,
    inducedDragK: 0.25,
    waveDragRise: 0.45,
    autopilotTauSec: 0.2,
    seekerNoiseMrad: 1.0,
    seekerUpdateSec: 0.05,
    datalinkIntervalSec: 1.0,
    datalinkErrMrad: 2,
    // Climbs ~37 deg above the sight line into thin air, capped at 22 km above the target.
    loftRad: 0.65,
    minSpeedMps: 350,
  },
  lethality: { fuzeReliability: 0.95, pkDirect: 0.95, pkAtLethalRadius: 0.35, lethalRadiusM: 12 },
  // Measured: 157 km head-on / 82 km tail at 10 km; 92 / 33 km at 1 km (both lofted).
  warhead: { explosiveKg: 15 },
  envelope: { rMaxHeadOnM: 160000, rMaxTailM: 80000, rNoEscapeM: 70000 },
};

/** Rafael Derby, the legacy BVR missile: 118 kg, 160 mm, active radar seeker, ~50 km. */
export const DERBY: WeaponProfile = {
  ...GENERIC_RADAR_MISSILE_PROFILE,
  id: 'derby',
  name: 'Derby',
  label: 'DERBY',
  short: 'DBY',
  crossSectionM2: 0.0201,
  dragCoeff: 0.4,
  maxLifetimeSec: 80,
  motorBurnSec: 5,
  motorThrustN: 18000,
  maxG: 40,
  radar: { maxRangeM: 50000, activeSeekerRangeM: 12000, activeSeekerHalfAngleRad: 20 * D2R, gSaturationLostSec: 2, chaffResistance: 0.6 },
  flight: {
    sustainBurnSec: 0,
    sustainThrustN: 0,
    propellantMassKg: 44,
    liftAreaM2: 0.25,
    clMax: 2.5,
    inducedDragK: 0.3,
    waveDragRise: 0.6,
    autopilotTauSec: 0.2,
    seekerNoiseMrad: 1.0,
    seekerUpdateSec: 0.05,
    datalinkIntervalSec: 1.0,
    datalinkErrMrad: 3,
    loftRad: 0.15,
    minSpeedMps: 420,
  },
  lethality: { fuzeReliability: 0.94, pkDirect: 0.93, pkAtLethalRadius: 0.3, lethalRadiusM: 10 },
  // Measured: 50 km head-on / 20 km tail at 10 km; 20 / 8 km at 1 km.
  warhead: { explosiveKg: 23 },
  envelope: { rMaxHeadOnM: 50000, rMaxTailM: 20000, rNoEscapeM: 17000 },
};

/** Shared shape of the newer missiles (the realism fields are filled per missile). */
type MissileSpecFields = Omit<WeaponProfile, 'kind' | 'roundIntervalSec' | 'dispersionMrad' | 'damageFrac'> & { damageFrac?: number };
function irMissile(p: MissileSpecFields): WeaponProfile {
  return { kind: 'ir_missile', roundIntervalSec: 0, dispersionMrad: 0, damageFrac: 0.6, ...p };
}
function radarMissile(p: MissileSpecFields): WeaponProfile {
  return { kind: 'radar_missile', roundIntervalSec: 0, dispersionMrad: 0, damageFrac: 0.65, ...p };
}

/**
 * Rafael Python-5, integrated on the Tejas Mk1. Public data: 105 kg, 160 mm, 3.1 m; dual-waveband
 * imaging IR seeker with lock-on-after-launch and near-spherical coverage (+-100 deg); ~20 km.
 */
export const PYTHON_5: WeaponProfile = irMissile({
  id: 'python-5',
  name: 'Python-5',
  label: 'PYTHON',
  short: 'PY5',
  carriageMassKg: 105,
  carriageDragAreaM2: 0.03,
  projectileMassKg: 105,
  dragCoeff: 0.55,
  crossSectionM2: 0.0201,
  maxLifetimeSec: 40,
  armDistanceM: 150,
  launchSpeedMps: 20,
  motorBurnSec: 2.6,
  motorThrustN: 16500,
  pnGain: 4,
  maxG: 60,
  proximityFuseRadiusM: 8,
  minLaunchRangeM: 250,
  ir: {
    acquireHalfAngleRad: 60 * D2R,
    trackHalfAngleRad: 100 * D2R,
    gimbalRateRadS: 16,
    lockTimeSec: 0.5,
    detectRangeTailOnM: 18000,
    detectRangeHeadOnM: 8000,
    afterburnerRangeMult: 1.3,
    flareResistance: 0.9,
  },
  flight: {
    sustainBurnSec: 0, sustainThrustN: 0, propellantMassKg: 35, liftAreaM2: 0.24, clMax: 3, inducedDragK: 0.25,
    waveDragRise: 0.6, autopilotTauSec: 0.12, seekerNoiseMrad: 0.3, seekerUpdateSec: 0.02, minSpeedMps: 400,
  },
  lethality: { fuzeReliability: 0.96, pkDirect: 0.95, pkAtLethalRadius: 0.4, lethalRadiusM: 8 },
  // Measured (.scratch/tune.ts): ~20 km head-on / 6 km tail at 10 km; 8 / 2.4 km at 1 km.
  warhead: { explosiveKg: 11 },
  envelope: { rMaxHeadOnM: 20000, rMaxTailM: 6000, rNoEscapeM: 7000 },
});

/**
 * Rafael I-Derby ER, the Mk1A's planned extended-range BVR missile: the Derby airframe with a
 * dual-pulse motor and a solid-state AESA seeker; ~100 km.
 */
export const DERBY_ER: WeaponProfile = radarMissile({
  id: 'derby-er',
  name: 'I-Derby ER',
  label: 'DERBY ER',
  short: 'DER',
  carriageMassKg: 125,
  carriageDragAreaM2: 0.04,
  projectileMassKg: 125,
  dragCoeff: 0.4,
  crossSectionM2: 0.0201,
  maxLifetimeSec: 130,
  armDistanceM: 300,
  launchSpeedMps: 25,
  motorBurnSec: 5,
  motorThrustN: 18000,
  pnGain: 4,
  maxG: 40,
  proximityFuseRadiusM: 10,
  minLaunchRangeM: 1000,
  radar: { maxRangeM: 100000, activeSeekerRangeM: 18000, activeSeekerHalfAngleRad: 25 * D2R, gSaturationLostSec: 2.5, chaffResistance: 0.75 },
  flight: {
    sustainBurnSec: 15, sustainThrustN: 3200, propellantMassKg: 55, liftAreaM2: 0.25, clMax: 2.5, inducedDragK: 0.3,
    waveDragRise: 0.55, autopilotTauSec: 0.2, seekerNoiseMrad: 0.8, seekerUpdateSec: 0.05, datalinkIntervalSec: 1.0,
    datalinkErrMrad: 2.5, loftRad: 0.45, minSpeedMps: 380,
  },
  lethality: { fuzeReliability: 0.95, pkDirect: 0.94, pkAtLethalRadius: 0.3, lethalRadiusM: 10 },
  // Measured: 99 km head-on / 33 km tail at 10 km; 34 / 14 km at 1 km.
  warhead: { explosiveKg: 23 },
  envelope: { rMaxHeadOnM: 100000, rMaxTailM: 33000, rNoEscapeM: 30000 },
});

// --- Hostile missiles (PAF fits: JF-17 with PL-5E II / SD-10A / PL-15E, F-16 with AIM-9M / AIM-120C-5). ---

/** PL-5E II: 83 kg, 127 mm, 2.9 m; all-aspect IR, +-40 deg off-boresight; ~16 km. */
export const PL_5E: WeaponProfile = irMissile({
  id: 'pl-5e',
  name: 'PL-5E II',
  label: 'PL-5E',
  short: 'PL5',
  carriageMassKg: 83,
  carriageDragAreaM2: 0.022,
  projectileMassKg: 83,
  dragCoeff: 0.55,
  crossSectionM2: 0.01267,
  maxLifetimeSec: 35,
  armDistanceM: 150,
  launchSpeedMps: 20,
  motorBurnSec: 2.4,
  motorThrustN: 9500,
  pnGain: 3.5,
  maxG: 40,
  proximityFuseRadiusM: 7,
  minLaunchRangeM: 400,
  ir: {
    acquireHalfAngleRad: 20 * D2R,
    trackHalfAngleRad: 40 * D2R,
    gimbalRateRadS: 10,
    lockTimeSec: 1.0,
    detectRangeTailOnM: 11000,
    detectRangeHeadOnM: 4000,
    afterburnerRangeMult: 1.5,
    flareResistance: 0.45,
  },
  flight: {
    sustainBurnSec: 0, sustainThrustN: 0, propellantMassKg: 26, liftAreaM2: 0.18, clMax: 2.8, inducedDragK: 0.3,
    waveDragRise: 0.6, autopilotTauSec: 0.15, seekerNoiseMrad: 0.7, seekerUpdateSec: 0.02, minSpeedMps: 400,
  },
  lethality: { fuzeReliability: 0.92, pkDirect: 0.88, pkAtLethalRadius: 0.3, lethalRadiusM: 7 },
  // Measured: 16 km head-on / 4 km tail at 10 km; 7 / 1.8 km at 1 km.
  warhead: { explosiveKg: 6 },
  envelope: { rMaxHeadOnM: 16000, rMaxTailM: 4000, rNoEscapeM: 5000 },
});

/** AIM-9M Sidewinder: 86 kg, 127 mm, 2.87 m; all-aspect cooled IR seeker with IRCCM; ~18 km. */
export const AIM_9M: WeaponProfile = irMissile({
  id: 'aim-9m',
  name: 'AIM-9M',
  label: 'AIM-9M',
  short: '9M',
  carriageMassKg: 86,
  carriageDragAreaM2: 0.022,
  projectileMassKg: 86,
  dragCoeff: 0.52,
  crossSectionM2: 0.01267,
  maxLifetimeSec: 35,
  armDistanceM: 150,
  launchSpeedMps: 20,
  motorBurnSec: 2.2,
  motorThrustN: 11000,
  pnGain: 4,
  maxG: 35,
  proximityFuseRadiusM: 8,
  minLaunchRangeM: 400,
  ir: {
    acquireHalfAngleRad: 15 * D2R,
    trackHalfAngleRad: 40 * D2R,
    gimbalRateRadS: 10,
    lockTimeSec: 1.0,
    detectRangeTailOnM: 12000,
    detectRangeHeadOnM: 4500,
    afterburnerRangeMult: 1.5,
    flareResistance: 0.6,
  },
  flight: {
    sustainBurnSec: 0, sustainThrustN: 0, propellantMassKg: 27, liftAreaM2: 0.18, clMax: 2.8, inducedDragK: 0.3,
    waveDragRise: 0.6, autopilotTauSec: 0.15, seekerNoiseMrad: 0.6, seekerUpdateSec: 0.02, minSpeedMps: 400,
  },
  lethality: { fuzeReliability: 0.93, pkDirect: 0.9, pkAtLethalRadius: 0.3, lethalRadiusM: 8 },
  // Measured: 18 km head-on / 5 km tail at 10 km; 8 / 2.1 km at 1 km.
  warhead: { explosiveKg: 9.4 },
  envelope: { rMaxHeadOnM: 18000, rMaxTailM: 5000, rNoEscapeM: 6000 },
});

/** SD-10A (PL-12 export): 199 kg, 203 mm, 3.85 m; active radar with datalink; ~70 km. */
export const SD_10A: WeaponProfile = radarMissile({
  id: 'sd-10a',
  name: 'SD-10A',
  label: 'SD-10A',
  short: 'SD10',
  carriageMassKg: 199,
  carriageDragAreaM2: 0.05,
  projectileMassKg: 199,
  dragCoeff: 0.3,
  crossSectionM2: 0.0324,
  maxLifetimeSec: 100,
  armDistanceM: 300,
  launchSpeedMps: 25,
  motorBurnSec: 5,
  motorThrustN: 22000,
  pnGain: 4,
  maxG: 38,
  proximityFuseRadiusM: 12,
  minLaunchRangeM: 1000,
  radar: { maxRangeM: 70000, activeSeekerRangeM: 15000, activeSeekerHalfAngleRad: 20 * D2R, gSaturationLostSec: 2, chaffResistance: 0.55 },
  flight: {
    sustainBurnSec: 4, sustainThrustN: 4000, propellantMassKg: 80, liftAreaM2: 0.35, clMax: 2.4, inducedDragK: 0.3,
    waveDragRise: 0.55, autopilotTauSec: 0.2, seekerNoiseMrad: 1.2, seekerUpdateSec: 0.05, datalinkIntervalSec: 1.0,
    datalinkErrMrad: 3, loftRad: 0.3, minSpeedMps: 400,
  },
  lethality: { fuzeReliability: 0.93, pkDirect: 0.92, pkAtLethalRadius: 0.3, lethalRadiusM: 12 },
  // Measured: 69 km head-on / 21 km tail at 10 km; 25 / 9 km at 1 km.
  warhead: { explosiveKg: 25 },
  envelope: { rMaxHeadOnM: 70000, rMaxTailM: 21000, rNoEscapeM: 20000 },
});

/** AIM-120C-5 AMRAAM: 157 kg, 178 mm, 3.66 m; active radar, datalink, lofted; ~105 km. */
export const AIM_120C: WeaponProfile = radarMissile({
  id: 'aim-120c',
  name: 'AIM-120C-5',
  label: 'AIM-120C',
  short: '120',
  carriageMassKg: 157,
  carriageDragAreaM2: 0.045,
  projectileMassKg: 157,
  dragCoeff: 0.28,
  crossSectionM2: 0.0249,
  maxLifetimeSec: 130,
  armDistanceM: 300,
  launchSpeedMps: 25,
  motorBurnSec: 6,
  motorThrustN: 20000,
  pnGain: 4,
  maxG: 40,
  proximityFuseRadiusM: 11,
  minLaunchRangeM: 1000,
  radar: { maxRangeM: 105000, activeSeekerRangeM: 18000, activeSeekerHalfAngleRad: 22 * D2R, gSaturationLostSec: 2.5, chaffResistance: 0.75 },
  flight: {
    sustainBurnSec: 7, sustainThrustN: 3600, propellantMassKg: 70, liftAreaM2: 0.3, clMax: 2.5, inducedDragK: 0.25,
    waveDragRise: 0.5, autopilotTauSec: 0.2, seekerNoiseMrad: 0.9, seekerUpdateSec: 0.05, datalinkIntervalSec: 1.0,
    datalinkErrMrad: 2, loftRad: 0.5, minSpeedMps: 380,
  },
  lethality: { fuzeReliability: 0.95, pkDirect: 0.94, pkAtLethalRadius: 0.35, lethalRadiusM: 11 },
  // Measured: 107 km head-on / 36 km tail at 10 km; 40 / 15 km at 1 km.
  warhead: { explosiveKg: 18 },
  envelope: { rMaxHeadOnM: 105000, rMaxTailM: 36000, rNoEscapeM: 35000 },
});

/** PL-15E: 210 kg, 203 mm, ~4 m; dual-pulse motor, AESA seeker, two-way datalink; ~145 km. */
export const PL_15E: WeaponProfile = radarMissile({
  id: 'pl-15e',
  name: 'PL-15E',
  label: 'PL-15E',
  short: 'PL15',
  carriageMassKg: 210,
  carriageDragAreaM2: 0.05,
  projectileMassKg: 210,
  dragCoeff: 0.28,
  crossSectionM2: 0.0324,
  maxLifetimeSec: 170,
  armDistanceM: 300,
  launchSpeedMps: 25,
  motorBurnSec: 5,
  motorThrustN: 34000,
  pnGain: 4,
  maxG: 40,
  proximityFuseRadiusM: 12,
  minLaunchRangeM: 1000,
  radar: { maxRangeM: 145000, activeSeekerRangeM: 22000, activeSeekerHalfAngleRad: 25 * D2R, gSaturationLostSec: 2.5, chaffResistance: 0.75 },
  flight: {
    sustainBurnSec: 25, sustainThrustN: 4600, propellantMassKg: 105, liftAreaM2: 0.36, clMax: 2.4, inducedDragK: 0.25,
    waveDragRise: 0.45, autopilotTauSec: 0.2, seekerNoiseMrad: 0.9, seekerUpdateSec: 0.05, datalinkIntervalSec: 1.0,
    datalinkErrMrad: 2, loftRad: 0.6, minSpeedMps: 350,
  },
  lethality: { fuzeReliability: 0.95, pkDirect: 0.95, pkAtLethalRadius: 0.35, lethalRadiusM: 12 },
  // Measured: 141 km head-on / 66 km tail at 10 km; 75 / 25 km at 1 km.
  warhead: { explosiveKg: 25 },
  envelope: { rMaxHeadOnM: 145000, rMaxTailM: 66000, rNoEscapeM: 55000 },
});

// --- Air-to-ground stores (Tejas Mk1A integrations; public-data approximations). ---

/** Shared shape of the unguided air-to-ground stores. */
type AgFields = Omit<WeaponProfile, 'roundIntervalSec' | 'dispersionMrad' | 'motorBurnSec' | 'motorThrustN' | 'pnGain' | 'maxG' | 'proximityFuseRadiusM' | 'minLaunchRangeM' | 'damageFrac'> &
  Partial<Pick<WeaponProfile, 'roundIntervalSec' | 'dispersionMrad' | 'motorBurnSec' | 'motorThrustN'>>;
function agStore(p: AgFields): WeaponProfile {
  return { roundIntervalSec: 0, dispersionMrad: 0, motorBurnSec: 0, motorThrustN: 0, pnGain: 0, maxG: 0, proximityFuseRadiusM: 0, minLaunchRangeM: 0, damageFrac: 1, ...p };
}

/**
 * DRDO HSLD-450: 450 kg high-speed low-drag general-purpose bomb (integrated on the Tejas). ~0.4 m
 * body, ~200 kg of explosive; released level or in a dive, from low to medium altitude.
 */
export const HSLD_450: WeaponProfile = agStore({
  id: 'hsld-450',
  name: 'HSLD-450',
  label: 'HSLD 450',
  short: '450',
  kind: 'bomb',
  carriageMassKg: 450,
  carriageDragAreaM2: 0.07,
  projectileMassKg: 450,
  dragCoeff: 0.22,
  crossSectionM2: 0.1257,
  maxLifetimeSec: 120,
  armDistanceM: 250,
  launchSpeedMps: 2,
  warhead: { explosiveKg: 200 },
});

/** DRDO HSLD-250: 250 kg high-speed low-drag bomb (~0.32 m body, ~110 kg explosive). */
export const HSLD_250: WeaponProfile = agStore({
  id: 'hsld-250',
  name: 'HSLD-250',
  label: 'HSLD 250',
  short: '250',
  kind: 'bomb',
  carriageMassKg: 250,
  carriageDragAreaM2: 0.05,
  projectileMassKg: 250,
  dragCoeff: 0.22,
  crossSectionM2: 0.0804,
  maxLifetimeSec: 120,
  armDistanceM: 250,
  launchSpeedMps: 2,
  warhead: { explosiveKg: 110 },
});

/**
 * 250 kg retarded bomb (the HSLD-250 with a ballute tail) for low-level laydown: the tail opens
 * 0.3 s after release and the bomb falls steeply behind the aircraft, giving it time to get clear
 * of the blast. Arms quickly (for 30-60 m releases).
 */
export const HSLD_250R: WeaponProfile = agStore({
  id: 'hsld-250r',
  name: 'HSLD-250 (retarded)',
  label: 'HSLD 250R',
  short: '250R',
  kind: 'bomb',
  carriageMassKg: 260,
  carriageDragAreaM2: 0.06,
  projectileMassKg: 260,
  dragCoeff: 0.22,
  crossSectionM2: 0.0804,
  maxLifetimeSec: 120,
  armDistanceM: 60,
  launchSpeedMps: 2,
  warhead: { explosiveKg: 110 },
  bomb: { retardAfterSec: 0.3, retardCdA: 0.9 },
});

/**
 * B-8M1 pod with 20 S-8 80 mm rockets (S-8KOM: shaped-charge / fragmentation, ~1.2 kg explosive).
 * Fired in a ripple while the release button is held; ~600 m/s after a 0.7 s motor burn; a few
 * mrad of dispersion. The pod stays on the pylon when empty.
 */
export const B8_S8: WeaponProfile = agStore({
  id: 'b8m1',
  name: 'B-8M1 rocket pod (S-8)',
  label: 'S-8 RKT',
  short: 'RKT',
  kind: 'rocket',
  roundsPerStore: 20,
  storeShellKg: 160,
  carriageMassKg: 11.3,
  carriageDragAreaM2: 0.1,
  projectileMassKg: 11.3,
  dragCoeff: 0.35,
  crossSectionM2: 0.005,
  maxLifetimeSec: 20,
  armDistanceM: 40,
  launchSpeedMps: 30,
  roundIntervalSec: 0.06,
  dispersionMrad: 5,
  motorBurnSec: 0.7,
  motorThrustN: 9000,
  warhead: { explosiveKg: 1.2 },
});

/** Every weapon store by catalogue id. */
export const WEAPONS: Readonly<Record<string, WeaponProfile>> = {
  [GENERIC_GUN_PROFILE.id]: GENERIC_GUN_PROFILE,
  [ASRAAM.id]: ASRAAM,
  [R73.id]: R73,
  [ASTRA_MK1.id]: ASTRA_MK1,
  [DERBY.id]: DERBY,
  [PYTHON_5.id]: PYTHON_5,
  [DERBY_ER.id]: DERBY_ER,
  [PL_5E.id]: PL_5E,
  [AIM_9M.id]: AIM_9M,
  [SD_10A.id]: SD_10A,
  [AIM_120C.id]: AIM_120C,
  [PL_15E.id]: PL_15E,
  [HSLD_450.id]: HSLD_450,
  [HSLD_250.id]: HSLD_250,
  [HSLD_250R.id]: HSLD_250R,
  [B8_S8.id]: B8_S8,
};

/** External fuel tanks: capacity, empty mass, drag area. */
export interface FuelTankStore {
  id: string;
  name: string;
  /** Stores-page names (see WeaponProfile.label/short). */
  label: string;
  short: string;
  capacityKg: number;
  emptyMassKg: number;
  dragAreaM2: number;
}

export const FUEL_TANKS: Readonly<Record<string, FuelTankStore>> = {
  // Tejas 1200 L wing tank: 1200 L at ~0.80 kg/L = 960 kg; ~140 kg empty.
  'tank-1200l': { id: 'tank-1200l', name: '1200 L tank', label: '1200 L', short: 'TK', capacityKg: 960, emptyMassKg: 140, dragAreaM2: 0.075 },
  // Tejas 725 L centreline tank.
  'tank-725l': { id: 'tank-725l', name: '725 L tank', label: '725 L', short: 'TK', capacityKg: 580, emptyMassKg: 95, dragAreaM2: 0.055 },
};

export type StoreKind = WeaponKind | 'fuel_tank' | 'pod';

/** The kind of a catalogue store, or undefined if the id is unknown. */
export function storeKind(id: string): StoreKind | undefined {
  const w = WEAPONS[id];
  if (w) return w.kind;
  return FUEL_TANKS[id] ? 'fuel_tank' : undefined;
}

/** What the displays show for a store: its kind, HUD/stores-page label and 3-letter short name. */
export interface StoreInfo {
  id: string;
  kind: StoreKind;
  label: string;
  short: string;
}

const storeInfoCache = new Map<string, StoreInfo | null>();
/** Display info for a catalogue store id, or undefined if the id is unknown. */
export function storeInfo(id: string): StoreInfo | undefined {
  let info = storeInfoCache.get(id);
  if (info === undefined) {
    const w = WEAPONS[id];
    const t = FUEL_TANKS[id];
    if (w) {
      const label = w.label ?? w.name.toUpperCase();
      info = { id, kind: w.kind, label, short: w.short ?? label.replace(/[^A-Z0-9]/g, '').slice(0, 3) };
    } else if (t) {
      info = { id, kind: 'fuel_tank', label: t.label, short: t.short };
    } else {
      info = null;
    }
    storeInfoCache.set(id, info);
  }
  return info ?? undefined;
}
