/**
 * src/ai/pilotAi.ts — AiPilotImpl: per-tick orchestration implementing
 * core.ts's `Pilot` / contracts/ai.ts's `AiPilot`. See docs/spec/06-ai.md
 * section 4.1.
 */
import type { Contact, EntityId, PilotContext, PilotInputs, Vec3Like } from '../contracts/core';
import { ENTITY_INDEX_RADIX, MAX_ENTITIES, NO_ENTITY_ID } from '../contracts/core';
import type {
  AiDifficultyProfile,
  AiPilot,
  AiPilotDebugState,
  AiPilotSpawnParams,
  BfmManoeuvre,
  CreateAiPilot,
  FlightGoal,
} from '../contracts/ai';
import { AiDifficultyProfiles, ControlGains, FormationRole, PitchMode, TacticalState } from '../contracts/ai';
import { clamp, createPrng, nextFloat01, type PrngState } from '../math';

import { computeFormationTargetPos, bearingToPointRad, nextGaussian, type GaussianCache } from './formation';
import { isHostileCandidate, nearestCandidate, scoreThreatContact, selectTarget } from './threatEvaluation';
import { createSteerToGoal } from './steering';
import { computeTerrainAvoidanceGoal } from './terrainAvoidance';
import { selectBfmManoeuvre, buildBfmGoal, createJinkState, type JinkState } from './bfmManoeuvres';
import { decideWeaponEmployment, createWeaponEmploymentState, type WeaponEmploymentState } from './weaponEmployment';
import { resolveHomeRunway, buildLandingGoal } from './landing';
import { buildPatrolGoal, buildRtbGoal, buildInterceptGoal } from './patrol';
import { evaluateTacticalTransition, buildGoalForEngageBvr, buildGoalForMerge, buildGoalForDisengage } from './tacticalFsm';

/**
 * `EntityId`s pack index (low) + generation (high) with plain arithmetic
 * (core.ts's own comment: "never bitwise"), but core.ts only exports the
 * *type* of pack/unpack (`PackEntityId`/`UnpackEntityId`), not a value —
 * the real implementation lives in `src/core/entityPool.ts`, which `src/ai`
 * cannot import (00-architecture.md section 10's dependency rule). This is
 * a private, module-internal re-derivation of the documented index
 * extraction, used only to index this AiPilot's own perception-delay
 * scratch arrays — it never crosses the module boundary as a value the
 * contract cares about.
 */
function entityIndexOf(id: EntityId): number {
  return ((id % ENTITY_INDEX_RADIX) + ENTITY_INDEX_RADIX) % ENTITY_INDEX_RADIX;
}

function defaultFlightGoal(): FlightGoal {
  return {
    pitchMode: PitchMode.AltitudeHold,
    desiredGLoad: 1,
    desiredAltitudeM: 0,
    desiredBankRad: 0,
    desiredSpeedMps: 0,
    throttleOverride: undefined,
    afterburnerOverride: undefined,
    gearDown: false,
    airbrake: false,
  };
}


/** Seconds between the AI's flare + chaff programs while a missile is inbound, by difficulty. */
const COUNTERMEASURE_INTERVAL_SEC: Readonly<Record<AiPilotSpawnParams['difficulty'], number>> = { rookie: 2.5, veteran: 1.2, ace: 0.8 };
class AiPilotImpl implements AiPilot {
  private readonly diffProfile: AiDifficultyProfile;
  private readonly rng: PrngState;

  private state: TacticalState = TacticalState.Patrol;
  private timeInStateSec = 0;
  private manoeuvre: BfmManoeuvre | undefined;
  private timeInManoeuvreSec = 0;
  private targetId: EntityId | undefined;
  private targetScore = 0;

  private readonly goal: FlightGoal = defaultFlightGoal();

  // Patrol anchor for a flight with no mission-supplied `patrolCenterWorld`
  // (a solo AI or a formation leader — 06-ai.md section 5.7's own note, and
  // this project's own dogfight1v1.json `bandit-1`). Captured ONCE, from
  // ctx.self.pos, the first tick Patrol (or a patrol-fallback goal) is built
  // after (re-)entering TacticalState.Patrol from a different state — never
  // re-derived every tick, which would otherwise make the "circular
  // racetrack" anchor a moving target the aircraft can never close on (see
  // 06-ai.md section 4.12's "at first entry" phrasing). Pre-allocated once;
  // only its fields are mutated, never reallocated.
  private readonly patrolAnchorWorld: Vec3Like = { x: 0, y: 0, z: 0 };
  private patrolAnchorCaptured = false;

  private readonly firstSeenSimTimeSec = new Float64Array(MAX_ENTITIES).fill(-1);
  private readonly firstSeenJitterSec = new Float64Array(MAX_ENTITIES);
  private readonly touchedTick = new Int32Array(MAX_ENTITIES).fill(-1);
  private perceptionTick = 0;
  private readonly perceivedContactsScratch: Contact[] = new Array(MAX_ENTITIES);
  private readonly reactionGaussianCache: GaussianCache = { value: undefined };

  private missileWarningFirstSeenSimTimeSec = -1;
  private missileWarningNoticedAt = -1;

  private readonly weaponEmploymentState: WeaponEmploymentState = createWeaponEmploymentState();
  private readonly jinkState: JinkState = createJinkState();
  private readonly steerToGoalFn = createSteerToGoal();
  private readonly formationScratchVec3 = { x: 0, y: 0, z: 0 };
  /** Seconds until the next countermeasure program while a missile warning is noticed. */
  private countermeasureTimerSec = 0;

  // Shallow, per-instance, reused "perceived" view of PilotContext: every
  // field aliases the real ctx's field except `contacts`, which is this
  // tick's reaction-delay-filtered array. Passed to evaluateTacticalTransition
  // (and, via it, target selection's candidate scan) so FSM transitions are
  // delayed exactly like target selection is (06-ai.md section 4.13).
  private readonly perceivedCtx: PilotContext = {
    self: undefined as unknown as PilotContext['self'],
    selfDamage: undefined as unknown as PilotContext['selfDamage'],
    telemetry: undefined as unknown as PilotContext['telemetry'],
    contacts: [],
    combat: undefined as unknown as PilotContext['combat'],
    sampler: undefined as unknown as PilotContext['sampler'],
    navDb: undefined as unknown as PilotContext['navDb'],
    windWorldMps: undefined as unknown as PilotContext['windWorldMps'],
    simTimeSec: 0,
  };

  public readonly debug: AiPilotDebugState = {
    tacticalState: TacticalState.Patrol,
    timeInStateSec: 0,
    activeManoeuvre: undefined,
    targetId: undefined,
    targetThreatScore: 0,
    desiredGLoad: 1,
    desiredBankRad: 0,
    desiredAltitudeM: 0,
    desiredSpeedMps: 0,
    lastLaunchSimTimeSec: -1e9,
  };

  constructor(private readonly params: Readonly<AiPilotSpawnParams>) {
    this.diffProfile = AiDifficultyProfiles[params.difficulty];
    this.rng = createPrng(params.seed);
  }

  update(ctx: PilotContext, dtSec: number, out: PilotInputs): void {
    this.timeInStateSec += dtSec;
    this.timeInManoeuvreSec += dtSec;
    this.perceptionTick += 1;

    const missileWarningNoticed = this.updateMissileWarningNotice(ctx);
    const perceived = this.filterPerceived(ctx);

    this.perceivedCtx.self = ctx.self;
    this.perceivedCtx.selfDamage = ctx.selfDamage;
    this.perceivedCtx.telemetry = ctx.telemetry;
    this.perceivedCtx.contacts = perceived;
    this.perceivedCtx.combat = ctx.combat;
    this.perceivedCtx.sampler = ctx.sampler;
    this.perceivedCtx.navDb = ctx.navDb;
    this.perceivedCtx.windWorldMps = ctx.windWorldMps;
    this.perceivedCtx.simTimeSec = ctx.simTimeSec;

    const leaderAlive = this.formationLeaderAlive(ctx);

    const next = evaluateTacticalTransition(
      this.perceivedCtx,
      this.state,
      this.timeInStateSec,
      this.diffProfile,
      leaderAlive,
      missileWarningNoticed,
      this.params.homeAirportId,
      this.params.homeRunwayId
    );
    if (next !== this.state) {
      this.state = next;
      this.timeInStateSec = 0;
      this.manoeuvre = undefined;
      this.timeInManoeuvreSec = 0;
      if (next === TacticalState.Patrol) this.patrolAnchorCaptured = false;
    }

    const prevTargetId = this.targetId;
    const target = selectTarget(this.perceivedCtx, perceived, this.targetId, this.diffProfile);
    this.targetId = target?.id;
    this.targetScore = target !== undefined ? scoreThreatContact(ctx, target, this.diffProfile) : 0;

    this.buildGoalForState(ctx, target, dtSec);

    const override = computeTerrainAvoidanceGoal(ctx, this.goal, dtSec, this.diffProfile);
    const activeGoal = override ?? this.goal;

    this.steerToGoalFn(ctx, activeGoal, dtSec, out);

    decideWeaponEmployment(ctx, target, this.diffProfile, this.timeInStateSec, dtSec, this.weaponEmploymentState, this.rng, out);
    out.cycleTarget = target?.id !== prevTargetId;
    // Countermeasures: once the missile warning is noticed, flares and chaff together every
    // COUNTERMEASURE_INTERVAL_SEC (a one-tick press each, since the keys are edge-detected).
    this.countermeasureTimerSec -= dtSec;
    const dispense = missileWarningNoticed && this.countermeasureTimerSec <= 0;
    if (dispense) this.countermeasureTimerSec = COUNTERMEASURE_INTERVAL_SEC[this.params.difficulty];
    out.dispenseFlare = dispense;
    out.dispenseChaff = dispense;
    out.nwsEnabled = undefined;
    out.alphaLimiterDisabled = undefined;

    this.syncDebugState(activeGoal);
  }

  // ---- Perception / reaction delay (06-ai.md section 4.13) ----

  private updateMissileWarningNotice(ctx: PilotContext): boolean {
    if (!ctx.combat.missileInboundWarning) {
      this.missileWarningFirstSeenSimTimeSec = -1;
      this.missileWarningNoticedAt = -1;
      return false;
    }
    if (this.missileWarningFirstSeenSimTimeSec < 0) this.missileWarningFirstSeenSimTimeSec = ctx.simTimeSec;
    if (this.missileWarningNoticedAt >= 0) return true;
    if (nextFloat01(this.rng) < this.diffProfile.missileWarningNoticeProb) {
      this.missileWarningNoticedAt = ctx.simTimeSec;
      return true;
    }
    return false;
  }

  private filterPerceived(ctx: PilotContext): readonly Contact[] {
    let count = 0;
    const contacts = ctx.contacts;
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      if (c === undefined) continue;

      if (!isHostileCandidate(ctx.self, c, this.diffProfile)) {
        // Not a candidate this tick: never delayed, passes straight through.
        this.perceivedContactsScratch[count++] = c;
        continue;
      }

      const idx = entityIndexOf(c.id);
      if (idx < 0 || idx >= MAX_ENTITIES) {
        // Out-of-range id (should not happen for a real pooled entity):
        // fail open rather than crash or silently drop the contact.
        this.perceivedContactsScratch[count++] = c;
        continue;
      }

      this.touchedTick[idx] = this.perceptionTick;
      if (this.firstSeenSimTimeSec[idx]! < 0) {
        this.firstSeenSimTimeSec[idx] = ctx.simTimeSec;
        this.firstSeenJitterSec[idx] = nextGaussian(this.rng, this.reactionGaussianCache, nextFloat01) * this.diffProfile.reactionJitterStdSec;
      }
      const elapsedSec = ctx.simTimeSec - this.firstSeenSimTimeSec[idx]!;
      if (elapsedSec >= this.diffProfile.reactionDelaySec + this.firstSeenJitterSec[idx]!) {
        this.perceivedContactsScratch[count++] = c;
      }
    }

    // Clear any tracked-but-no-longer-seen-as-candidate slot so a later
    // re-appearance is treated as new.
    for (let idx = 0; idx < MAX_ENTITIES; idx++) {
      if (this.firstSeenSimTimeSec[idx]! >= 0 && this.touchedTick[idx] !== this.perceptionTick) {
        this.firstSeenSimTimeSec[idx] = -1;
      }
    }

    this.perceivedContactsScratch.length = count;
    return this.perceivedContactsScratch;
  }

  /**
   * The patrol anchor to fly a racetrack around: the mission-supplied fixed
   * `patrolCenterWorld` when set, otherwise this pilot's own captured
   * anchor (frozen at Patrol entry — see `patrolAnchorWorld`'s doc comment
   * above; never `ctx.self.pos` fresh on every call, which would collapse
   * the "tangent point on the circle" geometry to a fixed offset from a
   * moving point and never converge). No allocation: mutates the
   * pre-allocated `patrolAnchorWorld` in place only on first capture.
   */
  private resolvePatrolAnchor(ctx: PilotContext): Readonly<Vec3Like> | undefined {
    if (this.params.patrolCenterWorld !== undefined) return this.params.patrolCenterWorld;
    if (!this.patrolAnchorCaptured) {
      this.patrolAnchorWorld.x = ctx.self.pos.x;
      this.patrolAnchorWorld.y = ctx.self.pos.y;
      this.patrolAnchorWorld.z = ctx.self.pos.z;
      this.patrolAnchorCaptured = true;
    }
    return this.patrolAnchorWorld;
  }

  private formationLeaderAlive(ctx: PilotContext): boolean {
    const formation = this.params.formation;
    if (formation === undefined || formation.role !== FormationRole.Wingman) return true;
    if (formation.leaderId === NO_ENTITY_ID) return false;
    const contacts = ctx.contacts;
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      if (c !== undefined && c.id === formation.leaderId) return true;
    }
    return false;
  }

  // ---- Goal construction (06-ai.md sections 4.8, 4.10, 4.11, 4.12, 4.12a-c) ----

  private buildGoalForState(ctx: PilotContext, target: Readonly<Contact> | undefined, _dtSec: number): void {
    const formation = this.params.formation;
    const isWingman = formation !== undefined && formation.role === FormationRole.Wingman;

    switch (this.state) {
      case TacticalState.Patrol: {
        if (isWingman && this.tryBuildFormationFollowGoal(ctx)) return;
        buildPatrolGoal(ctx, this.resolvePatrolAnchor(ctx), this.params.patrolRadiusM, this.goal);
        return;
      }
      case TacticalState.Intercept: {
        if (isWingman && this.tryBuildFormationFollowGoal(ctx)) return;
        if (target !== undefined) buildInterceptGoal(ctx, target, this.goal);
        else buildPatrolGoal(ctx, this.resolvePatrolAnchor(ctx), this.params.patrolRadiusM, this.goal);
        return;
      }
      case TacticalState.Rtb: {
        if (isWingman && this.tryBuildFormationFollowGoal(ctx)) return;
        buildRtbGoal(ctx, this.params.homeAirportId, this.goal);
        return;
      }
      case TacticalState.EngageBvr: {
        if (target !== undefined) buildGoalForEngageBvr(ctx, target, this.goal);
        else buildPatrolGoal(ctx, this.resolvePatrolAnchor(ctx), this.params.patrolRadiusM, this.goal);
        return;
      }
      case TacticalState.Merge: {
        if (target !== undefined) buildGoalForMerge(ctx, target, this.goal);
        else buildPatrolGoal(ctx, this.resolvePatrolAnchor(ctx), this.params.patrolRadiusM, this.goal);
        return;
      }
      case TacticalState.Disengage: {
        const nearest = nearestCandidate(ctx.contacts, ctx, this.diffProfile);
        buildGoalForDisengage(ctx, nearest, this.goal);
        return;
      }
      case TacticalState.Bfm:
      case TacticalState.Defensive: {
        if (target === undefined) {
          buildPatrolGoal(ctx, this.resolvePatrolAnchor(ctx), this.params.patrolRadiusM, this.goal);
          return;
        }
        const nextManoeuvre = selectBfmManoeuvre(ctx, target, this.state, this.diffProfile, this.manoeuvre, this.timeInManoeuvreSec);
        if (nextManoeuvre !== this.manoeuvre) {
          this.manoeuvre = nextManoeuvre;
          this.timeInManoeuvreSec = 0;
        }
        buildBfmGoal(ctx, target, this.manoeuvre, this.diffProfile, this.goal, this.rng, this.timeInManoeuvreSec, this.jinkState);
        return;
      }
      case TacticalState.Land: {
        const runway = resolveHomeRunway(ctx, this.params.homeAirportId, this.params.homeRunwayId);
        if (runway !== undefined) buildLandingGoal(ctx, runway, this.goal);
        else buildRtbGoal(ctx, this.params.homeAirportId, this.goal);
        return;
      }
      default:
        buildPatrolGoal(ctx, this.resolvePatrolAnchor(ctx), this.params.patrolRadiusM, this.goal);
    }
  }

  private tryBuildFormationFollowGoal(ctx: PilotContext): boolean {
    const formation = this.params.formation;
    if (formation === undefined || formation.leaderId === NO_ENTITY_ID) return false;

    let leaderContact: Contact | undefined;
    const contacts = ctx.contacts;
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      if (c !== undefined && c.id === formation.leaderId) {
        leaderContact = c;
        break;
      }
    }
    if (leaderContact === undefined) return false;

    const targetPoint = computeFormationTargetPos(leaderContact.pos, leaderContact.vel, formation, this.formationScratchVec3);
    const bearingRad = bearingToPointRad(ctx.self.pos, ctx.telemetry.headingRad, targetPoint);
    const leaderSpeedMps = Math.hypot(leaderContact.vel.x, leaderContact.vel.y, leaderContact.vel.z);

    this.goal.pitchMode = PitchMode.AltitudeHold;
    this.goal.desiredAltitudeM = targetPoint.y;
    this.goal.desiredBankRad = clamp(
      ControlGains.HEADING_TO_BANK_KP * bearingRad,
      -ControlGains.MAX_MANOEUVRE_BANK_RAD,
      ControlGains.MAX_MANOEUVRE_BANK_RAD
    );
    this.goal.desiredGLoad = 1;
    this.goal.desiredSpeedMps = clamp(leaderSpeedMps, 80, 280);
    this.goal.throttleOverride = undefined;
    this.goal.afterburnerOverride = false;
    this.goal.gearDown = false;
    this.goal.airbrake = false;
    return true;
  }

  private syncDebugState(activeGoal: Readonly<FlightGoal>): void {
    this.debug.tacticalState = this.state;
    this.debug.timeInStateSec = this.timeInStateSec;
    this.debug.activeManoeuvre = this.manoeuvre;
    this.debug.targetId = this.targetId;
    this.debug.targetThreatScore = this.targetScore;
    this.debug.desiredGLoad = activeGoal.desiredGLoad;
    this.debug.desiredBankRad = activeGoal.desiredBankRad;
    this.debug.desiredAltitudeM = activeGoal.desiredAltitudeM;
    this.debug.desiredSpeedMps = activeGoal.desiredSpeedMps;
    this.debug.lastLaunchSimTimeSec = this.weaponEmploymentState.lastLaunchSimTimeSec;
  }
}

export const createAiPilot: CreateAiPilot = (params: Readonly<AiPilotSpawnParams>): AiPilot => new AiPilotImpl(params);
