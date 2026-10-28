/**
 * src/physics/storeBody.ts — a free-flying store (a jettisoned drop tank, and later bombs and
 * rockets) as a 6-DOF rigid body: an axisymmetric slender body under gravity and its own
 * aerodynamics. Nothing is scripted: whether a store weathercocks, wobbles or tumbles comes from
 * where its normal force acts relative to its centre of gravity, its mass and its inertia.
 *
 * Aerodynamics (body frame, +X nose), from the airspeed v_air = vel - wind:
 *   - axial drag:   q S cdAxial cos(alpha), along -X (signed: a store flying tail-first is pushed nose-wards);
 *   - normal force: q S (cnAlpha sin(alpha)|cos(alpha)| + cdCrossflow (L d / S) sin^2(alpha)),
 *     against the crossflow (Jorgensen's slender-body model: linear potential lift plus crossflow
 *     drag, which takes over at high angle of attack and when the body falls broadside);
 *   - the potential part acts at cpOffsetM from the CG, the crossflow part at the planform centroid
 *     (crossflowArmM); their moments turn the body;
 *   - damping: pitch/yaw rate damping (cmq) plus the crossflow drag of a spinning rod
 *     (rho cdCrossflow d L^4 / 64 |w| w, which slows a tumble even at low airspeed); roll damping (clp).
 * Integration: semi-implicit Euler (velocity, then position from the new velocity), Euler's
 * equations for an axisymmetric body (Iy = Iz), quaternion from the new rate; fixed substeps.
 *
 * Pure and allocation-free (module-level scratch). Every coefficient is a game tuning value.
 */
import type { QuatLike, Vec3Like } from '../contracts/core';
import { Quat } from '../math';

/** Position, velocity (world) and attitude, body rates (body frame), as on EntityState. */
export interface StoreBodyState {
  pos: Vec3Like;
  vel: Vec3Like;
  rot: QuatLike;
  omega: Vec3Like;
}

export interface StoreBodyParams {
  massKg: number;
  lengthM: number;
  diameterM: number;
  /** Axial drag coefficient on the frontal area at zero angle of attack. */
  cdAxial: number;
  /** Normal-force slope of the body's potential (linear) lift, per rad, on the frontal area. */
  cnAlpha: number;
  /** Crossflow drag coefficient of the body seen side-on (a cylinder: ~1.2), on L x d. */
  cdCrossflow: number;
  /**
   * Where the potential normal force acts, body X from the CG, m, flying nose-first. Negative =
   * behind the CG (weathercock-stable: fins); positive = ahead (unstable: a finless body).
   */
  cpOffsetM: number;
  /**
   * True: the force stays at that body point when the store flies tail-first (fins). False: it moves
   * to the leading end, mirrored (a finless body is unstable both ways round).
   */
  cpFixed: boolean;
  /** Where the crossflow drag acts, body X from the CG, m (0 = the CG is at mid-length). */
  crossflowArmM: number;
  /** Pitch/yaw damping derivative, on q S L and the reduced rate w L / 2V. */
  cmq: number;
  /** Roll damping derivative, on q S d and p d / 2V. */
  clp: number;
}

export interface StoreBodyEnv {
  densityKgM3: number;
  windWorldMps: Readonly<Vec3Like>;
  gravityMps2: number;
}

/** Substeps per call: keeps a light, fast-tumbling store stable at the sim's 120 Hz. */
export const STORE_BODY_SUBSTEPS = 4;

const vAirW = { x: 0, y: 0, z: 0 };
const vAirB = { x: 0, y: 0, z: 0 };
const forceB = { x: 0, y: 0, z: 0 };
const forceW = { x: 0, y: 0, z: 0 };

/** Axial and transverse moments of inertia of a solid cylinder of this mass and size, kg m^2. */
export function slenderBodyInertia(massKg: number, lengthM: number, diameterM: number): { axial: number; transverse: number } {
  const r = diameterM / 2;
  return { axial: 0.5 * massKg * r * r, transverse: (massKg * (3 * r * r + lengthM * lengthM)) / 12 };
}

/** Advances `s` by `dtSec` in place. */
export function stepStoreBody(s: StoreBodyState, p: Readonly<StoreBodyParams>, env: Readonly<StoreBodyEnv>, dtSec: number): void {
  const dt = dtSec / STORE_BODY_SUBSTEPS;
  const inertia = slenderBodyInertia(p.massKg, p.lengthM, p.diameterM);
  const ix = inertia.axial;
  const it = inertia.transverse;
  const S = (Math.PI * p.diameterM * p.diameterM) / 4;
  const planform = p.lengthM * p.diameterM;
  const rho = env.densityKgM3;
  const L = p.lengthM;
  const d = p.diameterM;
  for (let k = 0; k < STORE_BODY_SUBSTEPS; k++) {
    vAirW.x = s.vel.x - env.windWorldMps.x;
    vAirW.y = s.vel.y - env.windWorldMps.y;
    vAirW.z = s.vel.z - env.windWorldMps.z;
    Quat.rotateInverse(s.rot, vAirW, vAirB);
    const V = Math.hypot(vAirB.x, vAirB.y, vAirB.z);
    const q = 0.5 * rho * V * V;
    forceB.x = 0;
    forceB.y = 0;
    forceB.z = 0;
    let my = 0;
    let mz = 0;
    let mx = 0;
    if (V > 0.5) {
      const cosA = vAirB.x / V;
      const vc = Math.hypot(vAirB.y, vAirB.z);
      const sinA = vc / V;
      forceB.x = -q * S * p.cdAxial * cosA;
      if (vc > 1e-6) {
        // Unit crossflow direction (the normal force pushes against it).
        const uy = vAirB.y / vc;
        const uz = vAirB.z / vc;
        const fPot = q * S * p.cnAlpha * sinA * Math.abs(cosA);
        const fCross = q * planform * p.cdCrossflow * sinA * sinA;
        forceB.y = -(fPot + fCross) * uy;
        forceB.z = -(fPot + fCross) * uz;
        // Moments of forces along -u applied at body x: r x F = (0, -x Fz, x Fy).
        const xPot = p.cpFixed || cosA >= 0 ? p.cpOffsetM : -p.cpOffsetM;
        const xCross = p.crossflowArmM;
        my += -(xPot * -fPot * uz + xCross * -fCross * uz);
        mz += xPot * -fPot * uy + xCross * -fCross * uy;
      }
      // Rate damping (pitch/yaw about Y and Z; roll about X).
      const kq = q * S * L * p.cmq * (L / (2 * V));
      my -= kq * s.omega.y;
      mz -= kq * s.omega.z;
      mx -= q * S * d * p.clp * (d / (2 * V)) * s.omega.x;
    }
    // A spinning rod's own crossflow drag: slows a tumble whatever the airspeed.
    const kRot = (rho * p.cdCrossflow * d * L * L * L * L) / 64;
    const wt = Math.hypot(s.omega.y, s.omega.z);
    my -= kRot * wt * s.omega.y;
    mz -= kRot * wt * s.omega.z;

    // Translation.
    Quat.rotate(s.rot, forceB, forceW);
    s.vel.x += (forceW.x / p.massKg) * dt;
    s.vel.y += (forceW.y / p.massKg - env.gravityMps2) * dt;
    s.vel.z += (forceW.z / p.massKg) * dt;
    s.pos.x += s.vel.x * dt;
    s.pos.y += s.vel.y * dt;
    s.pos.z += s.vel.z * dt;

    // Rotation: Euler's equations with Iy = Iz = it.
    const wx = s.omega.x, wy = s.omega.y, wz = s.omega.z;
    s.omega.x = wx + (mx / ix) * dt;
    s.omega.y = wy + ((my - (ix - it) * wz * wx) / it) * dt;
    s.omega.z = wz + ((mz - (it - ix) * wx * wy) / it) * dt;
    Quat.integrate(s.rot, s.omega, dt, s.rot);
  }
}
