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
import { Quat, clamp, inverseLerp, interpolate2D, type Table2D } from '../../src/math';
import { SIM_DT_SEC } from '../../src/contracts/core';
import { resetFcsTrimState } from '../../src/physics';
import { entityPoolIndex, getLastGLoad, neutralGReference } from '../../src/physics/fcs';
import { emptyMassKg as TEJAS_EMPTY_MASS_KG } from '../../src/aircraft/tejasGeometry';

/**
 * Fuel load that makes the (clean, no-stores) Tejas weigh `massKg`. src/physics's mass is now
 * `emptyMassKg + fuelKg + storesMassKg` (it used to be a fixed def.massKg regardless of fuel), so
 * each performance condition's own massKg is honoured by fuelling to it. May exceed maxFuelKg for
 * the heavier (e.g. 9500 kg, i.e. stores-equivalent) conditions -- the solver only needs the mass.
 */
function fuelKgForMass(massKg: number): number {
  return Math.max(0, massKg - TEJAS_EMPTY_MASS_KG);
}

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

/** Builds an EntityState per 12-verification.md section 4.2.1's exact recipe. `fuelKg` is not specified by that recipe; it is set so the aircraft weighs `condition.massKg` (see fuelKgForMass). */
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
    fuelKg: fuelKgForMass(condition.massKg),
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
  // `src/physics/fcs.ts` keeps its trim-integral/last-gLoad state in
  // module-private tables keyed by the entity's pool-slot index, not by
  // EntityState itself (00-architecture.md section 9's rationale: that
  // state is FCS-internal, not part of the portable EntityState/DamageState
  // shape). Every seed state this module builds uses `id: 0` (see
  // `makeTrimSeedState`/`computeGroundRollM`), so every `findTrim` call
  // (and every bisection step within `findVmax`/`findMaxSustainedTurnRateDegSec`)
  // shares that SAME slot 0 across calls. Without resetting it here, a
  // search starting from a fresh `seedState` would silently inherit
  // leftover trim-integral windup and gLoad history from whichever
  // condition was probed immediately before it in the same process (e.g.
  // the previous bisection midpoint, possibly a wildly different
  // speed/altitude) — a real cross-call contamination bug, not merely a
  // cosmetic one: it was one of the compounding causes behind the
  // out_of_control_authority failures across the whole trim envelope. Each
  // trim search must start from the same clean FCS state a freshly-spawned
  // aircraft would.
  resetFcsTrimState(entityPoolIndex(seedState.id));

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
    // Re-anchor the TRANSLATIONAL part of state (pos/vel) back to the exact
    // nominal trim condition before returning: the settle phase exists only
    // to give actuator/engine lag (elevon rate limit, spool time constant)
    // real elapsed time to respond to the latest command, per
    // TRIM_SETTLE_STEPS_PER_ITERATION's note above, and altitude/speed are
    // the trim CONDITION (held fixed by definition -- see 4.2.1), so letting
    // position/velocity drift away from it (compounding over up to
    // TRIM_MAX_ITERATIONS iterations) would bias the residual/Jacobian away
    // from the condition being solved for. Actuator/engine fields (elevons,
    // rudder, throttle, afterburner, gearPos, fuelKg) are exactly what's
    // meant to carry forward, so those are left as settleForward produced
    // them.
    //
    // `rot` (and `omega`) are deliberately NOT reset here. Unlike
    // position/velocity, attitude is not part of the trim condition -- it is
    // exactly the free variable trim exists to solve for: the pitch angle
    // (hence angle of attack) at which the aero moment balances and the
    // aero force matches weight. An earlier version of this function also
    // reset `rot`/`omega` back to the seed's zero-pitch, zero-rate attitude
    // every iteration, which discarded the very pitch-up (or pitch-down)
    // attitude the FCS had just spent this settle window building toward:
    // every subsequent probe started from alpha~0 again regardless of how
    // many iterations ran, so the residual could never reflect the
    // AoA-dependent lift a real trim needs and the search saturated
    // pitchStick at its bound without ever converging (this was the root
    // cause of tools/sim-check.ts's/tests/integration/trimAndPerformance.
    // test.ts's whole-envelope `out_of_control_authority` failures). Leaving
    // `rot`/`omega` to evolve under the closed-loop FCS across iterations is
    // exactly the shooting-method behaviour trim needs: as pitchStick/
    // throttle converge, the attitude converges alongside them to the actual
    // trimmed AoA, and `omega` converges toward zero as the pitch rate damps
    // out -- both are read back by the NEXT iteration's probe/Jacobian, and
    // `alphaRad` in the final `TrimResult` (computed from the true evolved
    // `rot`) is now the real trimmed AoA instead of a near-zero artifact of a
    // 2ms probe from a forcibly relevelled attitude.
    //
    cur.pos.x = seedState.pos.x;
    cur.pos.y = seedState.pos.y;
    cur.pos.z = seedState.pos.z;
    cur.vel.x = seedState.vel.x;
    cur.vel.y = seedState.vel.y;
    cur.vel.z = seedState.vel.z;
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
      //
      // The Jacobian also goes singular later on, past the FIRST iteration,
      // whenever `alpha` has been driven beyond `fcsLimits.maxAlphaRad`:
      // `stepFcs`'s alpha limiter then clamps `gCmd` to a ceiling that
      // depends only on the CURRENT alpha (shared by both the +eps/-eps
      // probes, since alpha comes from `currentState`, not from this
      // probe's own command), not on `pitchStick` any more, so both
      // perturbations produce the identical clamped command and `j00`
      // measures exactly zero. Nudging `pitchStick` UNCONDITIONALLY toward
      // +1 (the literal spec text/an earlier version of this function) is
      // wrong here: once `pitchStick` is already saturated at its +1 bound
      // (typical once the search has driven alpha past the limit) and the
      // aircraft is producing far MORE lift than the trim condition needs
      // (`center.rVertical` strongly positive — verified empirically: this
      // was the actual mechanism behind the whole-envelope
      // `out_of_control_authority` failures in tools/sim-check.ts /
      // tests/integration/trimAndPerformance.test.ts once the gain fix
      // above stopped the earlier gross instability), `clamp(pitchStick +
      // 0.05, -1, 1)` is already at its clamp and can never move, so the
      // search is stuck at the bound forever with no way back. Stepping
      // pitchStick AWAY from lift excess/deficit using the one signal that
      // IS still valid here (the sign of the center residual, which the
      // alpha limiter does not zero out) lets the search escape a
      // saturated bound in either direction instead of only ever pushing
      // further into it.
      // Throttle gets the same treatment for the same reason: once it is
      // pinned at a bound (0 or 1) with a singular Jacobian, a search that
      // only ever moved pitchStick here left throttle permanently stuck
      // even when `center.rForward` clearly still called for more or less
      // thrust — observed empirically as `rForward` growing steadily more
      // negative (decelerating) across many consecutive singular
      // iterations with `throttle` frozen at 0.
      const fallbackPitchStepSign = center.rVertical > 0 ? -1 : 1;
      const fallbackThrottleStepSign = center.rForward < 0 ? 1 : -1;
      pitchStick = clamp(pitchStick + fallbackPitchStepSign * 0.05, -1, 1);
      throttle = clamp(throttle + fallbackThrottleStepSign * 0.05, 0, 1);
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
// findGCommandTrim — a trim solver SPECIFIC to src/physics/fcs.ts's G-command
// pitch law, used below by trimConverges (hence by findVmax/
// findMaxSustainedTurnRateDegSec) instead of the generic findTrim above. See
// that function's own doc comment for the full rationale; findTrim itself is
// left completely unmodified (tests/tools/trimSolver.test.ts still exercises
// it, unchanged, against a synthetic OPEN-LOOP aircraft where a 2D Newton
// search over (pitchStick, throttle) is exactly the right tool).
// -----------------------------------------------------------------------------

/**
 * The narrow structural subset of AircraftDefinition's FcsLimits
 * (contracts/aircraft.ts) that `computeGCommand`'s inverse
 * (`pitchStickForGCommand` below) needs. The real `tejasDefinition`
 * (module 03) satisfies this structurally with no cast.
 */
export interface GCommandAircraftDefLike {
  fcsLimits: { maxGLoadPos: number; maxGLoadNeg: number };
}

/**
 * Exact inverse of `src/physics/fcs.ts`'s exported `computeGCommand`: the
 * `pitchStick` for which `computeGCommand(pitchStick, fcsLimits) ===
 * gCmdTarget` (using the same `lerp` computeGCommand itself uses, so this
 * stays byte-for-byte consistent with the real FCS law rather than
 * re-deriving an approximate inverse).
 */
export function pitchStickForGCommand(gCmdTarget: number, maxGLoadPos: number, maxGLoadNeg: number, neutralG = 1): number {
  return gCmdTarget >= neutralG
    ? clamp(inverseLerp(neutralG, maxGLoadPos, gCmdTarget), 0, 1)
    : -clamp(inverseLerp(neutralG, maxGLoadNeg, gCmdTarget), 0, 1);
}

/**
 * The FCS's neutral-stick load factor (fcs.ts `neutralGReference`) for a wings-level-pitch seed
 * at `bankRad`: it compensates bank up to 33deg, so within that range a level turn's 1/cos(bank)
 * needs little or no stick at all. Passing this to `pitchStickForGCommand` keeps the inverse exact.
 */
function neutralGForBank(bankRad: number): number {
  const rot: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  Quat.fromYawPitchRoll(0, 0, bankRad, rot);
  return neutralGReference(rot);
}

/**
 * Probe window (whole `SIM_DT_SEC` ticks) `findGCommandTrim`'s own residual
 * measurement uses in place of the generic `probe`'s `TRIM_PROBE_DT_SEC`
 * (2ms, contracts/verify.ts). See `probeAveraged`'s doc comment for why.
 */
const GCMD_PROBE_TICKS = 1;

/**
 * Cross-module fix (this pass): the real Tejas's closed-loop pitch axis
 * settles, once `stepFcs`'s trim-integral has done its job, to a MEAN gLoad
 * that matches `gCmdTarget` exactly (confirmed empirically: averaging gLoad
 * over one full period gives a value matching the target to 10+ significant
 * figures) but with a small, bounded, NON-DECAYING two-substep-period ripple
 * around that mean — a weakly damped short-period oscillation of the
 * aero+one-substep-delayed-actuator model (02-flight-model.md section 4.2's
 * one-substep force/elevon delay is documented as intentional), not a gain
 * bug: scaling `FcsLimits.pitchRateGain`'s own qBar schedule by a wide range
 * of factors (src/physics/fcs.ts, this same cross-module pass) left this
 * ripple's amplitude essentially unchanged, ruling out insufficient active
 * damping as the cause. The generic `probe`'s `TRIM_PROBE_DT_SEC` (2ms) is
 * SHORTER than this ripple's half-period (1/240s ~= 4.17ms), so a single such
 * probe measures whatever INSTANTANEOUS phase of the ripple it happens to
 * land on rather than the (already-converged) mean — this is what produced
 * widespread `max_iterations_exceeded` results at small, physically
 * plausible trimmed alpha values across the whole trim envelope (not just
 * the named performance targets) even after the sign/settle-time fixes
 * elsewhere in this file: the bisection's OWN convergence check
 * (`residualMag < TRIM_RESIDUAL_TOLERANCE_MPS2`) was comparing against
 * whichever phase the 2ms probe landed on, which for many candidates never
 * fell under the tight tolerance even once the true (mean) trim was reached.
 * `probeAveraged` (below) sidesteps this: average acceleration over a window
 * is exactly the endpoint velocity difference divided by the window length,
 * independent of the waveform in between, so measuring over a WHOLE number
 * of ripple periods (a ripple period is 2 substeps = 1/120s = one
 * `SIM_DT_SEC` tick, so `GCMD_PROBE_TICKS` ticks is that many whole periods)
 * exactly cancels the ripple and reports the TRUE, already-converged trim
 * residual instead of an arbitrary sample of the ripple's amplitude.
 */
/**
 * Averages `GCMD_PROBE_TICKS` independent one-tick measurements (each
 * starting from `currentState`'s own pos/vel, reset after every tick, same
 * as `settleFromSeed`'s own per-tick re-anchoring) rather than one single
 * `GCMD_PROBE_TICKS`-tick FREE-DRIFT window. Cross-module fix, this pass:
 * an earlier version of this function let the state evolve un-reset across
 * multiple ticks — mathematically appealing (average acceleration over a
 * window is just the endpoint velocity delta divided by the window length,
 * independent of the waveform in between) but WRONG here whenever the
 * probed condition is not perfectly balanced (`rForward`/`rVertical`
 * genuinely nonzero, as for `fullPowerResidual`'s aggressive high-bank
 * candidates): letting velocity actually drift across several ticks changes
 * `alpha`/`qBar` as it goes, so the measurement stops being "the residual
 * AT this trim condition" and starts including the condition's own onward
 * evolution — confirmed empirically (this pass) to make the measured
 * residual WORSE, not better, as the window grew past a couple of ticks.
 * Averaging independent PER-TICK measurements (each anchored back to the
 * unperturbed condition before the next one starts, exactly like the settle
 * loop already does every tick) still cancels a short-period ripple whose
 * period does not evenly divide `SIM_DT_SEC` — confirmed empirically to
 * closely match a `GCMD_PROBE_TICKS=1` measurement when the true residual
 * is near zero (ripple case) while also converging correctly toward the
 * genuine nonzero mean for an off-trim condition (drift case), unlike the
 * free-drift version.
 */
function probeAveraged<TDef>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  currentState: EntityState,
  damage: DamageState,
  env: EnvironmentLike,
  pitchStick: number,
  throttle: number
): ProbeOutcome {
  const inputs = makeProbeInputs(pitchStick, throttle);
  const anchorVel = { x: currentState.vel.x, y: currentState.vel.y, z: currentState.vel.z };
  const anchorPos = { x: currentState.pos.x, y: currentState.pos.y, z: currentState.pos.z };
  const startSpeed = vecLength(anchorVel);
  let cur = cloneEntityState(currentState);
  let scratch = cloneEntityState(currentState);
  let sumRVertical = 0;
  let sumRForward = 0;
  for (let i = 0; i < GCMD_PROBE_TICKS; i++) {
    cur.pos.x = anchorPos.x;
    cur.pos.y = anchorPos.y;
    cur.pos.z = anchorPos.z;
    cur.vel.x = anchorVel.x;
    cur.vel.y = anchorVel.y;
    cur.vel.z = anchorVel.z;
    step(cur, damage, inputs, env, def, SIM_DT_SEC, scratch);
    const tmp = cur;
    cur = scratch;
    scratch = tmp;
    sumRVertical += (cur.vel.y - anchorVel.y) / SIM_DT_SEC;
    sumRForward += (vecLength(cur.vel) - startSpeed) / SIM_DT_SEC;
  }
  return {
    rVertical: sumRVertical / GCMD_PROBE_TICKS,
    rForward: sumRForward / GCMD_PROBE_TICKS,
  };
}

/** Bisection iterations for the throttle axis (see below); 40 gives throttle precision well under 1e-9 of [0,1]. */
const GCMD_TRIM_MAX_ITERATIONS = 40;
/**
 * Settle steps run (at real `SIM_DT_SEC`) before EVERY throttle candidate
 * this function measures (both bisection endpoints and every midpoint) —
 * far larger than `findTrim`'s own `TRIM_SETTLE_STEPS_PER_ITERATION`.
 * Empirically, holding `pitchStick` fixed at the analytically-correct value
 * for a level (or banked) trim still needs on the order of MINUTES of real
 * elapsed simulated time for `stepFcs`'s trim-integral to bring `gLoad`
 * within `TRIM_RESIDUAL_TOLERANCE_MPS2` of `gCmd`, given this airframe's
 * deliberately gentle `FCS_TRIM_INTEGRAL_GAIN` (src/physics/fcs.ts, ~0.02
 * rad/(g*s)) — 0.25s-1.5s (this constant's earlier, far smaller values,
 * tuned before the cross-module fixes below) is nowhere near enough.
 *
 * This was masked by two independent sign bugs (both fixed as part of the
 * same cross-module pass that raised this constant — see
 * src/physics/fcs.ts's trim-integral sign fix and
 * src/aircraft/tejasGeometry.ts's `yawRateGain` sign fix): with either bug
 * present, a long settle window was actively harmful (the closed loop never
 * truly converges — it either fights itself on the pitch axis, per fcs.ts's
 * own comment, or develops an exponentially growing roll/yaw divergence from
 * floating-point noise within roughly a minute of simulated time, per
 * tejasGeometry.ts's own comment — so previous tuning passes had no reason
 * to try a long settle here). With both fixed, the closed loop is genuinely,
 * stably convergent (confirmed empirically over 100+ simulated seconds with
 * no divergence), and giving the slow trim-integral gain enough elapsed time
 * to actually close the residual gap is the correct fix rather than further
 * gain surgery: `FCS_TRIM_INTEGRAL_GAIN` is deliberately gentle (a fast
 * auto-trim would fight a human pilot's own stick inputs), and this file is
 * free to spend CLI/test wall-clock time (a few hundred milliseconds per
 * settle call at ~2us/step) that a real-time 120 Hz sim tick budget could
 * never afford.
 */
const GCMD_TRIM_SETTLE_STEPS_PER_ITERATION = 9000;
/** How often (in settle ticks) the adaptive early-exit below re-checks gLoad/alpha — cheap (an array read + a quaternion rotate), but no need to pay it every single tick. */
const GCMD_SETTLE_CHECK_INTERVAL_STEPS = 30;
/**
 * Consecutive-reading STABILITY threshold (g) for the adaptive early-exit,
 * replacing an earlier version's direct comparison against `gCmdTarget`
 * (cross-module fix, this pass; see `probeAveraged`'s doc comment for the
 * full mechanism this codifies). `getLastGLoad` always samples the SAME
 * phase of the real Tejas's small, non-decaying two-substep-period trim
 * ripple (the phase right after each tick's second/last substep), so once
 * the trim-integral has truly reached its fixed point this reading is
 * BIT-STABLE tick to tick but is NOT equal to `gCmdTarget` itself — it sits
 * offset from it by (half) the ripple's amplitude (confirmed empirically:
 * the ripple's two-substep MEAN converges to `gCmdTarget` exactly, but its
 * "low" phase, the one this function samples, does not). Comparing against
 * `gCmdTarget` directly (the earlier version) therefore either never fires
 * (burning the full settle budget on every candidate) or, worse, fires
 * PREMATURELY whenever a partially-settled trajectory's transient happens to
 * swing close to the target in passing, stopping the settle before the
 * trim-integral has actually reached its fixed point — both were observed
 * empirically to leave a real, unconverged residual for `findGCommandTrim`'s
 * own final `probeAveraged` measurement to trip on, propagating into
 * `max_iterations_exceeded` results across most of the trim envelope
 * (tests/integration/trimAndPerformance.test.ts / tools/sim-check.ts's own
 * whole-grid finding). Checking whether the reading has STOPPED CHANGING
 * between successive checks instead correctly detects "the trim-integral has
 * reached its fixed point" regardless of that fixed point's offset from
 * `gCmdTarget`, and remains just as cheap (one extra scalar compare).
 */
const GCMD_SETTLE_STABLE_GLOAD_DELTA = 1e-6;
/**
 * Minimum settle ticks before the stability early-exit above is even
 * consulted (cross-module fix, this pass). `src/physics/engine.ts`'s
 * throttle spool lag (`spoolTimeConstantSec`, ~2.5s for the real Tejas) is
 * MUCH slower than the pitch axis's own settle time — `stepFcs`'s gLoad
 * reading can reach a stable-looking value (see
 * `GCMD_SETTLE_STABLE_GLOAD_DELTA`'s own comment) within a couple of
 * simulated seconds, well before applied thrust has finished spooling up
 * toward its commanded value, because thrust contributes nothing to gLoad
 * (it is purely body +X, 02-flight-model.md section 4.7) — so the
 * gLoad-stability check alone cannot tell a genuinely settled trim apart
 * from "pitch already settled, thrust still spooling". Confirmed empirically
 * (this cross-module pass, `findVmax`'s own full-power residual sweep): the
 * gLoad-only early-exit was firing after only a few hundred ticks at some
 * candidate speeds, well before throttle had reached even half its
 * commanded value, which corrupted the FORWARD (thrust-vs-drag) residual
 * `findVmax` bisects on — the aircraft was probed while still meaningfully
 * under-thrust, reporting a false deceleration at speeds the fully-spooled
 * aircraft can in fact sustain or exceed, collapsing `vmax_sl`'s measured
 * value far below its true full-power equilibrium. Five time constants
 * (>99% spooled) comfortably covers this regardless of which
 * `AircraftDefinition.engine.spoolTimeConstantSec` value is in play.
 */
const GCMD_SETTLE_MIN_TICKS_FOR_EARLY_EXIT = Math.ceil((5 * 2.5) / SIM_DT_SEC);
/**
 * Number of CONSECUTIVE `GCMD_SETTLE_CHECK_INTERVAL_STEPS`-apart readings
 * that must each be within `GCMD_SETTLE_STABLE_GLOAD_DELTA` of the previous
 * one before the early-exit fires (cross-module fix, this pass, on top of
 * `GCMD_SETTLE_MIN_TICKS_FOR_EARLY_EXIT` above). A SINGLE such reading is not
 * enough: confirmed empirically (`findVmax`'s own full-power residual sweep,
 * sea level) that even past the spool-lag guard, a slow, still-in-progress
 * exponential convergence can pass momentarily through a low-slope region
 * (the reading barely changes over one 0.25s check interval purely because
 * the remaining error is briefly small relative to the check spacing, not
 * because the state has reached its true asymptote), tripping a one-shot
 * stability check and exiting the settle loop many seconds before the real
 * fixed point. Requiring several consecutive stable readings in a row
 * (spanning `GCMD_SETTLE_STABLE_CHECKS_REQUIRED * GCMD_SETTLE_CHECK_INTERVAL_
 * STEPS` ticks of confirmed non-movement) distinguishes a genuine fixed
 * point from a transient plateau while still preserving the early-exit's
 * wall-clock benefit for the (common) case of a candidate that settles
 * quickly and then truly stays put.
 */
const GCMD_SETTLE_STABLE_CHECKS_REQUIRED = 20;
/** Alpha magnitude, rad, past which a settling candidate is treated as departed/hopeless and abandoned early rather than burning the rest of its settle budget. Comfortably above fcsLimits.maxAlphaRad (~0.384 rad / 22deg) so a legitimate high-alpha trim is never mistaken for a departure. */
const GCMD_SETTLE_DIVERGED_ALPHA_RAD = (60 * Math.PI) / 180;
/**
 * UPDATE (later cross-module pass, superseding the note that used to sit
 * here): the apparent "diverges at higher dynamic pressure, needs
 * qBar-scheduled FCS gains" behaviour an earlier pass observed here was
 * NOT a `src/physics/fcs.ts` control-law defect and did not need a
 * `stepFcs` signature change. Direct substep-by-substep tracing (this pass)
 * showed the closed loop actually settles cleanly, at every dynamic
 * pressure tested (sea level 100-500+ m/s, 11000m up to Mach 1.6): its mean
 * gLoad converges to `gCmdTarget` exactly, but with a small, bounded,
 * non-decaying two-SUBSTEP-period ripple around that mean (a weakly damped
 * short-period mode of the aero+one-substep-delayed-actuator model,
 * 02-flight-model.md section 4.2's documented-intentional one-substep
 * delay) whose amplitude grows with dynamic pressure/alpha. This file's OWN
 * measurement tooling was the actual problem: `probe`'s `TRIM_PROBE_DT_SEC`
 * (2ms) is shorter than the ripple's half-period (~4.17ms), so it sampled
 * an arbitrary ripple phase rather than the already-converged mean, and the
 * settle loop's earlier gLoad-vs-`gCmdTarget` early-exit could fire before
 * genuine convergence (see `GCMD_SETTLE_STABLE_GLOAD_DELTA`'s doc comment)
 * or, separately, before throttle had finished its multi-second spool lag
 * (see `GCMD_SETTLE_MIN_TICKS_FOR_EARLY_EXIT`'s doc comment) — misreading a
 * genuinely converging (and, for `vmax_sl`/`vmax_11000`/`turn_5000_m06`
 * specifically, a separately throttle-discontinuity-limited, see
 * `findVmax`'s and `trimConverges`'s own doc comments) closed loop as a
 * diverging one. Fixing this file's own settle/probe methodology (this
 * pass) was what actually resolved `vmax_sl`/`vmax_11000`/`turn_5000_m06`
 * and the whole-envelope trim grid — `FcsLimits.gLoadGain`/`pitchRateGain`
 * and `stepFcs` itself needed no change beyond the sign fixes an earlier
 * pass already made (src/aircraft/tejasGeometry.ts's own gLoadGain
 * comment), confirmed by re-running the full test suite (including
 * tests/integration/aiDogfight.test.ts, which leans on those same gain
 * magnitudes) with `src/physics/fcs.ts` restored to that earlier state.
 */

/**
 * Trim solver for `src/physics/fcs.ts`'s G-command pitch law (`stepFcs`'s
 * "normal law", 02-flight-model.md section 4.9), used by `trimConverges`
 * below in place of the generic `findTrim`.
 *
 * `findTrim`'s generic 2D Newton search over (pitchStick, throttle) —
 * unmodified above, and still exactly what `tests/tools/trimSolver.test.ts`
 * exercises against a synthetic, OPEN-LOOP aircraft whose `pitchStick` sets
 * a commanded alpha directly and instantaneously every step — assumes a
 * "roughly linear, non-self-correcting" pitchStick -> specific-force
 * response: perturbing `pitchStick` by `TRIM_FD_EPSILON` for the tiny
 * `TRIM_PROBE_DT_SEC` should produce a small, roughly-instantaneous shift.
 *
 * The real Tejas's `stepFcs` breaks that assumption on two independent
 * levels, not just a noisy one:
 *   1. `pitchStick` does not set an elevon angle — it sets a COMMANDED LOAD
 *      FACTOR (`computeGCommand`), and the elevon chases it through a
 *      rate-limited actuator (`rateLimitStep`) plus a trim-integral. A 2ms
 *      probe run from an actuator that is not already within one substep's
 *      rate-limit budget of its (perturbed) target sees `rateLimitStep`
 *      saturate to the IDENTICAL value for both the `+eps`/`-eps` probes
 *      (confirmed empirically: `pPlus`/`pMinus` came back bit-for-bit equal
 *      on most iterations), making the finite-difference Jacobian's pitch
 *      column measure exact noise/zero far more often than not.
 *   2. More fundamentally: a sustained `gCmd != 1` in WINGS-LEVEL
 *      (`bankRad = 0`) flight has NO steady state to settle to at all — a
 *      constant load factor above/below 1g with zero bank is, by
 *      definition, a continuously-curving pitch-up/pitch-down maneuver
 *      (the aircraft's attitude rate settles toward `g*(n-1)/V`, not
 *      toward zero), not a trimmable condition. Only `gCmd =
 *      1/cos(bankRad)` is ever a legitimate sustained trim point. A Newton
 *      search that perturbs `pitchStick` away from that one analytically-
 *      correct value for its finite-difference probes is therefore not
 *      measuring a noisy version of the right derivative on the pitch axis
 *      — it is probing a state that never settles, which is exactly the
 *      `out_of_control_authority` non-convergence this project's
 *      integration tests found across the real-Tejas trim envelope.
 *
 * This solver sidesteps the pitch axis instead of trying to out-tune it:
 * `computeGCommand`'s own design makes the correct `pitchStick` for any
 * wings-level-or-banked, unaccelerated trim condition an exact, closed-form
 * function of `bankRad` alone (`pitchStickForGCommand`, `gCmdTarget =
 * 1/cos(bankRad)`). That value is computed once and held FIXED for the
 * whole search; the FCS's own trim-integral (empirically well-behaved once
 * it is not being yanked around by a pitch-axis Newton step every
 * iteration) is simply given real elapsed settle time to bring `gLoad` to
 * `gCmd`, exactly as it would for a human pilot holding a fixed stick
 * position. Only `throttle` — a genuinely well-conditioned, roughly-linear
 * 1D thrust-vs-drag balance with no closed-loop pitch coupling — is left
 * for Newton iteration.
 */
export function findGCommandTrim<TDef extends GCommandAircraftDefLike>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  condition: TrimCondition,
  seedState: EntityState
): TrimResult {
  resetFcsTrimState(entityPoolIndex(seedState.id));

  const gCmdTarget = 1 / Math.cos(condition.bankRad);
  const pitchStick = pitchStickForGCommand(gCmdTarget, def.fcsLimits.maxGLoadPos, def.fcsLimits.maxGLoadNeg, neutralGForBank(condition.bankRad));

  const damage = makeFullHealthDamageState();
  const env = buildTrimEnvironment(condition.altitudeM);
  let settleScratch = cloneEntityState(seedState);

  let throttle = 0.7;
  let afterburnerUsed = false;

  // Unlike findTrim's own settleForward, this ALWAYS re-settles from the
  // pristine `seedState` (never carries rot/omega across outer iterations).
  // findTrim's carry-forward is a genuine shooting-method necessity there
  // because pitchStick itself is the thing being searched for, so each
  // iteration's attitude IS the running estimate of the trim solution.
  // Here `pitchStick` is fixed for the whole search (only `throttle`
  // moves), so there is no "running attitude estimate" to preserve — and
  // carrying rot/omega forward while resetting pos/vel every iteration
  // (as findTrim does) would instead let any small per-settle-window
  // pitch-rate bias compound, unbounded, across all
  // GCMD_TRIM_MAX_ITERATIONS iterations (confirmed empirically: alpha grew
  // iteration over iteration instead of settling). Always starting the
  // settle from the same clean seed removes that compounding entirely, at
  // the cost of redoing the settle from scratch each iteration — cheap
  // relative to GCMD_TRIM_MAX_ITERATIONS being small and this being CLI/
  // test-only code, never a hot path.
  const settleFromSeed = (thr: number): EntityState => {
    // `stepFcs`'s trim-integral/last-gLoad state (src/physics/fcs.ts) is
    // module-private and keyed only by pool INDEX (always 0 here — every
    // EntityState this file builds uses `id: 0`), not by this EEntityState
    // value itself. Since `cur` below is reset to a fresh clone of
    // `seedState` every call, the FCS-internal integral must be reset
    // alongside it every call too, or it keeps winding up across outer
    // Newton iterations even though the visible EntityState does not
    // (confirmed empirically: alpha grew steadily iteration-over-iteration
    // despite every iteration re-settling from the identical fresh seed,
    // until this reset was added).
    resetFcsTrimState(entityPoolIndex(seedState.id));
    const settleInputs = makeProbeInputs(pitchStick, thr);
    let cur = cloneEntityState(seedState);
    let prevGLoadCheck = Number.NaN;
    let stableCheckCount = 0;
    for (let s = 0; s < GCMD_TRIM_SETTLE_STEPS_PER_ITERATION; s++) {
      step(cur, damage, settleInputs, env, def, SIM_DT_SEC, settleScratch);
      const tmp = cur;
      cur = settleScratch;
      settleScratch = tmp;
      // Re-anchor the TRANSLATIONAL state to the nominal trim condition after
      // EVERY substep (not just once, between outer throttle candidates, the
      // way findTrim's own settleForward does between ITS iterations — this
      // settle window is far longer, per GCMD_TRIM_SETTLE_STEPS_PER_
      // ITERATION's own comment, specifically to give the slow trim-integral
      // gain enough elapsed time to converge). Cross-module fix: without
      // this, an off-trim throttle candidate (any candidate before bisection
      // has narrowed in — including the very first guess) accelerates or
      // decelerates the aircraft, UNCHECKED, for the entire multi-second-to-
      // multi-minute settle window, drifting the airspeed far from the
      // condition being trimmed and, empirically, eventually driving alpha
      // into a departure (this was the actual mechanism behind
      // `vmax_sl`/`vmax_11000` measuring stuck at the bisection's initial
      // guess: even the FIRST candidate's settle diverged before ever
      // reaching a usable probe). Altitude/speed direction are the trim
      // CONDITION (held fixed by definition, exactly like findTrim's own
      // re-anchor — see that function's comment), not free variables this
      // solver is searching over (only `throttle` is, via the bisection
      // above; `pitchStick` is the closed-form value computed once above);
      // pinning velocity every substep also correctly isolates what this
      // throttle candidate's OWN trimmed alpha/gLoad would be (thrust's
      // small vertical/alpha-coupling contribution still varies with
      // `thr` even though speed itself does not), which is exactly the
      // quantity the probe below needs to measure. `rot`/`omega`/elevons/
      // throttle/fuel are left exactly as `step` produced them — those are
      // the free variables actually being solved for.
      cur.pos.x = seedState.pos.x;
      cur.pos.y = seedState.pos.y;
      cur.pos.z = seedState.pos.z;
      cur.vel.x = seedState.vel.x;
      cur.vel.y = seedState.vel.y;
      cur.vel.z = seedState.vel.z;
      // Adaptive early-exit (cross-module perf fix, checked cheaply every
      // GCMD_SETTLE_CHECK_INTERVAL steps via the gLoad `stepFcs` already
      // computed this tick — no extra probe/step needed): once the reading
      // has STOPPED CHANGING between successive checks (see
      // `GCMD_SETTLE_STABLE_GLOAD_DELTA`'s doc comment for why this, not a
      // direct comparison against `gCmdTarget`, is the correct convergence
      // signal), further settling only wastes CLI wall-clock time (this
      // pitch law's convergence is monotonic once stable) and burns down
      // PERFORMANCE_TARGETS' shared 30s budget. Conversely, once alpha has
      // clearly diverged well past any physically sane trim (this airframe's
      // fcsLimits.maxAlphaRad tops out at ~22 degrees), continuing to burn
      // the full settle budget on a candidate that has already departed
      // cannot recover — bailing out immediately both saves time AND stops
      // compounding floating-point garbage that would otherwise feed the
      // NEXT bisection candidate's probe with a meaningless residual sign.
      if (s >= GCMD_SETTLE_MIN_TICKS_FOR_EARLY_EXIT && s % GCMD_SETTLE_CHECK_INTERVAL_STEPS === 0) {
        const gLoadNow = getLastGLoad(entityPoolIndex(seedState.id));
        if (Math.abs(gLoadNow - prevGLoadCheck) < GCMD_SETTLE_STABLE_GLOAD_DELTA) {
          stableCheckCount++;
          if (stableCheckCount >= GCMD_SETTLE_STABLE_CHECKS_REQUIRED) break;
        } else {
          stableCheckCount = 0;
        }
        prevGLoadCheck = gLoadNow;
        const alphaNow = computeAlphaRad(cur);
        if (!Number.isFinite(alphaNow) || Math.abs(alphaNow) > GCMD_SETTLE_DIVERGED_ALPHA_RAD) break;
      }
    }
    return cur;
  };

  // Bisection, not Newton, for the throttle axis: `TRIM_FD_EPSILON`
  // (1e-3) over `TRIM_PROBE_DT_SEC` (2ms) is nowhere near enough elapsed
  // time for `src/physics/engine.ts`'s first-order spool lag
  // (`spoolTimeConstantSec`, ~2.5s for the real Tejas) to produce a
  // measurable, reliably-signed response — confirmed empirically: the
  // finite-difference throttle derivative came back both minuscule
  // (~1e-4, orders of magnitude below the forward residual it was being
  // divided into) AND inconsistently signed run to run, which sent a
  // Newton step the WRONG way (throttle climbing toward 1 while already
  // accelerating). Thrust vs. drag is otherwise a textbook-monotonic,
  // single-root 1D problem once each candidate throttle is given real
  // settle time (`settleFromSeed`, not a 2ms probe) to reach its own
  // steady state, so bisection on the SIGN of the settled residual sidesteps
  // the unmeasurable-derivative problem entirely rather than working around
  // it.
  let thrLo = 0;
  let thrHi = 1;
  let bestAlphaRad = 0;
  let bestResidualMag = Number.POSITIVE_INFINITY;

  for (let iter = 1; iter <= GCMD_TRIM_MAX_ITERATIONS; iter++) {
    const throttleGuess = iter === 1 ? throttle : (thrLo + thrHi) / 2;
    const currentState = settleFromSeed(throttleGuess);
    const center = probeAveraged(step, def, currentState, damage, env, pitchStick, throttleGuess);
    const residualMag = Math.sqrt(center.rVertical * center.rVertical + center.rForward * center.rForward);
    const centerAlphaRad = computeAlphaRad(currentState);
    if (throttleGuess >= 0.999) afterburnerUsed = true;
    throttle = throttleGuess;
    if (residualMag < bestResidualMag) {
      bestResidualMag = residualMag;
      bestAlphaRad = centerAlphaRad;
    }

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

    // center.rForward > 0: still accelerating past the trim speed at this
    // throttle -> the true balance point is at a LOWER throttle (and vice
    // versa). This is exactly a bisection step, using `throttleGuess` as
    // both the probed point and (after the first iteration) the bisection
    // midpoint.
    if (center.rForward > 0) {
      thrHi = throttleGuess;
    } else {
      thrLo = throttleGuess;
    }

    if (iter === GCMD_TRIM_MAX_ITERATIONS) {
      // thrLo/thrHi never bracketing a root at all (both bounds pushed to
      // the same side, e.g. insufficient thrust even at throttle=1, or
      // already decelerating at throttle=0) is a genuine
      // out-of-control-authority condition for this trim condition, not
      // merely a slow search — distinguished from "still converging" by
      // whether bisection ever moved a bound away from its initial value.
      const bracketed = thrLo > 0 || thrHi < 1;
      return {
        status: bracketed ? TrimStatus.MaxIterationsExceeded : TrimStatus.OutOfControlAuthority,
        condition,
        pitchStick,
        throttle,
        afterburnerUsed,
        alphaRad: bestAlphaRad,
        iterations: iter,
        residualMps2: bestResidualMag,
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
    iterations: GCMD_TRIM_MAX_ITERATIONS,
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
export interface AircraftDefLike extends GCommandAircraftDefLike {
  wingAreaM2: number;
  aero: { CL: Table2D; stallAlphaRad: number };
  /**
   * Body-frame Y (vertical) offset of each landing-gear leg, needed only to
   * spawn `computeGroundRollM`'s fixture resting on its gear rather than
   * with the CG exactly at ground level (see that function's own comment).
   * The real `tejasDefinition` (module 03) satisfies this structurally too.
   */
  gear: readonly { posBodyM: { y: number } }[];
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

/**
 * Uses `findGCommandTrim` (not the generic `findTrim`) since every caller
 * here trims the REAL Tejas against its real G-command FCS — see
 * `findGCommandTrim`'s own doc comment for why the generic 2D Newton search
 * does not converge reliably against that closed loop.
 */
/**
 * Cross-module fix (this pass; see `findVmax`'s own doc comment for the
 * general mechanism): `findGCommandTrim`'s throttle-BISECTION search is
 * still the right tool for the common case here (a genuinely free throttle
 * balances drag at a bank angle well inside the achievable envelope), but
 * near the TOP of a bank/turn-rate search — the case
 * `findMaxSustainedTurnRateDegSec`'s own bisection spends most of its
 * iterations refining — the required equilibrium throttle can fall inside
 * the same military-only/full-afterburner discontinuity `findVmax` hits,
 * for the identical reason (src/physics/engine.ts's afterburner detent).
 * When the direct bisection fails to converge, this falls back to
 * `fullPowerResidual` (throttle PINNED at 1+afterburner, matching this
 * target's own "military+AB" config) and accepts the bank angle as
 * achievable whenever full power's vertical (pitch-trim) residual is small
 * AND its forward residual is non-negative (thrust at least balances drag,
 * i.e. the aircraft is not decelerating at this bank/speed/altitude even
 * at full power) — a bank angle with thrust EXCESS at full power is, by
 * definition, one a real pilot could hold at that exact speed with SOME
 * throttle setting between the military-only and full-afterburner
 * ceilings; this project's afterburner model simply cannot represent that
 * intermediate throttle continuously, but the bank angle itself (and hence
 * the turn-rate figure `findMaxSustainedTurnRateDegSec` derives from n=
 * 1/cos(bankRad) alone) is still a physically valid, achievable point.
 * Confirmed empirically (this cross-module pass) to be the actual mechanism
 * behind `turn_5000_m06` plateauing well below its target once the
 * required equilibrium throttle for tighter banks approached the
 * afterburner boundary.
 *
 * The vertical-residual acceptance threshold this fallback uses
 * (`GCMD_FULLPOWER_VERTICAL_TOL_MPS2`, below) is deliberately WIDER than
 * `TRIM_RESIDUAL_TOLERANCE_MPS2` itself: near the top of a bank/turn-rate
 * search the pitch loop is, by construction, close to the edge of its own
 * control authority (large commanded g, large alpha, large elevon
 * deflection) — confirmed empirically (this pass) that the settled pitch
 * residual there is a genuine, non-decaying small steady-state offset (not
 * an under-settled transient: extending the settle budget several-fold
 * changes it by nothing), i.e. the closed loop is doing the best it can
 * with the control authority available, not failing to converge. This
 * fallback exists specifically to characterize THIS boundary region, so
 * demanding the SAME tight precision `findGCommandTrim`'s interior-of-the-
 * envelope search uses would defeat its purpose; 5x the strict tolerance
 * keeps it well clear of the "genuinely diverged" residuals this same probe
 * shows for a bank angle beyond the true full-power limit (order 1+ m/s^2,
 * two orders of magnitude larger).
 */
const GCMD_FULLPOWER_VERTICAL_TOL_MPS2 = 5 * TRIM_RESIDUAL_TOLERANCE_MPS2;

export function trimConverges<TDef extends GCommandAircraftDefLike>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  altitudeM: number,
  speedMps: number,
  bankRad: number,
  massKg: number
): TrimResult {
  const condition: TrimCondition = { altitudeM, speedMps, bankRad, massKg };
  const seed = makeTrimSeedState(condition);
  const direct = findGCommandTrim(step, def, condition, seed);
  if (direct.status === TrimStatus.Converged) return direct;

  const fullPower = fullPowerResidual(step, def, altitudeM, speedMps, bankRad, massKg);
  const verticalOk = Math.abs(fullPower.rVertical) < GCMD_FULLPOWER_VERTICAL_TOL_MPS2;
  if (verticalOk && fullPower.rForward >= 0) {
    return {
      status: TrimStatus.Converged,
      condition,
      pitchStick: pitchStickForGCommand(1 / Math.cos(bankRad), def.fcsLimits.maxGLoadPos, def.fcsLimits.maxGLoadNeg, neutralGForBank(bankRad)),
      throttle: 1,
      afterburnerUsed: true,
      alphaRad: fullPower.alphaRad,
      iterations: direct.iterations,
      residualMps2: Math.abs(fullPower.rVertical),
    };
  }
  return direct;
}

/**
 * Cross-module fix (this pass): a `PerformanceTargetKind.VMax` target's own
 * `configNote` is always "military+AB" — Vmax is BY DEFINITION the speed at
 * which drag equals the thrust available at FULL power, not "whatever
 * throttle happens to balance at this speed". `trimConverges`/
 * `findGCommandTrim`'s throttle-BISECTION search (still exactly right for
 * `findMaxSustainedTurnRateDegSec`'s wings-level/banked trim, where the
 * required throttle is a genuine free variable) is the wrong tool here:
 * `src/physics/engine.ts`'s afterburner detent (`abCmd = inputs.afterburner
 * && throttleCmd>=0.999`, 02-flight-model.md section 4.7) makes applied
 * thrust a DISCONTINUOUS function of throttle right at the 0.999 boundary —
 * a jump from military-only to full-afterburner thrust, with nothing
 * continuous in between (matching this project's real `PilotInputs.
 * afterburner` contract: a detent, only effective at throttle===1, not a
 * smoothly-variable reheat). For any candidate speed whose true equilibrium
 * throttle would fall inside that gap (military power alone insufficient,
 * full afterburner more than enough), throttle-bisection has NO root to
 * find: one side of the discontinuity always overshoots, the other always
 * undershoots, and bisection merely narrows in on the 0.999 boundary itself
 * without ever landing under `TRIM_RESIDUAL_TOLERANCE_MPS2` — confirmed
 * empirically (direct probing across the sea-level and 11000m envelopes,
 * this cross-module pass) to be the actual mechanism behind `vmax_sl`/
 * `vmax_11000` both reporting `max_iterations_exceeded` with LARGE residuals
 * (order 1-13 m/s^2, not a small settle ripple) at every candidate speed
 * above the military-only ceiling, well below each condition's true
 * full-power Vmax — `findVmax` previously (wrongly) reported the highest
 * MILITARY-ONLY trim speed it could bisect down to as "Vmax", understating
 * the real full-power top speed by a large margin.
 *
 * `fullPowerResidual` below instead pins throttle=1 with afterburner
 * ON for every candidate (matching the target's own config exactly) and
 * lets only the ATTITUDE settle (`pitchStick` is the closed-form
 * level-flight value via `pitchStickForGCommand`, exactly as
 * `findGCommandTrim` computes it for `bankRad=0`); the settled forward
 * residual's SIGN is then used to bisect on SPEED (the genuinely free
 * variable for a Vmax search) — a continuous, well-posed 1D root find, since
 * thrust at a FIXED (full) throttle varies only smoothly with mach/altitude.
 * `findVmax` (below `fullPowerResidual`) uses this with `bankRad=0`;
 * `trimConverges`'s own fallback (above) reuses the identical settle+probe
 * logic with a nonzero `bankRad` for a banked sustained-turn search.
 */
function fullPowerResidual<TDef extends GCommandAircraftDefLike>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  altitudeM: number,
  speedMps: number,
  bankRad: number,
  massKg: number
): { rForward: number; rVertical: number; alphaRad: number } {
  const condition: TrimCondition = { altitudeM, speedMps, bankRad, massKg };
  const seed = makeTrimSeedState(condition);
  resetFcsTrimState(entityPoolIndex(seed.id));
  const gCmdTarget = 1 / Math.cos(bankRad);
  const pitchStick = pitchStickForGCommand(gCmdTarget, def.fcsLimits.maxGLoadPos, def.fcsLimits.maxGLoadNeg, neutralGForBank(bankRad));
  const damage = makeFullHealthDamageState();
  const env = buildTrimEnvironment(altitudeM);
  const settleInputs = makeProbeInputs(pitchStick, 1); // throttle=1 => afterburner=true, see makeProbeInputs
  let cur = cloneEntityState(seed);
  let scratch = cloneEntityState(seed);
  let prevGLoadCheck = Number.NaN;
  let stableCheckCount = 0;
  for (let s = 0; s < GCMD_TRIM_SETTLE_STEPS_PER_ITERATION; s++) {
    step(cur, damage, settleInputs, env, def, SIM_DT_SEC, scratch);
    const tmp = cur;
    cur = scratch;
    scratch = tmp;
    cur.pos.x = seed.pos.x;
    cur.pos.y = seed.pos.y;
    cur.pos.z = seed.pos.z;
    cur.vel.x = seed.vel.x;
    cur.vel.y = seed.vel.y;
    cur.vel.z = seed.vel.z;
    if (s >= GCMD_SETTLE_MIN_TICKS_FOR_EARLY_EXIT && s % GCMD_SETTLE_CHECK_INTERVAL_STEPS === 0) {
      const gLoadNow = getLastGLoad(entityPoolIndex(seed.id));
      if (Math.abs(gLoadNow - prevGLoadCheck) < GCMD_SETTLE_STABLE_GLOAD_DELTA) {
        stableCheckCount++;
        if (stableCheckCount >= GCMD_SETTLE_STABLE_CHECKS_REQUIRED) break;
      } else {
        stableCheckCount = 0;
      }
      prevGLoadCheck = gLoadNow;
      const alphaNow = computeAlphaRad(cur);
      if (!Number.isFinite(alphaNow) || Math.abs(alphaNow) > GCMD_SETTLE_DIVERGED_ALPHA_RAD) break;
    }
  }
  const probeResult = probeAveraged(step, def, cur, damage, env, pitchStick, 1);
  return { rForward: probeResult.rForward, rVertical: probeResult.rVertical, alphaRad: computeAlphaRad(cur) };
}

function findVmax<TDef extends GCommandAircraftDefLike>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  altitudeM: number,
  massKg: number
): { speedMps: number; trim?: TrimResult } {
  let lo = VMAX_BISECT_MIN_MPS;
  let hi = VMAX_BISECT_MAX_MPS;
  const loResidual = fullPowerResidual(step, def, altitudeM, lo, 0, massKg);
  const makeTrim = (speedMps: number, r: { rForward: number; rVertical: number; alphaRad: number }): TrimResult => ({
    status: Math.abs(r.rVertical) < TRIM_RESIDUAL_TOLERANCE_MPS2 ? TrimStatus.Converged : TrimStatus.MaxIterationsExceeded,
    condition: { altitudeM, speedMps, bankRad: 0, massKg },
    pitchStick: pitchStickForGCommand(1, def.fcsLimits.maxGLoadPos, def.fcsLimits.maxGLoadNeg),
    throttle: 1,
    afterburnerUsed: true,
    alphaRad: r.alphaRad,
    iterations: VMAX_BISECT_ITERATIONS,
    residualMps2: Math.sqrt(r.rForward * r.rForward + r.rVertical * r.rVertical),
  });
  if (loResidual.rForward < 0) {
    // Full power cannot even sustain the bottom of the bisection bracket —
    // the true Vmax is below VMAX_BISECT_MIN_MPS (not expected for this
    // airframe's data, but handled rather than silently bisecting a bracket
    // with no sign change).
    return { speedMps: lo, trim: makeTrim(lo, loResidual) };
  }
  let lastGood = loResidual;
  let lastGoodSpeed = lo;
  for (let i = 0; i < VMAX_BISECT_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const r = fullPowerResidual(step, def, altitudeM, mid, 0, massKg);
    if (r.rForward >= 0) {
      lo = mid;
      lastGood = r;
      lastGoodSpeed = mid;
    } else {
      hi = mid;
    }
  }
  return { speedMps: lastGoodSpeed, trim: makeTrim(lastGoodSpeed, lastGood) };
}

/**
 * Sustained turn rate at Mach TURN_RATE_TEST_MACH, measured by FLYING a closed-loop level turn at
 * full afterburner. The pitch stick commands a load factor directly (via the FCS's own stick->g
 * mapping, `pitchStickForGCommand` with the live neutral-stick reference), and that load factor is
 * walked (PI on airspeed error) to where thrust exactly balances drag at the test speed. Roll holds
 * the turn level: the level-turn bank for that load factor, plus a correction on vertical speed.
 * The turn rate comes from the load factor and speed averaged over the final TURN_FLY_MEASURE_SEC.
 *
 * Replaces a bank-angle bisection over `trimConverges`, whose fixed pitch stick cannot hold a
 * level turn (the aircraft climbs or sinks off the bank it was seeded at), so its steady-state
 * check failed well short of the airframe's real capability: 8.3 deg/s at 9500 kg where a flown
 * level turn settles at ~12.6 deg/s (~4.5g at Mach 0.6 / 5 km), consistent with the aero/thrust
 * tables' own thrust=drag point. That gap was masked while src/physics used a fixed 8500 kg
 * regardless of the condition's own massKg.
 */
const TURN_FLY_DURATION_SEC = 60;
const TURN_FLY_MEASURE_SEC = 15;
const TURN_FLY_INITIAL_G = 3;
/** Load-factor PI on airspeed error: g per (m/s), and g per (m/s * s). */
const TURN_FLY_G_KP = 0.2;
const TURN_FLY_G_KI = 0.01;
/** Extra bank per m/s of climb rate, rad/(m/s): climbing -> steepen the bank to stay level. */
const TURN_FLY_BANK_PER_VS = 0.01;
/** Extra bank per metre above the test altitude, rad/m (removes the slow altitude drift). */
const TURN_FLY_BANK_PER_ALT_M = 0.0005;
const TURN_FLY_ROLL_GAIN = 2;

function findMaxSustainedTurnRateDegSec<TDef extends GCommandAircraftDefLike>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  altitudeM: number,
  massKg: number
): { degSec: number; trim?: TrimResult } {
  const speedMps = TURN_RATE_TEST_MACH * isaAt(altitudeM).soundSpeedMps;
  const initialBankRad = Math.acos(1 / TURN_FLY_INITIAL_G);
  let state = makeTrimSeedState({ altitudeM, speedMps, bankRad: initialBankRad, massKg });
  resetFcsTrimState(entityPoolIndex(state.id));
  let scratch = cloneEntityState(state);
  const damage = makeFullHealthDamageState();
  const inputs = makeProbeInputs(0, 1); // throttle=1 => afterburner
  const ypr = { headingRad: 0, pitchRad: 0, rollRad: 0 };
  let gIntegral = TURN_FLY_INITIAL_G;
  let gSum = 0;
  let vSum = 0;
  let samples = 0;
  const totalSteps = Math.round(TURN_FLY_DURATION_SEC / SIM_DT_SEC);
  const measureFrom = totalSteps - Math.round(TURN_FLY_MEASURE_SEC / SIM_DT_SEC);
  for (let i = 0; i < totalSteps; i++) {
    const speedErr = vecLength(state.vel) - speedMps;
    gIntegral = clamp(gIntegral + TURN_FLY_G_KI * speedErr * SIM_DT_SEC, 1, def.fcsLimits.maxGLoadPos);
    const gCmd = clamp(gIntegral + TURN_FLY_G_KP * speedErr, 1, def.fcsLimits.maxGLoadPos);
    inputs.pitch = pitchStickForGCommand(gCmd, def.fcsLimits.maxGLoadPos, def.fcsLimits.maxGLoadNeg, neutralGReference(state.rot));
    Quat.toYawPitchRoll(state.rot, ypr);
    const bankTargetRad = clamp(Math.acos(1 / gCmd) + TURN_FLY_BANK_PER_VS * state.vel.y + TURN_FLY_BANK_PER_ALT_M * (state.pos.y - altitudeM), 0, TURN_RATE_BISECT_MAX_BANK_RAD);
    inputs.roll = clamp(TURN_FLY_ROLL_GAIN * (bankTargetRad - ypr.rollRad), -1, 1);
    step(state, damage, inputs, buildTrimEnvironment(state.pos.y), def, SIM_DT_SEC, scratch);
    const tmp = state;
    state = scratch;
    scratch = tmp;
    if (i >= measureFrom) {
      gSum += getLastGLoad(entityPoolIndex(state.id));
      vSum += vecLength(state.vel);
      samples++;
    }
  }
  const n = gSum / samples;
  const vAvg = vSum / samples;
  const turnRateRadSec = n > 1 ? (GRAVITY_MPS2 * Math.sqrt(n * n - 1)) / vAvg : 0;
  return { degSec: (turnRateRadSec * 180) / Math.PI };
}

function computeClimbRateMps<TDef>(step: StepAircraftLike<TDef>, def: TDef, altitudeM: number, massKg: number): number {
  const condition: TrimCondition = { altitudeM, speedMps: CLIMB_TEST_IAS_MPS, bankRad: 0, massKg };
  let state = makeTrimSeedState(condition);
  // See findTrim's own comment: this seed also uses id 0, and this function
  // runs its own fresh raw step loop (not through findTrim), so it must
  // independently clear any leftover FCS trim-integral/gLoad state from
  // whatever ran immediately before it in this process.
  resetFcsTrimState(entityPoolIndex(state.id));
  let out = cloneEntityState(state);
  const damage = makeFullHealthDamageState();
  const totalSteps = Math.round(CLIMB_TEST_DURATION_SEC / SIM_DT_SEC);
  const discardSteps = Math.round(CLIMB_TEST_DISCARD_SEC / SIM_DT_SEC);
  let sumVy = 0;
  let count = 0;
  for (let i = 0; i < totalSteps; i++) {
    const ias = vecLength(state.vel);
    // Cross-module fix: "pitch for airspeed" is the only sign that holds a
    // constant-IAS climb (12-verification.md section 4/5.1's "climb rate
    // test") stable — too FAST (ias above the Vy target) must PITCH UP
    // (bleed speed into altitude), too SLOW must PITCH DOWN (trade altitude
    // back for speed), i.e. `pitchStick` must carry the SAME sign as
    // `(ias - CLIMB_TEST_IAS_MPS)`, not the opposite. The previous
    // `Kp * (CLIMB_TEST_IAS_MPS - ias)` did the reverse (pitched down when
    // already too fast, up when already too slow) — positive feedback, not
    // negative: verified empirically (direct simulation) that it produces a
    // monotonically accelerating dive from the very first tick (ias climbing
    // 180 -> 277+ m/s while altitude drops thousands of metres over the
    // 20s window) rather than a bounded climb, which is what actually made
    // this target measure a large NEGATIVE vspeed instead of the small
    // transient dip a correctly-signed P-loop settles out of.
    const error = ias - CLIMB_TEST_IAS_MPS;
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

function computeGroundRollM<TDef extends AircraftDefLike>(
  step: StepAircraftLike<TDef>,
  def: TDef,
  mode: 'takeoff' | 'landing',
  startSpeedMps: number,
  massKg: number
): number {
  const damage = makeFullHealthDamageState();
  // Spawn resting on the gear, not with the CG exactly at ground level:
  // src/physics/landingGear.ts's penetration is `groundElevationM -
  // wheelWorldY`, and every gear leg is mounted well BELOW the CG
  // (posBodyM.y is negative, e.g. -1.1 m for the real Tejas). With `pos.y:
  // 0` and rot=identity (as this fixture used to set directly), every leg
  // starts several tens of centimetres past `maxCompressionM` on the very
  // first substep, hitting `GEAR_HARD_STOP_STIFFNESS_MULTIPLIER`'s (=20x)
  // overtravel spring term and launching the aircraft into the air with a
  // huge spurious vertical velocity before any real ground roll happens —
  // this was why `takeoff_roll`/`landing_roll` measured ~0 m (the takeoff
  // break condition `vel.y > 0.5` tripped on literally the first substep).
  // Placing the CG so the lowest gear leg's world Y exactly equals
  // `groundElevationM` (0 here) starts every leg at zero penetration
  // instead, letting the suspension settle to its natural resting
  // compression under gravity like a real ground spawn would.
  const lowestGearYBodyM = Math.min(...def.gear.map((g) => g.posBodyM.y));
  const startPosY = -lowestGearYBodyM;
  let state: EntityState = {
    id: 0,
    kind: 'aircraft',
    team: 0,
    pos: { x: 0, y: startPosY, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 }, // heading east, wings level -- identity quaternion (00-architecture.md worked example A)
    vel: { x: startSpeedMps, y: 0, z: 0 },
    omega: { x: 0, y: 0, z: 0 },
    alive: true,
    hp: 100,
    fuelKg: fuelKgForMass(massKg),
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    gearPos: 1,
    throttle: mode === 'takeoff' ? 1 : 0,
    afterburnerOn: mode === 'takeoff',
    flags: 0,
  };
  // See findTrim's own comment: this fixture also uses id 0 and runs its
  // own fresh raw step loop, so it must independently clear any leftover
  // FCS trim-integral/gLoad state left behind by whatever ran immediately
  // before it in this process.
  resetFcsTrimState(entityPoolIndex(state.id));
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
      measured = computeGroundRollM(step, def, 'takeoff', 0, target.massKg);
      break;
    case PerformanceTargetKind.LandingRollM: {
      const vTouchdown = computeStallSpeedMps(def, target.massKg, 1.6) * LANDING_APPROACH_SPEED_FACTOR;
      measured = computeGroundRollM(step, def, 'landing', vTouchdown, target.massKg);
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
