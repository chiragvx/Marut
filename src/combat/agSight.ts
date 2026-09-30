/**
 * src/combat/agSight.ts — the air-to-ground weapon sight: where the selected free-flying store
 * (bomb, rocket, or gun round) would hit if released now (CCIP), and for a designated ground point
 * (the SPI, "sensor point of interest") the release solution (CCRP): seconds to go until the
 * predicted impact reaches it along track, and how far it lies off to the side.
 *
 * The prediction integrates the same physics stepProjectile flies (drag with ISA density, gravity,
 * motor thrust, a bomb's retarding tail) in coarse steps until the path meets the terrain, so the
 * pipper is honest about retarded bombs, rockets' motors, and high releases.
 *
 * Designation: in air-to-ground mode the target key (T) designates the pipper's point as the SPI
 * (dive-toss style: put the pipper on the target, press T, pull up and hold release); a targeting
 * pod or a mission steerpoint can set it too. Allocation-free.
 */
import type { HeightSampler, Vec3Like } from '../contracts/core';
import type { WeaponProfile } from '../contracts/combat';

/** Integration step of the prediction, s, and the longest fall it follows. */
const PREDICT_DT_SEC = 0.05;
const PREDICT_MAX_SEC = 90;

export interface AgSightResult {
  valid: boolean;
  /** Predicted impact point, world m. */
  impact: Vec3Like;
  /** Time of flight to it, s. */
  tofSec: number;
}

const GRAVITY = 9.80665;

/**
 * Predicts where store `p` released now from an aircraft at `pos` with velocity `vel` and nose
 * direction `fwd` would meet the ground. Bombs drop off the pylon (launchSpeed down); rockets and
 * gun rounds leave along the nose (launchSpeed forward). Writes `out`; returns it.
 */
export function predictImpact(p: WeaponProfile, pos: Vec3Like, vel: Vec3Like, fwd: Vec3Like, sampler: HeightSampler, densityAt: (altM: number) => number, out: AgSightResult): AgSightResult {
  let x = pos.x, y = pos.y, z = pos.z;
  let vx = vel.x, vy = vel.y, vz = vel.z;
  if (p.kind === 'bomb') {
    vy -= p.launchSpeedMps;
  } else {
    vx += fwd.x * p.launchSpeedMps;
    vy += fwd.y * p.launchSpeedMps;
    vz += fwd.z * p.launchSpeedMps;
  }
  const dt = PREDICT_DT_SEC;
  let ground = sampler.heightAt(x, z);
  out.valid = false;
  // No further than the store flies (a gun round self-destructs after its lifetime).
  const maxT = Math.min(PREDICT_MAX_SEC, p.maxLifetimeSec);
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
    vx += ax * dt;
    vy += ay * dt;
    vz += az * dt;
    const nx = x + vx * dt, ny = y + vy * dt, nz = z + vz * dt;
    // The terrain is re-sampled every step once near it (every 8th step while well above it).
    const stepIndex = Math.round(t / dt);
    if (ny - ground < 300 || stepIndex % 8 === 0) ground = sampler.heightAt(nx, nz);
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
