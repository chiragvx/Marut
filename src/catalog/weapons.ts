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

/** Every weapon store by catalogue id. */
export const WEAPONS: Readonly<Record<string, WeaponProfile>> = {
  [GENERIC_GUN_PROFILE.id]: GENERIC_GUN_PROFILE,
  [GENERIC_IR_MISSILE_PROFILE.id]: GENERIC_IR_MISSILE_PROFILE,
  [GENERIC_RADAR_MISSILE_PROFILE.id]: GENERIC_RADAR_MISSILE_PROFILE,
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
  'tank-1200l': { id: 'tank-1200l', name: '1200 L tank', capacityKg: 960, emptyMassKg: 140, dragAreaM2: 0.12 },
  // Tejas 725 L centreline tank.
  'tank-725l': { id: 'tank-725l', name: '725 L tank', capacityKg: 580, emptyMassKg: 95, dragAreaM2: 0.09 },
};

export type StoreKind = 'gun' | 'ir_missile' | 'radar_missile' | 'fuel_tank';

/** The kind of a catalogue store, or undefined if the id is unknown. */
export function storeKind(id: string): StoreKind | undefined {
  const w = WEAPONS[id];
  if (w) return w.kind;
  return FUEL_TANKS[id] ? 'fuel_tank' : undefined;
}
