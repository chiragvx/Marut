/**
 * tools/sim-check.ts — headless CLI entry point (module 12).
 * See docs/spec/12-verification.md section 4.1 (build/run) and sections
 * 4.2/4.5/4.7/5 (trim, determinism, dogfight algorithms).
 *
 * This is IMPLEMENTATION code, not a contract file, so it is free to import
 * directly from src/aircraft, src/physics, src/math and src/core (section
 * 4.1's own note) in addition to this module's own tools/lib/*.
 *
 * Bundled to dist-tools/sim-check.mjs by scripts/vite.tools.config.ts and
 * run with plain `node` (see that file and 12-verification.md section 4.1).
 */
import { writeFileSync } from 'node:fs';
import type { Mission, Pilot, EntityState, DamageState, AircraftTelemetry } from '../src/contracts/core';
import { AiDifficulty } from '../src/contracts/core';
import type { SimCheckCliOptions, DeterminismCheckpoint, DeterminismResult, SimWorldHandle } from '../src/contracts/verify';
import {
  SimCheckMode,
  SimCheckExitCode,
  TrimStatus,
  DETERMINISM_TEST_TICKS,
  DETERMINISM_CHECKPOINT_INTERVAL_TICKS,
} from '../src/contracts/verify';
import type { TrimCondition } from '../src/contracts/verify';
import { tejasDefinition } from '../src/aircraft';
import { stepAircraft } from '../src/physics';
import * as core from '../src/core';
import { checkPerformanceTarget, findGCommandTrim, makeTrimSeedState, isaAt } from './lib/trimSolver';
import { PERFORMANCE_TARGETS } from './lib/perfTargets';
import { formatPerformanceTable } from './lib/table';
import { hashSimState } from './lib/hash';
import { runAiDogfight } from './lib/dogfightRunner';
import { adaptWorldToHandle, createRealWorld } from './lib/worldAdapter';

// -----------------------------------------------------------------------------
// CLI argument parsing.
// -----------------------------------------------------------------------------

interface ParsedCliOptions extends SimCheckCliOptions {
  difficulty?: AiDifficulty;
}

function parseArgs(argv: readonly string[]): ParsedCliOptions {
  let mode: SimCheckMode = SimCheckMode.All;
  let missionPath = 'src/core/missions/freeFlight.json';
  let seed = 12345;
  let outJsonPath: string | undefined;
  let verbose = false;
  let difficulty: AiDifficulty | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      i += 1;
      return argv[i] ?? '';
    };
    switch (arg) {
      case '--mode':
        mode = next() as SimCheckMode;
        break;
      case '--mission':
        missionPath = next();
        break;
      case '--seed':
        seed = Number(next());
        break;
      case '--out':
        outJsonPath = next();
        break;
      case '--verbose':
        verbose = true;
        break;
      case '--difficulty':
        difficulty = next() as AiDifficulty;
        break;
      default:
        break;
    }
  }
  return { mode, missionPath, seed, outJsonPath, verbose, difficulty };
}

/**
 * `src/core/missions/*.json` on disk are `MissionDescriptor`s (contracts/sim.ts
 * section 9), not `Mission`s directly -- resolving one into a real `Mission`
 * needs module 04/05's real airport/terrain factories, which only
 * `src/core`'s own `resolveBuiltinMission(id)` (barrel export) has wired up.
 * `--mission` is therefore mapped from the file path the acceptance
 * checklist (12-verification.md section 8) passes to the matching builtin
 * id, rather than parsed as JSON directly.
 */
function loadMission(path: string): Mission {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.endsWith('freeFlight.json')) return core.resolveBuiltinMission('free-flight');
  if (normalized.endsWith('dogfight1v1.json')) return core.resolveBuiltinMission('dogfight-1v1');
  console.error(
    `sim-check.ts's --mission '${path}' is not one of the two built-in missions (src/core/missions/freeFlight.json, src/core/missions/dogfight1v1.json). Arbitrary MissionDescriptor JSON paths are not yet supported by this CLI.`
  );
  process.exit(SimCheckExitCode.UsageError);
}

// -----------------------------------------------------------------------------
// World creation. Uses the shared adapter in tools/lib/worldAdapter.ts (also
// used by tests/integration/testHarness.ts) so both places carry the same
// World -> SimWorldHandle bridging logic and the same one guessed seam.
// -----------------------------------------------------------------------------

function createWorldOrExit(mission: Mission, seed: number): SimWorldHandle {
  const result = createRealWorld(core, mission, seed);
  if (!result.ok) {
    console.error(`Failed to create sim world: ${result.error}`);
    process.exit(SimCheckExitCode.UsageError);
  }
  return adaptWorldToHandle(result.value);
}

// -----------------------------------------------------------------------------
// Mode: trim (12-verification.md sections 4.2, 5.1, 5.2).
// -----------------------------------------------------------------------------

const TRIM_GRID_ALTITUDES_M: readonly number[] = [0, 3000, 6000, 9000, 11000, 14000];
const TRIM_GRID_SPEEDS_MPS: readonly number[] = [150, 200, 250, 300, 350];
const TRIM_GRID_MASS_KG = 9500;
const TRIM_GRID_SPEED_OVER_SOUND_SKIP_FACTOR = 1.3;

function runTrimMode(verbose: boolean): number {
  const results = PERFORMANCE_TARGETS.map((target) => checkPerformanceTarget(stepAircraft, tejasDefinition, target));
  console.log(formatPerformanceTable(results));
  const allNamedPassed = results.every((r) => r.passed);

  console.log('\nTrim envelope grid (altitude m x speed m/s):');
  let gridOk = true;
  for (const altitudeM of TRIM_GRID_ALTITUDES_M) {
    for (const speedMps of TRIM_GRID_SPEEDS_MPS) {
      if (speedMps > TRIM_GRID_SPEED_OVER_SOUND_SKIP_FACTOR * isaAt(altitudeM).soundSpeedMps) continue;
      const condition: TrimCondition = { altitudeM, speedMps, bankRad: 0, massKg: TRIM_GRID_MASS_KG };
      const seed = makeTrimSeedState(condition);
      // Cross-module fix: this grid probes src/physics/fcs.ts's real
      // G-command closed loop, not an open-loop aircraft, so it must use
      // `findGCommandTrim` (see that function's own doc comment in
      // tools/lib/trimSolver.ts for why the generic 2D Newton `findTrim` —
      // still correct and exercised by tests/tools/trimSolver.test.ts
      // against a synthetic open-loop plant — cannot converge against this
      // closed loop: a sustained gCmd != 1 in wings-level flight has no
      // steady state for a pitchStick-perturbing Newton search to find).
      // This was the direct cause of this grid's near-total
      // out_of_control_authority/max_iterations_exceeded failure rate.
      const result = findGCommandTrim(stepAircraft, tejasDefinition, condition, seed);
      if (verbose || result.status !== TrimStatus.Converged) {
        console.log(`  alt=${altitudeM.toString().padStart(5)} m  speed=${speedMps.toString().padStart(4)} m/s  -> ${result.status}`);
      }
      if (result.status !== TrimStatus.Converged) gridOk = false;
    }
  }

  return allNamedPassed && gridOk ? SimCheckExitCode.Success : SimCheckExitCode.PerformanceFailure;
}

// -----------------------------------------------------------------------------
// Mode: determinism (12-verification.md section 4.5).
// -----------------------------------------------------------------------------

function makeScriptedPilot(): Pilot {
  let tick = 0;
  return {
    update(_ctx, _dtSec, out) {
      out.pitch = Math.sin(tick / 240) * 0.3;
      out.roll = Math.sin(tick / 180) * 0.4;
      out.yaw = 0;
      out.throttle = 0.8;
      out.afterburner = false;
      out.brakes = 0;
      out.gearDown = false;
      out.airbrake = false;
      out.trigger = tick % 300 === 0;
      out.launch = false;
      out.cycleWeapon = false;
      out.cycleTarget = false;
      tick += 1;
    },
  };
}

function hashWorld(world: SimWorldHandle): string {
  const ids = [...world.listAliveEntityIds()].sort((a, b) => a - b);
  const entities: Array<{ state: EntityState; damage?: DamageState; telemetry?: AircraftTelemetry }> = [];
  for (const id of ids) {
    const state = world.getEntityState(id);
    if (state === undefined) continue;
    entities.push({ state, damage: world.getDamage(id), telemetry: world.getTelemetry(id) });
  }
  return hashSimState(entities);
}

const DETERMINISM_SPAWN_AIRCRAFT_ID = 'tejas-mk1';
const DETERMINISM_SPAWN_ALTITUDE_M = 4000;
const DETERMINISM_SPAWN_SPEED_MPS = 200;

function runDeterminismMode(missionPath: string, seed: number, verbose: boolean): number {
  const mission = loadMission(missionPath);
  const worldA = createWorldOrExit(mission, seed);
  const worldB = createWorldOrExit(mission, seed);
  worldA.spawnAircraft(
    DETERMINISM_SPAWN_AIRCRAFT_ID,
    0,
    { x: 0, y: DETERMINISM_SPAWN_ALTITUDE_M, z: 0 },
    0,
    DETERMINISM_SPAWN_SPEED_MPS,
    makeScriptedPilot()
  );
  worldB.spawnAircraft(
    DETERMINISM_SPAWN_AIRCRAFT_ID,
    0,
    { x: 0, y: DETERMINISM_SPAWN_ALTITUDE_M, z: 0 },
    0,
    DETERMINISM_SPAWN_SPEED_MPS,
    makeScriptedPilot()
  );

  const checkpointsA: DeterminismCheckpoint[] = [];
  const checkpointsB: DeterminismCheckpoint[] = [];
  for (let t = 1; t <= DETERMINISM_TEST_TICKS; t++) {
    worldA.stepFixed();
    worldB.stepFixed();
    if (t % DETERMINISM_CHECKPOINT_INTERVAL_TICKS === 0) {
      checkpointsA.push({ tick: t, hash: hashWorld(worldA) });
      checkpointsB.push({ tick: t, hash: hashWorld(worldB) });
    }
  }

  let firstDivergentTick: number | undefined;
  for (let i = 0; i < checkpointsA.length; i++) {
    const a = checkpointsA[i];
    const b = checkpointsB[i];
    if (a !== undefined && b !== undefined && a.hash !== b.hash) {
      firstDivergentTick = a.tick;
      break;
    }
  }
  const matched = firstDivergentTick === undefined;

  const result: DeterminismResult = {
    seed,
    ticksRun: DETERMINISM_TEST_TICKS,
    checkpointsA,
    checkpointsB,
    matched,
    firstDivergentTick,
  };
  if (verbose) console.log(JSON.stringify(result, null, 2));
  console.log(matched ? 'Determinism: MATCHED' : `Determinism: DIVERGED at tick ${firstDivergentTick}`);
  return matched ? SimCheckExitCode.Success : SimCheckExitCode.DeterminismFailure;
}

// -----------------------------------------------------------------------------
// Mode: dogfight (12-verification.md section 4.7).
// -----------------------------------------------------------------------------

const DOGFIGHT_DEFAULT_AIRCRAFT_ID = 'tejas-mk1';

function runDogfightMode(missionPath: string, seed: number, difficulty: AiDifficulty | undefined, verbose: boolean): number {
  const mission = loadMission(missionPath);
  const world = createWorldOrExit(mission, seed);
  const diff = difficulty ?? AiDifficulty.Veteran;
  const result = runAiDogfight(world, {
    seed,
    difficultyTeam0: diff,
    difficultyTeam1: diff,
    aircraftDefId: DOGFIGHT_DEFAULT_AIRCRAFT_ID,
  });
  if (verbose) console.log(JSON.stringify(result, null, 2));
  console.log(
    `Dogfight (${diff} vs ${diff}): terminatedByKill=${result.terminatedByKill} groundCollision=${result.groundCollision} cheatSuspected=${result.cheatSuspected} ticksRun=${result.ticksRun}`
  );
  const ok = !result.cheatSuspected && !result.groundCollision;
  return ok ? SimCheckExitCode.Success : SimCheckExitCode.DogfightFailure;
}

// -----------------------------------------------------------------------------
// Main.
// -----------------------------------------------------------------------------

const VALID_MODES: readonly string[] = Object.values(SimCheckMode);

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  if (!VALID_MODES.includes(opts.mode)) {
    console.error(`Unknown --mode '${opts.mode}'. Expected one of: ${VALID_MODES.join(', ')}`);
    process.exitCode = SimCheckExitCode.UsageError;
    return;
  }

  let exitCode: number = SimCheckExitCode.Success;
  const recordExit = (code: number): void => {
    if (exitCode === SimCheckExitCode.Success && code !== SimCheckExitCode.Success) exitCode = code;
  };

  if (opts.mode === SimCheckMode.Trim || opts.mode === SimCheckMode.All) {
    recordExit(runTrimMode(opts.verbose));
  }
  if (opts.mode === SimCheckMode.Determinism || opts.mode === SimCheckMode.All) {
    recordExit(runDeterminismMode(opts.missionPath, opts.seed, opts.verbose));
  }
  if (opts.mode === SimCheckMode.Dogfight || opts.mode === SimCheckMode.All) {
    recordExit(runDogfightMode(opts.missionPath, opts.seed, opts.difficulty, opts.verbose));
  }

  if (opts.outJsonPath !== undefined) {
    writeFileSync(
      opts.outJsonPath,
      JSON.stringify({ mode: opts.mode, missionPath: opts.missionPath, seed: opts.seed, exitCode }, null, 2)
    );
  }

  process.exitCode = exitCode;
}

main();
