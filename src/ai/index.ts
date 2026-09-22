/**
 * src/ai/index.ts — barrel re-export. The one value src/core imports is
 * `createAiPilot`; everything else is exported so tests/ai/*.test.ts can
 * import and unit-test each internal collaborator in isolation (06-ai.md
 * section 3).
 */
export { createAiPilot } from './pilotAi';

export { AiDifficultyProfiles } from './difficultyProfiles';
export { computeEnergyHeightM } from './energyState';
export { headingFromVelocity, computeAspectAngleRad, computeFormationTargetPos, headingOfDelta, bearingToPointRad, nextGaussian } from './formation';
export type { GaussianCache } from './formation';
export {
  scoreThreatContact,
  selectTarget,
  isHostileCandidate,
  pickBestCandidate,
  nearestCandidate,
  nearestCandidateRangeM,
} from './threatEvaluation';
export { createSteerToGoal } from './steering';
export { computeTerrainAvoidanceGoal } from './terrainAvoidance';
export { selectBfmManoeuvre, buildBfmGoal, createJinkState } from './bfmManoeuvres';
export type { JinkState } from './bfmManoeuvres';
export { estimateWeaponEnvelope, decideWeaponEmployment, createWeaponEmploymentState } from './weaponEmployment';
export type { WeaponEmploymentState } from './weaponEmployment';
export { resolveHomeRunway, buildLandingGoal, rangeToThresholdM, LOCALISER_CAPTURE_RANGE_M, GLIDESLOPE_CAPTURE_RANGE_M, FINAL_APPROACH_SPEED_MPS } from './landing';
export { buildPatrolGoal, buildRtbGoal, buildInterceptGoal } from './patrol';
export { evaluateTacticalTransition, buildGoalForEngageBvr, buildGoalForMerge, buildGoalForDisengage } from './tacticalFsm';
