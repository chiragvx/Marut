/**
 * src/combat/agSight.ts — the air-to-ground weapon sight: where the selected free-flying store
 * (bomb, rocket, or gun round) would hit if released now (CCIP), and for a designated ground point
 * (the SPI, "sensor point of interest") the release solution (CCRP): seconds to go until the
 * predicted impact reaches it along track, and how far it lies off to the side.
 *
 * The prediction integrates the same physics stepProjectile flies (drag with ISA density, gravity,
 * motor thrust, a bomb's retarding tail) in coarse steps until the path meets the terrain, so the
 * pipper is honest about retarded bombs, rockets' motors, and high releases. Bombs and rockets
 * with an airframe are flown as the same rigid body they fly as (attitude, fins, wind; see
 * storeFlight.ts), from the aircraft's attitude and rates at release.
 *
 * Designation: in air-to-ground mode the target key (T) designates the pipper's point as the SPI
 * (dive-toss style: put the pipper on the target, press T, pull up and hold release); a targeting
 * pod or a mission steerpoint can set it too. Allocation-free.
 */
import type { HeightSampler, QuatLike, Vec3Like } from '../contracts/core';
import type { FreeBodyEnv, FreeBodyState, StepFreeBody, WeaponProfile } from '../contracts/combat';
import { createFreeBodyParams, freeBodyParamsInto, isRigidStore, soundSpeedAt } from './storeFlight';

/** Integration step of the prediction, s, and the longest fall it follows. */
const PREDICT_DT_SEC = 0.05;
/** Re-sample the terrain every step within this height of it (every 4th step above). */
const TERRAIN_NEAR_M = 1500;
const PREDICT_MAX_SEC = 90;

export interface AgSightResult {
  valid: boolean;
  /** Predicted impact point, world m. */
  impact: Vec3Like;
  /** Time of flight to it, s. */
  tofSec: number;
}

const GRAVITY = 9.80665;
/** Step of the rigid-body prediction for rockets (they weathercock fast while the motor burns), s. */
const PREDICT_ROCKET_DT_SEC = 1 / 60;

/** A rigid-body store's release: the aircraft's attitude and body rates, the integrator, and the wind. */
export interface RigidRelease {
  rot: QuatLike;
  /** The store's body rates at release (the aircraft's, plus an ejector's kick), rad/s. */
  omegaBody: Vec3Like;
  step: StepFreeBody;
  windWorldMps: Readonly<Vec3Like>;
}

const _body: FreeBodyState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, omega: { x: 0, y: 0, z: 0 } };
const _bodyParams = createFreeBodyParams();
const _bodyEnv: FreeBodyEnv = { densityKgM3: 1.225, soundSpeedMps: 340.3, windWorldMps: { x: 0, y: 0, z: 0 }, gravityMps2: GRAVITY };

/**
 * Predicts where store `p` released now from an aircraft at `pos` with velocity `vel` and nose
 * direction `fwd` would meet the ground. `pos` should be the store's own station (the release
 * point). Bombs are ejected along `down` (the aircraft's body down; world down when omitted);
 * rockets and gun rounds leave along the nose (launchSpeed forward). With `rigid`, a bomb or rocket
 * with an airframe flies as a rigid body from that release. Writes `out`; returns it.
 *
 * Positions advance with the step's mean velocity, which matches stepProjectile's fine-step flight
 * to well under a metre (plain Euler at this coarse step lands several metres short).
 */
export function predictImpact(p: WeaponProfile, pos: Vec3Like, vel: Vec3Like, fwd: Vec3Like, sampler: HeightSampler, densityAt: (altM: number) => number, out: AgSightResult, down?: Vec3Like, rigid?: RigidRelease): AgSightResult {
  let x = pos.x, y = pos.y, z = pos.z;
  let vx = vel.x, vy = vel.y, vz = vel.z;
  if (p.kind === 'bomb') {
    if (down) {
      vx += down.x * p.launchSpeedMps;
      vy += down.y * p.launchSpeedMps;
      vz += down.z * p.launchSpeedMps;
    } else {
      vy -= p.launchSpeedMps;
    }
  } else {
    vx += fwd.x * p.launchSpeedMps;
    vy += fwd.y * p.launchSpeedMps;
    vz += fwd.z * p.launchSpeedMps;
  }
  let ground = sampler.heightAt(x, z);
  out.valid = false;
  // No further than the store flies (a gun round self-destructs after its lifetime).
  const maxT = Math.min(PREDICT_MAX_SEC, p.maxLifetimeSec);
  if (rigid && isRigidStore(p.kind, p)) {
    const b = _body;
    b.pos.x = x; b.pos.y = y; b.pos.z = z;
    b.vel.x = vx; b.vel.y = vy; b.vel.z = vz;
    b.rot.x = rigid.rot.x; b.rot.y = rigid.rot.y; b.rot.z = rigid.rot.z; b.rot.w = rigid.rot.w;
    b.omega.x = rigid.omegaBody.x; b.omega.y = rigid.omegaBody.y; b.omega.z = rigid.omegaBody.z;
    _bodyEnv.windWorldMps = rigid.windWorldMps;
    const rdt = p.motorBurnSec > 0 ? PREDICT_ROCKET_DT_SEC : PREDICT_DT_SEC;
    const steps = Math.ceil(maxT / rdt);
    for (let i = 0; i < steps; i++) {
      const t = i * rdt;
      freeBodyParamsInto(p, t, rdt, _bodyParams);
      _bodyEnv.densityKgM3 = densityAt(b.pos.y);
      _bodyEnv.soundSpeedMps = soundSpeedAt(b.pos.y);
      x = b.pos.x; y = b.pos.y; z = b.pos.z;
      rigid.step(b, _bodyParams, _bodyEnv, rdt);
      const nx = b.pos.x, ny = b.pos.y, nz = b.pos.z;
      if (ny - ground < TERRAIN_NEAR_M || i % 4 === 0) ground = sampler.heightAt(nx, nz);
      if (ny <= ground) {
        const f = (y - ground) / Math.max(1e-6, y - ny);
        out.impact.x = x + (nx - x) * f;
        out.impact.y = ground;
        out.impact.z = z + (nz - z) * f;
        out.tofSec = t + rdt * f;
        out.valid = true;
        return out;
      }
    }
    return out;
  }
  const dt = PREDICT_DT_SEC;
  for (let t = 0; t < maxT; t += dt) {
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const rho = densityAt(y);
    let cdA = p.dragCoeff * p.crossSectionM2;
    if (p.bomb && t >= p.bomb.retardAfterSec) cdA += p.bomb.retardCdA;
    let ax = 0, ay = -GRAVITY, az = 0;
    if (speed > 1e-6) {
      const drag = (0.5 * rho * speed * speed * cdA) / p.projectileMassKg;
      const thrust = t < p.motorBurnSec ? p.motorThrustN / p.projectileMassKg : 0;
      const k = (thrust - drag) / speed;
      ax += vx * k;
      ay += vy * k;
      az += vz * k;
    }
    const nvx = vx + ax * dt, nvy = vy + ay * dt, nvz = vz + az * dt;
    const nx = x + (vx + nvx) * 0.5 * dt, ny = y + (vy + nvy) * 0.5 * dt, nz = z + (vz + nvz) * 0.5 * dt;
    vx = nvx;
    vy = nvy;
    vz = nvz;
    // The terrain is re-sampled every step once near it (every 4th step while well above it).
    const stepIndex = Math.round(t / dt);
    if (ny - ground < TERRAIN_NEAR_M || stepIndex % 4 === 0) ground = sampler.heightAt(nx, nz);
    if (ny <= ground) {
      // Interpolate to the crossing.
      const f = (y - ground) / Math.max(1e-6, y - ny);
      out.impact.x = x + (nx - x) * f;
      out.impact.y = ground;
      out.impact.z = z + (nz - z) * f;
      out.tofSec = t + dt * f;
      out.valid = true;
      return out;
    }
    x = nx;
    y = ny;
    z = nz;
  }
  return out;
}

export interface CcrpSolution {
  /** Seconds until release (<= 0: the release point has been reached or passed). */
  timeToReleaseSec: number;
  /** Cross-track error, m: + = the SPI lies to the right of the predicted impact's track. */
  crossTrackM: number;
}

/**
 * CCRP from the current prediction: the SPI's along-track distance beyond the predicted impact,
 * over the ground speed, is the time to release; its sideways offset is the steering error.
 */
export function ccrpSolution(predicted: Vec3Like, spi: Vec3Like, vel: Vec3Like, out: CcrpSolution): CcrpSolution {
  const gs = Math.hypot(vel.x, vel.z);
  if (gs < 1) {
    out.timeToReleaseSec = Infinity;
    out.crossTrackM = 0;
    return out;
  }
  const ux = vel.x / gs, uz = vel.z / gs;
  const dx = spi.x - predicted.x, dz = spi.z - predicted.z;
  const along = dx * ux + dz * uz;
  // Track (ux, uz) with +x east, +z south: its right-hand side is (-uz, ux) (heading h: forward
  // (sin h, -cos h), right (cos h, sin h)).
  out.crossTrackM = -dx * uz + dz * ux;
  out.timeToReleaseSec = along / gs;
  return out;
}
