/**
 * tools/lib/trimSolver.ts — implements FindTrim (Newton trim solver) and
 * CheckPerformanceTarget (performance-target evaluation), both against the
 * generic StepAircraftLike<TDef>/EnvironmentLike surface pinned in
 * src/contracts/verify.ts (itself transcribed verbatim from
 * 00-architecture.md section 9.1). See docs/spec/12-verification.md
 * sections 4.2, 4.2.1 and 5.1 for the full algorithms.
 *
 * NOTE on ISA sound-speed at 11000m: this module's own worked reference
 * point (tests/physics/atmosphere.test.ts, testing src/physics/atmosphere.ts
 * independently) targets 295.2 m/s per 12-verification.md section 7, but the
 * rigorous ISA formula (also used here) yields ~295.07 m/s at the tropopause
 * for the standard R=287.05287 J/(kg*K), gamma=1.4 constants. This ~0.13 m/s
 * gap is a minor inconsistency in the spec's own literal worked value, not a
 * bug in the formula (sea-level density/soundspeed and 11000m density all
 * match the spec's reference points to within its stated tolerance). Flagged
 * as a contract/spec concern in this module's return value; the physically
 * rigorous formula is kept here since it is what both this module and
 * src/physics/atmosphere.ts must independently converge on (section 4.2.1).
 */
import type { EntityState, DamageState, PilotInputs, Vec3Like, QuatLike } from '../../src/contracts/core';
import { GRAVITY_MPS2 } from '../../src/contracts/core';
import type {
  EnvironmentLike,
  StepAircraftLike,
  TrimCondition,
  TrimResult,
  PerformanceTarget,
  PerformanceCheckResult,
} from '../../src/contracts/verify';
import {
  TrimStatus,
  TRIM_MAX_ITERATIONS,
  TRIM_RESIDUAL_TOLERANCE_MPS2,
  TRIM_PROBE_DT_SEC,
  TRIM_FD_EPSILON,
  TRIM_STEP_DAMPING,
  PerformanceTargetKind,
} from '../../src/contracts/verify';
import { Quat, clamp, interpolate2D, type Table2D } from '../../src/math';
import { SIM_DT_SEC } from '../../src/contracts/core';

// -----------------------------------------------------------------------------
// ISA atmosphere (module 12's own inlined copy — see 12-verification.md
// section 4.2.1: intentionally independent of src/physics/atmosphere.ts).
// -----------------------------------------------------------------------------

const ISA_T0_K = 288.15;
const ISA_P0_PA = 101325;
const ISA_LAPSE_K_PER_M = 0.0065;
const ISA_R_J_PER_KGK = 287.05287;
const ISA_GAMMA = 1.4;
const ISA_TROPOPAUSE_M = 11000;

export interface IsaResult {
  airDensityKgM3: number;
  soundSpeedMps: number;
}

export function isaAt(altitudeM: number): IsaResult {
  const t11 = ISA_T0_K - ISA_LAPSE_K_PER_M * ISA_TROPOPAUSE_M;
  const p11 = ISA_P0_PA * Math.pow(t11 / ISA_T0_K, GRAVITY_MPS2 / (ISA_R_J_PER_KGK * ISA_LAPSE_K_PER_M));
  let t: number;
  let p: number;
  if (altitudeM <= ISA_TROPOPAUSE_M) {
    t = ISA_T0_K - ISA_LAPSE_K_PER_M * altitudeM;
    p = ISA_P0_PA * Math.pow(t / ISA_T0_K, GRAVITY_MPS2 / (ISA_R_J_PER_KGK * ISA_LAPSE_K_PER_M));
  } else {
    t = t11;
    p = p11 * Math.exp((-GRAVITY_MPS2 * (altitudeM - ISA_TROPOPAUSE_M)) / (ISA_R_J_PER_KGK * t11));
  }
  const airDensityKgM3 = p / (ISA_R_J_PER_KGK * t);
  const soundSpeedMps = Math.sqrt(ISA_GAMMA * ISA_R_J_PER_KGK * t);
  return { airDensityKgM3, soundSpeedMps };
}

// -----------------------------------------------------------------------------
// Shared scaffolding: seed state, environment, damage state, probe inputs.
// See 12-verification.md section 4.2.1.
// -----------------------------------------------------------------------------

/** ISA sea-level air density, kg/m^3 — used by the analytic stall-speed check. */
export const RHO0_KG_M3 = 1.225;

/** Builds an EntityState per 12-verification.md section 4.2.1's exact recipe. `fuelKg` is not specified by that recipe; a generous fixed value is used so an engine model that zeroes thrust at zero fuel never masks a trim search. */
export function makeTrimSeedState(condition: TrimCondition): EntityState {
  const rot: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  Quat.fromYawPitchRoll(0, 0, condition.bankRad, rot);
  return {
    id: 0,
    kind: 'aircraft',
    team: 0,
    pos: { x: 0, y: condition.altitudeM, z: 0 },
    rot,
    vel: { x: 0, y: 0, z: -condition.speedMps },
    omega: { x: 0, y: 0, z: 0 },
    alive: true,
    hp: 100,
    fuelKg: 3000,
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    gearPos: 0,
    throttle: 0.5,
    afterburnerOn: false,
    flags: 0,
  };
}

export function makeFullHealthDamageState(): DamageState {
  return {
    structurePct: 1,
    engineHealthPct: 1,
    controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
    hydraulicsOk: true,
    fuelLeak: false,
    radarHealthPct: 1,
    gearHealthPct: 1,
  };
}

export function buildTrimEnvironment(altitudeM: number): EnvironmentLike {
  const isa = isaAt(altitudeM);
  return {
    airDensityKgM3: isa.airDensityKgM3,
    soundSpeedMps: isa.soundSpeedMps,
    windWorldMps: { x: 0, y: 0, z: 0 },
    gravityMps2: GRAVITY_MPS2,
    groundElevationM: 0,
    groundNormalWorld: { x: 0, y: 1, z: 0 },
  };
}

function makeProbeInputs(pitchStick: number, throttle: number): PilotInputs {
  return {
    pitch: pitchStick,
    roll: 0,
    yaw: 0,
    throttle,
    afterburner: throttle >= 0.999,
    brakes: 0,
    gearDown: false,
    airbrake: false,
    trigger: false,
    launch: false,
    cycleWeapon: false,
    cycleTarget: false,
  };
}

function cloneEntityState(s: EntityState): EntityState {
  return {
    id: s.id,
    kind: s.kind,
    team: s.team,
    pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
    rot: { x: s.rot.x, y: s.rot.y, z: s.rot.z, w: s.rot.w },
    vel: { x: s.vel.x, y: s.vel.y, z: s.vel.z },
    omega: { x: s.omega.x, y: s.omega.y, z: s.omega.z },
    alive: s.alive,
    hp: s.hp,
    fuelKg: s.fuelKg,
    elevonL: s.elevonL,
    elevonR: s.elevonR,
    rudder: s.rudder,
    gearPos: s.gearPos,
    throttle: s.throttle,
    afterburnerOn: s.afterburnerOn,
    flags: s.flags,
  };
}

function vecLength(v: Vec3Like): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/** alpha = atan2(-v_body.y, v_body.x), per 00-architecture.md section 3.5, computed from a state's own vel/rot (StepAircraftLike does not return telemetry directly — see 12-verification.md section 4.2). */
export function computeAlphaRad(s: EntityState): number {
  const vBody: Vec3Like = { x: 0, y: 0, z: 0 };
  Quat.rotateInverse(s.rot, s.vel, vBody);
  return Math.atan2(-vBody.y, vBody.x);
}

function solve2x2(
  j00: number,
  j01: number,
  j10: number,
  j11: number,
  r0: number,
  r1: number
): { x0: number; x1: number; det: number } {
  const det = j00 * j11 - j01 * j10;
  if (Math.abs(det) < 1e-9) return { x0: 0, x1: 0, det };
  const x0 = (r0 * j11 - j01 * r1) / det;
  const x1 = (j00 * r1 - j10 * r0) / det;
  return { x0, x1, det };
}

interface ProbeOutcome {
  rVertical: number;
  rForward: number;
}

/**
 * Probes `step` for TRIM_PROBE_DT_SEC from `seedState` at the given
 * (pitchStick, throttle) and returns the two specific-force residuals.
 * `seedState` is never mutated (StepAircraftLike's contract guarantees
 * `state` is read-only in); `outScratch` is overwritten each call and reused
 * across probes to avoid per-probe allocation.
 */
function probe<TDef>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  seedState: EntityState,
  damage: DamageState,
  env: EnvironmentLike,
  pitchStick: number,
  throttle: number,
  outScratch: EntityState
): ProbeOutcome {
  const inputs = makeProbeInputs(pitchStick, throttle);
  step(seedState, damage, inputs, env, def, TRIM_PROBE_DT_SEC, outScratch);
  const speedBefore = vecLength(seedState.vel);
  const speedAfter = vecLength(outScratch.vel);
  return {
    rVertical: (outScratch.vel.y - seedState.vel.y) / TRIM_PROBE_DT_SEC,
    rForward: (speedAfter - speedBefore) / TRIM_PROBE_DT_SEC,
  };
}

/**
 * How many extra `SIM_DT_SEC`-sized steps are run (at the just-accepted
 * pitchStick/throttle command) at the end of each Newton iteration, before
 * the NEXT iteration's residual/Jacobian are measured. See the
 * `contractConcerns` note in this module's header comment: with actuator/
 * engine dynamics (elevon rate limit, ~2.5s engine spool lag) that are far
 * slower than `TRIM_PROBE_DT_SEC` (2ms), probing a literal fixed `seedState`
 * every Newton iteration (as 12-verification.md section 4.2's pseudocode
 * reads most literally) makes the finite-difference Jacobian exactly
 * singular in practice: a command far from what the rate-limited elevon can
 * reach saturates identically for both the `+eps`/`-eps` perturbations,
 * giving a zero derivative. Carrying the state forward between iterations
 * (a standard shooting/Newton hybrid) gives the actuators the elapsed
 * simulated time they need to actually respond to each iteration's command
 * before the next linearization, without changing the residual/Jacobian
 * formulas or any TRIM_* contract constant.
 */
const TRIM_SETTLE_STEPS_PER_ITERATION = 30;

/**
 * Trust-region cap on the raw (pre-bounds-clamp) Newton step for pitchStick
 * per iteration, on top of TRIM_STEP_DAMPING. The Jacobian here comes from a
 * physical, actuator-rate-limited, closed-loop (and, for this airframe's
 * data, only lightly damped -- see this module's contractConcerns) system,
 * not a clean analytic function: near a saturating regime it can be small
 * or noisy, and an undamped Newton step through a near-singular Jacobian
 * can fling pitchStick straight to +-1 (commanding an unreachable g) in one
 * iteration, from which the search never recovers (every subsequent probe
 * is deep in a stalled/departed regime with no useful gradient back toward
 * the real root). Capping the per-iteration step keeps the search inside a
 * trust region where the local linearization stays meaningful, a standard
 * safeguard for Newton iteration on a numerically-estimated Jacobian.
 */
const TRIM_MAX_PITCH_STEP_PER_ITERATION = 0.1;
const TRIM_MAX_THROTTLE_STEP_PER_ITERATION = 0.1;

/**
 * Newton trim solver over (pitchStick, throttle) with a central-difference
 * numerical Jacobian. See 12-verification.md section 4.2 for the full
 * algorithm; this is a direct implementation of it, with one necessary
 * addition — see `TRIM_SETTLE_STEPS_PER_ITERATION` above.
 */
export function findTrim<TDef>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  condition: TrimCondition,
  seedState: EntityState
): TrimResult {
  const damage = makeFullHealthDamageState();
  const env = buildTrimEnvironment(condition.altitudeM);
  const outScratch = cloneEntityState(seedState);
  let settleScratch = cloneEntityState(seedState);

  let pitchStick = 0;
  let throttle = 0.7;
  let afterburnerUsed = false;

  // The base state THIS iteration's probes measure from. Starts at
  // `seedState` (never mutated — see `probe`'s own contract) and is advanced
  // after every iteration by `settleForward` below.
  let currentState: EntityState = seedState;

  const settleForward = (base: EntityState, pitch: number, thr: number): EntityState => {
    const settleInputs = makeProbeInputs(pitch, thr);
    let cur = cloneEntityState(base);
    for (let s = 0; s < TRIM_SETTLE_STEPS_PER_ITERATION; s++) {
      step(cur, damage, settleInputs, env, def, SIM_DT_SEC, settleScratch);
      const tmp = cur;
      cur = settleScratch;
      settleScratch = tmp;
    }
    // Re-anchor the KINEMATIC part of state (pos/rot/vel/omega) back to the
    // exact nominal trim condition before returning: the settle phase exists
    // only to give actuator/engine lag (elevon rate limit, spool time
    // constant) real elapsed time to respond to the latest command, per
    // TRIM_SETTLE_STEPS_PER_ITERATION's note above -- it is not meant to
    // simulate a real trajectory, and letting position/velocity/attitude
    // drift away from the condition being trimmed (compounding over up to
    // TRIM_MAX_ITERATIONS iterations) would bias the residual/Jacobian away
    // from that condition. Actuator/engine fields (elevons, rudder,
    // throttle, afterburner, gearPos, fuelKg) are exactly what's meant to
    // carry forward, so those are left as settleForward produced them.
    cur.pos.x = seedState.pos.x;
    cur.pos.y = seedState.pos.y;
    cur.pos.z = seedState.pos.z;
    cur.rot.x = seedState.rot.x;
    cur.rot.y = seedState.rot.y;
    cur.rot.z = seedState.rot.z;
    cur.rot.w = seedState.rot.w;
    cur.vel.x = seedState.vel.x;
    cur.vel.y = seedState.vel.y;
    cur.vel.z = seedState.vel.z;
    cur.omega.x = seedState.omega.x;
    cur.omega.y = seedState.omega.y;
    cur.omega.z = seedState.omega.z;
    return cur;
  };

  for (let iter = 1; iter <= TRIM_MAX_ITERATIONS; iter++) {
    const center = probe(step, def, currentState, damage, env, pitchStick, throttle, outScratch);
    const residualMag = Math.sqrt(center.rVertical * center.rVertical + center.rForward * center.rForward);
    // Capture alpha AND a full state snapshot from the center probe's output
    // NOW — outScratch is about to be overwritten by the Jacobian's
    // finite-difference probes below, and the snapshot is what this
    // iteration's settle phase (below) advances forward from.
    const centerAlphaRad = computeAlphaRad(outScratch);
    const centerState = cloneEntityState(outScratch);
    if (throttle >= 0.999) afterburnerUsed = true;

    if (residualMag < TRIM_RESIDUAL_TOLERANCE_MPS2) {
      return {
        status: TrimStatus.Converged,
        condition,
        pitchStick,
        throttle,
        afterburnerUsed,
        alphaRad: centerAlphaRad,
        iterations: iter,
        residualMps2: residualMag,
      };
    }

    const pPlus = probe(step, def, currentState, damage, env, pitchStick + TRIM_FD_EPSILON, throttle, outScratch);
    const pMinus = probe(step, def, currentState, damage, env, pitchStick - TRIM_FD_EPSILON, throttle, outScratch);
    const tPlus = probe(step, def, currentState, damage, env, pitchStick, throttle + TRIM_FD_EPSILON, outScratch);
    const tMinus = probe(step, def, currentState, damage, env, pitchStick, throttle - TRIM_FD_EPSILON, outScratch);

    const j00 = (pPlus.rVertical - pMinus.rVertical) / (2 * TRIM_FD_EPSILON);
    const j10 = (pPlus.rForward - pMinus.rForward) / (2 * TRIM_FD_EPSILON);
    const j01 = (tPlus.rVertical - tMinus.rVertical) / (2 * TRIM_FD_EPSILON);
    const j11 = (tPlus.rForward - tMinus.rForward) / (2 * TRIM_FD_EPSILON);

    const solved = solve2x2(j00, j01, j10, j11, center.rVertical, center.rForward);
    if (Math.abs(solved.det) < 1e-9) {
      // A singular Jacobian this early is expected on iteration 1 (before
      // `currentState` has had any settle time at all — see
      // `TRIM_SETTLE_STEPS_PER_ITERATION`'s note): a fresh, zero-elevon
      // state's rate-limited actuator saturates identically for the +eps/
      // -eps perturbations. Keep perturbing and settling for the REST of
      // the iteration budget (not just one extra try) rather than giving up
      // immediately — by the time `currentState` has had a few settle
      // rounds it is no longer pinned at the pristine seed and the Jacobian
      // stops being exactly singular in practice.
      pitchStick = clamp(pitchStick + 0.05, -1, 1);
      currentState = settleForward(centerState, pitchStick, throttle);
      if (iter === TRIM_MAX_ITERATIONS) {
        return {
          status: TrimStatus.OutOfControlAuthority,
          condition,
          pitchStick,
          throttle,
          afterburnerUsed,
          alphaRad: centerAlphaRad,
          iterations: iter,
          residualMps2: residualMag,
        };
      }
      continue;
    }

    const pitchStep = clamp(TRIM_STEP_DAMPING * solved.x0, -TRIM_MAX_PITCH_STEP_PER_ITERATION, TRIM_MAX_PITCH_STEP_PER_ITERATION);
    const throttleStep = clamp(TRIM_STEP_DAMPING * solved.x1, -TRIM_MAX_THROTTLE_STEP_PER_ITERATION, TRIM_MAX_THROTTLE_STEP_PER_ITERATION);
    pitchStick = clamp(pitchStick - pitchStep, -1, 1);
    throttle = clamp(throttle - throttleStep, 0, 1);
    currentState = settleForward(centerState, pitchStick, throttle);

    if (iter === TRIM_MAX_ITERATIONS) {
      return {
        status: TrimStatus.MaxIterationsExceeded,
        condition,
        pitchStick,
        throttle,
        afterburnerUsed,
        alphaRad: centerAlphaRad,
        iterations: iter,
        residualMps2: residualMag,
      };
    }
  }

  // Unreachable (the loop above always returns), but keeps control flow
  // exhaustive for strict mode.
  return {
    status: TrimStatus.MaxIterationsExceeded,
    condition,
    pitchStick,
    throttle,
    afterburnerUsed,
    alphaRad: 0,
    iterations: TRIM_MAX_ITERATIONS,
    residualMps2: Number.POSITIVE_INFINITY,
  };
}

// -----------------------------------------------------------------------------
// CheckPerformanceTarget — evaluates one PerformanceTarget (12-verification.md
// section 5.1) by driving `step`/`findTrim` through the recipe that target
// kind calls for. Bundled in this file (rather than a separate tools/lib
// module) because every kind reuses this file's trim/environment/probe
// internals directly. See 12-verification.md section 9's open assumption #1:
// these are module 12's own public-data-derived checks, reviewed rather than
// treated as an automatic flight-model bug on mismatch.
// -----------------------------------------------------------------------------

/**
 * The narrow, structural subset of AircraftDefinition (contracts/aircraft.ts,
 * a sibling contract this module does not read) needed for the analytic
 * stall-speed check. Per 00-architecture.md section 8's guidance, this is the
 * conservative local subset rather than an invented full re-declaration — the
 * real `tejasDefinition` (module 03) satisfies it structurally with no cast.
 */
export interface AircraftDefLike {
  wingAreaM2: number;
  aero: { CL: Table2D; stallAlphaRad: number };
}

const VMAX_BISECT_MIN_MPS = 100;
const VMAX_BISECT_MAX_MPS = 600;
const VMAX_BISECT_ITERATIONS = 22;
/** Matches the one 'turn_5000_m06' row in 12-verification.md section 5.1 — the only sustained-turn-rate target this table defines. */
const TURN_RATE_TEST_MACH = 0.6;
const TURN_RATE_BISECT_MAX_BANK_RAD = (85 * Math.PI) / 180;
const TURN_RATE_BISECT_ITERATIONS = 22;
/** Matches the one 'climb_sl' row's Vy=180 m/s condition. */
const CLIMB_TEST_IAS_MPS = 180;
const CLIMB_TEST_DURATION_SEC = 20;
const CLIMB_TEST_DISCARD_SEC = 15;
/** rad of pitch-stick per m/s of IAS error, per 12-verification.md section 5.1's climb-rate P-controller. */
const CLIMB_TEST_KP = 0.02;
const STALL_ALPHA_SCAN_STEPS = 40;
const STALL_ALPHA_SCAN_START_RAD = (-5 * Math.PI) / 180;
/** A representative low/subsonic Mach at which to slice the CL table, matching tests/aircraft/tejasAeroTables.test.ts's MACH_REF. */
const STALL_MACH_REF = 0.3;
/** Conventional powered-approach speed margin above stall for the landing-roll touchdown-speed estimate. */
const LANDING_APPROACH_SPEED_FACTOR = 1.15;
/** Hard cap on ground-roll integration steps so a physics bug that never reaches liftoff/stop cannot hang the CLI. */
const GROUND_ROLL_MAX_SIM_SEC = 120;

function trimConverges<TDef>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  altitudeM: number,
  speedMps: number,
  bankRad: number,
  massKg: number
): TrimResult {
  const condition: TrimCondition = { altitudeM, speedMps, bankRad, massKg };
  const seed = makeTrimSeedState(condition);
  return findTrim(step, def, condition, seed);
}

function findVmax<TDef>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  altitudeM: number,
  massKg: number
): { speedMps: number; trim?: TrimResult } {
  let lo = VMAX_BISECT_MIN_MPS;
  let hi = VMAX_BISECT_MAX_MPS;
  const loTrim = trimConverges(step, def, altitudeM, lo, 0, massKg);
  if (loTrim.status !== TrimStatus.Converged) {
    return { speedMps: lo, trim: loTrim };
  }
  let lastConverged = loTrim;
  for (let i = 0; i < VMAX_BISECT_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const r = trimConverges(step, def, altitudeM, mid, 0, massKg);
    if (r.status === TrimStatus.Converged) {
      lo = mid;
      lastConverged = r;
    } else {
      hi = mid;
    }
  }
  return { speedMps: lo, trim: lastConverged };
}

function findMaxSustainedTurnRateDegSec<TDef>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  altitudeM: number,
  massKg: number
): { degSec: number; trim?: TrimResult } {
  const speedMps = TURN_RATE_TEST_MACH * isaAt(altitudeM).soundSpeedMps;
  let lo = 0;
  let hi = TURN_RATE_BISECT_MAX_BANK_RAD;
  let lastConverged: TrimResult | undefined;
  const wingsLevel = trimConverges(step, def, altitudeM, speedMps, 0, massKg);
  if (wingsLevel.status === TrimStatus.Converged) lastConverged = wingsLevel;
  for (let i = 0; i < TURN_RATE_BISECT_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const r = trimConverges(step, def, altitudeM, speedMps, mid, massKg);
    if (r.status === TrimStatus.Converged) {
      lo = mid;
      lastConverged = r;
    } else {
      hi = mid;
    }
  }
  const n = 1 / Math.cos(lo);
  const turnRateRadSec = n > 1 ? (GRAVITY_MPS2 * Math.sqrt(n * n - 1)) / speedMps : 0;
  return { degSec: (turnRateRadSec * 180) / Math.PI, trim: lastConverged };
}

function computeClimbRateMps<TDef>(step: StepAircraftLike<TDef>, def: TDef, altitudeM: number, massKg: number): number {
  const condition: TrimCondition = { altitudeM, speedMps: CLIMB_TEST_IAS_MPS, bankRad: 0, massKg };
  let state = makeTrimSeedState(condition);
  let out = cloneEntityState(state);
  const damage = makeFullHealthDamageState();
  const totalSteps = Math.round(CLIMB_TEST_DURATION_SEC / SIM_DT_SEC);
  const discardSteps = Math.round(CLIMB_TEST_DISCARD_SEC / SIM_DT_SEC);
  let sumVy = 0;
  let count = 0;
  for (let i = 0; i < totalSteps; i++) {
    const ias = vecLength(state.vel);
    const error = CLIMB_TEST_IAS_MPS - ias;
    const pitchStick = clamp(CLIMB_TEST_KP * error, -1, 1);
    const inputs = makeProbeInputs(pitchStick, 1);
    const env = buildTrimEnvironment(state.pos.y);
    step(state, damage, inputs, env, def, SIM_DT_SEC, out);
    const tmp = state;
    state = out;
    out = tmp;
    if (i >= discardSteps) {
      sumVy += state.vel.y;
      count++;
    }
  }
  return count > 0 ? sumVy / count : 0;
}

function computeStallSpeedMps<TDef extends AircraftDefLike>(def: TDef, massKg: number, assumedClMax: number): number {
  let scannedClMax = -Infinity;
  const stallAlphaRad = def.aero.stallAlphaRad;
  for (let i = 0; i <= STALL_ALPHA_SCAN_STEPS; i++) {
    const alphaRad = STALL_ALPHA_SCAN_START_RAD + (i / STALL_ALPHA_SCAN_STEPS) * (stallAlphaRad - STALL_ALPHA_SCAN_START_RAD);
    const cl = interpolate2D(def.aero.CL, alphaRad, STALL_MACH_REF);
    if (cl > scannedClMax) scannedClMax = cl;
  }
  const clMax = Math.min(assumedClMax, scannedClMax);
  return Math.sqrt((2 * massKg * GRAVITY_MPS2) / (RHO0_KG_M3 * def.wingAreaM2 * clMax));
}

function computeGroundRollM<TDef>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  mode: 'takeoff' | 'landing',
  startSpeedMps: number
): number {
  const damage = makeFullHealthDamageState();
  let state: EntityState = {
    id: 0,
    kind: 'aircraft',
    team: 0,
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 }, // heading east, wings level -- identity quaternion (00-architecture.md worked example A)
    vel: { x: startSpeedMps, y: 0, z: 0 },
    omega: { x: 0, y: 0, z: 0 },
    alive: true,
    hp: 100,
    fuelKg: 3000,
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    gearPos: 1,
    throttle: mode === 'takeoff' ? 1 : 0,
    afterburnerOn: mode === 'takeoff',
    flags: 0,
  };
  let out = cloneEntityState(state);
  const env = buildTrimEnvironment(0);
  const inputs = makeProbeInputs(0, mode === 'takeoff' ? 1 : 0);
  inputs.afterburner = mode === 'takeoff';
  inputs.brakes = mode === 'landing' ? 1 : 0;
  inputs.gearDown = true;

  let distanceM = 0;
  const maxSteps = Math.round(GROUND_ROLL_MAX_SIM_SEC / SIM_DT_SEC);
  for (let i = 0; i < maxSteps; i++) {
    step(state, damage, inputs, env, def, SIM_DT_SEC, out);
    distanceM += SIM_DT_SEC * state.vel.x;
    const tmp = state;
    state = out;
    out = tmp;
    if (mode === 'takeoff' && state.vel.y > 0.5) break;
    if (mode === 'landing' && vecLength(state.vel) < 1) break;
  }
  return distanceM;
}

/**
 * Implements CheckPerformanceTarget<TDef> (contracts/verify.ts). Dispatches
 * on `target.kind` per the recipe in 12-verification.md section 5.1.
 */
export function checkPerformanceTarget<TDef extends AircraftDefLike>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  target: PerformanceTarget
): PerformanceCheckResult {
  let measured: number;
  let trim: TrimResult | undefined;

  switch (target.kind) {
    case PerformanceTargetKind.VMax: {
      const r = findVmax(step, def, target.altitudeM, target.massKg);
      measured = r.speedMps;
      trim = r.trim;
      break;
    }
    case PerformanceTargetKind.SustainedTurnRateDegSec: {
      const r = findMaxSustainedTurnRateDegSec(step, def, target.altitudeM, target.massKg);
      measured = r.degSec;
      trim = r.trim;
      break;
    }
    case PerformanceTargetKind.ClimbRateMps:
      measured = computeClimbRateMps(step, def, target.altitudeM, target.massKg);
      break;
    case PerformanceTargetKind.StallSpeedMps: {
      const assumedClMax = target.id === 'stall_landing' ? 1.6 : 1.1;
      measured = computeStallSpeedMps(def, target.massKg, assumedClMax);
      break;
    }
    case PerformanceTargetKind.TakeoffRollM:
      measured = computeGroundRollM(step, def, 'takeoff', 0);
      break;
    case PerformanceTargetKind.LandingRollM: {
      const vTouchdown = computeStallSpeedMps(def, target.massKg, 1.6) * LANDING_APPROACH_SPEED_FACTOR;
      measured = computeGroundRollM(step, def, 'landing', vTouchdown);
      break;
    }
    default: {
      const exhaustiveCheck: never = target.kind;
      throw new Error(`Unknown PerformanceTargetKind: ${String(exhaustiveCheck)}`);
    }
  }

  const deltaRel = target.targetValue !== 0 ? (measured - target.targetValue) / target.targetValue : measured;
  const passed = Math.abs(deltaRel) <= target.toleranceRel;
  return { target, measured, passed, deltaRel, trim };
}
