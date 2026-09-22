/**
 * src/ai/terrainAvoidance.ts — ground-proximity avoidance safety override.
 * See docs/spec/06-ai.md section 4.4.
 *
 * CONTRACT NOTE: `ComputeTerrainAvoidanceGoal` (contracts/ai.ts) is typed as
 * `(ctx, currentGoal, dtSec) => FlightGoal | undefined`, but section 4.4's
 * formula needs `difficulty.maxCommandedGLoad`, which is not reachable from
 * a bare `PilotContext`. As with `scoreThreatContact` (see threatEvaluation.ts's
 * note), `difficulty` is added as a fourth OPTIONAL parameter — still
 * structurally assignable to the contract type — defaulting to the
 * `veteran` profile when omitted. `pilotAi.ts` always passes the real
 * difficulty explicitly.
 */
import type { PilotContext } from '../contracts/core';
import type { FlightGoal, ComputeTerrainAvoidanceGoal, AiDifficultyProfile } from '../contracts/ai';
import { PitchMode, TerrainAvoidanceParams, AiDifficultyProfiles } from '../contracts/ai';
import { clamp } from '../math';

const FALLBACK_DIFFICULTY = AiDifficultyProfiles.veteran;

// Pooled, module-owned scratch goal. Safe to share across all AiPilot
// instances because pilot updates run sequentially (never re-entrant/
// concurrent) within one sim tick, and the caller (pilotAi.ts) consumes the
// returned object synchronously before the next call.
const scratchGoal: FlightGoal = {
  pitchMode: PitchMode.GLoad,
  desiredGLoad: 1,
  desiredAltitudeM: 0,
  desiredBankRad: 0,
  desiredSpeedMps: 0,
  throttleOverride: 1,
  afterburnerOverride: false,
  gearDown: false,
  airbrake: false,
};

// NOTE: exported WITHOUT a `: ComputeTerrainAvoidanceGoal` annotation on the
// const — see threatEvaluation.ts's identical note on `scoreThreatContact`.
// `_computeTerrainAvoidanceGoalSatisfiesContract` below is the checked proof
// of contract compliance.
function computeTerrainAvoidanceGoalImpl(
  ctx: PilotContext,
  _currentGoal: Readonly<FlightGoal>,
  _dtSec: number,
  difficulty?: Readonly<AiDifficultyProfile>
): FlightGoal | undefined {
  const diff = difficulty ?? FALLBACK_DIFFICULTY;
  const vel = ctx.self.vel;
  const pos = ctx.self.pos;
  const speedHorizontal = Math.hypot(vel.x, vel.z);

  let sampleCount = Math.ceil((speedHorizontal * TerrainAvoidanceParams.LOOKAHEAD_SEC) / TerrainAvoidanceParams.SAMPLE_SPACING_MAX_M) + 1;
  sampleCount = clamp(sampleCount, TerrainAvoidanceParams.SAMPLE_COUNT, TerrainAvoidanceParams.SAMPLE_COUNT_MAX);

  let worstClearanceM = Infinity;
  const denom = sampleCount - 1;
  for (let i = 0; i < sampleCount; i++) {
    const t = denom > 0 ? (i / denom) * TerrainAvoidanceParams.LOOKAHEAD_SEC : 0;
    const sampleX = pos.x + vel.x * t;
    const sampleZ = pos.z + vel.z * t;
    const projectedY = pos.y + vel.y * t;
    const terrainY = ctx.sampler.heightAt(sampleX, sampleZ);
    const clearanceM = projectedY - terrainY;
    if (clearanceM < worstClearanceM) worstClearanceM = clearanceM;
  }

  if (worstClearanceM >= TerrainAvoidanceParams.MIN_CLEARANCE_M) return undefined;

  const hard = worstClearanceM < TerrainAvoidanceParams.HARD_MIN_CLEARANCE_M;
  scratchGoal.pitchMode = PitchMode.GLoad;
  scratchGoal.desiredBankRad = 0;
  scratchGoal.desiredGLoad = hard ? diff.maxCommandedGLoad : diff.maxCommandedGLoad * 0.7;
  scratchGoal.desiredAltitudeM = ctx.telemetry.altMslM;
  scratchGoal.desiredSpeedMps = ctx.telemetry.iasMps;
  scratchGoal.throttleOverride = 1.0;
  scratchGoal.afterburnerOverride = hard;
  scratchGoal.gearDown = false;
  scratchGoal.airbrake = false;
  return scratchGoal;
}
export const computeTerrainAvoidanceGoal = computeTerrainAvoidanceGoalImpl;
const _computeTerrainAvoidanceGoalSatisfiesContract: ComputeTerrainAvoidanceGoal = computeTerrainAvoidanceGoalImpl;
