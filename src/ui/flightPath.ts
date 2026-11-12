/**
 * src/ui/flightPath.ts — believable flight for the cinematic shots (src/ui/reel.ts): a point-mass
 * jet flown by a roll rate and a load factor, with gravity, thrust and drag, so a pull curves the
 * flight path (and bleeds speed), the nose rides above the path by its angle of attack, an unloaded
 * jet sags, and rolls and pulls build up and settle through lags rather than switching on. A little
 * turbulence keeps the jet from looking pinned to a rail.
 *
 * The whole flight is integrated once (240 Hz) when the shot is built and sampled per frame; the
 * camera ship is a critically damped spring chasing where the shot wants it, so it lags a fast jet
 * as a real one would.
 */
import type { QuatLike, Vec3Like } from '../contracts/core';
import type { ShowcaseAircraft } from '../contracts/render';
import { Quat } from '../math';

const G = 9.81;
const HZ = 240;
const deg = Math.PI / 180;

export const smooth01 = (x: number): number => {
  const u = Math.min(1, Math.max(0, x));
  return u * u * (3 - 2 * u);
};
/** 0 → 1 → 0 over [a, b], a smooth bell (area (b - a) / 2). */
export const bell = (t: number, a: number, b: number): number => (t <= a || t >= b ? 0 : 0.5 - 0.5 * Math.cos((2 * Math.PI * (t - a)) / (b - a)));
/** A rate (rad/s) whose bell over [a, b] turns through `angle` rad in total. */
export const bellRate = (t: number, a: number, b: number, angle: number): number => ((2 * angle) / (b - a)) * bell(t, a, b);

/** What a command function sees. */
export interface FlightState {
  t: number;
  pos: Vec3Like;
  /** Speed, m/s, and the flight path angle, rad. */
  speed: number;
  gamma: number;
  /** Unit vectors: along the path, the lift direction (body up without the AoA) and the right wing. */
  u: Vec3Like;
  lift: Vec3Like;
  right: Vec3Like;
  /** Bank angle, rad (+ right wing down). */
  bank: number;
}

export interface FlightPlan {
  start: Vec3Like;
  headingRad: number;
  /** Initial flight path angle and bank, rad. */
  gammaRad?: number;
  bankRad?: number;
  speed: number;
  durationSec: number;
  /** Commanded roll rate, rad/s (+ right wing down). */
  roll?: (t: number, s: FlightState) => number;
  /** Commanded load factor, g. Default: hold the current flight path angle. */
  load?: (t: number, s: FlightState) => number;
  /** Afterburner (true), else the throttle 0..1 of military power. */
  afterburner?: (t: number) => boolean;
  throttle?: (t: number) => number;
  /** Engines hold the starting speed (whatever the manoeuvre) instead of thrust minus drag. */
  holdSpeed?: boolean;
  /** Turbulence scale (1 = light chop) and its seed. */
  turbulence?: number;
  seed?: number;
}

/** Load factor that holds the flight path angle at `target` (rad), banked or not. */
export function holdGamma(s: FlightState, target: number, k = 1.2): number {
  const cosPhi = Math.max(0.15, s.lift.y / Math.max(0.2, Math.cos(s.gamma)));
  return Math.min(9, Math.max(-2, (Math.cos(s.gamma) + (k * s.speed * (target - s.gamma)) / G / 4) / cosPhi));
}

/** Smooth, deterministic noise in about [-1, 1] (a few incommensurate sines). */
export function wobble(t: number, seed: number): number {
  const a = seed * 12.9898;
  return (Math.sin(t * 1.31 + a) * 0.5 + Math.sin(t * 2.77 + a * 1.7) * 0.3 + Math.sin(t * 5.13 + a * 2.3) * 0.2);
}

export interface Track {
  readonly durationSec: number;
  /** Writes the jet's position, attitude and velocity at time t. */
  sample(t: number, jet: ShowcaseAircraft): void;
  /** The flight state (path frame) at time t, nearest step. */
  state(t: number): FlightState;
  /** Moves the whole track so that its position at time t is `p`. */
  anchor(t: number, p: Vec3Like): Track;
}

const cross = (a: Vec3Like, b: Vec3Like, o: Vec3Like): Vec3Like => {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
};
const norm = (v: Vec3Like): Vec3Like => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  v.x /= l;
  v.y /= l;
  v.z /= l;
  return v;
};

/** The quaternion whose body x (forward), y (up), z (right) are the given world unit vectors. */
export function fromBasis(fx: Vec3Like, uy: Vec3Like, rz: Vec3Like, out: QuatLike): QuatLike {
  const m00 = fx.x, m10 = fx.y, m20 = fx.z;
  const m01 = uy.x, m11 = uy.y, m21 = uy.z;
  const m02 = rz.x, m12 = rz.y, m22 = rz.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    out.w = 0.25 * s;
    out.x = (m21 - m12) / s;
    out.y = (m02 - m20) / s;
    out.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out.w = (m21 - m12) / s;
    out.x = 0.25 * s;
    out.y = (m01 + m10) / s;
    out.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out.w = (m02 - m20) / s;
    out.x = (m01 + m10) / s;
    out.y = 0.25 * s;
    out.z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out.w = (m10 - m01) / s;
    out.x = (m02 + m20) / s;
    out.y = (m12 + m21) / s;
    out.z = 0.25 * s;
  }
  return Quat.normalize(out, out);
}

/** Flies the plan and returns the sampled track. */
export function flyPath(plan: FlightPlan): Track {
  const n = Math.ceil(plan.durationSec * HZ) + 1;
  const P = new Float64Array(n * 3);
  const V = new Float64Array(n * 3);
  const Q = new Float64Array(n * 4);
  const states: FlightState[] = [];
  const h = plan.headingRad;
  const g0 = plan.gammaRad ?? 0;
  const pos = { ...plan.start };
  const u = { x: Math.sin(h) * Math.cos(g0), y: Math.sin(g0), z: -Math.cos(h) * Math.cos(g0) };
  let speed = plan.speed;
  // The lift direction: perpendicular to the path, in the vertical plane, then banked.
  const flatRight = norm({ x: Math.cos(h), y: 0, z: Math.sin(h) });
  const lift = norm(cross(flatRight, u, { x: 0, y: 0, z: 0 }));
  const right = cross(u, lift, { x: 0, y: 0, z: 0 });
  const b0 = plan.bankRad ?? 0;
  if (b0 !== 0) {
    const c = Math.cos(b0), s = Math.sin(b0);
    const lx = lift.x * c + right.x * s, ly = lift.y * c + right.y * s, lz = lift.z * c + right.z * s;
    lift.x = lx; lift.y = ly; lift.z = lz;
    cross(u, lift, right);
  }
  const turb = plan.turbulence ?? 1;
  const seed = plan.seed ?? 1;
  let p = 0;
  let nz = 1;
  const dt = 1 / HZ;
  const fwd = { x: 0, y: 0, z: 0 };
  const up = { x: 0, y: 0, z: 0 };
  const q = { x: 0, y: 0, z: 0, w: 1 };
  const dq = { x: 0, y: 0, z: 0, w: 1 };
  const st = (t: number): FlightState => {
    const gamma = Math.asin(Math.max(-1, Math.min(1, u.y)));
    // Bank: the lift vector's tilt from the path's vertical plane.
    const fr = norm({ x: -u.z, y: 0, z: u.x });
    const vert = cross(fr, u, { x: 0, y: 0, z: 0 });
    const bank = Math.atan2(lift.x * fr.x + lift.z * fr.z, lift.x * vert.x + lift.y * vert.y + lift.z * vert.z);
    return { t, pos: { ...pos }, speed, gamma, u: { ...u }, lift: { ...lift }, right: { ...right }, bank };
  };
  let nCmdFirst = true;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const s = st(t);
    states.push(s);
    const nCmd = (plan.load ? plan.load(t, s) : holdGamma(s, g0)) + 0.06 * turb * wobble(t * 1.7, seed + 3);
    if (nCmdFirst) {
      nz = nCmd;
      nCmdFirst = false;
    }
    const pCmd = plan.roll ? plan.roll(t, s) : 0;
    // Roll rate and g build up through first-order lags (the jet's response).
    p += (pCmd - p) * (1 - Math.exp(-dt / 0.09));
    nz += (nCmd - nz) * (1 - Math.exp(-dt / 0.16));
    // Attitude: the nose above the path by the angle of attack, plus a little chop.
    const alpha = Math.min(22 * deg, Math.max(-6 * deg, 3.2 * deg * nz * (200 / Math.max(60, speed)) ** 2));
    const ca = Math.cos(alpha), sa = Math.sin(alpha);
    fwd.x = u.x * ca + lift.x * sa; fwd.y = u.y * ca + lift.y * sa; fwd.z = u.z * ca + lift.z * sa;
    up.x = lift.x * ca - u.x * sa; up.y = lift.y * ca - u.y * sa; up.z = lift.z * ca - u.z * sa;
    fromBasis(fwd, up, right, q);
    const k = turb * Math.min(1, speed / 150);
    Quat.fromYawPitchRoll(0.15 * deg * k * wobble(t, seed + 7), 0.25 * deg * k * wobble(t * 1.3, seed + 11), 0.7 * deg * k * wobble(t * 1.1, seed + 5), dq);
    Quat.multiply(q, dq, q);
    P[i * 3] = pos.x; P[i * 3 + 1] = pos.y; P[i * 3 + 2] = pos.z;
    V[i * 3] = u.x * speed; V[i * 3 + 1] = u.y * speed; V[i * 3 + 2] = u.z * speed;
    Q[i * 4] = q.x; Q[i * 4 + 1] = q.y; Q[i * 4 + 2] = q.z; Q[i * 4 + 3] = q.w;
    // Forces: lift along `lift`, thrust minus drag along the path, gravity down.
    const drag = 2.85 * (speed / 200) ** 2 + 0.3 * nz * nz * (200 / Math.max(60, speed)) ** 2;
    const thrust = plan.holdSpeed
      ? drag + G * u.y + 1.5 * (plan.speed - speed)
      : plan.afterburner?.(t) ? 10.5 : 6.2 * (plan.throttle?.(t) ?? 0.6);
    const at = thrust - drag;
    const ax = lift.x * nz * G + u.x * at;
    const ay = lift.y * nz * G + u.y * at - G;
    const az = lift.z * nz * G + u.z * at;
    const vx = u.x * speed + ax * dt, vy = u.y * speed + ay * dt, vz = u.z * speed + az * dt;
    pos.x += vx * dt; pos.y += vy * dt; pos.z += vz * dt;
    speed = Math.hypot(vx, vy, vz);
    u.x = vx / speed; u.y = vy / speed; u.z = vz / speed;
    // Carry the lift vector along (perpendicular to the new path), then roll it about the path.
    const d = lift.x * u.x + lift.y * u.y + lift.z * u.z;
    lift.x -= d * u.x; lift.y -= d * u.y; lift.z -= d * u.z;
    norm(lift);
    cross(u, lift, right);
    const c = Math.cos(p * dt), sn = Math.sin(p * dt);
    const lx = lift.x * c + right.x * sn, ly = lift.y * c + right.y * sn, lz = lift.z * c + right.z * sn;
    lift.x = lx; lift.y = ly; lift.z = lz;
    norm(lift);
    cross(u, lift, right);
  }
  const off = { x: 0, y: 0, z: 0 };
  const qa = { x: 0, y: 0, z: 0, w: 1 };
  const qb = { x: 0, y: 0, z: 0, w: 1 };
  const track: Track = {
    durationSec: plan.durationSec,
    sample(t, jet) {
      const f = Math.min(n - 1.0001, Math.max(0, t * HZ));
      const i = Math.floor(f);
      const w = f - i;
      const j = i + 1;
      jet.pos.x = P[i * 3]! + (P[j * 3]! - P[i * 3]!) * w + off.x;
      jet.pos.y = P[i * 3 + 1]! + (P[j * 3 + 1]! - P[i * 3 + 1]!) * w + off.y;
      jet.pos.z = P[i * 3 + 2]! + (P[j * 3 + 2]! - P[i * 3 + 2]!) * w + off.z;
      jet.vel.x = V[i * 3]! + (V[j * 3]! - V[i * 3]!) * w;
      jet.vel.y = V[i * 3 + 1]! + (V[j * 3 + 1]! - V[i * 3 + 1]!) * w;
      jet.vel.z = V[i * 3 + 2]! + (V[j * 3 + 2]! - V[i * 3 + 2]!) * w;
      qa.x = Q[i * 4]!; qa.y = Q[i * 4 + 1]!; qa.z = Q[i * 4 + 2]!; qa.w = Q[i * 4 + 3]!;
      qb.x = Q[j * 4]!; qb.y = Q[j * 4 + 1]!; qb.z = Q[j * 4 + 2]!; qb.w = Q[j * 4 + 3]!;
      Quat.slerp(qa, qb, w, jet.rot);
    },
    state(t) {
      const s = states[Math.min(n - 1, Math.max(0, Math.round(t * HZ)))]!;
      return { ...s, pos: { x: s.pos.x + off.x, y: s.pos.y + off.y, z: s.pos.z + off.z } };
    },
    anchor(t, p) {
      const i = Math.min(n - 1, Math.max(0, Math.round(t * HZ)));
      off.x = p.x - P[i * 3]!;
      off.y = p.y - P[i * 3 + 1]!;
      off.z = p.z - P[i * 3 + 2]!;
      return track;
    },
  };
  return track;
}

/**
 * A camera-ship follower: a critically damped spring (natural frequency `omega`, rad/s) on the
 * error from `target(t)` (place and velocity), from t = 0, starting on it and moving with it. Integrated once; `at(t)` samples it.
 */
export function follower(durationSec: number, omega: number, target: (t: number, out: Vec3Like) => Vec3Like): (t: number, out: Vec3Like) => Vec3Like {
  const n = Math.ceil(durationSec * HZ) + 1;
  const A = new Float64Array(n * 3);
  const dt = 1 / HZ;
  const tg = { x: 0, y: 0, z: 0 };
  const t1 = { x: 0, y: 0, z: 0 };
  target(0, tg);
  target(dt, t1);
  const x = { ...tg };
  const v = { x: (t1.x - tg.x) / dt, y: (t1.y - tg.y) / dt, z: (t1.z - tg.z) / dt };
  const prev = { ...tg };
  for (let i = 0; i < n; i++) {
    target(i * dt, tg);
    A[i * 3] = x.x; A[i * 3 + 1] = x.y; A[i * 3 + 2] = x.z;
    for (const k of ['x', 'y', 'z'] as const) {
      // Matches the target's velocity as well as its place: steady motion is followed exactly,
      // only changes in it (a pull, a roll) lag, by about accel / omega^2.
      const tv = i === 0 ? v[k] : (tg[k] - prev[k]) / dt;
      const a = omega * omega * (tg[k] - x[k]) + 2 * omega * (tv - v[k]);
      v[k] += a * dt;
      x[k] += v[k] * dt;
      prev[k] = tg[k];
    }
  }
  return (t, out) => {
    const f = Math.min(n - 1.0001, Math.max(0, t * HZ));
    const i = Math.floor(f);
    const w = f - i;
    out.x = A[i * 3]! + (A[i * 3 + 3]! - A[i * 3]!) * w;
    out.y = A[i * 3 + 1]! + (A[i * 3 + 4]! - A[i * 3 + 1]!) * w;
    out.z = A[i * 3 + 2]! + (A[i * 3 + 5]! - A[i * 3 + 2]!) * w;
    return out;
  };
}

/** A small hand-held drift for a camera, m. */
export function shake(t: number, amp: number, seed: number, out: Vec3Like): Vec3Like {
  out.x += amp * wobble(t * 0.9, seed);
  out.y += amp * wobble(t * 1.1, seed + 17);
  out.z += amp * wobble(t * 0.8, seed + 29);
  return out;
}
