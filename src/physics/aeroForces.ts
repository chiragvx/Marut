/**
 * src/physics/aeroForces.ts — airspeed/alpha/beta/dynamic-pressure
 * computation (4.3), and the CL/CD/CY/Cl/Cm/Cn buildup into body-frame
 * force/moment, including control-derivative, damping-derivative and
 * ground-effect terms (4.4, 4.5).
 * See docs/spec/02-flight-model.md sections 4.3-4.5.
 *
 * Allocation-free: all scratch Vec3s are module-level, reused every call.
 * `computeAirspeedFrame` is shared with telemetry.ts (4.11 recomputes the
 * same quantities from `state` instead of `out`).
 */
import type { QuatLike, Vec3Like } from '../contracts/core';
import type { AircraftDefinition } from '../contracts/aircraft';
import { MIN_AIRSPEED_FOR_AERO_MPS } from '../contracts/flight';
import { Vec3, Quat, clamp, smoothstep } from '../math';
import { bodyRateP, bodyRateQ, bodyRateR } from '../math';
import { interpolate2D } from '../math';

export interface AirspeedFrame {
  alpha: number;
  beta: number;
  Vt: number;
  mach: number;
  qBar: number;
}

const scratchVAirWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchVAirBody: Vec3Like = { x: 0, y: 0, z: 0 };

/**
 * Computes airspeed/alpha/beta/dynamic-pressure/mach from a velocity,
 * orientation and wind, per 00-architecture.md section 3.5 / this module's
 * section 4.3. Pure, allocation-free.
 */
export function computeAirspeedFrame(
  vel: Readonly<Vec3Like>,
  rot: Readonly<QuatLike>,
  windWorldMps: Readonly<Vec3Like>,
  airDensityKgM3: number,
  soundSpeedMps: number,
  out: AirspeedFrame
): AirspeedFrame {
  Vec3.sub(vel, windWorldMps, scratchVAirWorld);
  Quat.rotateInverse(rot, scratchVAirWorld, scratchVAirBody);
  const Vt = Vec3.length(scratchVAirBody);
  out.Vt = Vt;
  out.mach = soundSpeedMps > 0 ? Vt / soundSpeedMps : 0;
  if (Vt < MIN_AIRSPEED_FOR_AERO_MPS) {
    out.alpha = 0;
    out.beta = 0;
    out.qBar = 0;
  } else {
    out.alpha = Math.atan2(-scratchVAirBody.y, scratchVAirBody.x);
    out.beta = Math.asin(clamp(scratchVAirBody.z / Vt, -1, 1));
    out.qBar = 0.5 * airDensityKgM3 * Vt * Vt;
  }
  return out;
}

export interface AeroOutput {
  forceBody: Vec3Like;
  momentBody: Vec3Like;
}

/**
 * Builds body-frame aero force + moment (4.4/4.5) from this substep's
 * airspeed frame, control-surface deflections and body rates. `altAglM` is
 * `out.pos.y - env.groundElevationM` (ground effect). Allocation-free.
 */
export function computeAeroForceMoment(
  frame: Readonly<AirspeedFrame>,
  elevonL: number,
  elevonR: number,
  rudder: number,
  omega: Readonly<Vec3Like>,
  altAglM: number,
  def: AircraftDefinition,
  out: AeroOutput
): AeroOutput {
  const aero = def.aero;
  const elevonSym = (elevonL + elevonR) / 2;

  // 4.4 — force buildup.
  const groundEffectMultiplier = 1 + aero.groundEffectMaxDeltaCL * (1 - smoothstep(0, 1, altAglM / def.wingSpanM));
  const CL = (interpolate2D(aero.CL, frame.alpha, frame.mach) + aero.CL_elevon * elevonSym) * groundEffectMultiplier;
  const CD = interpolate2D(aero.CD, frame.alpha, frame.mach) + aero.CD_elevon * Math.abs(elevonSym);
  const CY = aero.CY_beta * frame.beta + aero.CY_rudder * rudder;

  const D = CD * frame.qBar * def.wingAreaM2;
  const L = CL * frame.qBar * def.wingAreaM2;
  const Y = CY * frame.qBar * def.wingAreaM2;

  const ca = Math.cos(frame.alpha);
  const sa = Math.sin(frame.alpha);
  const cb = Math.cos(frame.beta);
  const sb = Math.sin(frame.beta);

  out.forceBody.x = -D * ca * cb - Y * ca * sb + L * sa;
  out.forceBody.y = D * sa * cb + Y * sa * sb + L * ca;
  out.forceBody.z = -D * sb + Y * cb;

  // 4.5 — moment buildup (non-dimensional rates, guarded against Vt=0).
  const p = bodyRateP(omega);
  const q = bodyRateQ(omega);
  const r = bodyRateR(omega);
  let pHat = 0;
  let qHat = 0;
  let rHat = 0;
  if (frame.Vt >= MIN_AIRSPEED_FOR_AERO_MPS) {
    const invTwoVt = 1 / (2 * frame.Vt);
    pHat = p * def.wingSpanM * invTwoVt;
    qHat = q * def.meanChordM * invTwoVt;
    rHat = r * def.wingSpanM * invTwoVt;
  }
  const elevonDiff = elevonL - elevonR;

  const ClStd = aero.Cl_beta * frame.beta + aero.Cl_p * pHat + aero.Cl_r * rHat + aero.Cl_elevon * elevonDiff + aero.Cl_rudder * rudder;
  const CmStd = interpolate2D(aero.Cm, frame.alpha, frame.mach) + aero.Cm_elevon * elevonSym + aero.Cm_q * qHat;
  const CnStd = aero.Cn_beta * frame.beta + aero.Cn_p * pHat + aero.Cn_r * rHat + aero.Cn_elevon * elevonDiff + aero.Cn_rudder * rudder;

  const Lmom = ClStd * frame.qBar * def.wingAreaM2 * def.wingSpanM;
  const Mmom = CmStd * frame.qBar * def.wingAreaM2 * def.meanChordM;
  const Nmom = CnStd * frame.qBar * def.wingAreaM2 * def.wingSpanM;

  out.momentBody.x = Lmom;
  out.momentBody.z = Mmom;
  out.momentBody.y = -Nmom;

  return out;
}
