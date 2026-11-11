/**
 * src/catalog/weaponSpec/types.ts — the modular weapon spec: every store (gun, missile, rocket,
 * bomb, glide weapon, surface-to-air missile) is described by the same parts. A spec names a
 * template (or another weapon) it `extends` and overrides only what differs; `compileWeapon`
 * (./define.ts) checks it and turns it into the flat WeaponProfile the simulation flies.
 *
 * Units are SI unless the name says otherwise; angles are in degrees. Every number here is a game
 * tuning value: change it, then check the result in the Weapon Lab (/lab/) or with
 * `npm run weapons-check`. See docs/weapons/GUIDE.md.
 */
import type { WeaponKind } from '../../contracts/core';

/** What hangs on the pylon before release (it weighs on and drags the launching aircraft). */
export interface CarriagePart {
  /** Mass added to the aircraft per round carried, kg. */
  massKg: number;
  /** Drag area added per store, m^2 (0 for internal gun ammunition). */
  dragAreaM2: number;
  /** Stores that carry several rounds (a rocket pod): rounds per store. */
  roundsPerStore?: number;
  /** An empty multi-round store's own mass (it stays on the pylon), kg. */
  storeShellKg?: number;
}

/** How the store leaves the aircraft. */
export interface ReleasePart {
  /** Gun: muzzle velocity. Missiles/rockets: speed added along the nose. Bombs: ejection speed off the rack (body down). m/s. */
  speedMps: number;
  /** The weapon won't fire at a target closer than this, m. */
  minRangeM?: number;
  /** Gun / rocket ripple: seconds between rounds. */
  roundIntervalSec?: number;
  /** Gun / rocket: 1-sigma dispersion, mrad. */
  dispersionMrad?: number;
}

/** The flying body: mass, drag, lift and structural limits. */
export interface AirframePart {
  /** Launch mass, kg (it gets lighter as the motor burns: motor.propellantKg). */
  massKg: number;
  /** Drag coefficient on `refAreaM2` (subsonic, zero lift). */
  dragCd: number;
  /** Reference (cross-section) area for drag, m^2. */
  refAreaM2: number;
  /** Structural / autopilot g limit. */
  maxG: number;
  /** Seconds before it self-destructs (or the simulation drops it). */
  maxLifetimeSec: number;
  /**
   * Lift, for manoeuvring stores (missiles, guided and glide weapons). Without it the store has no
   * realism model: constant mass, flat maxG, no induced drag.
   */
  lift?: {
    /** Lifting area, m^2: available g = min(maxG, clMax * q * areaM2 / (m g)). */
    areaM2: number;
    clMax: number;
    /** Induced drag: D_i = inducedDragK * (m a_lat)^2 / (q * areaM2). */
    inducedDragK: number;
  };
  /** Transonic/supersonic drag rise: Cd x (1 + waveDragRise) near Mach 1, easing above. */
  waveDragRise?: number;
  /** Below this speed after the motor is out, it can no longer manoeuvre, m/s. */
  minSpeedMps?: number;
  /** A retarding tail (ballute) that opens `afterSec` after release, adding `cdA` (Cd x area, m^2). */
  retard?: { afterSec: number; cdA: number };
}

/** One motor burn. */
export interface MotorPhase {
  thrustN: number;
  burnSec: number;
  /** Coast before this burn starts (a second pulse), s. */
  delaySec?: number;
}

/** The motor: one or more burns in order. */
export interface MotorPart {
  phases: MotorPhase[];
  /** Propellant burnt over all phases (the store gets lighter), kg. */
  propellantKg: number;
}

/** How the store steers. */
export interface GuidancePart {
  /** 'pn': proportional navigation on the seeker's / datalink's target; 'none': ballistic. */
  law: 'pn' | 'none';
  /** Navigation constant (pn), typically 3-5. */
  gain?: number;
  /** Autopilot/airframe response time constant, s. */
  autopilotTauSec?: number;
  /** Mid-course climb above the line to the target while far out, deg (0 = none). */
  loftDeg?: number;
  /** Mid-course updates from the launcher's radar track: interval, s, and its angular error, mrad. */
  datalink?: { intervalSec: number; errMrad: number };
  /** Unpowered glide: hold this airspeed on the way (best glide angle `angleDeg`), terminal steering near the target. */
  glide?: { speedMps: number; angleDeg: number };
}

/** The seeker: what the store homes on. */
export type SeekerPart =
  | {
      type: 'ir';
      /** Lock-on field before launch, and gimbal limit in flight, deg (half-angles). */
      acquireDeg: number;
      trackDeg: number;
      gimbalRateRadS: number;
      lockTimeSec: number;
      /** Lock-on range against a non-afterburning fighter, tail-on and head-on, m. */
      rangeTailM: number;
      rangeHeadM: number;
      afterburnerRangeMult: number;
      /** 0..1: chance it ignores a flare. */
      flareResistance?: number;
      /** Line-of-sight noise, mrad (1 sigma), resampled every `noiseUpdateSec`. */
      noiseMrad?: number;
      noiseUpdateSec?: number;
    }
  | {
      type: 'radar';
      /** Furthest it may be fired, m. */
      maxRangeM: number;
      /** Its own seeker takes over inside this range, within this half-angle of its nose. */
      activeRangeM: number;
      activeHalfAngleDeg: number;
      /** Seconds of saturated steering before the shot is judged lost. */
      gSaturationLostSec: number;
      /** 0..1: chance it ignores chaff. */
      chaffResistance?: number;
      /** Surface-to-air: guided by its site's radar; terminal homing needs that radar to keep tracking. */
      siteGuided?: boolean;
      noiseMrad?: number;
      noiseUpdateSec?: number;
    }
  | { type: 'laser'; halfAngleDeg: number; noiseMrad?: number; noiseUpdateSec?: number }
  | { type: 'gps'; errorM: number; noiseUpdateSec?: number }
  | { type: 'arm'; halfAngleDeg: number; maxRangeM: number; memoryErrorM: number; noiseMrad?: number; noiseUpdateSec?: number }
  | { type: 'none' };

/** When it goes off. */
export interface FuzePart {
  /** Distance travelled before it can go off, m. */
  armDistanceM: number;
  /** Air-to-air: goes off at its closest approach when inside this, m. 0 = impact only. */
  proximityM?: number;
  /** 0..1: chance it works when it should. */
  reliability?: number;
}

/** What it does when it goes off. */
export interface WarheadPart {
  /** Structure fraction removed by a hit (gun: per round; missile: before proximity falloff). */
  damageFrac: number;
  /** Explosive charge for blast damage on the ground, kg (absent = no blast). */
  explosiveKg?: number;
  /** Hard-target penetrator. */
  penetrator?: boolean;
  /** Air-to-air kill chance: `pkDirect` at 0 m miss, `pkAtRadius` at `lethalRadiusM`, 0 beyond. */
  kill?: { pkDirect: number; pkAtRadius: number; lethalRadiusM: number };
}

/** Guided air-to-ground weapons: their launch zone cue (DLZ). */
export interface LaunchZonePart {
  rangeSeaLevelM: number;
  rangePerKmAltM: number;
}

/** Air-to-air launch ranges the AI uses (head-on, tail-on, no-escape at ~10 km), m. */
export interface EnvelopePart {
  rMaxHeadOnM: number;
  rMaxTailM: number;
  rNoEscapeM: number;
}

/** A Weapon Lab scenario (src/weaponLab): who fires at what, and in what air. */
export interface LabScenario {
  /** Shown in reports. */
  name: string;
  /** Air-to-air: target range (m), aspect (deg, 180 = head-on, 0 = tail), both at `altM`, Mach `mach`. */
  rangeM?: number;
  aspectDeg?: number;
  altM?: number;
  mach?: number;
  /** Target's manoeuvre: straight, a hard turn at launch (`breakG`), flares every `flareEverySec`. */
  manoeuvre?: 'straight' | 'break' | 'beam';
  breakG?: number;
  flareEverySec?: number;
  chaffEverySec?: number;
  /** Air-to-ground: release at `altM`, `speedMps`, `diveDeg` (+ = nose down), `bankDeg`. */
  speedMps?: number;
  diveDeg?: number;
  bankDeg?: number;
  /** Weather: wind (m/s, blowing towards +x), temperature offset from a standard day (K). */
  windMps?: number;
  tempOffsetK?: number;
}

/** What you expect from a scenario: `npm run weapons-check` fails when the weapon drifts outside it. */
export interface LabTarget {
  scenario: LabScenario;
  /** Fraction of shots that kill (air-to-air), 0..1. */
  minKill?: number;
  maxKill?: number;
  /** Air-to-ground: largest miss from the pipper, m. */
  maxMissM?: number;
  /** Shots to run (default 20). */
  shots?: number;
}

/** A complete weapon (after templates are applied). */
export interface WeaponSpecFull {
  id: string;
  name: string;
  label?: string;
  short?: string;
  kind: WeaponKind;
  carriage: CarriagePart;
  release: ReleasePart;
  airframe: AirframePart;
  motor?: MotorPart;
  guidance?: GuidancePart;
  seeker?: SeekerPart;
  fuze: FuzePart;
  warhead: WarheadPart;
  launchZone?: LaunchZonePart;
  envelope?: EnvelopePart;
  /** Expected behaviour, checked by `npm run weapons-check`. */
  targets?: LabTarget[];
}

type DeepPartial<T> = T extends (infer U)[] ? U[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/**
 * A weapon as authored: `extends` a template (./templates.ts) or another weapon by id, and
 * overrides any part or field. Parts merge field by field; arrays (motor phases, targets) replace.
 */
export type WeaponSpec = DeepPartial<WeaponSpecFull> & { id: string; name: string; extends?: string };
