/**
 * =============================================================================
 * TEJAS SIM — VERIFICATION CONTRACT (docs/spec/contracts/verify.ts)
 * =============================================================================
 * Owner: module 12 (docs/spec/12-verification.md). Implements `tools/sim-check.ts`,
 * `tests/**`, `scripts/**`.
 *
 * This file contains ONLY interfaces, type aliases, `as const` objects, derived
 * union types, bare function-signature type aliases, and trivial pure constant
 * arithmetic (matching the precedent set by `contracts/core.ts`'s own
 * `entityFieldOffset`/`HUD_BLOCK_START`/`SNAPSHOT_BYTES`). NO classes with
 * bodies, NO control flow, NO executable algorithm. It must compile standalone
 * with `tsc --noEmit --strict`, importing only from `./core`.
 *
 * WHY THIS FILE DOES NOT IMPORT `./flight` or `./aircraft`:
 * Module 12 is drafted in parallel with, and cannot read, `contracts/flight.ts`
 * (module 02) or `contracts/aircraft.ts` (module 03). `00-architecture.md`
 * section 9.1 nonetheless PINS DOWN the exact shape of `StepAircraft` and its
 * `Environment` parameter (both reproduced verbatim below as `StepAircraftLike`
 * / `EnvironmentLike`, generic over an opaque `TDef` standing in for the
 * not-yet-seen `AircraftDefinition`). Because section 9.1 is normative, this
 * duplication is safe: at integration time `tools/sim-check.ts` (an
 * IMPLEMENTATION file, not a contract, so free to import anything) imports the
 * real `StepAircraft` and `AircraftDefinition` from `src/physics` and
 * `src/aircraft` and passes them wherever this contract asks for
 * `StepAircraftLike<TDef>` / `TDef` — TypeScript structural typing makes the
 * real, fully-typed functions assignable to these generic signatures with no
 * adapter code required, PROVIDED module 02/03 keep the section-9.1 shape.
 *
 * WHY `SimWorldHandle` IS DELIBERATELY NARROW:
 * The AI-vs-AI dogfight test and the full-world determinism test need a
 * running simulation (entity pool, Pilots, combat) — that is module 10's
 * `contracts/sim.ts`, which this module also cannot read. `SimWorldHandle`
 * below is the minimal, structural subset of behaviour module 12's tests
 * actually call. `tests/integration/testHarness.ts` (owned by module 12, see
 * `12-verification.md` section 4.6) is the ONE file that adapts whatever
 * `src/core/index.ts` (module 10) actually exports to this shape; if module
 * 10's real factory name/signature differs, only that one adapter file needs a
 * post-integration edit — no other test file is affected. See
 * `12-verification.md` section 9 for the full rationale.
 * =============================================================================
 */

import type {
  EntityState,
  DamageState,
  PilotInputs,
  AircraftTelemetry,
  Vec3Like,
  EntityId,
  Team,
  Mission,
  AiDifficulty,
  SimEvent,
  Pilot,
  Result,
} from './core';
import { SIM_HZ } from './core';

// -----------------------------------------------------------------------------
// 1. Generic flight-model probing shapes.
//    EnvironmentLike mirrors `contracts/flight.ts`'s `Environment` EXACTLY as
//    fixed by 00-architecture.md section 9.1 — field names and types must not
//    drift from that section. StepAircraftLike<TDef> mirrors `StepAircraft`
//    from the same section, generic over the not-yet-seen AircraftDefinition.
// -----------------------------------------------------------------------------

export interface EnvironmentLike {
  airDensityKgM3: number;
  soundSpeedMps: number;
  windWorldMps: Vec3Like;
  gravityMps2: number;
  groundElevationM: number;
  groundNormalWorld: Vec3Like;
}

/** Structurally identical to `contracts/flight.ts`'s `StepAircraft` (module 02), generic over the opaque AircraftDefinition type `TDef`. Pure, allocation-free: mutates `out` in place; `state` is read-only in. */
export type StepAircraftLike<TDef> = (
  state: EntityState,
  damage: DamageState,
  inputs: PilotInputs,
  env: EnvironmentLike,
  def: TDef,
  dtSec: number,
  out: EntityState
) => void;

// -----------------------------------------------------------------------------
// 2. Trim solver — Newton's method over (pitchStick, throttle) with a
//    numerical Jacobian, probing StepAircraftLike<TDef> at a short dt. See
//    12-verification.md section 4.2 for the full algorithm.
// -----------------------------------------------------------------------------

/** Max Newton iterations before a trim search is declared non-convergent. */
export const TRIM_MAX_ITERATIONS = 60;
/** Convergence tolerance on both residuals (vertical and forward specific acceleration), m/s^2. */
export const TRIM_RESIDUAL_TOLERANCE_MPS2 = 0.02;
/** Probe step duration used to measure instantaneous acceleration from StepAircraftLike, seconds. Must be << SIM_DT_SEC*10 so the probe stays in the linear-response regime. */
export const TRIM_PROBE_DT_SEC = 0.002;
/** Finite-difference epsilon applied to pitchStick/throttle when building the numerical Jacobian. */
export const TRIM_FD_EPSILON = 1e-3;
/** Damping factor applied to each raw Newton step before clamping to input bounds (prevents overshoot divergence near stall/high-alpha nonlinearity). */
export const TRIM_STEP_DAMPING = 0.6;

export interface TrimCondition {
  altitudeM: number;
  /** Target true airspeed, m/s, wings-level unaccelerated flight unless bankRad is set. */
  speedMps: number;
  /** Bank angle for a sustained-turn trim search, rad. 0 = wings-level. */
  bankRad: number;
  massKg: number;
}

export const TrimStatus = {
  Converged: 'converged',
  MaxIterationsExceeded: 'max_iterations_exceeded',
  OutOfControlAuthority: 'out_of_control_authority',
} as const;
export type TrimStatus = (typeof TrimStatus)[keyof typeof TrimStatus];

export interface TrimResult {
  status: TrimStatus;
  condition: TrimCondition;
  /** [-1,1], PilotInputs.pitch at convergence. */
  pitchStick: number;
  /** [0,1], PilotInputs.throttle at convergence. */
  throttle: number;
  /** true once throttle==1 alone cannot hold the condition and afterburner was engaged during the search. */
  afterburnerUsed: boolean;
  alphaRad: number;
  iterations: number;
  /** Residual specific force magnitude at the accepted solution, m/s^2. */
  residualMps2: number;
}

/** Generic over TDef so the contract never imports AircraftDefinition. See file header. */
export type FindTrim<TDef> = (
  step: StepAircraftLike<TDef>,
  def: TDef,
  condition: TrimCondition,
  seedState: EntityState
) => TrimResult;

// -----------------------------------------------------------------------------
// 3. Performance targets and pass/fail checking. tools/sim-check.ts's own
//    numeric target TABLE (public-domain-derived, module-12-owned; NOT sourced
//    from contracts/aircraft.ts, which this file cannot see) lives in
//    tools/lib/perfTargets.ts as data conforming to these shapes — see
//    12-verification.md sections 5 and 9 for every value and its source.
// -----------------------------------------------------------------------------

export const PerformanceTargetKind = {
  VMax: 'vmax',
  SustainedTurnRateDegSec: 'sustained_turn_rate_deg_sec',
  ClimbRateMps: 'climb_rate_mps',
  StallSpeedMps: 'stall_speed_mps',
  TakeoffRollM: 'takeoff_roll_m',
  LandingRollM: 'landing_roll_m',
} as const;
export type PerformanceTargetKind = (typeof PerformanceTargetKind)[keyof typeof PerformanceTargetKind];

export interface PerformanceTarget {
  id: string;
  kind: PerformanceTargetKind;
  description: string;
  altitudeM: number;
  massKg: number;
  /** Extra kind-specific condition, e.g. gear/flap config for takeoff/landing roll, or bank angle context for turn rate. Free-form, human-readable only — not machine-parsed beyond the numbers above. */
  configNote: string;
  targetValue: number;
  unit: string;
  /** Relative tolerance, e.g. 0.1 = +/-10%. Always paired with `sourceNote` explaining why this width was chosen (see 12-verification.md section 9). */
  toleranceRel: number;
  sourceNote: string;
}

export interface PerformanceCheckResult {
  target: PerformanceTarget;
  measured: number;
  passed: boolean;
  deltaRel: number;
  trim?: TrimResult;
}

export type CheckPerformanceTarget<TDef> = (
  step: StepAircraftLike<TDef>,
  def: TDef,
  target: PerformanceTarget
) => PerformanceCheckResult;

// -----------------------------------------------------------------------------
// 4. Determinism hashing.
// -----------------------------------------------------------------------------

/** Number of sim ticks the standard determinism test runs before comparing hashes (= 30 simulated seconds at SIM_HZ). */
export const DETERMINISM_TEST_TICKS = SIM_HZ * 30;
/** Tick interval at which an intermediate checkpoint hash is recorded, so a divergence can be localised to within this many ticks instead of only detected at the end. */
export const DETERMINISM_CHECKPOINT_INTERVAL_TICKS = SIM_HZ * 5;
/** FNV-1a 32-bit offset basis, used by HashSimState (see 12-verification.md section 4.4 for the exact byte-serialisation order). */
export const FNV1A_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
export const FNV1A_PRIME = 0x01000193;

export interface ObservedEntity {
  state: EntityState;
  damage?: DamageState;
  telemetry?: AircraftTelemetry;
}

/** Deterministic, allocation-tolerant (this runs in test/CLI code, not a hot path) hash of one tick's fully-observable state. Same input array contents (in the same order) MUST yield the same 8-hex-character string on every call, every platform. */
export type HashSimState = (entities: readonly ObservedEntity[]) => string;

export interface DeterminismCheckpoint {
  tick: number;
  hash: string;
}

export interface DeterminismResult {
  seed: number;
  ticksRun: number;
  checkpointsA: readonly DeterminismCheckpoint[];
  checkpointsB: readonly DeterminismCheckpoint[];
  matched: boolean;
  /** Tick of the first mismatching checkpoint, or undefined if matched. */
  firstDivergentTick?: number;
}

// -----------------------------------------------------------------------------
// 5. Integration test harness — the narrow, structural subset of a running
//    simulation world this module's tests need. See file header and
//    12-verification.md section 4.6 for the adapter contract.
// -----------------------------------------------------------------------------

export interface SimWorldHandle {
  readonly tick: number;
  readonly simTimeSec: number;
  /** Advances the world by exactly one SIM_DT_SEC tick (the same code path sim.worker.ts's accumulator loop calls). Must not allocate in steady state. */
  stepFixed(): void;
  spawnAircraft(
    aircraftDefId: string,
    team: Team,
    pos: Vec3Like,
    headingRad: number,
    speedMps: number,
    pilot: Pilot,
    difficulty?: AiDifficulty
  ): EntityId;
  getEntityState(id: EntityId): EntityState | undefined;
  getDamage(id: EntityId): DamageState | undefined;
  getTelemetry(id: EntityId): AircraftTelemetry | undefined;
  listAliveEntityIds(): readonly EntityId[];
  /** Returns and clears the events accumulated since the last call. */
  drainEvents(): readonly SimEvent[];
}

export type CreateTestWorld = (mission: Mission, seed: number) => Result<SimWorldHandle, string>;

// -----------------------------------------------------------------------------
// 6. AI-vs-AI headless dogfight test.
// -----------------------------------------------------------------------------

/** Hard cap on simulated dogfight duration before the test harness gives up and fails the "must terminate" requirement, seconds. */
export const DOGFIGHT_MAX_SIM_TIME_SEC = 180;
/** Derived tick cap: DOGFIGHT_MAX_SIM_TIME_SEC * SIM_HZ. */
export const DOGFIGHT_MAX_TICKS = DOGFIGHT_MAX_SIM_TIME_SEC * SIM_HZ;
/** Minimum simulated time before a `lockAcquired` event for either side is accepted as legitimate rather than an omniscient-targeting bug, seconds. See 12-verification.md section 4.7. */
export const DOGFIGHT_MIN_LOCK_TIME_SEC = 1.0;
/** Initial separation between the two spawned aircraft, metres (beyond nominal visual range, forcing sensor-mediated acquisition). */
export const DOGFIGHT_INITIAL_SEPARATION_M = 20000;
/** Minimum altitude-above-ground tolerance before a ground-collision failure is recorded, metres (accounts for gear compression / float noise, not a real margin). */
export const DOGFIGHT_MIN_ALT_AGL_TOLERANCE_M = -2;
/** Real wall-clock timeout for the vitest-run dogfight test, milliseconds. */
export const DOGFIGHT_TEST_TIMEOUT_MS = 30000;

export interface AiDogfightConfig {
  seed: number;
  difficultyTeam0: AiDifficulty;
  difficultyTeam1: AiDifficulty;
  aircraftDefId: string;
}

export interface AiDogfightResult {
  terminatedByKill: boolean;
  winnerTeam?: Team;
  ticksRun: number;
  simTimeSec: number;
  minAltAglTeam0: number;
  minAltAglTeam1: number;
  firstLockTimeSec?: number;
  groundCollision: boolean;
  cheatSuspected: boolean;
}

export type RunAiDogfight = (world: SimWorldHandle, config: AiDogfightConfig) => AiDogfightResult;

// -----------------------------------------------------------------------------
// 7. Acceptance checklist / report — the machine-readable shape
//    `scripts/ci.mjs` and `tools/sim-check.ts` both emit, and that the final
//    review agents' run of `12-verification.md` section 8 produces.
// -----------------------------------------------------------------------------

export const AcceptanceCheckId = {
  Install: 'install',
  ContractsCompile: 'contracts_compile',
  SrcCompile: 'src_compile',
  UnitTests: 'unit_tests',
  IntegrationTests: 'integration_tests',
  TrimPerformance: 'trim_performance',
  Determinism: 'determinism',
  AiDogfightVeteran: 'ai_dogfight_veteran',
  AiDogfightAce: 'ai_dogfight_ace',
  NoAllocationHotPath: 'no_allocation_hot_path',
  Build: 'build',
  E2eSmoke: 'e2e_smoke',
  MobileSmoke: 'mobile_smoke',
} as const;
export type AcceptanceCheckId = (typeof AcceptanceCheckId)[keyof typeof AcceptanceCheckId];

export const AcceptanceStatus = {
  Pass: 'pass',
  Fail: 'fail',
  Skip: 'skip',
} as const;
export type AcceptanceStatus = (typeof AcceptanceStatus)[keyof typeof AcceptanceStatus];

export interface AcceptanceCheckResult {
  id: AcceptanceCheckId;
  status: AcceptanceStatus;
  /** Human-readable detail, e.g. a failing assertion message or a skip reason ("playwright not installed"). */
  detail: string;
  durationMs: number;
}

export interface AcceptanceReport {
  generatedAtIso: string;
  checks: readonly AcceptanceCheckResult[];
  allPassed: boolean;
}

// -----------------------------------------------------------------------------
// 8. sim-check.ts CLI surface.
// -----------------------------------------------------------------------------

export const SimCheckMode = {
  Trim: 'trim',
  Determinism: 'determinism',
  Dogfight: 'dogfight',
  All: 'all',
} as const;
export type SimCheckMode = (typeof SimCheckMode)[keyof typeof SimCheckMode];

export interface SimCheckCliOptions {
  mode: SimCheckMode;
  missionPath: string;
  seed: number;
  /** Optional path to write the AcceptanceReport-shaped JSON result to, in addition to the printed table. */
  outJsonPath?: string;
  verbose: boolean;
}

/** Exit codes tools/sim-check.ts returns via process.exitCode. 0 is the ONLY passing code; scripts/ci.mjs and CI treat anything else as failure. */
export const SimCheckExitCode = {
  Success: 0,
  PerformanceFailure: 1,
  DeterminismFailure: 2,
  DogfightFailure: 3,
  UsageError: 64,
} as const;
export type SimCheckExitCode = (typeof SimCheckExitCode)[keyof typeof SimCheckExitCode];

/** Renders a pass/fail row set as a fixed-width text table (Category | Condition | Target | Measured | Tolerance | Result). Pure formatting, no I/O. */
export type FormatPerformanceTable = (results: readonly PerformanceCheckResult[]) => string;
