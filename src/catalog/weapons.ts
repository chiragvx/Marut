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
  radar: { maxRangeM: 160000, activeSeekerRangeM: 20000, activeSeekerHalfAngleRad: 20 * D2R, gSaturationLostSec: 2.5 },
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
  envelope: { rMaxHeadOnM: 160000, rMaxTailM: 80000, rNoEscapeM: 70000 },
};

/** Rafael Derby, the legacy BVR missile: 118 kg, 160 mm, active radar seeker, ~50 km. */
export const DERBY: WeaponProfile = {
  ...GENERIC_RADAR_MISSILE_PROFILE,
  id: 'derby',
  name: 'Derby',
  crossSectionM2: 0.0201,
  dragCoeff: 0.4,
  maxLifetimeSec: 80,
  motorBurnSec: 5,
  motorThrustN: 18000,
  maxG: 40,
  radar: { maxRangeM: 50000, activeSeekerRangeM: 12000, activeSeekerHalfAngleRad: 20 * D2R, gSaturationLostSec: 2 },
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
  envelope: { rMaxHeadOnM: 50000, rMaxTailM: 20000, rNoEscapeM: 17000 },
};

/** Every weapon store by catalogue id. */
export const WEAPONS: Readonly<Record<string, WeaponProfile>> = {
  [GENERIC_GUN_PROFILE.id]: GENERIC_GUN_PROFILE,
  [ASRAAM.id]: ASRAAM,
  [R73.id]: R73,
  [ASTRA_MK1.id]: ASTRA_MK1,
  [DERBY.id]: DERBY,
};

/** External fuel tanks: capacity, empty mass, drag area. */
export interface FuelTankStore {
  id: string;
  name: string;
  capacityKg: number;
  emptyMassKg: number;
  dragAreaM2: number;
}

export const FUEL_TANKS: Readonly<Record<string, FuelTankStore>> = {
  // Tejas 1200 L wing tank: 1200 L at ~0.80 kg/L = 960 kg; ~140 kg empty.
  'tank-1200l': { id: 'tank-1200l', name: '1200 L tank', capacityKg: 960, emptyMassKg: 140, dragAreaM2: 0.075 },
  // Tejas 725 L centreline tank.
  'tank-725l': { id: 'tank-725l', name: '725 L tank', capacityKg: 580, emptyMassKg: 95, dragAreaM2: 0.055 },
};

export type StoreKind = 'gun' | 'ir_missile' | 'radar_missile' | 'fuel_tank';

/** The kind of a catalogue store, or undefined if the id is unknown. */
export function storeKind(id: string): StoreKind | undefined {
  const w = WEAPONS[id];
  if (w) return w.kind;
  return FUEL_TANKS[id] ? 'fuel_tank' : undefined;
}
