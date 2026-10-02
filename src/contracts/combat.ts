/**
 * =============================================================================
 * TEJAS SIM — COMBAT CONTRACT (docs/spec/contracts/combat.ts)
 * =============================================================================
 * Owner: module 07 (docs/spec/07-combat.md). Implemented by src/combat/*.
 *
 * Imports ONLY from './core'. No import from './math' is required: every
 * function below that would otherwise need a mutable Vec3/Quat instead takes
 * a `Vec3Like`/`QuatLike`-shaped `out` parameter (per core.ts's own §1
 * rationale — "Anything that only needs to read/write x,y,z(,w) uses these
 * [structural types], so core.ts never has to import math.ts"). The same
 * reasoning applies here: src/combat's real IMPLEMENTATION imports the real
 * mutable Vec3/Quat classes from src/math directly (permitted — see
 * 00-architecture.md §10, "src/combat imports src/contracts/*, src/math/*
 * only") and passes them in wherever an `out: Vec3Like` appears; the
 * CONTRACT itself stays free of any dependency on contracts/math.ts's exact
 * exported surface.
 *
 * This file contains ONLY interfaces, type aliases, `as const` objects +
 * derived unions, plain numeric/object constants, and bare function-
 * signature aliases (`export type Foo = (...) => Bar`). NO class bodies, NO
 * function bodies. It must compile standalone with `tsc --noEmit --strict`.
 * (`as const` objects and plain `export const X = <literal>` constants ARE
 * real, executable values — see core.ts's own `SIM_HZ`/`GRAVITY_MPS2` — and
 * are imported at runtime by every module that needs them, same as here.)
 *
 * -----------------------------------------------------------------------------
 * SCOPE. This module owns: weapon stations/loadouts, the 23 mm GSh-23 gun +
 * ballistic bullets, the lead-computing gunsight solution, an R-73-like IR
 * missile (seeker FOV/gimbal, heat lock, proportional navigation), a
 * Derby-like radar missile (STT-lock-to-launch, datalink midcourse, active
 * terminal seeker approximation), a radar model (detection/scan/lock/notch),
 * subsystem damage (writes core.ts's `DamageState`), and the `SimEvent`s
 * (explosion/hit/kill/lock/warning) all of the above produce. Full
 * algorithms, worked examples and the per-tick call order src/core must
 * follow live in docs/spec/07-combat.md — this file is the compilable
 * surface only.
 *
 * CONVENTION used throughout this file for every `outX: T[]` parameter: it
 * is a pre-sized, caller-owned, REUSED array. The caller clears it
 * (`outX.length = 0`) before calling; the function only ever `.push()`s into
 * it (steady-state allocation-free once the array's backing capacity has
 * grown to its high-water mark, matching how `src/core/eventQueue.ts`
 * collects `SimEvent`s per 00-architecture.md §5). The function never reads
 * or clears `outX` itself.
 * =============================================================================
 */

import type {
  Vec3Like,
  QuatLike,
  EntityId,
  EntityKind,
  Team,
  EntityState,
  PilotInputs,
  DamageState,
  Contact,
  CombatStatus,
  LockState,
  WeaponKind,
  SimEvent,
  HeightSampler,
} from './core';
import type { WarheadProfile } from './ground';

// -----------------------------------------------------------------------------
// 1. Constants — general
// -----------------------------------------------------------------------------

/** Combined hard cap on simultaneously alive bullet+missile entities this module will ever request spawned. Subset of core.ts's MAX_ENTITIES=400 shared budget (aircraft + missiles + bullets + effects together). */
export const MAX_PROJECTILES = 128;

/** Max spawn requests `FireWeapons` may push in a single call (one aircraft, one tick). Sized generously above the gun's own per-tick round cap (see §2) so a multi-round tick from a very high ROF weapon never silently drops a request. */
export const MAX_SPAWN_REQUESTS_PER_TICK = 4;

/** Additional multiplier applied to `damage` (already a 0..1 structurePct fraction, per core.ts's `HitEvent.damage` doc comment) when it lands on the ONE subsystem `rollSubsystemHit` selected, on top of the flat structurePct reduction every hit always applies. */
export const SUBSYSTEM_DAMAGE_EXTRA_MULT = 2.0;

export const SubsystemHitKind = {
  /** No subsystem beyond flat structural damage. */
  StructureOnly: 'structure_only',
  Engine: 'engine',
  ElevonL: 'elevon_l',
  ElevonR: 'elevon_r',
  Rudder: 'rudder',
  Fuel: 'fuel',
  Radar: 'radar',
  Gear: 'gear',
  Hydraulics: 'hydraulics',
} as const;
export type SubsystemHitKind = (typeof SubsystemHitKind)[keyof typeof SubsystemHitKind];

/** Weighted probability `rollSubsystemHit` draws from. Sums to exactly 1.0 (see 07-combat.md §5 for the derivation table). */
export const SUBSYSTEM_HIT_WEIGHT: Record<SubsystemHitKind, number> = {
  structure_only: 0.4,
  engine: 0.15,
  elevon_l: 0.0667,
  elevon_r: 0.0667,
  rudder: 0.0666,
  fuel: 0.1,
  radar: 0.05,
  gear: 0.05,
  hydraulics: 0.05,
} as const;

/** Default aircraft hit-test ellipsoid semi-axes in BODY frame, metres: x = half-length (nose/tail), y = half-height, z = half-span-ish width. Used by `segmentHitsEllipsoid` when a `DetectableEntity.hitEllipsoidBodyM` is not supplied (see §9 of 07-combat.md — no other module contract carries per-aircraft geometry to this module). Sized to approximate the Tejas Mk1 (length ~13.2 m, height ~4.4 m incl. fin, span ~8.2 m). */
export const DEFAULT_AIRCRAFT_HIT_ELLIPSOID_M: Vec3Like = { x: 6.6, y: 2.2, z: 4.1 };

/** Default radar cross-section, m^2, used when `DetectableEntity.radarSignature` is absent. Approximates a small single-engine delta fighter (nose-on lower, broadside higher). */
export const DEFAULT_AIRCRAFT_RCS_NOSE_ON_M2 = 2.0;
export const DEFAULT_AIRCRAFT_RCS_BROADSIDE_M2 = 6.0;

export const EXPLOSION_RADIUS_MISSILE_M = 15;
export const EXPLOSION_RADIUS_AIRCRAFT_KILL_M = 25;

/** Direct hit inside the target ellipsoid always applies full warhead damage (fraction 1.0 of the weapon's own `*_WARHEAD_DAMAGE_FRAC`). A proximity-fuse detonation applies a linearly-reduced fraction, from 1.0 at zero miss distance down to this floor at the fuse radius itself. */
export const PROXIMITY_DAMAGE_FALLOFF_MIN_FRAC = 0.35;

// -----------------------------------------------------------------------------
// 2. Constants — 23 mm GSh-23 gun
// -----------------------------------------------------------------------------

export const GUN_ROF_ROUNDS_PER_MIN = 3400;
/** = 60 / GUN_ROF_ROUNDS_PER_MIN, seconds between rounds while trigger is held and ammo remains. */
export const GUN_ROUND_INTERVAL_SEC = 60 / GUN_ROF_ROUNDS_PER_MIN;
export const GUN_MUZZLE_VELOCITY_MPS = 715;
export const GUN_ROUND_MASS_KG = 0.19;
export const GUN_ROUND_DIAMETER_M = 0.023;
/** Dimensionless drag coefficient for the ballistic drag model (07-combat.md §4.2). */
export const GUN_ROUND_DRAG_COEFF = 0.3;
/** = pi * (GUN_ROUND_DIAMETER_M/2)^2, m^2. Precomputed so no module needs Math.PI in a hot path. */
export const GUN_ROUND_CROSS_SECTION_M2 = 4.1548e-4;
export const GUN_MAX_AMMO_ROUNDS = 220;
/** 1-sigma circular dispersion, milliradians, applied as random jitter to the muzzle direction (07-combat.md §4.2). */
export const GUN_DISPERSION_MRAD = 2.0;
/** Structural damage fraction (of `DamageState.structurePct`) applied per round that hits, 0..1. */
export const GUN_HIT_DAMAGE_FRAC = 0.04;
export const GUN_BULLET_MAX_LIFETIME_SEC = 3.0;
/** A bullet may not proximity-detonate or hit anything before travelling this far — prevents impossible self-hits on the muzzle-adjacent airframe. Bullets have no fuse, but still use this as a minimum hit-test-eligibility distance. */
export const GUN_ARM_DISTANCE_M = 5.0;

// -----------------------------------------------------------------------------
// 3. Constants — IR missile (R-73-like)
// -----------------------------------------------------------------------------

export const IR_MISSILE_MASS_KG = 105;
export const IR_MISSILE_DIAMETER_M = 0.17;
export const IR_MISSILE_DRAG_COEFF = 0.25;
/** = pi * (IR_MISSILE_DIAMETER_M/2)^2, m^2. */
export const IR_MISSILE_CROSS_SECTION_M2 = 0.0227;
export const IR_MOTOR_BURN_TIME_SEC = 2.5;
export const IR_MOTOR_THRUST_N = 20000;
export const IR_PN_GAIN = 3.5;
/** Max lateral guidance acceleration, in g (multiply by core.ts's GRAVITY_MPS2 for m/s^2). */
export const IR_MAX_G = 35;
/** Half-angle, radians, of the narrow cone the target must be within to ACQUIRE a fresh heat lock (~2 deg — boresight/helmet-cue-style acquisition; see 07-combat.md §9). */
export const IR_SEEKER_ACQUIRE_HALF_ANGLE_RAD = 0.035;
/** Half-angle, radians, the seeker gimbal may reach once TRACKING a lock (~40 deg, matches the R-73's high off-boresight seeker). */
export const IR_SEEKER_TRACK_HALF_ANGLE_RAD = 0.698;
export const IR_SEEKER_GIMBAL_RATE_MAX_RAD_S = 12.0;
export const IR_LOCK_TIME_SEC = 1.0;
export const IR_MIN_LAUNCH_RANGE_M = 300;
export const IR_BASE_DETECT_RANGE_TAIL_ON_M = 8000;
export const IR_BASE_DETECT_RANGE_HEAD_ON_M = 2000;
export const IR_AFTERBURNER_RANGE_MULT = 1.5;
export const IR_PROXIMITY_FUSE_RADIUS_M = 8;
export const IR_ARM_DISTANCE_M = 50;
export const IR_MAX_FLIGHT_TIME_SEC = 25;
/** Warhead structural damage fraction on a direct hit (before proximity falloff). */
export const IR_WARHEAD_DAMAGE_FRAC = 0.6;
export const IR_MAX_AMMO_MISSILES = 4;
/** Muzzle/rail ejection speed added to shooter velocity along shooter-forward at launch, m/s. */
export const IR_EJECTION_SPEED_MPS = 25;

// -----------------------------------------------------------------------------
// 4. Constants — radar model
// -----------------------------------------------------------------------------

/** Detection range, m, at which a target of `RADAR_REFERENCE_RCS_M2` is first detected (the r^4 radar-range-equation reference point). */
export const RADAR_REFERENCE_RANGE_M = 80000;
export const RADAR_REFERENCE_RCS_M2 = 5.0;
/** Hard cap regardless of RCS (the r^4 formula alone is unbounded for large RCS). */
export const RADAR_MAX_RANGE_M = 100000;
export const RADAR_SCAN_AZ_HALF_ANGLE_RAD = 1.047;
export const RADAR_SCAN_EL_HALF_ANGLE_RAD = 0.524;
/** Narrower cone a selected target must stay within to build/hold an STT lock. */
export const RADAR_TRACK_HALF_ANGLE_RAD = 0.175;
export const RADAR_LOCK_TIME_SEC = 3.0;
/** Continuous seconds a locked target may spend outside the track cone/range/notch before the lock fully drops back to Searching. */
export const RADAR_LOCK_BREAK_GRACE_SEC = 1.5;
/** Below this absolute closure speed, a contact's Doppler return is treated as indistinguishable from ground clutter (notched) — see 07-combat.md §4.5. */
export const RADAR_NOTCH_CLOSURE_MPS = 15;
export const RADAR_NOTCH_MAX_RANGE_M = 20000;
/** Number of terrain-height samples `updateSensors` takes along the observer-target line to approximate line-of-sight terrain masking. */
export const RADAR_LOS_SAMPLE_COUNT = 3;
export const TERRAIN_LOS_MASK_MARGIN_M = 15;

// -----------------------------------------------------------------------------
// 5. Constants — radar missile (Derby-like)
// -----------------------------------------------------------------------------

export const RADAR_MISSILE_MASS_KG = 118;
export const RADAR_MISSILE_DIAMETER_M = 0.2;
export const RADAR_MISSILE_DRAG_COEFF = 0.28;
/** = pi * (RADAR_MISSILE_DIAMETER_M/2)^2, m^2. */
export const RADAR_MISSILE_CROSS_SECTION_M2 = 0.031416;
export const RADAR_MISSILE_MOTOR_BURN_TIME_SEC = 4.0;
export const RADAR_MISSILE_MOTOR_THRUST_N = 25000;
export const RADAR_MISSILE_PN_GAIN = 4.0;
export const RADAR_MISSILE_MAX_G = 30;
export const RADAR_MISSILE_MAX_RANGE_M = 50000;
/** Beyond this range from the target, the missile relies entirely on shooter datalink (see §4.6); within it, it may re-acquire autonomously even if datalink is lost. */
export const RADAR_MISSILE_ACTIVE_SEEKER_RANGE_M = 12000;
export const RADAR_MISSILE_ACTIVE_SEEKER_HALF_ANGLE_RAD = 0.349;
export const RADAR_MISSILE_MAX_FLIGHT_TIME_SEC = 60;
export const RADAR_MISSILE_PROXIMITY_FUSE_RADIUS_M = 10;
export const RADAR_MISSILE_ARM_DISTANCE_M = 100;
export const RADAR_MISSILE_WARHEAD_DAMAGE_FRAC = 0.65;
/** Continuous seconds the PN lateral-accel command may stay saturated at `RADAR_MISSILE_MAX_G` before guidance is judged unable to close and downgraded to 'lost'. */
export const RADAR_MISSILE_G_SATURATION_LOST_SEC = 2.0;
export const RADAR_MISSILE_MAX_AMMO = 4;
export const RADAR_MISSILE_EJECTION_SPEED_MPS = 25;

// -----------------------------------------------------------------------------
// 6. Constants — RWR, visual detection, threat scoring
// -----------------------------------------------------------------------------

/** A live hostile missile is treated as an inbound threat against an observer when its velocity, extrapolated in a straight line, would pass within this radius of the observer... */
export const RWR_MISSILE_THREAT_RADIUS_M = 200;
/** ...within this many seconds. Both conditions must hold (see 07-combat.md §4.7). */
export const RWR_MISSILE_THREAT_TIME_SEC = 12;

export const VISUAL_DETECT_RANGE_M = 8000;
export const VISUAL_FOV_HALF_ANGLE_RAD = 1.5708;
/** Visual detections closer than this are additionally marked `identified = true` on the resulting `Contact`. */
export const VISUAL_IFF_CONFIRM_RANGE_M = 3000;

/** Weights (sum to 1.0) `updateSensors` uses to rank contacts most-threatening-first. See 07-combat.md §4.8 for the exact formula each term feeds. */
export const THREAT_SCORE_WEIGHTS = {
  range: 0.4,
  aspect: 0.2,
  targetingMe: 0.3,
  closure: 0.1,
} as const;

// -----------------------------------------------------------------------------
// 6b. Weapon and radar profiles (data-driven weapons: one profile per store type,
//     from src/catalog; the *_ constants above are the defaults the generic
//     profiles in src/combat/weaponProfiles.ts are built from).
// -----------------------------------------------------------------------------

/** IR seeker performance (heat-seeking missiles). */
export interface IrSeekerProfile {
  /** Seeker must be within this of the target to start a lock, rad. */
  acquireHalfAngleRad: number;
  /** Seeker gimbal limit once tracking, rad. */
  trackHalfAngleRad: number;
  gimbalRateRadS: number;
  lockTimeSec: number;
  /** Lock-on range against a non-afterburning fighter, tail-on and head-on, m. */
  detectRangeTailOnM: number;
  detectRangeHeadOnM: number;
  afterburnerRangeMult: number;
  /** Chance (0..1) the seeker rejects a flare that appears in its field of view; absent = 0.5. */
  flareResistance?: number;
}

/** Active-radar seeker / datalink performance (radar-guided missiles). */
export interface RadarSeekerProfile {
  maxRangeM: number;
  /** The missile's own seeker takes over inside this range, m. */
  activeSeekerRangeM: number;
  activeSeekerHalfAngleRad: number;
  /** Seconds of saturated guidance before the shot is judged lost. */
  gSaturationLostSec: number;
  /** Chance (0..1) the active seeker rejects a chaff cloud next to its target; absent = 0.5. */
  chaffResistance?: number;
  /**
   * Surface-to-air missiles guided by their site's radar (semi-active, command, track-via-missile):
   * the terminal homing inside activeSeekerRangeM works only while that radar still tracks the
   * target (projectile.datalinkOk); otherwise the missile flies on its last track.
   */
  siteGuided?: boolean;
}

/**
 * One weapon type (a store): carriage, projectile physics, guidance, fuzing and damage. Guns and
 * missiles share the shape; guns ignore the motor/guidance fields, missiles the gun ones.
 */
export interface WeaponProfile {
  /** Catalogue id, e.g. 'gsh-23', 'r-73', 'derby'. */
  id: string;
  /** Display name, e.g. 'R-73'. */
  name: string;
  /** HUD / stores-page label (e.g. 'ASTRA') and 3-letter station legend (e.g. 'AST'). Absent = derived from `name`. */
  label?: string;
  short?: string;
  kind: WeaponKind;
  /** Mass and drag area added to the aircraft per round/missile loaded (drag 0 for internal gun ammo). */
  carriageMassKg: number;
  carriageDragAreaM2: number;
  /** In-flight projectile. */
  projectileMassKg: number;
  dragCoeff: number;
  crossSectionM2: number;
  maxLifetimeSec: number;
  armDistanceM: number;
  /** Gun: muzzle velocity. Missile: ejection speed off the rail. m/s. */
  launchSpeedMps: number;
  /** Gun only: seconds between rounds, and 1-sigma dispersion (mrad). */
  roundIntervalSec: number;
  dispersionMrad: number;
  /** Missiles only. */
  motorBurnSec: number;
  motorThrustN: number;
  pnGain: number;
  maxG: number;
  proximityFuseRadiusM: number;
  /** Structure fraction removed by a hit (gun: per round; missile: warhead, before proximity falloff). */
  damageFrac: number;
  minLaunchRangeM: number;
  ir?: IrSeekerProfile;
  radar?: RadarSeekerProfile;
  /** Realism (missiles). Every field is optional; absent = the simple model (constant mass, one
   *  motor phase, the flat maxG limit, perfect instantaneous guidance, a fixed damage fraction). */
  flight?: MissileFlightProfile;
  lethality?: MissileLethality;
  /** Explosive charge, for blast damage on the ground (contracts/ground.ts). Absent = no blast (gun rounds). */
  warhead?: WarheadProfile;
  /** Stores that carry several rounds (a rocket pod): rounds per store. The fit counts stores; the
   *  station fires rounds. `carriageMassKg` is then per round, `carriageDragAreaM2` per store, and
   *  `storeShellKg` the empty store's mass (it stays on the pylon). */
  roundsPerStore?: number;
  storeShellKg?: number;
  /** Free-fall bombs: a retarding tail (ballute) that opens `retardAfterSec` after release and adds `retardCdA` (Cd x area, m^2) of drag. */
  bomb?: { retardAfterSec: number; retardCdA: number };
  /** Guided bombs: how they find the target, and their launch envelope for the DLZ cue. */
  guided?: GuidedWeaponProfile;
  /** Anti-radiation missiles: the passive seeker's field of regard, its range, and how far off its
   *  remembered aim drifts when the radar stops transmitting while the missile is still far out. */
  arm?: { seekerHalfAngleDeg: number; maxRangeM: number; memoryErrorM: number };
  /** Published/validated launch envelope at ~10 km, launcher at Mach 0.9, non-manoeuvring target (m). For the AI and HUD cues. */
  envelope?: { rMaxHeadOnM: number; rMaxTailM: number; rNoEscapeM: number };
}

/** A missile's propulsion, aerodynamics and guidance imperfections. */
export interface MissileFlightProfile {
  /** Sustain phase after the boost (motorBurnSec / motorThrustN). */
  sustainBurnSec: number;
  sustainThrustN: number;
  /** Propellant burnt over boost + sustain (the missile gets lighter), kg. */
  propellantMassKg: number;
  /** Lifting reference area and maximum lift coefficient: the g available at dynamic pressure q is
   *  min(maxG, clMax * q * liftAreaM2 / (mass * g)). */
  liftAreaM2: number;
  clMax: number;
  /** Induced drag: D_i = inducedDragK * (m a_lat)^2 / (q * liftAreaM2). */
  inducedDragK: number;
  /** Supersonic wave-drag rise: Cd is multiplied by (1 + waveDragRise) around Mach 1 and by (1 + waveDragRise/2) above. */
  waveDragRise: number;
  /** Autopilot/airframe first-order lag on the lateral acceleration command, s. */
  autopilotTauSec: number;
  /** Seeker line-of-sight noise, 1-sigma, mrad (resampled every seekerUpdateSec). */
  seekerNoiseMrad: number;
  seekerUpdateSec: number;
  /** Radar missiles: datalink updates from the launcher's radar track, and that track's angular error. */
  datalinkIntervalSec?: number;
  datalinkErrMrad?: number;
  /** Radar missiles: lofted mid-course climb, rad above the line to the target (0 = none). */
  loftRad?: number;
  /**
   * Unpowered glide weapons (GPS): far from the target they fly the shallower of the line of sight
   * and a glide that holds this airspeed (best glide angle glideAngleRad at that speed, steeper when
   * slow), so they reach as far as their wings allow; normal steering in the last few km.
   */
  glideSpeedMps?: number;
  glideAngleRad?: number;
  /** After burnout, below this speed the missile can no longer manoeuvre to intercept and self-destructs, m/s. */
  minSpeedMps?: number;
}

/** Guided bombs / air-to-ground missiles. */
export interface GuidedWeaponProfile {
  /** 'laser': homes on a laser spot (a friendly designator lasing a point) inside its seeker cone;
   *  'gps': flies to the coordinates designated at release (GPS/INS), with a small error. */
  seeker: 'laser' | 'gps';
  /** Laser seeker's field of regard, half-angle, deg (laser only). */
  seekerHalfAngleDeg?: number;
  /** Circular error of the GPS/INS solution, m (1 sigma). */
  gpsErrorM?: number;
  /** Launch envelope: maximum range at sea level and its gain per km of release altitude, m. */
  rangeSeaLevelM: number;
  rangePerKmAltM: number;
}

/** A sensor pod (targeting pod) carried on a station: FLIR/TV, laser designator/rangefinder. */
export interface SensorPodProfile {
  id: string;
  name: string;
  label: string;
  short: string;
  massKg: number;
  dragAreaM2: number;
  /** Fields of view (wide, medium, narrow), deg. */
  fovsDeg: readonly number[];
  /** Laser designation / ranging range, m. */
  laserRangeM: number;
  /** The pod can't look above this elevation in the aircraft's frame (it hangs under the intake), deg. */
  maxUpDeg: number;
}

/** What the warhead does: fuze reliability and kill probability by miss distance. */
export interface MissileLethality {
  fuzeReliability: number;
  /** Kill probability for a direct hit, and at lethalRadiusM (linear between; 0 beyond). */
  pkDirect: number;
  pkAtLethalRadius: number;
  lethalRadiusM: number;
}

/** An aircraft's fire-control radar. */
export interface RadarProfile {
  id: string;
  name: string;
  /** Detection range against a target of referenceRcsM2, m (range scales with RCS^(1/4)). */
  referenceRangeM: number;
  referenceRcsM2: number;
  maxRangeM: number;
  scanAzHalfAngleRad: number;
  scanElHalfAngleRad: number;
  trackHalfAngleRad: number;
  lockTimeSec: number;
  lockBreakGraceSec: number;
  notchClosureMps: number;
  notchMaxRangeM: number;
  /** Simultaneous tracks. */
  maxTracks: number;
  /** IFF interrogator range, m (0 = no IFF). */
  iffRangeM: number;
  /** Non-cooperative target recognition: a tracked non-responder inside this range is identified hostile after NCTR_TIME_SEC, m (0 = none). */
  nctrRangeM: number;
  /** Dogfight (ACM) mode auto-acquisition range, m. */
  acmRangeM: number;
  /** Seconds a track coasts on memory after it is lost. */
  trackMemorySec: number;
}

/** Seconds of continuous radar track needed for an IFF reply / a non-cooperative identification. */
export const IFF_INTERROGATION_SEC = 1.0;
export const NCTR_TIME_SEC = 2.0;
/** ACM auto-acquisition field, relative to the nose: +-azimuth, and elevation from -down to +up, rad. */
export const ACM_FIELD_AZ_HALF_RAD = 0.26;
export const ACM_FIELD_EL_DOWN_RAD = 0.17;
export const ACM_FIELD_EL_UP_RAD = 0.79;

/** One entry of an aircraft's track file (radar/visual), with its estimate and identification. */
export interface TrackRecord {
  id: EntityId;
  pos: Vec3Like;
  vel: Vec3Like;
  firstSeenSec: number;
  lastSeenSec: number;
  identity: 'unknown' | 'friend' | 'hostile';
  /** Accumulated seconds of IFF interrogation / NCTR while unidentified. */
  iffSec: number;
  nctrSec: number;
  source: 'radar' | 'visual';
  memory: boolean;
  /** Last threat-score inputs (kept while coasting). */
  aspectFromNoseRad: number;
  targetingMe: number;
}

// -----------------------------------------------------------------------------
// 7. Weapon stations & loadout
// -----------------------------------------------------------------------------

/** One weapon station's static loadout spec, supplied by src/core at aircraft-spawn time (derived from the aircraft's mission loadout choice; this module does not read `contracts/aircraft.ts`'s `Hardpoint` shape directly — see 07-combat.md §9 — so `hardpointId`/`posBodyM` are passed through verbatim as plain fields instead). */
export interface WeaponStationSpec {
  hardpointId: string;
  /** Body-frame mount/muzzle/rail position, m. */
  posBodyM: Vec3Like;
  weapon: WeaponKind;
  /** Rounds (gun) or missiles (ir_missile/radar_missile) carried at this station at mission start. */
  maxCount: number;
  /** The store's profile. Absent = the generic profile for `weapon` (src/combat/weaponProfiles.ts). */
  profile?: WeaponProfile;
}

export interface WeaponsLoadout {
  stations: readonly WeaponStationSpec[];
  /** Targeting pod carried (on its station), if any. */
  pod?: SensorPodProfile;
  /** The aircraft's radar. Absent = the generic radar (the RADAR_* constants). */
  radar?: RadarProfile;
  /** Chaff bundles and flares carried (AircraftSensors.countermeasures). Absent = none. */
  countermeasures?: { chaff: number; flares: number };
}

export interface WeaponStationRuntime {
  hardpointId: string;
  posBodyM: Vec3Like;
  weapon: WeaponKind;
  /** Rounds/missiles remaining at this station right now. */
  count: number;
  /** Rounds/missiles this station holds when full (re-arming refills to this). */
  maxCount: number;
  profile: WeaponProfile;
}

/** Mutable holder for one mulberry32 PRNG stream's state (a uint32, per 00-architecture.md's determinism rule — src/combat's real implementation advances it via src/math's `mulberry32`; this contract only needs the storage shape). */
export interface CombatRngState {
  seedState: number;
}
/** `subSeed` should be derived by the caller from `WorldConfig.seed` (e.g. via src/math's sub-seed helper) so this stream never collides with another subsystem's — see 00-architecture.md §13. */
export type CreateCombatRngState = (subSeed: number) => CombatRngState;

export interface WeaponsState {
  stations: WeaponStationRuntime[];
  /** This aircraft's radar. */
  radar: RadarProfile;
  radarMode: 'rws' | 'acm';
  prevRadarModeCycle: boolean;
  /** Track file by entity id (radar/visual detections, with memory and identity). */
  tracks: Map<EntityId, TrackRecord>;
  /** The selected store's catalogue id (WeaponProfile.id): the pilot selects by store, so two
   *  missile types of one kind are separate selections. `selectedWeapon` is its kind. */
  selectedStoreId: string;
  selectedWeapon: WeaponKind;
  /** Seconds until the gun may fire its next round; counts down, reset to GUN_ROUND_INTERVAL_SEC on every round fired. */
  gunCooldownSec: number;
  /** Edge-detect latches for `PilotInputs`'s edge-triggered fields (`launch`, `cycleWeapon`, `cycleTarget` are all edge-triggered per core.ts's own doc comments). `gun` fire is level-triggered (`trigger` held), so no latch is needed for it. */
  prevLaunch: boolean;
  prevCycleWeapon: boolean;
  prevCycleTarget: boolean;
  /** Index into the most recent `updateSensors` call's `outContacts` that the pilot has cycled to, or -1 if none selected. Only meaningful for the tick it was computed in; `updateSensors` re-resolves `lockedTargetId` by id every call, not by re-using this index against a new contacts list. */
  selectedContactIndex: number;
  /** Lock progress toward `selectedWeapon`'s OWN sensor (radar STT cone/time for radar_missile, IR seeker cone/time/heat-range for ir_missile, always 'none' for gun — see 07-combat.md §4.4/§4.6). Changing `selectedWeapon` resets this to 'searching'/0, since the two sensors use different acquisition criteria. */
  lockState: LockState;
  lockedTargetId: EntityId | undefined;
  /** Seconds the current candidate has continuously satisfied its lock criteria. */
  lockProgressSec: number;
  /** Seconds remaining before a currently-Locked target that just left the track cone/range/notch fully drops to Searching (hysteresis). Reset to the relevant `*_LOCK_BREAK_GRACE_SEC` whenever the target leaves; reset to 0 whenever it is back inside. */
  lockBreakGraceRemainingSec: number;
  /** Mirrors `CombatStatus.rwrWarning` / `missileInboundWarning`; `writeCombatStatus` copies these through. */
  rwrWarning: boolean;
  missileInboundWarning: boolean;
  /** Countermeasures left and carried (refilled by re-arming), the keys' last state, and seconds until a held key releases its next program. */
  chaff: number;
  flares: number;
  chaffMax: number;
  flaresMax: number;
  prevFlare: boolean;
  prevChaff: boolean;
  flareRepeatSec: number;
  chaffRepeatSec: number;
  /** Air-to-ground sight (src/combat/agSight.ts): the selected store's predicted impact (CCIP) and time of flight. */
  agValid: boolean;
  agImpact: Vec3Like;
  agTofSec: number;
  /** Designated ground point (SPI) and the CCRP solution to it. */
  spiValid: boolean;
  spi: Vec3Like;
  ccrpTimeToReleaseSec: number;
  ccrpCrossTrackM: number;
  /**
   * The SPI is the route's target steerpoint (pre-planned): its aim points, one per GPS weapon in
   * turn (`next` is the SPI now). Dropped when the pilot designates anything else.
   */
  briefed?: { points: Vec3Like[]; next: number };
  /** The target key was pressed with an air-to-ground store selected: designate at the next sight update. */
  designateRequest: boolean;
  /** Seconds until the next sight update (it runs at AG_SIGHT_HZ). */
  agSightDueSec: number;
  /** Release button: a bomb already released during this press (CCIP: one per press; CCRP: one on reaching the release point). */
  releasedThisPress: boolean;
  /** The selected guided weapon's launch zone to the SPI (DlzCode). */
  dlz: number;
  /** Rockets: seconds until the next round of the ripple, and which station fires next. */
  rocketCooldownSec: number;
  nextRocketStation: number;
  /** Targeting pod (src/combat/targetingPod.ts), when carried. */
  pod?: PodState;
  /**
   * World-space gun lead-computing-sight aim point against `lockedTargetId`
   * (or the currently-selected contact, if the pilot has cycled a target
   * without a full missile lock — see 07-combat.md section 4.10), recomputed
   * once per tick via `computeLeadSolution` using `GUN_MUZZLE_VELOCITY_MPS`
   * and the caller-supplied `gravityMps2`, REGARDLESS of `selectedWeapon`
   * (so switching to the gun never shows a stale pipper). Mirrors
   * `CombatStatus.aimPointWorld`/`aimPointValid`; `writeCombatStatus` copies
   * these straight through, and src/core copies `CombatStatus`'s copy into
   * the Snapshot HUD block's `PIPPER_*` fields (core.ts section 11).
   */
  aimPointWorld: Vec3Like;
  aimPointValid: boolean;
  rng: CombatRngState;
}

export type CreateWeaponsState = (loadout: WeaponsLoadout, rngSubSeed: number) => WeaponsState;

/** A targeting pod's state: where it looks (a ground point), how, and whether it is lasing. */
export interface PodState {
  profile: SensorPodProfile;
  /** The ground point under the crosshair (the pod is ground-stabilised on it). */
  point: Vec3Like;
  pointValid: boolean;
  /** Point track on a ground unit (the point follows it); NO_ENTITY_ID = area/inertial track. */
  trackId: EntityId;
  /** The pod's point is the designated point (SPI) while designating. */
  designating: boolean;
  fovIndex: number;
  /** Lasing now (manual or automatic for a laser-guided bomb). */
  laser: boolean;
  /** Line of sight blocked (gimbal limit or terrain). */
  masked: boolean;
  rangeM: number;
  prevZoom: boolean;
  prevTrack: boolean;
  /** Seconds until the next terrain line-of-sight check, and its result. */
  losDueSec: number;
  terrainMasked: boolean;
}

/** Aggregates `WeaponsState` into the public `CombatStatus` shape `core.ts`'s `PilotContext.combat` and the snapshot HUD block are built from. Writes into `out` in place; never allocates. */
export type WriteCombatStatus = (state: WeaponsState, out: CombatStatus) => void;

// -----------------------------------------------------------------------------
// 8. Damage state
// -----------------------------------------------------------------------------

/** The canonical "fully healthy" `DamageState` (core.ts owns the TYPE; this module owns the write-side logic, so it also owns the one canonical factory — see 07-combat.md §9). src/core calls this once per aircraft at spawn. */
export type CreateDamageState = () => DamageState;

export interface ApplyHitResult {
  subsystemHit: SubsystemHitKind;
  /** True if this hit brought `targetState.hp` to <= 0 (equivalently `targetDamage.structurePct` to <= 0). Caller (src/core) is responsible for emitting the `kill` SimEvent and setting `targetState.alive = false` when true — `applyHit` itself only ever mutates `hp`/`structurePct`/the rolled subsystem field, never `alive`, since a "destroyed but not yet despawned" aircraft may still need a few ticks of wreckage/crash-sequence handling that is src/core's call, not combat's. */
  lethal: boolean;
  /** `targetState.hp` after this hit, 0..100. */
  newHp: number;
}

/**
 * Applies one weapon hit to an aircraft target: reduces `targetDamage.structurePct`
 * by `damageFrac` (clamped to >= 0), sets `targetState.hp = round(structurePct * 100)`,
 * rolls one `SubsystemHitKind` via `rng` (weighted by `SUBSYSTEM_HIT_WEIGHT`) and
 * additionally degrades that subsystem's own `DamageState` field by
 * `damageFrac * SUBSYSTEM_DAMAGE_EXTRA_MULT` (clamped to [0,1]; `hydraulics`/`fuel`
 * rolls instead set `hydraulicsOk = false` / `fuelLeak = true` outright, since
 * those two DamageState fields are boolean, not 0..1 — see 07-combat.md §4.9).
 * Mutates `targetState` and `targetDamage` in place; mutates `rng.seedState`
 * in place (one or two mulberry32 draws). Allocation-free.
 */
export type ApplyHit = (
  weapon: WeaponKind,
  damageFrac: number,
  targetState: EntityState,
  targetDamage: DamageState,
  rng: CombatRngState,
) => ApplyHitResult;

/** Exposed standalone (in addition to being used inside `applyHit`) so 07-combat.md's statistical unit test can verify the weighted distribution in isolation. Defined as `subsystemHitFromU01(nextFloat01(rng))` (one mulberry32 draw). Mutates `rng.seedState` in place; returns the drawn kind. */
export type RollSubsystemHit = (rng: CombatRngState) => SubsystemHitKind;

/** The pure, RNG-free core of `rollSubsystemHit`: walks `SUBSYSTEM_HIT_WEIGHT` in the fixed key order given in 07-combat.md §5's cumulative-threshold table and returns the bucket `u` (a uniform draw in [0,1)) falls into. Exposed standalone so unit tests can assert exact boundary behaviour (e.g. `u = 0` -> `'structure_only'`, `u = 0.99` -> `'hydraulics'`) without depending on src/math's mulberry32 sequence. */
export type SubsystemHitFromU01 = (u: number) => SubsystemHitKind;

// -----------------------------------------------------------------------------
// 9. Detection, radar, RWR, contacts
// -----------------------------------------------------------------------------

export interface RadarSignature {
  /** RCS at 0 deg aspect (nose/tail-on), m^2. */
  noseOnRcsM2: number;
  /** RCS at 90 deg aspect (beam-on), m^2. Always >= noseOnRcsM2. */
  broadsideRcsM2: number;
}

/**
 * The read-only per-entity view `updateSensors`/`stepProjectile` need of every
 * OTHER entity in the world. src/core builds one array of these once per
 * tick (from its entity pool) and passes the same array into every aircraft's
 * `updateSensors` call and every projectile's `stepProjectile` call — see
 * 07-combat.md §3 for why this is O(1) allocation and not per-observer.
 */
export interface DetectableEntity {
  id: EntityId;
  team: Team;
  kind: EntityKind;
  pos: Vec3Like;
  vel: Vec3Like;
  rot: QuatLike;
  alive: boolean;
  /** Absent -> DEFAULT_AIRCRAFT_RCS_*_M2 is used. Meaningful for `kind === 'aircraft'` only. */
  radarSignature?: RadarSignature;
  /** Absent -> DEFAULT_AIRCRAFT_HIT_ELLIPSOID_M is used. Meaningful for `kind === 'aircraft'` only. */
  hitEllipsoidBodyM?: Vec3Like;
  /**
   * Aircraft only: this entity's OWN current radar targeting state, so a
   * DIFFERENT observer's `updateSensors` call can derive RWR warnings without
   * reading that aircraft's private `WeaponsState` (which src/combat has no
   * other way to reach across aircraft — see 07-combat.md §9). src/core
   * populates this from each aircraft's own `WeaponsState.radarTrackedId` /
   * `lockedTargetId` before building the shared array. Absent (or the field
   * simply not wired by src/core) means RWR radar-lock warnings never fire —
   * degrades gracefully, does not error.
   */
  radarEmission?: { trackedTargetId: EntityId | undefined; lockedTargetId: EntityId | undefined };
}

/**
 * The single per-tick, per-aircraft sensor/lock/RWR update. Called by
 * src/core once per SIM_DT_SEC for every aircraft entity that carries a
 * `Pilot`, BEFORE that Pilot's `update()` (so `outContacts` and the
 * `WeaponsState` fields `Pilot.update` reads via `PilotContext.combat` are
 * fresh for this tick). Responsibilities, all in one call:
 *   1. Build `outContacts` (radar + visual detection, terrain-LOS-masked,
 *      threat-sorted) — see 07-combat.md §4.1/§4.3/§4.8.
 *   2. Consume `inputs.cycleTarget` (edge-triggered) to advance
 *      `state.selectedContactIndex` / `state.lockedTargetId` through the
 *      contacts just built.
 *   3. Consume `inputs.cycleWeapon` (edge-triggered) to advance
 *      `state.selectedWeapon` through stations with `count > 0`; resets lock
 *      progress since the two missile types use different lock criteria.
 *   4. Advance `state.lockState`/`lockProgressSec`/`lockBreakGraceRemainingSec`
 *      toward/away from a lock on `state.lockedTargetId`, using radar
 *      criteria (RADAR_*) when `state.selectedWeapon === 'radar_missile'`,
 *      IR seeker criteria (IR_*) when `'ir_missile'`, and leaves `lockState`
 *      at `'none'` when `'gun'` — see 07-combat.md §4.4/§4.6.
 *   5. Recompute `state.rwrWarning` (any hostile `radarEmission` targeting
 *      `observerId`) and `state.missileInboundWarning` (any hostile live
 *      missile whose extrapolated path threatens `observerId`, RWR_* consts)
 *      and push `warning` SimEvents on each boolean's rising/falling edge.
 *   6. Push `lockAcquired`/`lockLost` SimEvents on `state.lockState`
 *      transitions into/out of `'locked'`.
 * Allocation-free: mutates `state` in place, pushes into `outContacts` and
 * `outEvents` (both pre-sized/reused per this file's header convention).
 */
export type UpdateSensors = (
  observerId: EntityId,
  observer: DetectableEntity,
  observerDamage: DamageState,
  /** Observer's altitude above the terrain directly below, m (src/core already computes this for `AircraftTelemetry.altAglM`; passed through rather than recomputed here). */
  observerAltAglM: number,
  /**
   * The PREVIOUS tick's `PilotInputs` for this aircraft (the same object
   * `stepAircraft` consumed last tick) — NOT this tick's, which does not
   * exist yet: `updateSensors` runs before `Pilot.update` produces it (see
   * 07-combat.md §4.1 for the full per-tick order). Only `cycleTarget` /
   * `cycleWeapon` are read here (edge-detected against `state.prevCycleTarget`
   * / `state.prevCycleWeapon`), so this one-tick lag on target/weapon
   * cycling is the only user-visible effect — imperceptible at 120 Hz.
   */
  inputs: PilotInputs,
  /** All entities in the world this tick, INCLUDING `observer` itself (the function skips `id === observerId`). */
  allEntities: readonly DetectableEntity[],
  sampler: HeightSampler,
  state: WeaponsState,
  simTimeSec: number,
  dtSec: number,
  outContacts: Contact[],
  outEvents: SimEvent[],
) => void;

/** Pure radar-range-equation formula (r^4 law), exposed standalone for unit testing: `RADAR_REFERENCE_RANGE_M * (rcsM2 / RADAR_REFERENCE_RCS_M2) ** 0.25`, clamped to `[0, RADAR_MAX_RANGE_M]`. */
export type RadarDetectionRangeM = (rcsM2: number, radar?: RadarProfile) => number;

/**
 * Pure IR heat-signature detection-range formula, exposed standalone for unit
 * testing. `aspectRad` is the aspect angle at the TARGET between the
 * target's own nose and the line back to the observer (0 = target flying
 * directly away / tail-on-hot, PI = target approaching head-on/cold) — see
 * 07-combat.md §4.6 for the exact lerp and the afterburner multiplier.
 */
export type IrDetectionRangeM = (aspectRad: number, targetAfterburnerOn: boolean, seeker?: IrSeekerProfile) => number;

// -----------------------------------------------------------------------------
// 10. Weapon firing
// -----------------------------------------------------------------------------

export const ProjectileKind = {
  Bullet: 'bullet',
  IrMissile: 'ir_missile',
  RadarMissile: 'radar_missile',
  Bomb: 'bomb',
  Rocket: 'rocket',
  GuidedBomb: 'guided_bomb',
  Agm: 'agm',
  Arm: 'arm',
} as const;
export type ProjectileKind = (typeof ProjectileKind)[keyof typeof ProjectileKind];

/** One request to spawn a bullet/missile entity, produced by `fireWeapons`. src/core (which owns the entity pool — this module does not) is responsible for actually allocating the `EntityId`, populating the new `EntityState` from this request's fields, and then calling `initProjectile` to initialise the matching `ProjectileState` slot — see 07-combat.md §3 for the full spawn hand-off sequence. */
export interface ProjectileSpawnRequest {
  kind: ProjectileKind;
  ownerId: EntityId;
  team: Team;
  posWorld: Vec3Like;
  /** Advisory initial orientation; `stepProjectile` re-derives orientation from velocity every tick from the very next call onward, so this only matters for the spawn frame's render. */
  rotWorld: QuatLike;
  velWorld: Vec3Like;
  /** Missiles only; `undefined` for a bullet. */
  targetId?: EntityId;
  /** The fired store's profile. Absent = the generic profile for `kind`. */
  profile?: WeaponProfile;
  /** Guided bombs (GPS): the coordinates to fly to. */
  targetPoint?: Vec3Like;
  /** Seed for this projectile's own random stream (guidance noise, fuze). */
  rngSeed?: number;
}

/**
 * Called by src/core once per SIM_DT_SEC for every aircraft entity that owns
 * a `WeaponsState`, AFTER that tick's `stepAircraft` (so muzzle position/
 * velocity reflect this tick's fresh `EntityState`). Consumes
 * `inputs.trigger` (level-triggered: fires the gun at most once per
 * GUN_ROUND_INTERVAL_SEC while held and `gunCooldownSec <= 0` and ammo
 * remains) and `inputs.launch` (edge-triggered via `state.prevLaunch`: fires
 * at most one missile per rising edge). A missile launch additionally
 * requires, for `'radar_missile'`, `state.lockState === 'locked'`
 * (STT-lock-to-launch — see 07-combat.md §4.6.1), and for `'ir_missile'`,
 * `state.lockState === 'locked'` AND `range(shooterState, target) >=
 * IR_MIN_LAUNCH_RANGE_M`; a launch attempt that fails either precondition is
 * silently dropped (no event, no ammo consumed). On every successful
 * fire/launch: decrements the relevant station's `count`, pushes exactly one
 * `ProjectileSpawnRequest` into `outRequests`, and pushes the matching
 * `gunFire`/`missileLaunch` `SimEvent` into `outEvents`. Allocation-free.
 */
export type FireWeapons = (
  shooterId: EntityId,
  shooterState: EntityState,
  shooterDamage: DamageState,
  /** Resolved via `state.lockedTargetId`; `undefined` if that id is stale/dead — launch is then silently dropped as above. */
  lockedTarget: DetectableEntity | undefined,
  inputs: PilotInputs,
  state: WeaponsState,
  simTimeSec: number,
  dtSec: number,
  outRequests: ProjectileSpawnRequest[],
  outEvents: SimEvent[],
) => void;

// -----------------------------------------------------------------------------
// 11. Projectile flight (bullets + both missile kinds share one pool/step fn)
// -----------------------------------------------------------------------------

export const ProjectileGuidanceMode = {
  /** Bullets always; also missiles once they can no longer guide (fuel out with no lock, or lock permanently lost). Gravity + drag only, no lateral accel. */
  Ballistic: 'ballistic',
  /** IR missile actively homing: target within seeker gimbal, PN active. */
  IrHoming: 'ir_homing',
  /** Radar missile receiving perfect target state via shooter datalink (shooter still alive and still locked on the same target) — see 07-combat.md §4.6.2. */
  RadarDatalink: 'radar_datalink',
  /** Radar missile within RADAR_MISSILE_ACTIVE_SEEKER_RANGE_M of its target and guiding autonomously (datalink lost or shooter destroyed, or simply close enough to not need it). */
  RadarActive: 'radar_active',
  /** Guidance permanently gave up this shot (seeker FOV exceeded for IR, or PN saturated too long for radar, or target died) — flight continues ballistic to `stepProjectile`'s `'expired'`/`'terrainImpact'` outcome, never regains guidance. */
  Lost: 'lost',
  /** Guided bomb / AGM steering to a point (GPS coordinates or a laser spot). */
  PointGuided: 'point_guided',
} as const;
export type ProjectileGuidanceMode = (typeof ProjectileGuidanceMode)[keyof typeof ProjectileGuidanceMode];

export interface ProjectileState {
  /** False = free pool slot. */
  active: boolean;
  kind: ProjectileKind;
  ownerId: EntityId;
  /** NO_ENTITY_ID (core.ts) for a bullet, or a guided missile that has gone `'lost'`. */
  targetId: EntityId;
  ageSec: number;
  guidance: ProjectileGuidanceMode;
  /** Distance travelled since spawn, m — compared against `*_ARM_DISTANCE_M` to gate fuse/hit eligibility. */
  distanceTravelledM: number;
  /** 1 at motor ignition, 0 once `ageSec >= *_MOTOR_BURN_TIME_SEC`. Always 0 for a bullet. */
  fuelFracRemaining: number;
  /** Current seeker boresight direction, missile BODY frame, unit length. Compared against `IR_SEEKER_*_HALF_ANGLE_RAD` / `RADAR_MISSILE_ACTIVE_SEEKER_HALF_ANGLE_RAD`. Unused (left at (1,0,0)) for a bullet. */
  seekerLosDirBody: Vec3Like;
  /** Last true target position/velocity this projectile received (from datalink or its own seeker); used to keep guiding for up to one tick after a target briefly drops out, and as the coast reference once `guidance` becomes `'lost'`. */
  lastKnownTargetPos: Vec3Like;
  lastKnownTargetVel: Vec3Like;
  /** Continuous seconds the PN command has been saturated at the kind's max-G limit; drives the `RadarActive`/`IrHoming` -> `Lost` transition alongside the seeker-FOV check. */
  gSaturatedSec: number;
  /** The fired store's profile (set by initProjectile). Absent = the generic profile for `kind`. */
  profile?: WeaponProfile;
  /** Realism state (used when profile.flight is present). */
  rngState?: number;
  /** Achieved lateral acceleration (after the autopilot lag), m/s^2. */
  accelLat?: Vec3Like;
  /** Seeker noise offset applied to the target position, and seconds until it is resampled. */
  noiseOffset?: Vec3Like;
  noiseAgeSec?: number;
  /** Datalink: set by the caller each tick (the launcher still holds the target in track), and the time since the last update. */
  datalinkOk?: boolean;
  datalinkAgeSec?: number;
  /** Guided bombs / AGMs: the point it steers to (GPS coordinates, or the laser spot it sees) and whether it has one this tick. */
  targetPoint?: Vec3Like;
  targetPointValid?: boolean;
  /** Anti-radiation missiles: its emitter stopped transmitting and it now flies to where it remembers it. */
  armMemory?: boolean;
}

export type CreateProjectilePool = (size: number) => ProjectileState[];

/** Resets `slot` to a free ("active = false") state, zeroing every field. Called by src/core when a projectile entity despawns, before the slot is reused by a later spawn. */
export type ResetProjectile = (slot: ProjectileState) => void;

/** Initialises a freshly-allocated pool slot from a spawn request. Called by src/core immediately after it allocates the matching `EntityId`/`EntityState`. */
export type InitProjectile = (slot: ProjectileState, spec: ProjectileSpawnRequest, simTimeSec: number) => void;

export interface CombatEnvironment {
  /** Air density at the projectile's current altitude, kg/m^3 (same ISA formula as `contracts/flight.ts`'s `Environment.airDensityKgM3` — this module declares its own copy of the field rather than importing flight.ts, per this file's "only './core'" import rule; src/core is expected to supply the same value it computed for the owning aircraft's atmosphere lookup, evaluated at the projectile's own altitude). */
  airDensityKgM3: number;
  windWorldMps: Vec3Like;
  gravityMps2: number;
  /** Air density at an altitude, kg/m^3. When present it replaces airDensityKgM3 (per projectile, per tick). */
  densityAtAltitude?: (altM: number) => number;
}

export const ProjectileOutcome = {
  Flying: 'flying',
  Expired: 'expired',
  TerrainImpact: 'terrain_impact',
  ProximityDetonation: 'proximity_detonation',
  DirectHit: 'direct_hit',
} as const;
export type ProjectileOutcome = (typeof ProjectileOutcome)[keyof typeof ProjectileOutcome];

export interface ProjectileStepResult {
  outcome: ProjectileOutcome;
  /** Populated only for 'proximity_detonation' / 'direct_hit'. */
  hitTargetId?: EntityId;
  /** Miss distance, m, at closest approach this tick — 0 for a 'direct_hit'. Populated for 'proximity_detonation' / 'direct_hit'; NaN otherwise. */
  missDistanceM: number;
  /** World-frame point of detonation/impact. Populated for 'terrain_impact' / 'proximity_detonation' / 'direct_hit'. */
  impactPos?: Vec3Like;
}

/**
 * Pure per-projectile physics + guidance step, called by src/core once per
 * SIM_DT_SEC for every alive bullet/missile entity — mirrors `StepAircraft`'s
 * `(state, ..., out)` shape (00-architecture.md §9.1) deliberately, for a
 * consistent calling convention across every per-entity step function in
 * this project. `out` may alias `state`. Always sets `out.alive = false`
 * (and `out.pos` to the exact impact point) when `outcome !== 'flying'`;
 * otherwise integrates thrust (if `fuelFracRemaining > 0`) + drag + gravity +
 * any active guidance lateral acceleration, and re-derives `out.rot` to face
 * `out.vel` (velocity-alignment; see 07-combat.md §4.2/§4.7 for the exact
 * integration order, PN formula and hit/fuse test). `candidates` is tested
 * for both guidance (missile looks up `projectile.targetId` within it) and
 * hit/fuse resolution (ALL kinds test against every candidate EXCEPT
 * `c.id === projectile.ownerId`, which is unconditionally skipped for the
 * projectile's entire flight — the shooter is never a valid hit/fuse target
 * for its own round; nearest remaining hit wins, so a bullet or missile CAN
 * still hit/detonate near an unintended aircraft — team/ROE filtering is not
 * this function's job). BOTH the direct-hit ellipsoid test and the
 * proximity-fuse test are gated identically by `distanceTravelledM >=
 * armDistance` (`GUN_ARM_DISTANCE_M`/`IR_ARM_DISTANCE_M`/
 * `RADAR_MISSILE_ARM_DISTANCE_M` per `kind`) for EVERY projectile kind, not
 * only bullets — this is what makes owner-exclusion safe to rely on for a
 * missile spawned at a wing-mounted `WeaponStationSpec.posBodyM`, well
 * inside the shooter's own `DEFAULT_AIRCRAFT_HIT_ELLIPSOID_M`, at ignition.
 * Allocation-free.
 */
export type StepProjectile = (
  state: EntityState,
  projectile: ProjectileState,
  candidates: readonly DetectableEntity[],
  sampler: HeightSampler,
  env: CombatEnvironment,
  dtSec: number,
  out: EntityState,
) => ProjectileStepResult;

/**
 * Pure true-proportional-navigation lateral acceleration formula (07-combat.md
 * §4.7 gives the exact vector derivation and a worked numeric example),
 * exposed standalone for unit testing and used internally by `stepProjectile`
 * for both missile kinds. Returns `(0,0,0)` when the closing velocity `Vc`
 * computed internally is `<= 0` (not closing — PN is undefined/inapplicable).
 * Result is clamped to magnitude `maxAccelMps2`. Mutates and returns `out`.
 */
export type ComputePnAccel = (
  missilePos: Vec3Like,
  missileVel: Vec3Like,
  targetPos: Vec3Like,
  targetVel: Vec3Like,
  gain: number,
  maxAccelMps2: number,
  out: Vec3Like,
) => Vec3Like;

// -----------------------------------------------------------------------------
// 12. Hit-test primitives (exposed standalone for isolated unit testing, and
//     used internally by `stepProjectile`)
// -----------------------------------------------------------------------------

export interface EllipsoidHitResult {
  hit: boolean;
  /** Parametric position along the tested segment, [0,1], of the entry point. `NaN` when `hit === false`. */
  tEntry: number;
}

/**
 * Swept segment-vs-ellipsoid test (prevents tunnelling at high closure
 * speed): does the line segment `segStartWorld -> segEndWorld` cross the
 * ellipsoid centred at `targetPos`, oriented by `targetRot`, with body-frame
 * semi-axes `ellipsoidSemiAxesBodyM`? Mutates and returns `out`.
 */
export type SegmentHitsEllipsoid = (
  segStartWorld: Vec3Like,
  segEndWorld: Vec3Like,
  targetPos: Vec3Like,
  targetRot: QuatLike,
  ellipsoidSemiAxesBodyM: Vec3Like,
  out: EllipsoidHitResult,
) => EllipsoidHitResult;

/** Minimum distance, m, from `targetPos` to the segment `segStartWorld -> segEndWorld`. Used for proximity-fuse miss-distance checks. */
export type ClosestApproachOnSegment = (segStartWorld: Vec3Like, segEndWorld: Vec3Like, targetPos: Vec3Like) => number;

// -----------------------------------------------------------------------------
// 13. Lead-computing sight (exposed for src/hud)
// -----------------------------------------------------------------------------

export interface LeadSolutionResult {
  /** False if no ballistic solution converges within `LEAD_SOLVE_MAX_ITERATIONS` (see 07-combat.md §4.10) — e.g. the target is outrunning the projectile. `outAimPointWorld` is left at `targetPosWorld` in that case (a sane fallback: point at the target itself) and the HUD should hide/gray the pipper. */
  valid: boolean;
  timeOfFlightSec: number;
  rangeM: number;
}

/**
 * Iterative constant-target-velocity ballistic lead solution (07-combat.md
 * §4.10 gives the exact fixed-point iteration and a worked numeric example).
 * Deliberately takes ONLY `Vec3Like` positions/velocities plus two plain
 * numeric constants — no `WeaponsState`/`ProjectileState`/anything else this
 * module owns — specifically so a consumer that only has snapshot data (its
 * own entity block for the shooter, the target's entity block found via
 * `SnapshotHud.TARGET_ID`) plus this module's own exported
 * `GUN_MUZZLE_VELOCITY_MPS` and core.ts's `GRAVITY_MPS2` has every input it
 * needs (see 07-combat.md §9 for why this matters given the fixed
 * dependency graph). Mutates and returns `outAimPointWorld`.
 */
export type ComputeLeadSolution = (
  shooterPosWorld: Vec3Like,
  shooterVelWorld: Vec3Like,
  targetPosWorld: Vec3Like,
  targetVelWorld: Vec3Like,
  muzzleVelocityMps: number,
  gravityMps2: number,
  outAimPointWorld: Vec3Like,
) => LeadSolutionResult;

export const LEAD_SOLVE_MAX_ITERATIONS = 5;
export const LEAD_SOLVE_MAX_RANGE_M = 3000;

// -----------------------------------------------------------------------------
// 14. Explosion / effect event helpers
// -----------------------------------------------------------------------------

/**
 * Builds the `explosion` `SimEvent` for a MISSILE detonation (direct hit or
 * proximity) and pushes it into `outEvents`, using `EXPLOSION_RADIUS_MISSILE_M`.
 * Never called for a bullet (a bullet hit produces only a `hit` SimEvent —
 * see `resolveProjectileHit` below). Allocation-free.
 */
export type PushExplosionEvent = (kind: ProjectileKind, pos: Vec3Like, causedBy: EntityId, outEvents: SimEvent[]) => void;

export interface ResolveProjectileHitResult {
  /** Mirrors `ApplyHitResult.lethal`. When true, the CALLER (src/core) is responsible for pushing a `kill` SimEvent and, once its own despawn/wreckage sequencing is done, setting `targetState.alive = false` — this function never does either, matching `applyHit`'s own contract. */
  targetLethal: boolean;
  targetNewHp: number;
  subsystemHit: SubsystemHitKind;
}

/**
 * The single call src/core makes for every `stepProjectile` result whose
 * `outcome` is `'direct_hit'` or `'proximity_detonation'` (for `'terrain_impact'`
 * / `'expired'`, src/core simply despawns the projectile itself — there is
 * nothing weapon-specific left to resolve, so no combat call is needed).
 * Computes `damageFrac` from `kind`'s `*_WARHEAD_DAMAGE_FRAC` /
 * `GUN_HIT_DAMAGE_FRAC` (bullets) and, for `'proximity_detonation'`, the
 * miss-distance falloff (`PROXIMITY_DAMAGE_FALLOFF_MIN_FRAC` at the fuse
 * radius, 1.0 at zero distance — 07-combat.md §4.9); calls `applyHit`
 * internally; pushes exactly one `hit` `SimEvent`; for `kind !== 'bullet'`
 * also calls `pushExplosionEvent`. Allocation-free.
 */
export type ResolveProjectileHit = (
  result: ProjectileStepResult,
  ownerId: EntityId,
  kind: ProjectileKind,
  targetState: EntityState,
  targetDamage: DamageState,
  rng: CombatRngState,
  outEvents: SimEvent[],
  /** The projectile's profile (damage, fuse radius). Absent = the generic profile for `kind`. */
  profile?: WeaponProfile,
) => ResolveProjectileHitResult;
