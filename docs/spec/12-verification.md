# 12 — Verification harness and acceptance

Read `00-architecture.md` and `contracts/core.ts` in full before this document; they are law. This document and `contracts/verify.ts` are the complete, self-contained specification for module 12: the vitest configuration, the canonical unit-test file list for every module, `tools/sim-check.ts` (the headless trim/performance/determinism/dogfight CLI), CI wiring, and the final acceptance checklist. Module 12 is the ONLY module that writes files under `tests/`, `tools/`, and `scripts/`, and the only one that may edit `.github/workflows/ci.yml` and `vitest.config.ts` (00-architecture.md section 11).

## 1. Purpose & scope

Module 12 turns the contract graph into a mechanically-checkable pass/fail gate for the single-pass build. It does four things:

1. **Unit tests** (`tests/math`, `tests/physics`, `tests/aircraft`, `tests/terrain`, `tests/airport`, `tests/ai`, `tests/combat`, `tests/core`, `tests/tools`, `tests/render`, `tests/hud`, `tests/input`, `tests/ui`) — one file per non-trivial source file in every module. Almost all of these run under vitest's default Node environment (no DOM) — including EVERY `tests/render/**`/`tests/hud/**` file and all but one `tests/input/**`/`tests/ui/**` file, since 08/09/11's own specs deliberately keep their unit-testable surface DOM/WebGL-free. Exactly three files genuinely need a DOM (`tests/input/playerPilot.test.ts`, `tests/ui/screens.test.ts`, `tests/ui/orientationPrompt.test.ts`) and run under `jsdom` via `vitest.config.ts`'s `environmentMatchGlobs` (section 4.10); `jsdom` is accordingly in `00-architecture.md` section 2's fixed devDependency list. These are additionally covered, end-to-end, by the smoke test in section 4.8.
2. **Integration tests** (`tests/integration`) — spawn-fly-land, determinism, AI-vs-AI dogfight, contract-compile.
3. **`tools/sim-check.ts`** — a headless CLI, runnable outside vitest, that trims the Tejas across an altitude/speed grid, derives Vmax/turn-rate/climb-rate/stall-speed/takeoff-roll/landing-roll, compares each to a target table this module owns (section 5.1), and exits non-zero on any failure. It also has `determinism` and `dogfight` modes.
4. **The acceptance checklist** (section 8) — the exact command sequence the final review agents run once integration is complete.

**Everything in this module is written against contracts, not implementations.** Per `00-architecture.md`'s build order, module 12 is drafted and its test *files* are written in parallel with modules 01–11; a given test cannot *pass* until the corresponding module's implementation exists, but every test file's shape, imports, and assertions are fixed here so nothing about them is left to whoever runs the acceptance pass.

## 2. Owned files

**Who writes each file's CONTENT, versus who owns the `tests/` directory.** `00-architecture.md` section 11 makes module 12 the only module allowed to CREATE files under `tests/`, `tools/`, `scripts/` — a directory-ownership rule, not an authorship rule. For `tests/math/**`, `tests/physics/**`, `tests/core/**`, `tests/integration/**`, `tests/tools/**`, `tests/render/**`, `tests/hud/**`, `tests/input/**`, `tests/ui/**` this document (module 12) both owns the directory AND authors every assertion, because module 12 either can see the relevant contract directly (`core.ts`, `contracts/math.ts`, `contracts/sim.ts`, `contracts/verify.ts` itself) or the target functions are pure/DOM-free enough that a black-box invariant test (section 4.3) is sufficient without seeing the real internal shapes. For `tests/aircraft/**`, `tests/terrain/**`, `tests/airport/**`, `tests/ai/**`, `tests/combat/**`, however, module 12 is drafted blind to `contracts/aircraft.ts`/`contracts/terrain.ts`/`contracts/airport.ts`/`contracts/ai.ts`/`contracts/combat.ts` (00-architecture.md section 1) and genuinely cannot write assertions against those modules' real function signatures (`FlightGoal`, `ComputeTerrainAvoidanceGoal`, `StepProjectile`, quadtree functions, etc.) sight-unseen. Modules 03/04/05/06/07 each ALREADY give full, concrete, numerically-worked test bodies in their OWN section 7 (`03-tejas-data.md`, `04-terrain.md`, `05-airport.md`, `06-ai.md`, `07-combat.md`) — written by the one drafter who actually has each contract file open. The file list below reserves every such path (so nothing is silently dropped, closing the gap this document's own section 9 used to flag), but the AUTHORITATIVE test body for each `tests/{aircraft,terrain,airport,ai,combat}/**` file is the corresponding module's own section 7, copied in verbatim at scaffold/integration time — module 12 does not, and is not expected to, independently re-derive or re-verify those assertions against contract internals it cannot read. `tests/aircraft/tejasDefinition.test.ts`/`tejasAeroTables.test.ts`/`tejasEngineTables.test.ts`/`wireframe.test.ts` are the one partial exception: they use REAL public-facing symbols module 12 CAN see (`AeroTables`/`EngineTables`/`GearDefinition`/`FcsLimits`/`WireframeModel`, now pinned by `00-architecture.md` section 9.1) for the structural-invariant tests in section 4.3, supplementing rather than replacing `03-tejas-data.md`'s own section 7.

```
tests/math/vec3.test.ts              Vec3 add/sub/scale/dot/cross/normalize/lerp, out-param no-alloc contract
tests/math/quat.test.ts              multiply, rotate/rotateInverse, fromYawPitchRoll/toYawPitchRoll, slerp/nlerp, bodyRateP/Q/R
tests/math/mat3.test.ts              inertia tensor multiply/inverse/transform
tests/math/scalar.test.ts            clamp, lerp, smoothstep, wrapAngle
tests/math/table1d.test.ts           1D lookup interpolation (alpha -> coefficient)
tests/math/table2d.test.ts           2D lookup interpolation (alpha, Mach -> coefficient)
tests/math/prng.test.ts              mulberry32 determinism + distribution sanity
tests/math/filters.test.ts           low-pass filter step response

tests/physics/atmosphere.test.ts     ISA density/speed-of-sound vs altitude, known reference points
tests/physics/rigidBody.test.ts      6-DOF integration invariants (energy/momentum sanity, quaternion stays unit)
tests/physics/aeroForces.test.ts     force/moment builder structural invariants (see section 4.3)
tests/physics/engine.test.ts         thrust/fuel-burn monotonicity vs throttle/altitude
tests/physics/landingGear.test.ts    gear contact/suspension/friction structural invariants
tests/physics/fcs.test.ts            FCS control-law limiting (g-limit, AoA-limit clamping)
tests/physics/integrator.test.ts     StepAircraft signature + purity (out may alias state; state untouched otherwise)
tests/physics/allocation.test.ts     02-flight-model.md section 7 — stepAircraft called 100000x, heapUsed growth under 1 MB
tests/physics/determinism.test.ts    02-flight-model.md section 7 — bit-identical 3600-tick replay given identical seed+inputs
tests/physics/telemetry.test.ts      02-flight-model.md section 7 — computeTelemetry alpha/beta/gLoad cross-checks against stepAircraft's internal values
tests/physics/relaxedStability.test.ts  02-flight-model.md section 7/8 criterion 9 — open-loop alpha divergence + closed-loop FCS damping

tests/aircraft/tejasDefinition.test.ts    mass/inertia/geometry sanity bounds (section 4.3)
tests/aircraft/tejasAeroTables.test.ts    CL/CD/Cm table monotonicity + bounds invariants
tests/aircraft/tejasEngineTables.test.ts  F404-IN20 thrust/fuel table monotonicity invariants
tests/aircraft/wireframe.test.ts          WireframeModel edge indices valid, groups reference declared vertices

tests/terrain/noise.test.ts          simplex noise determinism (same seed/coords -> same value) + range bound
tests/terrain/heightSampler.test.ts  flattenZone blending: exact elevationM inside flatRadiusM, smoothstep in blend band
tests/terrain/quadtree.test.ts       LOD selection monotonic with camera distance
tests/terrain/chunkGeometryBuilder.test.ts  triangle count and index bounds for a known chunk size
tests/terrain/domainWarp.test.ts     04-terrain.md section 7 — warp displacement bounded per FbmParams amplitude formula
tests/terrain/fbm.test.ts            04-terrain.md section 7 — fbm octave summation matches the documented amplitude bound
tests/terrain/ridge.test.ts          04-terrain.md section 7 — ridge output stays within [0, conservative max amplitude]
tests/terrain/chunkManager.test.ts   04-terrain.md section 7 — request/cancel/evict lifecycle, MAX_RESIDENT_CHUNKS cap
tests/terrain/terrainHeight.test.ts  04-terrain.md section 7 — CreateRawTerrainHeight fixture vs. DEFAULT_TERRAIN_PARAMS reference values

tests/airport/parser.test.ts         valid JSON -> Result.ok; malformed JSON -> Result.err (never throws)
tests/airport/validator.test.ts      schema violations rejected with specific error messages
tests/airport/ils.test.ts            localiser/glideslope deviation formula, known geometry -> known deviation
tests/airport/navDb.test.ts          AirportNavDb query surface (getAirport/listAirports/nearestAirport/getRunway)
tests/airport/layouts.test.ts        rangpur-afb.json and konarak-coastal.json both parse + validate clean (05-airport.md section 7's own "builtinLayouts" coverage — same file, see that document's naming note)
tests/airport/apronGeometry.test.ts    05-airport.md section 7 — GenerateApronGeometry outline point count/winding
tests/airport/runwayGeometry.test.ts   05-airport.md section 7 — GenerateRunwayGeometry outline/centerline/threshold-bar geometry
tests/airport/surfaceIndex.test.ts     05-airport.md section 7 — AirportSurfaceIndex.frictionAt known-point lookups
tests/airport/taxiwayGeometry.test.ts  05-airport.md section 7 — GenerateTaxiwayGeometry edge-line offsets
tests/airport/papi.test.ts             05-airport.md section 7 — PapiColorAt lamp-color thresholds vs glidepath angle

tests/ai/pilotAi.test.ts             Pilot.update never allocates a new `out`, respects PilotInputs bounds
tests/ai/terrainAvoidance.test.ts    pulls up before HeightSampler collision given closing geometry
tests/ai/tacticalFsm.test.ts         state transitions are deterministic given identical PilotContext sequence
tests/ai/bfmManoeuvres.test.ts       manoeuvre outputs stay within PilotInputs [-1,1]/[0,1] bounds
tests/ai/threatEvaluation.test.ts    contact scoring ordering matches documented priority rules
tests/ai/difficultyProfiles.test.ts  06-ai.md section 7 — monotonic skill ordering across rookie/veteran/ace
tests/ai/energyState.test.ts         06-ai.md section 7 — computeEnergyHeightM worked-example values
tests/ai/formation.test.ts           06-ai.md section 7 — headingFromVelocity/computeFormationTargetPos worked examples
tests/ai/steering.test.ts            06-ai.md section 7 — steerToGoal bank/pitch/yaw/speed worked-example values
tests/ai/weaponEmployment.test.ts    06-ai.md section 7 — estimateWeaponEnvelope + launch-cooldown gating

tests/combat/gunBallistics.test.ts   bullet ballistic drop over known time-of-flight
tests/combat/leadComputingSight.test.ts  lead angle formula, known target geometry -> known pipper offset
tests/combat/irMissileSeeker.test.ts proportional navigation converges on a constant-velocity target
tests/combat/radarModel.test.ts      detection range/probability structural invariants
tests/combat/hitDetection.test.ts    known geometry -> known hit/miss
tests/combat/subsystemDamage.test.ts DamageState fields stay within [0,1]/boolean bounds after any hit sequence
tests/combat/hitDetection_rwr.test.ts  07-combat.md section 7 — RWR warning edge-detection (rising/falling) fixtures
tests/combat/proportionalNavigation.test.ts  07-combat.md section 7 — computePnAccel worked example (section 4.7)
tests/combat/radarMissile.test.ts    07-combat.md section 7 — datalink/active-seeker guidance-mode transitions
tests/combat/weaponStation.test.ts   07-combat.md section 7 — WeaponsState station count decrement, cooldown, edge-triggered launch latches

tests/core/entityPool.test.ts        packEntityId/unpackEntityId round-trip, generation increments on despawn/respawn
tests/core/snapshotWriter.test.ts    written buffer decodes via entityFieldOffset back to the source EntityState
tests/core/snapshotReader.test.ts    reader is the exact inverse of snapshotWriter for header/entity/HUD blocks
tests/core/fixedStepLoop.test.ts     accumulator ticks exactly floor(realDt/SIM_DT_SEC) times, catch-up cap at 0.25s

tests/tools/hash.test.ts             HashSimState fixed-vector regression (section 4.4)
tests/tools/trimSolver.test.ts       FindTrim against an analytic synthetic aircraft with a closed-form trim solution
tests/tools/perfTargets.test.ts      every PerformanceTarget in tools/lib/perfTargets.ts has toleranceRel in (0,1] and a non-empty sourceNote

tests/integration/contractsCompile.test.ts   shells out to scripts/checkContracts.mjs, asserts exit code 0
tests/integration/trimAndPerformance.test.ts runs tools/sim-check.ts in-process (mode=trim) against the real Tejas, asserts all PerformanceCheckResult.passed
tests/integration/determinism.test.ts        two fresh SimWorldHandles, identical seed+scripted inputs, hashes match (section 4.4)
tests/integration/aiDogfight.test.ts         section 4.7, both Veteran and Ace
tests/integration/spawnFlyLand.test.ts       spawn at an airport, fly a scripted circuit, touch down within the runway footprint
tests/integration/noAllocation.test.ts       section 6.2 heap-growth proxy check

tests/e2e/appSmoke.test.ts           section 4.8; self-skips if `playwright` cannot be imported
tests/e2e/mobile.test.ts             section 8 row 12; mobile device-emulation smoke test; self-skips like appSmoke.test.ts

tests/render/floatingOrigin.test.ts         08-render.md section 7 — DOM/WebGL-free pure functions, node environment
tests/render/snapshotInterpolation.test.ts  "
tests/render/wireframeAircraftRenderer.test.ts  "
tests/render/cameraModes.test.ts            "
tests/hud/targetBox.test.ts                 08-render.md section 7 — DOM-free, node environment
tests/hud/leadSight.test.ts                 "
tests/hud/snapshotView.test.ts              "
tests/hud/ladder.test.ts                    "
tests/hud/ilsNeedles.test.ts                "
tests/hud/radarScope.test.ts                "

tests/input/deadzones.test.ts        09-input.md section 7 — DOM-free, node environment
tests/input/inputMap.test.ts         09-input.md section 7 — DOM-free, node environment
tests/input/playerPilot.test.ts      09-input.md section 7 — jsdom environment (vitest.config.ts environmentMatchGlobs, section 4.10)

tests/ui/airportEditorGeometry.test.ts   11-ui.md section 7 — DOM-free, node environment
tests/ui/qualityTierDetect.test.ts       "
tests/ui/airportEditorValidate.test.ts   "
tests/ui/airportEditorExport.test.ts     "
tests/ui/urlHash.test.ts                 "
tests/ui/benchmarkFallback.test.ts       "
tests/ui/screens.test.ts                 11-ui.md section 7 — jsdom environment (vitest.config.ts environmentMatchGlobs)
tests/ui/orientationPrompt.test.ts       11-ui.md section 7 — jsdom environment (vitest.config.ts environmentMatchGlobs), window.matchMedia mocked by the test itself

tests/integration/testHarness.ts     NOT a test file: adapts src/core's real exports to SimWorldHandle (section 4.6)

tools/sim-check.ts                   CLI entry point (section 4)
tools/lib/perfTargets.ts             PerformanceTarget[] data table (section 5.1)
tools/lib/trimSolver.ts              FindTrim implementation (Newton solver, section 4.2)
tools/lib/hash.ts                    HashSimState implementation (FNV-1a, section 4.4)
tools/lib/dogfightRunner.ts          RunAiDogfight implementation (section 4.7)
tools/lib/table.ts                   FormatPerformanceTable implementation (fixed-width text table)

scripts/vite.tools.config.ts         Vite SSR/lib build config bundling tools/sim-check.ts -> dist-tools/sim-check.mjs (section 4.1)
scripts/checkContracts.mjs           shells `tsc --noEmit --strict` over docs/spec/contracts/*.ts (section 4.9)
scripts/ci.mjs                       orchestrates the full acceptance sequence (section 8); plain JS, no build step needed
.github/workflows/ci.yml             GitHub Actions: checkout, setup-node, npm ci, node scripts/ci.mjs
vitest.config.ts                     section 3
```

## 3. Public API (must match `contracts/verify.ts`)

`contracts/verify.ts` is reproduced by signature here; see the file itself for full field-level doc comments.

```ts
// Generic flight-model probing (imports nothing from flight.ts/aircraft.ts; see file header)
export interface EnvironmentLike { airDensityKgM3: number; soundSpeedMps: number; windWorldMps: Vec3Like; gravityMps2: number; }
export type StepAircraftLike<TDef> = (state: EntityState, damage: DamageState, inputs: PilotInputs, env: EnvironmentLike, def: TDef, dtSec: number, out: EntityState) => void;

// Trim
export const TRIM_MAX_ITERATIONS = 60;
export const TRIM_RESIDUAL_TOLERANCE_MPS2 = 0.02;
export const TRIM_PROBE_DT_SEC = 0.002;
export const TRIM_FD_EPSILON = 1e-3;
export const TRIM_STEP_DAMPING = 0.6;
export interface TrimCondition { altitudeM: number; speedMps: number; bankRad: number; massKg: number; }
export const TrimStatus = { Converged: 'converged', MaxIterationsExceeded: 'max_iterations_exceeded', OutOfControlAuthority: 'out_of_control_authority' } as const;
export interface TrimResult { status: TrimStatus; condition: TrimCondition; pitchStick: number; throttle: number; afterburnerUsed: boolean; alphaRad: number; iterations: number; residualMps2: number; }
export type FindTrim<TDef> = (step: StepAircraftLike<TDef>, def: TDef, condition: TrimCondition, seedState: EntityState) => TrimResult;

// Performance targets
export const PerformanceTargetKind = { VMax: 'vmax', SustainedTurnRateDegSec: 'sustained_turn_rate_deg_sec', ClimbRateMps: 'climb_rate_mps', StallSpeedMps: 'stall_speed_mps', TakeoffRollM: 'takeoff_roll_m', LandingRollM: 'landing_roll_m' } as const;
export interface PerformanceTarget { id: string; kind: PerformanceTargetKind; description: string; altitudeM: number; massKg: number; configNote: string; targetValue: number; unit: string; toleranceRel: number; sourceNote: string; }
export interface PerformanceCheckResult { target: PerformanceTarget; measured: number; passed: boolean; deltaRel: number; trim?: TrimResult; }
export type CheckPerformanceTarget<TDef> = (step: StepAircraftLike<TDef>, def: TDef, target: PerformanceTarget) => PerformanceCheckResult;

// Determinism
export const DETERMINISM_TEST_TICKS = SIM_HZ * 30;
export const DETERMINISM_CHECKPOINT_INTERVAL_TICKS = SIM_HZ * 5;
export const FNV1A_OFFSET_BASIS = 0x811c9dc5;
export const FNV1A_PRIME = 0x01000193;
export interface ObservedEntity { state: EntityState; damage?: DamageState; telemetry?: AircraftTelemetry; }
export type HashSimState = (entities: readonly ObservedEntity[]) => string;
export interface DeterminismCheckpoint { tick: number; hash: string; }
export interface DeterminismResult { seed: number; ticksRun: number; checkpointsA: readonly DeterminismCheckpoint[]; checkpointsB: readonly DeterminismCheckpoint[]; matched: boolean; firstDivergentTick?: number; }

// Integration harness
export interface SimWorldHandle {
  readonly tick: number; readonly simTimeSec: number;
  stepFixed(): void;
  spawnAircraft(aircraftDefId: string, team: Team, pos: Vec3Like, headingRad: number, speedMps: number, pilot: Pilot, difficulty?: AiDifficulty): EntityId;
  getEntityState(id: EntityId): EntityState | undefined;
  getDamage(id: EntityId): DamageState | undefined;
  getTelemetry(id: EntityId): AircraftTelemetry | undefined;
  listAliveEntityIds(): readonly EntityId[];
  drainEvents(): readonly SimEvent[];
}
export type CreateTestWorld = (mission: Mission, seed: number) => Result<SimWorldHandle, string>;

// AI dogfight
export const DOGFIGHT_MAX_SIM_TIME_SEC = 180;
export const DOGFIGHT_MAX_TICKS = DOGFIGHT_MAX_SIM_TIME_SEC * SIM_HZ;
export const DOGFIGHT_MIN_LOCK_TIME_SEC = 1.0;
export const DOGFIGHT_INITIAL_SEPARATION_M = 20000;
export const DOGFIGHT_MIN_ALT_AGL_TOLERANCE_M = -2;
export const DOGFIGHT_TEST_TIMEOUT_MS = 30000;
export interface AiDogfightConfig { seed: number; difficultyTeam0: AiDifficulty; difficultyTeam1: AiDifficulty; aircraftDefId: string; }
export interface AiDogfightResult { terminatedByKill: boolean; winnerTeam?: Team; ticksRun: number; simTimeSec: number; minAltAglTeam0: number; minAltAglTeam1: number; firstLockTimeSec?: number; groundCollision: boolean; cheatSuspected: boolean; }
export type RunAiDogfight = (world: SimWorldHandle, config: AiDogfightConfig) => AiDogfightResult;

// Acceptance report
export const AcceptanceCheckId = { Install: 'install', ContractsCompile: 'contracts_compile', SrcCompile: 'src_compile', UnitTests: 'unit_tests', IntegrationTests: 'integration_tests', TrimPerformance: 'trim_performance', Determinism: 'determinism', AiDogfightVeteran: 'ai_dogfight_veteran', AiDogfightAce: 'ai_dogfight_ace', NoAllocationHotPath: 'no_allocation_hot_path', Build: 'build', E2eSmoke: 'e2e_smoke' } as const;
export const AcceptanceStatus = { Pass: 'pass', Fail: 'fail', Skip: 'skip' } as const;
export interface AcceptanceCheckResult { id: AcceptanceCheckId; status: AcceptanceStatus; detail: string; durationMs: number; }
export interface AcceptanceReport { generatedAtIso: string; checks: readonly AcceptanceCheckResult[]; allPassed: boolean; }

// CLI
export const SimCheckMode = { Trim: 'trim', Determinism: 'determinism', Dogfight: 'dogfight', All: 'all' } as const;
export interface SimCheckCliOptions { mode: SimCheckMode; missionPath: string; seed: number; outJsonPath?: string; verbose: boolean; }
export const SimCheckExitCode = { Success: 0, PerformanceFailure: 1, DeterminismFailure: 2, DogfightFailure: 3, UsageError: 64 } as const;
export type FormatPerformanceTable = (results: readonly PerformanceCheckResult[]) => string;
```

## 4. Design & algorithms

### 4.1 Building and running `tools/sim-check.ts`

`tools/sim-check.ts` imports directly from `src/aircraft`, `src/physics`, `src/math`, and (for dogfight/determinism modes) `src/core` — it is implementation code, not a contract, so the `core.ts`-derived import restriction does not apply to it. Because `tsconfig.json`'s `moduleResolution: "Bundler"` output is not directly runnable by plain Node, and the project's devDependencies are fixed to `typescript`/`vite`/`vitest`/`@types/three` (no `tsx`/`ts-node`), module 12 bundles the CLI with Vite's library build before running it with plain `node`:

```ts
// scripts/vite.tools.config.ts
import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    ssr: true,
    target: 'node18',
    outDir: 'dist-tools',
    emptyOutDir: true,
    rollupOptions: {
      input: { 'sim-check': 'tools/sim-check.ts' },
      output: { format: 'es', entryFileNames: '[name].mjs' },
    },
  },
});
```

Build + run:
```
npx vite build --config scripts/vite.tools.config.ts
node dist-tools/sim-check.mjs --mode all --mission src/core/missions/freeFlight.json --seed 12345
```
`scripts/ci.mjs` performs exactly these two steps (section 8). `vitest`-run tests that need `tools/sim-check.ts`'s logic (e.g. `tests/integration/trimAndPerformance.test.ts`) instead import `tools/lib/*.ts` directly (vitest transforms TS on the fly; no bundling needed there) — only the standalone CLI entry point needs the Vite bundle, because it must be runnable outside vitest by a plain `node dist-tools/sim-check.mjs` invocation for CI and manual use.

### 4.2 Trim solver algorithm (`tools/lib/trimSolver.ts`, implements `FindTrim`)

Two unknowns: `pitchStick ∈ [-1,1]` (`PilotInputs.pitch`), `throttle ∈ [0,1]` (`PilotInputs.throttle`). Two residuals, both specific forces (m/s²) computed by probing `step` for `TRIM_PROBE_DT_SEC` from the same `seedState` (never mutating `seedState`; `step`'s contract guarantees `state` is read-only in):

```
r_vertical(pitchStick, throttle) = (outState.vel.y - seedState.vel.y) / TRIM_PROBE_DT_SEC
r_forward(pitchStick, throttle)  = (|outState.vel| - |seedState.vel|) / TRIM_PROBE_DT_SEC
```
`roll = 0`, `yaw = 0`, `throttle` held equal to the unknown for both elements of the 2-vector, `afterburner = throttle >= 0.999` (afterburner only helps once throttle is pinned at military), all other `PilotInputs` fields `false`/`0`. For a turning trim (`condition.bankRad != 0`), `seedState.rot` is pre-rolled to `bankRad` before probing (see 4.2.1) and the target `r_vertical` is not zero but `-gravityMps2 * (1 - 1/cos(bankRad))`... precisely: the trim target replaces "hold altitude" with "hold the turn radius", implemented as: target vertical specific force in the WORLD frame equals `0` (level turn — altitude held), which is still `r_vertical → 0` because gravity + the vertical component of lift are still balanced at any bank angle in a level, coordinated turn; only the REQUIRED total lift (and hence AoA/CL) changes with bank angle. So the residual definitions above are used unchanged for both wings-level and turning trims; `bankRad` only affects `seedState.rot` and hence which body-frame lift vector direction produces the needed world-vertical component.

Newton step, numerical Jacobian via central differences with step `TRIM_FD_EPSILON` on each unknown:
```
J[i][j] = (r_i(x + eps*e_j) - r_i(x - eps*e_j)) / (2*eps)
dx = -damping * solve2x2(J, r)     // damping = TRIM_STEP_DAMPING
x_next = clamp(x + dx, bounds)     // pitchStick to [-1,1], throttle to [0,1]
```
`solve2x2` is closed-form 2×2 linear solve (Cramer's rule); if `|det(J)| < 1e-9`, treat the step as failed and retry from a perturbed `x` (add `0.05` to `pitchStick`) once before declaring `OutOfControlAuthority`. Converged when `sqrt(r_vertical² + r_forward²) < TRIM_RESIDUAL_TOLERANCE_MPS2`. Not converged within `TRIM_MAX_ITERATIONS` → `MaxIterationsExceeded`. `alphaRad` in the result is read from the LAST probe's `AircraftTelemetry`-equivalent computation: since `StepAircraftLike` does not return telemetry directly, `tools/lib/trimSolver.ts` recomputes `alpha = atan2(-v_body.y, v_body.x)` itself from `outState.vel` rotated into `outState.rot`'s body frame, using the exact formula in `00-architecture.md` section 3.5 (module 12 may inline this three-line formula — it is normative arithmetic, not an implementation detail left to module 01).

#### 4.2.1 Initial seed state per condition

```
seedState.pos = {0, altitudeM, 0}
seedState.rot = fromYawPitchRoll(headingRad=0, pitchRad=0, rollRad=bankRad)   // per 00-architecture.md section 3.3
seedState.vel = {0, 0, -speedMps}     // heading 0 = north = -Z, per section 3.1
seedState.omega = {0,0,0}
seedState.alive = true; seedState.hp = 100
seedState.elevonL = seedState.elevonR = seedState.rudder = 0
seedState.gearPos = 0; seedState.throttle = 0.5; seedState.afterburnerOn = false
seedState.flags = 0
```
`env` for every probe: `airDensityKgM3`/`soundSpeedMps` from the ISA formula at `altitudeM` (module 12 inlines the standard ISA troposphere/lower-stratosphere piecewise formula for this purpose ONLY, independently of whatever `src/physics/atmosphere.ts` does internally — see section 9 for why this is safe: both must converge on the same public ISA constants), `windWorldMps = {0,0,0}`, `gravityMps2 = 9.80665` (= `core.ts`'s `GRAVITY_MPS2`).

### 4.3 Structural (invariant) unit tests for modules whose exact numeric data is not visible to module 12

Modules 02/03's exact coefficient values are their own design (per `00-architecture.md`, sparse public data forces approximation, and module 12 cannot read `03-tejas-data.md`). Rather than guessing numbers that would silently pass regardless of correctness, `tests/aircraft/tejasAeroTables.test.ts` and `tests/physics/aeroForces.test.ts` assert PHYSICAL INVARIANTS that must hold for any reasonable implementation. These tests are able to call the REAL `interpolate2D` (`contracts/math.ts`) directly against `tejasDefinition.aero.CL`/`.CD`/`.stallAlphaRad` — not an invented per-module helper — because `00-architecture.md` section 9.1 now pins `AeroTables`'s full field-level shape centrally (module 03 cannot have chosen a different one):

```ts
// tests/aircraft/tejasAeroTables.test.ts (excerpt)
import { tejasDefinition } from '../../src/aircraft';
import { interpolate2D } from '../../src/math';

const MACH_REF = 0.3;   // a representative low/subsonic Mach at which to slice the 2D CL/CD tables for this alpha sweep

test('CL(alpha) is monotonically non-decreasing from -5deg to the stall AoA', () => {
  const { aero } = tejasDefinition;
  const N = 40;
  let prev = -Infinity;
  for (let i = 0; i <= N; i++) {
    const alphaRad = (-5 * Math.PI / 180) + (i / N) * (aero.stallAlphaRad - (-5 * Math.PI / 180));
    const cl = interpolate2D(aero.CL, alphaRad, MACH_REF);
    expect(cl).toBeGreaterThanOrEqual(prev - 1e-6);
    prev = cl;
  }
});

test('CD(alpha) is never negative and CD(0) is within [0.015, 0.06] (clean cranked-delta parasite-drag range)', () => {
  const cd0 = interpolate2D(tejasDefinition.aero.CD, 0, MACH_REF);
  expect(cd0).toBeGreaterThanOrEqual(0.015);
  expect(cd0).toBeLessThanOrEqual(0.06);
});

test('mass properties satisfy the inertia triangle inequality and mass bounds', () => {
  const d = tejasDefinition;
  expect(d.massKg).toBeGreaterThan(d.emptyMassKg);
  expect(d.massKg).toBeLessThanOrEqual(d.emptyMassKg + d.maxFuelKg + 4000); // + generous stores allowance
  const { xx, yy, zz } = d.inertiaBodyKgM2;
  expect(xx + yy).toBeGreaterThanOrEqual(zz);
  expect(yy + zz).toBeGreaterThanOrEqual(xx);
  expect(xx + zz).toBeGreaterThanOrEqual(yy);
});

test('wingAreaM2 and wingSpanM are within the public HAL Tejas Mk1 range', () => {
  expect(tejasDefinition.wingAreaM2).toBeGreaterThanOrEqual(34);
  expect(tejasDefinition.wingAreaM2).toBeLessThanOrEqual(43);
  expect(tejasDefinition.wingSpanM).toBeGreaterThanOrEqual(8.0);
  expect(tejasDefinition.wingSpanM).toBeLessThanOrEqual(8.4);
});
```
These bound-checks use the SAME source-noted public figures as `tools/lib/perfTargets.ts` (section 5.1) so there is exactly one place (section 5.1's table plus this test file) where "public Tejas data" is asserted, and both are cross-referenced.

### 4.4 Determinism hashing (`tools/lib/hash.ts`, implements `HashSimState`)

For each `ObservedEntity` in array order, append to a running byte stream (a pre-sized `Float64Array` scratch buffer reused across calls — this runs in test/CLI code, not a hot path, but the pattern is written allocation-consciously anyway):
```
state.id, state.kind-as-EntityKindCode, state.team,
state.pos.x/y/z, state.rot.x/y/z/w, state.vel.x/y/z, state.omega.x/y/z,
state.alive?1:0, state.hp, state.fuelKg, state.elevonL, state.elevonR, state.rudder,
state.gearPos, state.throttle, state.afterburnerOn?1:0, state.flags,
damage?.structurePct ?? -1, damage?.engineHealthPct ?? -1,
damage?.controlSurfaces.elevonL ?? -1, damage?.controlSurfaces.elevonR ?? -1, damage?.controlSurfaces.rudder ?? -1,
damage?.hydraulicsOk ? 1 : (damage ? 0 : -1), damage?.fuelLeak ? 1 : (damage ? 0 : -1),
damage?.radarHealthPct ?? -1, damage?.gearHealthPct ?? -1,
telemetry?.fuelKg ?? -1, telemetry?.thrustFrac ?? -1
```
(36 floats per entity; `-1` sentinels distinguish "field present with value -1" — impossible for every one of these fields except `hp`/percentages which never legitimately go negative — from "damage/telemetry omitted".) Then FNV-1a-32 over the `Uint8Array` view of that `Float64Array`'s buffer:
```
hash = FNV1A_OFFSET_BASIS
for each byte b: hash = (hash ^ b) >>> 0; hash = Math.imul(hash, FNV1A_PRIME) >>> 0
return hash.toString(16).padStart(8, '0')
```
Entities MUST be hashed in a stable order (ascending `EntityId`) — `tests/integration/testHarness.ts` sorts `listAliveEntityIds()` before mapping to `ObservedEntity[]`, since the underlying pool's iteration order is not itself part of any contract.

`tests/tools/hash.test.ts` fixes a regression vector so any accidental change to the byte layout is caught immediately:
```ts
test('known vector hashes to a fixed value', () => {
  const e: ObservedEntity = { state: { id: 1, kind: 'aircraft', team: 0,
    pos: {x:100,y:2000,z:-500}, rot: {x:0,y:0,z:0,w:1}, vel: {x:50,y:0,z:-150}, omega: {x:0,y:0,z:0},
    alive: true, hp: 100, elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0.8, afterburnerOn: false, flags: 0 } };
  expect(hashSimState([e])).toBe('fbe75177');
});
```
This literal (`'fbe75177'`) was computed by mechanically executing the exact algorithm in section 4.4 against the exact fixture above (36 fields for the one entity, `Float64Array` -> `Uint8Array` view, FNV-1a-32 with `FNV1A_OFFSET_BASIS`/`FNV1A_PRIME` from `src/math`), not chosen or estimated — the algorithm, byte order, and fixture are fully specified above, so re-running that computation independently must reproduce this exact value. This is a "generate-then-pin" golden test, not an open design decision. If module 12's implementation of `hashSimState` ever produces a different value for this exact fixture, that is a byte-layout or algorithm bug (e.g. wrong field order, wrong `EntityKindCode`, endianness, or hashing beyond the intended byte range) and must be fixed to match this pinned value, not the other way around.

### 4.5 Determinism test (`tests/integration/determinism.test.ts`)

```ts
// A scripted Pilot (module 12's own, used only in this test) — SimWorldHandle
// takes a full Pilot per spawned aircraft (section 4.6), so "scripted inputs"
// means implementing Pilot.update() to write a fixed function of tick into
// `out`, never a bespoke world-level input-injection method.
function makeScriptedPilot(): Pilot {
  let tick = 0;
  return {
    update(_ctx, _dtSec, out) {
      out.pitch = Math.sin(tick / 240) * 0.3; out.roll = Math.sin(tick / 180) * 0.4; out.yaw = 0;
      out.throttle = 0.8; out.afterburner = false; out.brakes = 0; out.gearDown = false; out.airbrake = false;
      out.trigger = (tick % 300) === 0; out.launch = false; out.cycleWeapon = false; out.cycleTarget = false;
      tick += 1;
    },
  };
}

const missionA = load('src/core/missions/dogfight1v1.json'); // one player-slot aircraft + one AI flight
const seed = 424242;
const worldA = mustOk(createTestWorld(missionA, seed));
const worldB = mustOk(createTestWorld(missionA, seed));
// dogfight1v1.json's player slot is respawned here under the scripted Pilot
// (a fresh instance per world, so per-instance closure state never crosses
// worldA/worldB) instead of a human/AI Pilot, so both runs see byte-identical
// PilotInputs; the mission's own AI flight is driven by the real src/ai Pilot
// in both worlds, which is exactly what this test is proving is deterministic.
for (const world of [worldA, worldB]) {
  world.spawnAircraft('tejas-mk1', 0, { x: 0, y: 4000, z: 0 }, 0, 200, makeScriptedPilot());
  for (let t = 0; t < DETERMINISM_TEST_TICKS; t++) world.stepFixed();
}
const hashesA = checkpointHashes(worldA); // recorded every DETERMINISM_CHECKPOINT_INTERVAL_TICKS during the loop above
const hashesB = checkpointHashes(worldB);
expect(hashesA).toEqual(hashesB);
```
This mission includes one AI flight, so a pass also proves `src/ai` draws only from the seeded PRNG. `firstDivergentTick` (first index where `hashesA[i] !== hashesB[i]`) is printed on failure so a regression can be bisected to a 5-second (`DETERMINISM_CHECKPOINT_INTERVAL_TICKS / SIM_HZ`) window instead of only "somewhere in 30 seconds of sim time."

### 4.6 `tests/integration/testHarness.ts` — the `SimWorldHandle` adapter

```ts
// tests/integration/testHarness.ts
import type { SimWorldHandle, CreateTestWorld } from '../../docs/spec/contracts/verify'; // path illustrative; actual import is 'src/contracts/verify' post-scaffold
import * as core from '../../src/core'; // module 10's barrel — the ONLY file in tests/ that imports it this directly for harness-construction purposes

export const createTestWorld: CreateTestWorld = (mission, seed) => {
  // ADAPTER SEAM: wraps whatever src/core/index.ts actually exports (its own
  // contracts/sim.ts, module 10, fixes the exact name/signature) into
  // SimWorldHandle. If module 10 exports e.g. `createWorld(mission, seed)`
  // returning an object with a differently-named step method, THIS function
  // is the only place that needs to change; every test importing
  // `createTestWorld` from this file is unaffected.
  ...
};
```
Every integration test file imports `createTestWorld` from this one adapter, never from `src/core` directly, for exactly this reason.

### 4.7 AI-vs-AI headless dogfight (`tools/lib/dogfightRunner.ts`, implements `RunAiDogfight`; used by `tests/integration/aiDogfight.test.ts` and `sim-check.ts --mode dogfight`)

Setup: two `aircraftDefId` aircraft (the built-in Tejas), team 0 at `pos={-DOGFIGHT_INITIAL_SEPARATION_M/2, 4000, 0}` heading east (`headingRad = PI/2`), team 1 at `pos={+DOGFIGHT_INITIAL_SEPARATION_M/2, 4000, 0}` heading west (`headingRad = -PI/2`), both level, `speedMps = 220`, both `Pilot`s supplied by `src/ai`'s factory at the configured `AiDifficulty`. Loop:
```
while (world.tick < DOGFIGHT_MAX_TICKS) {
  world.stepFixed();
  for (const id of world.listAliveEntityIds()) {
    const tel = world.getTelemetry(id);
    if (tel) minAltAgl[teamOf(id)] = Math.min(minAltAgl[teamOf(id)], tel.altAglM);
  }
  for (const ev of world.drainEvents()) {
    if (ev.type === 'lockAcquired' && firstLockTimeSec === undefined) firstLockTimeSec = world.simTimeSec;
    if (ev.type === 'kill') { terminatedByKill = true; winnerTeam = otherTeamOf(ev.targetId); break outer; }
    if (ev.type === 'crash') groundCollision = groundCollision || minAltAgl[teamOf(ev.entityId)] < DOGFIGHT_MIN_ALT_AGL_TOLERANCE_M;
  }
}
cheatSuspected = firstLockTimeSec !== undefined && firstLockTimeSec < DOGFIGHT_MIN_LOCK_TIME_SEC;
```
Assertions in `tests/integration/aiDogfight.test.ts`, run once per `{difficultyTeam0: 'veteran', difficultyTeam1: 'veteran'}` and once per `{difficultyTeam0: 'ace', difficultyTeam1: 'ace'}` (the brief's "both difficulties"; `'ace'` stands in for the harder tier), each wrapped in `{ timeout: DOGFIGHT_TEST_TIMEOUT_MS }`:
```ts
expect(result.cheatSuspected).toBe(false);                 // no omniscient-targeting bug
expect(result.groundCollision).toBe(false);                // both alive-window altAglM stayed >= DOGFIGHT_MIN_ALT_AGL_TOLERANCE_M
expect(Number.isFinite(result.ticksRun)).toBe(true);        // loop returned (no hang) within the vitest test timeout — the literal "must terminate"
if (difficultyTeam0 === 'ace') expect(result.minAltAglTeam0).toBeGreaterThanOrEqual(DOGFIGHT_MIN_ALT_AGL_TOLERANCE_M);
if (difficultyTeam1 === 'ace') expect(result.minAltAglTeam1).toBeGreaterThanOrEqual(DOGFIGHT_MIN_ALT_AGL_TOLERANCE_M);
```
`result.terminatedByKill` is logged but NOT asserted `true` — two evenly-matched AI pilots at the same difficulty are not guaranteed to produce a kill within 180 simulated seconds, and asserting it would make the test flaky against AI-tuning changes in modules 06/07 that are entirely legitimate. The unconditional, always-checkable requirement is that the harness returns.

### 4.8 End-to-end smoke test (`tests/e2e/appSmoke.test.ts`)

```ts
let playwright: typeof import('playwright') | undefined;
try { playwright = await import('playwright'); } catch { playwright = undefined; }

describe.skipIf(!playwright)('app smoke (playwright)', () => {
  test('vite build produces index.html and the app renders a canvas with no console errors', async () => {
    execFileSync('npx', ['vite', 'build'], { stdio: 'inherit' });
    expect(existsSync('dist/index.html')).toBe(true);
    const preview = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort']);
    await waitForPort(4173, 10000);
    const browser = await playwright!.chromium.launch();
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto('http://localhost:4173', { waitUntil: 'load' });
    await page.waitForTimeout(3000); // let the first sim/render frames run
    const canvas = await page.$('canvas');
    expect(canvas).not.toBeNull();
    const box = await canvas!.boundingBox();
    expect(box && box.width).toBeGreaterThan(0);
    expect(box && box.height).toBeGreaterThan(0);
    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
    await browser.close();
    preview.kill();
  }, 60000);
});
```
`playwright` is never added to `package.json` (module 10's file; the fixed devDependency list stays `typescript`/`vite`/`vitest`/`@types/three`). This test is opportunistic: if a developer or CI image happens to have `playwright` resolvable (`npm install --no-save playwright` run manually, or a CI step that installs it ephemerally before this one test file), it runs and is a real acceptance gate (section 8, `E2eSmoke`); otherwise it reports `AcceptanceStatus.Skip`, never `Fail`, and never blocks `npx vitest run`. The mandatory, always-run part of "smoke-test the built app" is the `vite build` + `dist/index.html` existence check, which needs no optional dependency and runs unconditionally inside the same test.

### 4.9 Contract-compile audit (`scripts/checkContracts.mjs`)

```js
#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const dir = 'docs/spec/contracts';
const files = readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => `${dir}/${f}`);
try {
  execFileSync('npx', ['tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'ESNext',
    '--moduleResolution', 'Bundler', '--noUncheckedIndexedAccess', '--noImplicitOverride',
    '--noFallthroughCasesInSwitch', '--forceConsistentCasingInFileNames', '--skipLibCheck',
    '--esModuleInterop', '--isolatedModules', ...files], { stdio: 'inherit' });
  process.exit(0);
} catch {
  process.exit(1);
}
```
This is the literal, exact flag set `00-architecture.md` section 13 fixes for `tsconfig.json`, applied directly to the contract files with no project file (contracts import nothing external, so no `lib`/`include` resolution is needed). `tests/integration/contractsCompile.test.ts` calls this same script via `execFileSync('node', ['scripts/checkContracts.mjs'])` and asserts a zero exit code, so a contract regression fails `vitest run` immediately, not just the separate CI step.

### 4.10 `vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',                 // default for every test file NOT matched below (see section 1) — this covers every tests/math/tests/physics/.../tests/render/tests/hud file, since all of those are DOM-free by construction
    environmentMatchGlobs: [              // the ONLY three files that need a DOM (section 2's own file list flags each with "jsdom environment")
      ['tests/input/playerPilot.test.ts', 'jsdom'],
      ['tests/ui/screens.test.ts', 'jsdom'],
      ['tests/ui/orientationPrompt.test.ts', 'jsdom'],
    ],
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    testTimeout: 5000,                   // default; individual dogfight/e2e tests override per-test
    hookTimeout: 10000,
    isolate: true,
    pool: 'forks',                       // fresh process per file: guards against one module's accidental global/module-level mutable state leaking into another's determinism test
    reporters: ['default'],
    coverage: { enabled: false },        // no coverage tooling dependency; not in the fixed devDependency list
  },
});
```
`tests/e2e/**` is excluded from the default `vitest run` (kept out of the fast inner-loop suite since it shells out to `vite build` and a real browser) and is instead run explicitly: `npx vitest run tests/e2e --testTimeout=60000` (section 8, `E2eSmoke`).

## 5. Data

### 5.1 Performance targets (`tools/lib/perfTargets.ts`, `PerformanceTarget[]`)

All targets use `aircraftDefId = 'tejas-mk1'` and a fixed **test mass** of `massKg = 9500` (a representative combat-configuration weight between the commonly cited empty weight ~6560 kg and MTOW ~13500 kg for the HAL Tejas Mk1 — see section 9) unless noted. `toleranceRel` widths reflect how directly each figure is sourced: publicly well-documented headline figures get ±10%; anything module 12 had to derive via a physics formula from an assumed input (e.g. an assumed `CLmax`) gets ±15–20%, and is flagged so a real mismatch is understood as "module 03's actual numbers differ from this table's assumptions," not automatically "the flight model is broken" — the acceptance checklist (section 8) treats `TrimPerformance` failures as a finding to review, not an automatic hard stop, for exactly this reason (see section 9).

| id | kind | altitudeM | condition | target | unit | tol | source |
|---|---|---|---|---|---|---|---|
| `vmax_sl` | vmax | 0 | military+AB, clean | 310 | m/s | 10% | public Tejas Mk1 low-level max-speed figures (~1100–1150 km/h class) |
| `vmax_11000` | vmax | 11000 | military+AB, clean | 472 | m/s | 10% | Mach 1.6 at 11 km ISA (a(11km)=295.2 m/s); Mach 1.6 is the commonly cited Tejas Mk1 top speed |
| `turn_5000_m06` | sustained_turn_rate_deg_sec | 5000 | Mach 0.6, military+AB, clean, 9500 kg | 11.0 | deg/s | 20% | no public Tejas turn-rate figure exists; approximated from contemporary light single-engine fighter analogues (F-16A/Gripen-class) at a similar thrust/weight — widest tolerance in this table |
| `climb_sl` | climb_rate_mps | 0 | military+AB, clean, Vy=180 m/s, 9500 kg | 87 | m/s | 15% | re-baselined from 66 m/s (~13,000 ft/min, a cited but unverified Tejas figure) after the engine moved to published F404-IN20 ratings; see tools/lib/perfTargets.ts |
| `stall_clean` | stall_speed_mps | 0 | clean, gear/flaps up, 9500 kg | 60.0 | m/s | 15% | computed: `sqrt(2*massKg*GRAVITY_MPS2/(rho0*wingAreaM2*CLmaxClean))`, `wingAreaM2=38.4` (public), `CLmaxClean=1.1` (assumed, generic delta-wing fighter clean CLmax) |
| `stall_landing` | stall_speed_mps | 0 | gear+flaps down, 9500 kg | 50.0 | m/s | 15% | same formula, `CLmaxLanding=1.6` (assumed, generic delta-wing fighter powered-approach CLmax) |
| `takeoff_roll` | takeoff_roll_m | 0 | military+AB, flaps takeoff, 9500 kg | 450 | m | 30% | public Tejas takeoff-roll figures cluster around 460–500 m at heavier loadouts; widened tolerance and a lighter test mass both push the target down |
| `landing_roll` | landing_roll_m | 0 | flaps landing, brakes, 8500 kg | 600 | m | 30% | public Tejas landing-roll figures cluster around 600–700 m; test mass assumes partial fuel remaining |

`rho0 = 1.225` kg/m³ (ISA sea-level density, a physical constant, not a Tejas-specific approximation). Every `PerformanceCheckResult` is produced by `CheckPerformanceTarget`: for `vmax`, run `FindTrim` at increasing `speedMps` (bisection between 100 and 600 m/s) for the LARGEST speed at which `TrimResult.status === 'converged'` AND `TrimResult.throttle` (with afterburner) actually balances thrust=drag — operationally, the largest `speedMps` for which the trim solver's forward-residual can be driven to zero at `throttle=1, afterburner=true`; for `sustained_turn_rate_deg_sec`, the bisection-on-bank-angle procedure in section 4.2 (turn rate `= GRAVITY_MPS2 * sqrt(n*n - 1) / speedMps`, `n = 1/cos(bankRad)`, evaluated at the largest converged bank angle); for `climb_rate_mps`, the 20-second constant-IAS climb simulation in section 4 (the "climb rate test" P-controller: `Kp = 0.02` rad-of-pitch-stick per m/s of IAS error, run for 20 sim-seconds at `SIM_DT_SEC` steps from a `vmax_sl`-style level-flight seed at `speedMps=180`, discard the first 15 s as transient, average `outState.vel.y` over the last 5 s); for `stall_speed_mps`, evaluated analytically from the formula above (no simulation run — it is a direct algebraic check against `tejasDefinition.wingAreaM2` and an assumed `CLmax`, cross-referenced against `tejasAeroTables`'s actual max sampled `CL` value from section 4.3's monotonicity scan, whichever is smaller, so the check also catches an aero table whose real `CLmax` falls short of this table's assumption); for `takeoff_roll_m`/`landing_roll_m`, direct forward-Euler integration of `stepAircraft` from `vel=0`/`vel=touchdown speed` with `gearDown=true`, full/idle throttle and `brakes=1` respectively, summing `dt * vel.x` (ground roll, wings level, runway heading east) until `vel.y > 0.5` (liftoff) or `|vel| < 1` (stopped).

### 5.2 Trim search grid (`tools/sim-check.ts --mode trim`, printed table rows beyond the 8 named targets)

Altitudes `[0, 3000, 6000, 9000, 11000, 14000]` m × speeds `[150, 200, 250, 300, 350]` m/s, skipping any `(altitude, speed)` pair where `speed` exceeds `1.3 * soundSpeedAt(altitude)` (nonsensical trim target). Each cell prints `TrimResult.status`; any `MaxIterationsExceeded`/`OutOfControlAuthority` cell inside the flight envelope implied by section 5.1's targets fails the CLI (`SimCheckExitCode.PerformanceFailure`) even if the 8 named targets happen to pass, since a hole in the trim envelope indicates a flight-model bug independent of the specific numeric targets.

### 5.3 Determinism seeds

CI always uses `seed = 424242` (section 4.5). `tools/sim-check.ts --mode determinism` additionally accepts `--seed` for ad hoc reproduction of a bug report.

## 6. Performance budget

### 6.1 Budgets

- **CI wall-clock budget**: the full sequence in section 8 (install already warm, contracts audit, `tsc --noEmit` over `src/`, `vitest run` excluding e2e, `tools/sim-check.ts --mode all`, `vite build`) must complete in under 6 minutes on a standard 2-core GitHub Actions runner. The dominant cost is expected to be `vitest run` (dozens of small files) and the trim grid (30 cells × ≤60 Newton iterations × 2 probes each = ≤3600 `stepAircraft` calls, each O(µs) — negligible, well under 1 s total).
- **`tests/integration/aiDogfight.test.ts`**: each of the two difficulty runs must complete within `DOGFIGHT_TEST_TIMEOUT_MS = 30000` ms real time. Since `stepFixed()` is called in a tight loop with no real-time pacing, `DOGFIGHT_MAX_TICKS` (21600 ticks = 180 simulated seconds) must execute in well under that budget on CI hardware — if `src/core`'s per-tick cost exceeds ~1.4 ms this test alone signals a performance regression worth flagging even though it is not itself a hot-path allocation test.
- **`tools/lib/hash.ts`**: reuses one scratch `Float64Array` across calls (sized `28 * MAX_ENTITIES` floats once), never reallocated per call, even though this code does not run in the 120 Hz hot path — good practice for a function called thousands of times across the determinism/dogfight tests.
- **Mobile**: none of module 12's own code ships to the browser (`tests/`, `tools/`, `scripts/` are excluded from the Vite app build by not being referenced from `index.html`/`src/main.ts`), so this module has no mobile runtime budget of its own; it only measures other modules' budgets (section 6.2).

### 6.2 No-allocation-in-hot-path proxy check (`tests/integration/noAllocation.test.ts`)

```ts
test('steady-state stepping does not grow the heap', () => {
  if (typeof global.gc !== 'function') {
    console.warn('run with NODE_OPTIONS=--expose-gc for a strict check; skipping strict assertion');
    return;
  }
  const world = mustOk(createTestWorld(freeFlightMission, 1));
  for (let i = 0; i < 600; i++) world.stepFixed();      // warm up JIT + pools
  global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 6000; i++) world.stepFixed();     // 50 simulated seconds
  global.gc();
  const after = process.memoryUsage().heapUsed;
  expect(after - before).toBeLessThan(2 * 1024 * 1024); // < 2 MB growth over 6000 ticks
});
```
Run in CI as `NODE_OPTIONS=--expose-gc npx vitest run tests/integration/noAllocation.test.ts` (section 8 includes this exact invocation). This is a PROXY for "no allocation in the hot path," not a proof — a small, bounded allocation that is promptly collected can still pass; a steadily growing retained heap cannot. The buffer-pool-specific claim in `00-architecture.md` section 5 ("the pool never grows") is not independently observable through any contract (no introspection hook is exposed) and is therefore a **manual/code-review acceptance item**, listed as such in section 8, not a mechanical test.

## 7. Unit tests to write

Section 2's file list is the canonical set; this section gives concrete numeric assertions for every file whose expected values are fixed by `00-architecture.md`/`core.ts` (and therefore knowable to module 12 without seeing a sibling module's spec) or are internal to module 12's own code. Files covering another module's implementation-specific numeric data (aero coefficients, engine tables, terrain noise parameters, airport JSON content, AI tuning constants) get INVARIANT assertions per section 4.3's pattern instead of literal numbers, because those numbers are legitimately that module's own design.

**`tests/math/quat.test.ts`** (values are `00-architecture.md` section 3.3's worked examples, normative):
```ts
test('worked example A: heading=PI/2, pitch=0, roll=0 is the identity quaternion', () => {
  const q = { x: 0, y: 0, z: 0, w: 1 };
  const out = { x: 0, y: 0, z: 0, w: 0 };
  Quat.fromYawPitchRoll(Math.PI / 2, 0, 0, out);
  expect(out.x).toBeCloseTo(0, 9); expect(out.y).toBeCloseTo(0, 9);
  expect(out.z).toBeCloseTo(0, 9); expect(out.w).toBeCloseTo(1, 9);
});

test('worked example B: heading=0, pitch=15deg, roll=0 rotates forward to (0, sin15, -cos15)', () => {
  const out = { x: 0, y: 0, z: 0, w: 0 };
  Quat.fromYawPitchRoll(0, 15 * Math.PI / 180, 0, out);
  const fwd = { x: 0, y: 0, z: 0 };
  Quat.rotate(out, { x: 1, y: 0, z: 0 }, fwd);
  expect(fwd.x).toBeCloseTo(0, 6);
  expect(fwd.y).toBeCloseTo(Math.sin(15 * Math.PI / 180), 6);
  expect(fwd.z).toBeCloseTo(-Math.cos(15 * Math.PI / 180), 6);
});

test('bodyRateP/Q/R match the core.ts frame mapping', () => {
  const omega = { x: 1.5, y: -2.0, z: 0.75 };
  expect(bodyRateP(omega)).toBeCloseTo(1.5, 9);
  expect(bodyRateQ(omega)).toBeCloseTo(0.75, 9);
  expect(bodyRateR(omega)).toBeCloseTo(2.0, 9);
});
```

**`tests/core/entityPool.test.ts`**:
```ts
test('packEntityId/unpackEntityId round-trip without bitwise overflow at high generation', () => {
  const id = packEntityId(42, 40000); // generation > 0x8000, would corrupt with `<<`
  const { index, generation } = unpackEntityId(id);
  expect(index).toBe(42);
  expect(generation).toBe(40000);
});
test('index alone (generation=0) round-trips', () => {
  const { index, generation } = unpackEntityId(packEntityId(0, 0));
  expect(index).toBe(0); expect(generation).toBe(0);
});
```

**`tests/core/snapshotWriter.test.ts`** / **`snapshotReader.test.ts`**:
```ts
test('entityFieldOffset(3, SnapshotEntity.POS_Y) matches the documented formula', () => {
  expect(entityFieldOffset(3, SnapshotEntity.POS_Y)).toBe(HEADER_FLOATS + 3 * ENTITY_STRIDE + SnapshotEntity.POS_Y);
});
test('a written EntityState round-trips through snapshotReader exactly', () => {
  const buf = new ArrayBuffer(SNAPSHOT_BYTES);
  const view = new Float64Array(buf);
  writeSnapshot(view, { tick: 7, simTimeSec: 0.0583, entities: [sampleAircraftState], playerIndex: 0 }, sampleHud);
  const read = readSnapshot(view);
  expect(read.header.tick).toBe(7);
  expect(read.entities[0].pos).toEqual(sampleAircraftState.pos);
  expect(read.entities[0].rot).toEqual(sampleAircraftState.rot);
});
test('SNAPSHOT_BYTES matches HEADER_FLOATS + MAX_ENTITIES*ENTITY_STRIDE + HUD_BLOCK_FLOATS, times 8', () => {
  expect(SNAPSHOT_BYTES).toBe((HEADER_FLOATS + MAX_ENTITIES * ENTITY_STRIDE + HUD_BLOCK_FLOATS) * 8);
});
```

**`tests/core/fixedStepLoop.test.ts`**:
```ts
test('a 0.033s real frame at 120Hz ticks exactly 3 or 4 times (accumulator carries remainder)', () => {
  const loop = createFixedStepLoop();
  let ticks = 0;
  loop.onAnimationTick(0.033, () => { ticks++; });
  expect(ticks === 3 || ticks === 4).toBe(true);
  expect(ticks).toBe(Math.floor(0.033 / SIM_DT_SEC));
});
test('a stalled 2s frame is clamped to the 0.25s catch-up cap, not 240 ticks', () => {
  const loop = createFixedStepLoop();
  let ticks = 0;
  loop.onAnimationTick(2.0, () => { ticks++; });
  expect(ticks).toBe(Math.floor(0.25 / SIM_DT_SEC)); // 30
});
```

**`tests/physics/atmosphere.test.ts`** (ISA is a public physical model, not module-02-specific data):
```ts
test('sea-level ISA density and speed of sound', () => {
  const env = isaAt(0);
  expect(env.airDensityKgM3).toBeCloseTo(1.225, 3);
  expect(env.soundSpeedMps).toBeCloseTo(340.29, 1);
});
test('11000m ISA (tropopause) density and speed of sound', () => {
  const env = isaAt(11000);
  expect(env.airDensityKgM3).toBeCloseTo(0.3639, 3);
  expect(env.soundSpeedMps).toBeCloseTo(295.2, 1);
});
```

**`tests/airport/ils.test.ts`** (formula is public geometry, fixed regardless of module 05's runway data):
```ts
test('on centerline, on glidepath -> zero deviation', () => {
  const ils = { frequencyMhz: 110.3, localiserHeadingRad: 0, glideslopeAngleRad: ILS_DEFAULT_GLIDESLOPE_RAD,
    localiserOriginPos: {x:0,y:0,z:0}, glideslopeOriginPos: {x:0,y:0,z:0} };
  const pos = { x: 0, y: 3000 * Math.tan(ILS_DEFAULT_GLIDESLOPE_RAD), z: -3000 };
  const dev = ilsDeviation(pos, ils);
  expect(dev.locNorm).toBeCloseTo(0, 3);
  expect(dev.gsNorm).toBeCloseTo(0, 3);
});
test('one full-scale localiser deflection (2.5deg off course at range) normalises to +-1', () => {
  const ils = { frequencyMhz: 110.3, localiserHeadingRad: 0, glideslopeAngleRad: ILS_DEFAULT_GLIDESLOPE_RAD,
    localiserOriginPos: {x:0,y:0,z:0}, glideslopeOriginPos: {x:0,y:0,z:0} };
  const rangeM = 5000;
  const offsetM = rangeM * Math.tan(ILS_LOC_FULL_SCALE_DEG * Math.PI / 180);
  const pos = { x: offsetM, y: 200, z: -rangeM };
  expect(Math.abs(ilsDeviation(pos, ils).locNorm)).toBeCloseTo(1, 2);
});
```

**`tests/tools/trimSolver.test.ts`** (closed-form check against a synthetic analytic aircraft, independent of the real Tejas data):
```ts
test('FindTrim converges on a synthetic linear aircraft to the analytic solution', () => {
  const def = { liftSlopePerRad: 5.5, dragK: 0.06, cd0: 0.02, wingAreaM2: 38, massKg: 9500, thrustMaxN: 85000 };
  const step: StepAircraftLike<typeof def> = syntheticLinearStep; // closed-form step fn, defined in this test file only
  const seed = makeLevelSeedState(5000, 220);
  const result = findTrim(step, def, { altitudeM: 5000, speedMps: 220, bankRad: 0, massKg: 9500 }, seed);
  expect(result.status).toBe('converged');
  expect(result.residualMps2).toBeLessThan(TRIM_RESIDUAL_TOLERANCE_MPS2);
  // analytic CL = 2*W/(rho*V^2*S); analytic alpha = CL / liftSlopePerRad for this synthetic model
  const rho = isaAt(5000).airDensityKgM3;
  const wN = def.massKg * GRAVITY_MPS2;
  const clAnalytic = 2 * wN / (rho * 220 * 220 * def.wingAreaM2);
  const alphaAnalytic = clAnalytic / def.liftSlopePerRad;
  expect(result.alphaRad).toBeCloseTo(alphaAnalytic, 2);
});
```

**`tests/tools/perfTargets.test.ts`**:
```ts
import { PERFORMANCE_TARGETS } from '../../tools/lib/perfTargets';
test('every target has a plausible tolerance and a non-empty source note', () => {
  for (const t of PERFORMANCE_TARGETS) {
    expect(t.toleranceRel).toBeGreaterThan(0);
    expect(t.toleranceRel).toBeLessThanOrEqual(1);
    expect(t.sourceNote.length).toBeGreaterThan(10);
    expect(t.targetValue).toBeGreaterThan(0);
  }
});
test('the 8 named ids from 12-verification.md section 5.1 are all present exactly once', () => {
  const ids = PERFORMANCE_TARGETS.map((t) => t.id).sort();
  expect(ids).toEqual(['climb_sl', 'landing_roll', 'stall_clean', 'stall_landing', 'takeoff_roll', 'turn_5000_m06', 'vmax_11000', 'vmax_sl'].sort());
});
```

## 8. Acceptance criteria — the final checklist

Run in this exact order from the repo root, after `npm install`. Each command's PASS condition is its exit code; `AcceptanceCheckId` in the right column is the id `scripts/ci.mjs` reports for that step in its printed `AcceptanceReport`.

| # | command | pass condition | id |
|---|---|---|---|
| 1 | `npm install` | exit 0 | `install` |
| 2 | `node scripts/checkContracts.mjs` | exit 0 (all 13 `docs/spec/contracts/*.ts` compile standalone, strict) | `contracts_compile` |
| 3 | `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.worker.json` | both exit 0 (whole `src/`+`tests/`+`tools/` tree under the main config, plus the two worker bootstrap files under the WebWorker-lib config, per `00-architecture.md` section 13's DOM/WebWorker split — combining both libs in one config does not compile, see that section) | `src_compile` |
| 4 | `npx vitest run` | all tests pass (includes every file in section 2 except `tests/e2e/**`) | `unit_tests` + `integration_tests` (vitest reports both; `scripts/ci.mjs` splits by directory for the report) |
| 5 | `npx vite build --config scripts/vite.tools.config.ts && node dist-tools/sim-check.mjs --mode trim --mission src/core/missions/freeFlight.json --seed 12345` | exit 0, printed table shows PASS for all 8 named targets (section 5.1) and no `MaxIterationsExceeded`/`OutOfControlAuthority` cell inside the envelope (section 5.2) | `trim_performance` |
| 6 | `node dist-tools/sim-check.mjs --mode determinism --mission src/core/missions/dogfight1v1.json --seed 424242` | exit 0 (`DeterminismResult.matched === true`) | `determinism` |
| 7 | `node dist-tools/sim-check.mjs --mode dogfight --mission src/core/missions/dogfight1v1.json --seed 1 --difficulty veteran` | exit 0, `cheatSuspected=false`, `groundCollision=false` | `ai_dogfight_veteran` |
| 8 | `node dist-tools/sim-check.mjs --mode dogfight --mission src/core/missions/dogfight1v1.json --seed 1 --difficulty ace` | exit 0, `cheatSuspected=false`, `groundCollision=false` | `ai_dogfight_ace` |
| 9 | `NODE_OPTIONS=--expose-gc npx vitest run tests/integration/noAllocation.test.ts` | test passes (or explicitly warns+passes when `--expose-gc` unavailable — re-run with the flag before accepting) | `no_allocation_hot_path` |
| 10 | `npx vite build` | exit 0, `dist/index.html` exists | `build` |
| 11 | `npm install --no-save playwright && npx playwright install --with-deps chromium && npx vitest run tests/e2e --testTimeout=60000` | test passes, OR self-reports `skip` if step 11's install itself is omitted — a reviewer MAY skip this row entirely on a machine without browser-install permissions, in which case `e2e_smoke` is recorded `skip`, not `fail` | `e2e_smoke` |
| 12 | `npm install --no-save playwright && npx playwright install --with-deps chromium && npx vitest run tests/e2e/mobile.test.ts --testTimeout=60000` | test passes, OR self-reports `skip` under the identical browser-install condition as row 11 (never silently omitted from the report either way) | `mobile_smoke` |
| — | **Manual/code-review only** (not mechanically checkable through any contract, per section 6.2): confirm `src/core/sim.worker.ts`'s snapshot buffer pool never allocates a 4th `ArrayBuffer` beyond `SNAPSHOT_BUFFER_POOL_SIZE` (e.g. by temporarily logging `pool.length` during a manual play session, or a heap snapshot diff) | reviewer sign-off in the PR/integration notes | — |

**`tests/e2e/mobile.test.ts` (row 12; section 4.8's own file, extended, not a new module — imports `playwright` dynamically and self-skips exactly like `appSmoke.test.ts` does).** Uses Playwright's built-in device emulation (`playwright.devices['Pixel 5']` and `playwright.devices['iPhone 13']`, one sub-test each) to load the built `dist/index.html` at a real mobile viewport/DPR/touch-capable context, then: (1) waits for `#render-canvas` to report a non-zero `getBoundingClientRect()` size; (2) forces the quality tier to `low` via the same `tejas.settings.v1` `localStorage` key `main.ts` reads at boot (`10-core-worker.md` section 4.10.2), reloads, and asserts the page still reaches a rendered frame within `10000` ms (no hang, no thrown console error) rather than running the ~2.5 s benchmark; (3) asserts the touch-control overlay's DOM elements (stick/yaw-bar/throttle-slider zones, `contracts/input.ts`'s `TouchZoneId`) exist and their bounding boxes fall entirely within the viewport (catches the `09-input.md` safe-area-inset regression class, section 4.5); (4) registers a `navigator.serviceWorker` listener BEFORE navigation and asserts a `ServiceWorkerRegistrationHandle` with `registered===true` is observed within `5000` ms; (5) with the service worker registered and the page reloaded once (priming the cache), sets the Playwright browser context offline (`context.setOffline(true)`) and reloads a third time, asserting the page still renders `#render-canvas` (PWA offline-capability check) — this is a MANDATORY gate (unlike row 11's E2E smoke test, which the acceptance table already lets a reviewer skip on a machine without browser-install permissions) whenever browser install permissions ARE available, i.e. it participates in `scripts/ci.mjs`'s scheduled/`PLAYWRIGHT=1` run the same way row 11 does, but is never silently dropped from the printed `AcceptanceReport` the way an ad-hoc manual mobile check would be.

**Overall PASS** requires rows 1–10 to all be `pass` and rows 11–12 to each be `pass` or `skip` (never `fail`). `scripts/ci.mjs` runs rows 1–10 automatically (rows 11–12 only if `PLAYWRIGHT=1` is set in the CI environment, since installing a real browser is a meaningfully heavier CI step the project may choose to run on a schedule rather than every push) and exits with `SimCheckExitCode`-style codes: `0` if `AcceptanceReport.allPassed`, else `1`, printing the full `AcceptanceReport` as both a formatted table (via `FormatPerformanceTable`-style rendering, reused) and (`--json`) machine-readable JSON for `.github/workflows/ci.yml` to upload as a build artifact.

```yaml
# .github/workflows/ci.yml (excerpt)
name: CI
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: node scripts/ci.mjs
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: acceptance-report, path: acceptance-report.json }
```

## 9. Open assumptions

1. **Performance target numbers (section 5.1) are module 12's own public-domain approximations, independent of module 03.** Module 12 cannot read `03-tejas-data.md` (parallel drafting). Every figure in section 5.1 is either a commonly-cited public HAL Tejas Mk1 headline number (Vmax, climb rate, ceiling-adjacent, takeoff/landing roll — sourced from general open press/reference material, not an official flight-test report) or a value module 12 DERIVED itself from a physics formula plus an explicitly-named assumed input (`CLmax`, test mass) when no public figure exists at all (sustained turn rate has no public source and uses the widest, 20%, tolerance for exactly this reason). If module 03's actual `AeroTables`/`EngineTables` yield a trimmed performance figure outside these tolerances, that is a legitimate integration-time finding to be reviewed (is module 03's data wrong, or was module 12's public-data approximation wrong?) — not evidence the flight model itself is broken. This is why the acceptance checklist (section 8, row 5) is listed as a normal pass/fail gate but `scripts/ci.mjs`'s `trim_performance` failure message explicitly prints both the target's `sourceNote` and a reminder to cross-check `03-tejas-data.md`'s own section 9 (its own "open assumptions") before treating the mismatch as a module-02/03 bug.
2. **`SimWorldHandle` (section 4.6) is a narrow guess at module 10's `contracts/sim.ts` surface**, since module 12 cannot read it either. `tests/integration/testHarness.ts` is deliberately the ONLY file that touches `src/core`'s real exports directly, isolating the adaptation to one file. If module 10's actual factory differs in name or signature, the integration pass (`00-architecture.md` section 12, step 4) edits only this adapter; no other test file changes. The same applies to `EnvironmentLike`/`StepAircraftLike<TDef>` (section 4.1 of `contracts/verify.ts`), except those two are LOW risk, not a guess: they are transcribed verbatim from `00-architecture.md` section 9.1, which is normative and fixes module 02's `Environment`/`StepAircraft` shapes exactly.
3. **Unit tests ARE written for `src/render`/`src/hud`/`src/input`/`src/ui` — RESOLVED from an earlier drafting pass's over-broad exclusion.** That earlier pass read `00-architecture.md` section 11's file manifest (which only gives an illustrative `tests/{math,physics,...}` list, not an exhaustive one) as forbidding `tests/render`/`tests/hud`/`tests/input`/`tests/ui` entirely, and read section 2's devDependency list as forbidding `jsdom` outright. Both readings were too strict: `00-architecture.md` section 2 now explicitly permits `jsdom`, scoped to exactly the three files that need it, and section 2 (above) lists every `tests/render/**`/`tests/hud/**`/`tests/input/**`/`tests/ui/**` file `08-render.md`/`09-input.md`/`11-ui.md`'s own section 7's already gave test bodies for — module 12 did not need to invent any new test content, only stop silently dropping content those three specs had already fully worked out. `tests/tools/` (three files, section 2) remains a small, deliberate extension beyond `00-architecture.md` section 11's illustrative list, justified because it is entirely internal to module 12's own owned code (`tools/lib/*`) and stays inside module 12's already-owned `tests/` directory.
4. **`playwright` is never a `package.json` dependency**, per the fixed devDependency list. The e2e smoke test dynamically `import()`s it and self-skips if absent (section 4.8); CI only attempts the real browser install when `PLAYWRIGHT=1` is set (section 8), so a default `npm ci && node scripts/ci.mjs` run never requires network access to a browser download CDN.
5. **`tools/sim-check.ts` cannot be run directly by plain `node` as a `.ts` file** given the fixed dependency list (no `tsx`/`ts-node`) and the project `tsconfig.json`'s `moduleResolution: "Bundler"` (not Node-ESM-runnable as emitted). Module 12 resolves this by bundling the CLI with Vite's library/SSR build mode (section 4.1) using its OWN `scripts/vite.tools.config.ts`, entirely inside module 12's owned `scripts/` directory — this does not touch or depend on module 10's root `vite.config.ts`.
6. **The "no allocation in hot path" acceptance item is split into a mechanical proxy (heap-growth, section 6.2, row 9) and one manual/code-review item** (the snapshot buffer pool never growing past `SNAPSHOT_BUFFER_POOL_SIZE`, section 8's final row) because the latter has no observable hook through any contract in this project. A future module 10/00 revision could close this gap by adding a `getSnapshotPoolStats()` debug accessor to `contracts/sim.ts`; module 12 does not invent one on module 10's behalf per `00-architecture.md` section 8's guidance to use the narrowest structural subset rather than inventing a cross-module shape.
7. **The `DETERMINISM_TEST_TICKS`/`DOGFIGHT_MAX_TICKS`/timeouts (sections 3–4) are module 12's own budget choices**, not derived from any other module's spec, chosen to keep the full acceptance sequence (section 6) under the stated CI wall-clock budget while still being long enough (30 simulated seconds for determinism, 180 for dogfight) to catch real drift/hangs rather than trivial fixed points.
8. **`tests/tools/hash.test.ts`'s regression vector (section 4.4) is already pinned to a literal value (`'fbe75177'`)**, computed by mechanically running the exact algorithm and byte layout specified in section 4.4 against the exact fixture in that same test, outside this document, once, ahead of hand-off — not left for the implementer to fill in. This is a "generate-then-pin" golden test: the algorithm, byte order (36 floats/entity), and fixture are normative and fully specified in section 4.4, so independently re-running `hashSimState` against that fixture must reproduce `'fbe75177'` exactly; if it does not, the implementation's byte layout or hashing has diverged from section 4.4 and must be fixed to match, not the other way around.
