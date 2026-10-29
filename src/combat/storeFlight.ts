/**
 * src/combat/storeFlight.ts — free-fall bombs and rockets as rigid bodies: the FreeBodyParams a
 * store with an airframe (WeaponProfile.airframe) flies with at a given age, and its release
 * state. Shared by the flight (stepProjectile) and the air-to-ground sight (predictImpact), so
 * the pipper predicts exactly the store that is released.
 *
 * The integrator itself lives in src/physics (stepStoreBody) and reaches this module through
 * CombatEnvironment.stepFreeBody (src/core injects it; combat imports only contracts and math).
 *
 * At release: a bomb starts at its pylon frame's attitude and body rates, pushed off the rack
 * with a nose-down kick from the ejector; from there its fins weathercock it into the airflow
 * (a short pitch wobble that damps out). A retarded bomb's ballute inflates over
 * BALLUTE_INFLATE_SEC once it opens. A rocket leaves along its tube, thrusts along its own nose
 * and turns into the airflow while it burns. Allocation-free.
 */
import type { Vec3Like } from '../contracts/core';
import type { FreeBodyParams, ProjectileKind, WeaponProfile } from '../contracts/combat';

/** Crossflow drag of a bomb or rocket body seen side-on. */
const BODY_CD_CROSSFLOW = 1.2;
/** A ballute takes this long to fill once its tail opens, s. */
export const BALLUTE_INFLATE_SEC = 0.15;
/** The ballute pulls this far behind the tail on its risers, m. */
const BALLUTE_RISER_M = 1.0;
/** The rack's ejector pitches a bomb nose-down as it pushes it clear, rad/s (body rate). */
export const BOMB_EJECT_PITCH_RAD_S = 0.25;
/** Gap between the pylon and the top of a bomb hung on it, m (the render mount). */
export const BOMB_PYLON_GAP_M = 0.05;

/** True for the stores flown as rigid bodies: free-fall bombs and rockets with an airframe. */
export function isRigidStore(kind: ProjectileKind | WeaponProfile['kind'], p: WeaponProfile | undefined): boolean {
  return !!p?.airframe && (kind === 'bomb' || kind === 'rocket');
}

/** Speed of sound by altitude (the same lapse the missiles' wave drag uses), m/s. */
export function soundSpeedAt(altM: number): number {
  return Math.max(295, 340.3 - 0.0041 * altM);
}

/**
 * Writes the params store `p` flies with over the step from age `ageSec` to `ageSec + dtSec`:
 * the motor's thrust is its mean over the step (so the burnout falls between ticks the same way
 * for any step length), and a ballute's drag grows as it inflates.
 */
export function freeBodyParamsInto(p: WeaponProfile, ageSec: number, dtSec: number, out: FreeBodyParams): FreeBodyParams {
  const a = p.airframe!;
  out.massKg = p.projectileMassKg;
  out.lengthM = a.lengthM;
  out.diameterM = a.diameterM;
  out.cdAxial = p.dragCoeff;
  out.machDragRise = a.machDragRise;
  out.cnAlpha = a.cnAlpha;
  out.cdCrossflow = BODY_CD_CROSSFLOW;
  out.cpOffsetM = a.cpOffsetM;
  out.cpFixed = true;
  out.crossflowArmM = 0;
  out.cmq = a.cmq;
  out.clp = a.clp;
  const b = p.bomb;
  if (b) {
    const t = ageSec + dtSec / 2;
    const fill = (t - b.retardAfterSec) / BALLUTE_INFLATE_SEC;
    out.trailingCdA = b.retardCdA * (fill <= 0 ? 0 : fill >= 1 ? 1 : fill);
    out.trailingArmM = -(a.lengthM / 2 + BALLUTE_RISER_M);
  } else {
    out.trailingCdA = 0;
    out.trailingArmM = 0;
  }
  const burn = p.motorBurnSec;
  const onFrac = burn > 0 ? Math.max(0, Math.min(1, (burn - ageSec) / dtSec)) : 0;
  out.thrustN = p.motorThrustN * onFrac;
  return out;
}

/** A fresh params object (init-time). */
export function createFreeBodyParams(): FreeBodyParams {
  return {
    massKg: 1, lengthM: 1, diameterM: 0.1, cdAxial: 0, machDragRise: 0, cnAlpha: 0, cdCrossflow: BODY_CD_CROSSFLOW,
    cpOffsetM: 0, cpFixed: true, crossflowArmM: 0, cmq: 0, clp: 0, trailingCdA: 0, trailingArmM: 0, thrustN: 0,
  };
}

/** The ballute is open (for the renderer). */
export function balluteOpen(p: WeaponProfile, ageSec: number): boolean {
  return !!p.bomb && ageSec >= p.bomb.retardAfterSec;
}

/** Where a store leaves from, aircraft body frame: a bomb from its own centre below the pylon (where it hangs), anything else from the station. */
export function releasePointBodyInto(p: WeaponProfile, stationBodyM: Readonly<Vec3Like>, out: Vec3Like): Vec3Like {
  out.x = stationBodyM.x;
  out.y = stationBodyM.y;
  out.z = stationBodyM.z;
  if (p.kind === 'bomb' && p.airframe) out.y -= BOMB_PYLON_GAP_M + p.airframe.diameterM / 2;
  return out;
}

/** A store's body rates at release: the aircraft's, and a bomb's ejector kick nose-down. */
export function releaseRatesInto(p: WeaponProfile, aircraftOmegaBody: Readonly<Vec3Like>, out: Vec3Like): Vec3Like {
  out.x = aircraftOmegaBody.x;
  out.y = aircraftOmegaBody.y;
  out.z = aircraftOmegaBody.z;
  if (p.kind === 'bomb' && p.airframe) out.z -= BOMB_EJECT_PITCH_RAD_S;
  return out;
}
