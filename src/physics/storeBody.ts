/**
 * src/physics/storeBody.ts — a free-flying store (a jettisoned drop tank, a free-fall bomb, a
 * rocket) as a 6-DOF rigid body: an axisymmetric slender body under gravity and its own
 * aerodynamics. Nothing is scripted: whether a store weathercocks, wobbles or tumbles comes from
 * where its normal force acts relative to its centre of gravity, its mass and its inertia.
 *
 * Aerodynamics (body frame, +X nose), from the airspeed v_air = vel - wind:
 *   - axial drag:   q S cdAxial cos(alpha), along -X (signed: a store flying tail-first is pushed nose-wards),
 *     rising through the sound barrier (machDragRise);
 *   - normal force: q S (cnAlpha sin(alpha)|cos(alpha)| + cdCrossflow (L d / S) sin^2(alpha)),
 *     against the crossflow (Jorgensen's slender-body model: linear potential lift plus crossflow
 *     drag, which takes over at high angle of attack and when the body falls broadside);
 *   - the potential part acts at cpOffsetM from the CG, the crossflow part at the planform centroid
 *     (crossflowArmM); their moments turn the body;
 *   - a trailing drag device (a retarded bomb's ballute): q trailingCdA along the airflow, pulling
 *     at trailingArmM behind the CG, so it also holds the body into the airflow;
 *   - motor thrust (a rocket) along +X;
 *   - damping: pitch/yaw rate damping (cmq) plus the crossflow drag of a spinning rod
 *     (rho cdCrossflow d L^4 / 64 |w| w, which slows a tumble even at low airspeed); roll damping (clp).
 * Integration: velocity by Euler, position from the mean of the old and new velocity (second order
 * under steady forces such as gravity, so a coarse step lands where a fine one does), Euler's
 * equations for an axisymmetric body (Iy = Iz), quaternion from the new rate; fixed substeps.
 *
 * Pure and allocation-free (module-level scratch). Every coefficient is a game tuning value.
 */
import type { FreeBodyEnv, FreeBodyParams, FreeBodyState, StepFreeBody } from '../contracts/combat';
import { Quat } from '../math';

/** Position, velocity (world) and attitude, body rates (body frame, rad/s), as on EntityState. */
export type StoreBodyState = FreeBodyState;
export type StoreBodyParams = FreeBodyParams;
export type StoreBodyEnv = FreeBodyEnv;

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

/** The transonic drag rise: 1 below Mach 0.85, up to 1 + rise by Mach 1.1, easing off supersonic. */
export function machDragFactor(mach: number, rise: number): number {
  if (rise <= 0 || mach < 0.85) return 1;
  if (mach < 1.1) return 1 + (rise * (mach - 0.85)) / 0.25;
  return 1 + rise * Math.max(0.4, 1 - (mach - 1.1) * 0.3);
}

/** Advances `s` by `dtSec` in place. */
export const stepStoreBody: StepFreeBody = (s, p, env, dtSec) => {
  const dt = dtSec / STORE_BODY_SUBSTEPS;
  const r = p.diameterM / 2;
  const ix = 0.5 * p.massKg * r * r;
  const it = (p.massKg * (3 * r * r + p.lengthM * p.lengthM)) / 12;
  const S = (Math.PI * p.diameterM * p.diameterM) / 4;
  const planform = p.lengthM * p.diameterM;
  const rho = env.densityKgM3;
  const L = p.lengthM;
  const d = p.diameterM;
  const rise = p.machDragRise ?? 0;
  const trailCdA = p.trailingCdA ?? 0;
  const trailArm = p.trailingArmM ?? 0;
  const thrust = p.thrustN ?? 0;
  for (let k = 0; k < STORE_BODY_SUBSTEPS; k++) {
    vAirW.x = s.vel.x - env.windWorldMps.x;
    vAirW.y = s.vel.y - env.windWorldMps.y;
    vAirW.z = s.vel.z - env.windWorldMps.z;
    Quat.rotateInverse(s.rot, vAirW, vAirB);
    const V = Math.hypot(vAirB.x, vAirB.y, vAirB.z);
    const q = 0.5 * rho * V * V;
    forceB.x = thrust;
    forceB.y = 0;
    forceB.z = 0;
    let my = 0;
    let mz = 0;
    let mx = 0;
    if (V > 0.5) {
      const cosA = vAirB.x / V;
      const vc = Math.hypot(vAirB.y, vAirB.z);
      const sinA = vc / V;
      const cdA = rise > 0 && env.soundSpeedMps ? p.cdAxial * machDragFactor(V / env.soundSpeedMps, rise) : p.cdAxial;
      forceB.x -= q * S * cdA * cosA;
      if (vc > 1e-6) {
        // Unit crossflow direction (the normal force pushes against it).
        const uy = vAirB.y / vc;
        const uz = vAirB.z / vc;
        const fPot = q * S * p.cnAlpha * sinA * Math.abs(cosA);
        const fCross = q * planform * p.cdCrossflow * sinA * sinA;
        forceB.y -= (fPot + fCross) * uy;
        forceB.z -= (fPot + fCross) * uz;
        // Moments of forces along -u applied at body x: r x F = (0, -x Fz, x Fy).
        const xPot = p.cpFixed || cosA >= 0 ? p.cpOffsetM : -p.cpOffsetM;
        const xCross = p.crossflowArmM;
        my += -(xPot * -fPot * uz + xCross * -fCross * uz);
        mz += xPot * -fPot * uy + xCross * -fCross * uy;
      }
      if (trailCdA > 0) {
        // The ballute: drag along the airflow it meets at the end of its risers (the body's own
        // rotation swings it through the air, which damps the swing).
        const bx = vAirB.x, by = vAirB.y + s.omega.z * trailArm, bz = vAirB.z - s.omega.y * trailArm;
        const vb = Math.hypot(bx, by, bz);
        const f = 0.5 * rho * vb * trailCdA;
        const fx = -f * bx, fy = -f * by, fz = -f * bz;
        forceB.x += fx;
        forceB.y += fy;
        forceB.z += fz;
        my -= trailArm * fz;
        mz += trailArm * fy;
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

    // Translation: position from the mean of the old and new velocity.
    Quat.rotate(s.rot, forceB, forceW);
    const vx0 = s.vel.x, vy0 = s.vel.y, vz0 = s.vel.z;
    s.vel.x += (forceW.x / p.massKg) * dt;
    s.vel.y += (forceW.y / p.massKg - env.gravityMps2) * dt;
    s.vel.z += (forceW.z / p.massKg) * dt;
    s.pos.x += (vx0 + s.vel.x) * 0.5 * dt;
    s.pos.y += (vy0 + s.vel.y) * 0.5 * dt;
    s.pos.z += (vz0 + s.vel.z) * 0.5 * dt;

    // Rotation: Euler's equations with Iy = Iz = it.
    const wx = s.omega.x, wy = s.omega.y, wz = s.omega.z;
    s.omega.x = wx + (mx / ix) * dt;
    s.omega.y = wy + ((my - (ix - it) * wz * wx) / it) * dt;
    s.omega.z = wz + ((mz - (it - ix) * wx * wy) / it) * dt;
    Quat.integrate(s.rot, s.omega, dt, s.rot);
  }
};
