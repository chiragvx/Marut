/**
 * =============================================================================
 * TEJAS SIM — MODULE 06 CONTRACT: COMBAT AI (docs/spec/contracts/ai.ts)
 * =============================================================================
 * Owner: module 06 (docs/spec/06-ai.md). Implemented by src/ai/*.
 *
 * Imports ONLY from './core'. This file deliberately does NOT import from
 * './math' even though 00-architecture.md permits any contract to do so: at
 * drafting time this module has not seen contracts/math.ts's actual export
 * surface (only 00-architecture.md's prose description of it), so every
 * vector/quaternion shape below uses core.ts's structural `Vec3Like` instead
 * of importing a concrete `Vec3`/`Quat` type that might not match module 01's
 * final names. src/ai's IMPLEMENTATION is of course free (and expected) to
 * import and use the real mutable Vec3/Quat/Mat3 classes and the mulberry32
 * PRNG from 'src/math' internally — this restriction applies only to this
 * contract file's own compile-time surface. See 06-ai.md section 9.
 *
 * Contains ONLY interfaces, type aliases, `as const` objects + derived union
 * types, and bare function-signature type aliases. NO implementation code.
 * Must compile standalone with `tsc --noEmit --strict`.
 *
 * DESIGN SUMMARY (full detail in 06-ai.md):
 *   - AiPilot implements core.ts's `Pilot` interface. It is a two-layer
 *     controller: a discrete TACTICAL layer (`TacticalState` FSM +
 *     `BfmManoeuvre` selection) decides WHAT the aircraft should be doing and
 *     emits a `FlightGoal`; a continuous CONTROL layer (`SteerToGoal`) turns
 *     that `FlightGoal` into `PilotInputs` every tick via PD control loops,
 *     going through the SAME flight-model/FCS path as the human player — the
 *     AI never touches control-surface deflections or forces directly.
 *   - The AI reads only `PilotContext` (core.ts): `self`/`telemetry` for its
 *     own state, `contacts` (sensor tracks, never ground truth) for outside
 *     awareness, `combat` for weapon/lock status, `sampler`/`navDb` for
 *     terrain and airport data. It never imports contracts/aircraft.ts,
 *     contracts/combat.ts or contracts/flight.ts, so it never reads another
 *     aircraft's true performance envelope, the real missile flight model or
 *     the Tejas's actual structural g-limit — every "envelope" constant below
 *     (gun/missile range bands, commanded g caps) is the AI's OWN estimate,
 *     analogous to what a real pilot judges from training/instruments, not a
 *     read of another module's private data. See 06-ai.md section 9.
 * =============================================================================
 */

import type {
  AiDifficulty,
  Contact,
  EntityId,
  LockState,
  PilotContext,
  PilotInputs,
  Pilot,
  Team,
  Vec3Like,
  WeaponKind,
} from './core';

// -----------------------------------------------------------------------------
// 1. Difficulty profiles. `core.ts` defines the `AiDifficulty` union
//    ('rookie'|'veteran'|'ace'); this module owns the concrete numeric
//    parameter set behind each level.
// -----------------------------------------------------------------------------

export interface AiDifficultyProfile {
  readonly id: AiDifficulty;
  /** UI display name, e.g. "Veteran". Consumed by src/ui's difficulty picker (src/ui imports src/contracts/* freely; see 00-architecture.md section 10). */
  readonly displayName: string;
  /** One-line UI description of what this level means for the player. */
  readonly descriptionText: string;
  /** Seconds between a fact becoming perceivable (a contact identified hostile, a new RWR warning) and this AI acting on it. See 06-ai.md 4.13. */
  reactionDelaySec: number;
  /** +/- standard deviation, seconds, of Gaussian jitter added to reactionDelaySec per new perceived event (mulberry32-derived, not Math.random). */
  reactionJitterStdSec: number;
  /** Contacts beyond this range (m) are excluded from threat scoring / target selection regardless of sensor detection — models limited scan/attention, not sensor range (sensor range itself is src/combat's job). */
  saRadiusM: number;
  /** Absolute maximum body +Y load factor (g) this AI will ever command via FlightGoal.desiredGLoad. NOT a fraction of the airframe's true structural limit (the AI has no access to AircraftDefinition.fcsLimits) — a fixed, difficulty-scaled self-imposed ceiling. The real FCS (src/physics, outside AI's knowledge) independently clamps to the airframe's actual limit regardless of this value. */
  maxCommandedGLoad: number;
  /** Minimum (most negative) body +Y load factor (g) this AI will command, used only by the Jink manoeuvre. */
  minCommandedGLoad: number;
  /** Standard deviation, degrees, of Gaussian error added to the AI's gun/lead-pursuit aim heading before it is fed to the control layer. 0 = perfect. */
  gunAccuracyErrorStdDeg: number;
  /** Probability [0,1], evaluated once per SIM_DT_SEC tick while `combat.missileInboundWarning` is true and not yet noticed, that this AI notices it this tick (models imperfect RWR interpretation). Once noticed for a given warning onset, always reacted to on subsequent ticks. */
  missileWarningNoticeProb: number;
  /** Multiplier applied to every *_DEG / *_M / *_SEC trigger threshold in `BfmThresholds` that gates a defensive reaction (Notch, BreakTurn, Jink) — values > 1 make the AI react later/less precisely (sloppier), < 1 earlier/tighter. Multiplies the threshold, not the outcome. */
  bfmSkillMultiplier: number;
  /** Max missiles (of any kind, combined) this AI keeps in flight against one target before withholding further launches at that target. */
  maxSimultaneousMissilesPerTarget: number;
}

export const AiDifficultyProfiles: Readonly<Record<AiDifficulty, AiDifficultyProfile>> = {
  rookie: {
    id: 'rookie',
    displayName: 'Rookie',
    descriptionText: 'Slow to react, flies conservatively, poor gun accuracy.',
    reactionDelaySec: 1.2,
    reactionJitterStdSec: 0.5,
    saRadiusM: 9000,
    maxCommandedGLoad: 5.0,
    minCommandedGLoad: 0.5,
    gunAccuracyErrorStdDeg: 3.0,
    missileWarningNoticeProb: 0.35,
    bfmSkillMultiplier: 1.6,
    maxSimultaneousMissilesPerTarget: 1,
  },
  veteran: {
    id: 'veteran',
    displayName: 'Veteran',
    descriptionText: 'Competent BFM, moderate reaction time, decent gun accuracy.',
    reactionDelaySec: 0.6,
    reactionJitterStdSec: 0.25,
    saRadiusM: 14000,
    maxCommandedGLoad: 7.0,
    minCommandedGLoad: -1.0,
    gunAccuracyErrorStdDeg: 1.2,
    missileWarningNoticeProb: 0.7,
    bfmSkillMultiplier: 1.0,
    maxSimultaneousMissilesPerTarget: 2,
  },
  ace: {
    id: 'ace',
    displayName: 'Ace',
    descriptionText: 'Near-instant reactions, aggressive BFM, accurate gunnery.',
    reactionDelaySec: 0.25,
    reactionJitterStdSec: 0.1,
    saRadiusM: 20000,
    maxCommandedGLoad: 8.5,
    minCommandedGLoad: -2.0,
    gunAccuracyErrorStdDeg: 0.4,
    missileWarningNoticeProb: 0.95,
    bfmSkillMultiplier: 0.7,
    maxSimultaneousMissilesPerTarget: 2,
  },
} as const;

// -----------------------------------------------------------------------------
// 2. Tactical FSM states (outer decision layer).
// -----------------------------------------------------------------------------

export const TacticalState = {
  Patrol: 'patrol',
  Intercept: 'intercept',
  EngageBvr: 'engage_bvr',
  Merge: 'merge',
  Bfm: 'bfm',
  Defensive: 'defensive',
  Disengage: 'disengage',
  Rtb: 'rtb',
  Land: 'land',
} as const;
export type TacticalState = (typeof TacticalState)[keyof typeof TacticalState];
export const TacticalStateCode: Record<TacticalState, number> = {
  patrol: 0,
  intercept: 1,
  engage_bvr: 2,
  merge: 3,
  bfm: 4,
  defensive: 5,
  disengage: 6,
  rtb: 7,
  land: 8,
} as const;

// -----------------------------------------------------------------------------
// 3. BFM manoeuvre library. First five are OFFENSIVE (selected only while
//    TacticalState.Bfm), last four are DEFENSIVE (selected only while
//    TacticalState.Defensive). See 06-ai.md 4.8.
// -----------------------------------------------------------------------------

export const BfmManoeuvre = {
  PurePursuit: 'pure_pursuit',
  LeadPursuit: 'lead_pursuit',
  LagPursuit: 'lag_pursuit',
  HighYoYo: 'high_yoyo',
  LowYoYo: 'low_yoyo',
  BreakTurn: 'break_turn',
  Notch: 'notch',
  Extension: 'extension',
  Jink: 'jink',
} as const;
export type BfmManoeuvre = (typeof BfmManoeuvre)[keyof typeof BfmManoeuvre];
export const BfmManoeuvreCode: Record<BfmManoeuvre, number> = {
  pure_pursuit: 0,
  lead_pursuit: 1,
  lag_pursuit: 2,
  high_yoyo: 3,
  low_yoyo: 4,
  break_turn: 5,
  notch: 6,
  extension: 7,
  jink: 8,
} as const;

// -----------------------------------------------------------------------------
// 4. Formation keeping.
// -----------------------------------------------------------------------------

export const FormationRole = { Leader: 'leader', Wingman: 'wingman' } as const;
export type FormationRole = (typeof FormationRole)[keyof typeof FormationRole];

export interface AiFormationSlot {
  role: FormationRole;
  /** EntityId of the flight leader. src/core must spawn a MissionAiFlight's leader (formation index 0) before its wingmen so this id is known at each wingman's AiPilotSpawnParams construction time — see 06-ai.md section 9. Ignored when role === 'leader'. If the referenced entity is dead or NO_ENTITY_ID, the wingman falls back to independent Patrol/Intercept behaviour (see 06-ai.md 4.10) rather than erroring. */
  leaderId: EntityId;
  /** Desired rightward offset from the leader's ground track, m (+ = leader's right). Computed against a heading derived from the leader's Contact.vel — Contact carries no orientation field, so full 3-D body-frame offsets are not obtainable; see `HeadingFromVelocity` below. */
  slotRightM: number;
  /** Desired aft offset along the leader's ground track, m (+ = behind leader). */
  slotBackM: number;
  /** Desired vertical offset from the leader's altitude, m (+ = above), applied directly in world Y. */
  slotUpM: number;
}

/** Heading (world convention, rad, [0,2*PI)) implied by a velocity vector: atan2(vel.x, -vel.z). Returns 0 (assumed-north fallback) when |velWorld| < MIN_SPEED_FOR_HEADING_MPS (see ThreatWeights) since a near-stationary object's velocity direction is not a meaningful heading estimate. Pure, no allocation. */
export type HeadingFromVelocity = (velWorld: Readonly<Vec3Like>) => number;

/** Angle (rad, [-PI,PI]) at the OBSERVED aircraft's nose between its own heading and the line of sight back to the observer. 0 = observed is pointed directly at observer (observer is in maximum danger from observed); +/-PI = observer is directly behind observed (a tail shot on observed). Used both for threat scoring (contact->self) and for defensive geometry (attacker->self) — see 06-ai.md 4.5 and 4.8. Pure, no allocation. */
export type ComputeAspectAngleRad = (
  observedHeadingRad: number,
  observedPos: Readonly<Vec3Like>,
  observerPos: Readonly<Vec3Like>
) => number;

/** Writes the world-frame position the given formation slot should occupy right now into `out` and returns `out`. Pure, no allocation. See 06-ai.md 4.10 for the worked example. */
export type ComputeFormationTargetPos = (
  leaderPos: Readonly<Vec3Like>,
  leaderVelWorld: Readonly<Vec3Like>,
  slot: Readonly<AiFormationSlot>,
  out: Vec3Like
) => Vec3Like;

// -----------------------------------------------------------------------------
// 5. FlightGoal — the shape the tactical layer hands to the control layer
//    every tick. Always fully populated (no per-tick allocation: callers
//    reuse one pooled FlightGoal object and overwrite its fields).
// -----------------------------------------------------------------------------

export const PitchMode = {
  /** Track a target body +Y load factor directly (BFM/manoeuvring). */
  GLoad: 'g_load',
  /** Track a target MSL altitude via an internal flight-path-angle loop (cruise: Patrol/Rtb/Land legs, Intercept). */
  AltitudeHold: 'altitude_hold',
} as const;
export type PitchMode = (typeof PitchMode)[keyof typeof PitchMode];

export interface FlightGoal {
  pitchMode: PitchMode;
  /** Body +Y load factor, g. Meaningful only when pitchMode === 'g_load'; otherwise carries the last commanded value for debug display only. */
  desiredGLoad: number;
  /** MSL altitude, m. Meaningful only when pitchMode === 'altitude_hold'. */
  desiredAltitudeM: number;
  /** rad, + = right wing down, matches core.ts's roll/bank sign convention exactly (no conversion needed against AircraftTelemetry.rollRad). */
  desiredBankRad: number;
  desiredSpeedMps: number;
  /** [0,1]. When set, SteerToGoal writes this directly to PilotInputs.throttle and bypasses the speed-hold PI loop entirely (resetting its integral term to 0 for smooth resumption once cleared). */
  throttleOverride?: number;
  afterburnerOverride?: boolean;
  gearDown: boolean;
  airbrake: boolean;
}

/**
 * The control layer. Converts one FlightGoal into PilotInputs for this tick
 * via independent PD/PI loops (bank, pitch, speed, yaw-coordination) using
 * only `ctx.self`/`ctx.telemetry` — the SAME information a HUD would show a
 * human. Writes every field of `out`; never allocates; `out` may be a pooled
 * PilotInputs reused across ticks. Boolean fields not driven by steering
 * (trigger/launch/cycleWeapon/cycleTarget) are left at whatever the caller
 * pre-set on `out` (weapon employment, section 6, sets those separately).
 * See 06-ai.md 4.2-4.3 for the exact per-field formulas and `ControlGains`.
 */
export type SteerToGoal = (ctx: PilotContext, goal: Readonly<FlightGoal>, dtSec: number, out: PilotInputs) => void;

/** Tunable gains for `SteerToGoal`. Units are documented per field; see 06-ai.md 4.2-4.3 for the formula each one appears in. */
export const ControlGains = {
  /** Roll-input command per radian of bank error. */
  BANK_KP: 2.2,
  /** Roll-input command per (rad/s) of roll rate (bodyRateP = omega.x), damping term. */
  BANK_RATE_KD: 0.35,
  /** Pitch-input command per g of (desiredGLoad - telemetry.gLoad), used when pitchMode === 'g_load'. */
  G_KP: 0.12,
  /** Pitch-input command per (rad/s) of pitch rate (bodyRateQ = omega.z), damping term, g_load mode. */
  G_RATE_KD: 0.05,
  /** rad of target flight-path angle per metre of altitude error, used when pitchMode === 'altitude_hold'. */
  ALT_TO_FPA_KP: 0.006,
  /** Clamp on the altitude-hold loop's target flight-path angle, rad (~10 deg). */
  MAX_ALT_HOLD_FPA_RAD: 0.174533,
  /** Pitch-input command per rad of flight-path-angle error, altitude_hold mode. */
  FPA_KP: 2.0,
  /** Pitch-input command per (rad/s) of pitch rate, damping term, altitude_hold mode. */
  FPA_RATE_KD: 0.4,
  /** Throttle delta per (m/s) of (desiredSpeedMps - telemetry.iasMps). */
  SPEED_KP: 0.008,
  /** Throttle delta per (m/s*s) of accumulated speed-error integral. */
  SPEED_KI: 0.0015,
  /** Clamp on the SPEED_KI*integral contribution to throttle, unitless [0,1] scale. */
  SPEED_INTEGRAL_CLAMP: 0.4,
  /** Baseline throttle (unitless) added before the P/I terms — a mid-power trim guess. */
  SPEED_THROTTLE_BIAS: 0.5,
  /** m/s of sustained (desiredSpeedMps - iasMps) deficit, at throttle already saturated to 1.0, before SteerToGoal engages afterburner on its own (independent of goal.afterburnerOverride). */
  AB_ENGAGE_SPEED_DEFICIT_MPS: 15,
  /** Rudder(yaw)-input command per radian of sideslip (telemetry.betaRad), sign chosen so positive beta (wind from the right) drives a positive (nose-right) yaw command, nulling beta — see 06-ai.md 4.2 for the sign derivation. */
  YAW_BETA_KP: 1.4,
  /** rad of desiredBankRad per radian of heading error, used by tacticalFsm/bfmManoeuvres (NOT by SteerToGoal itself) to turn a target bearing into a bank command before handing off a FlightGoal — see 06-ai.md 4.8. */
  HEADING_TO_BANK_KP: 1.3,
  /** Hard clamp on any BFM-derived desiredBankRad, rad (80 deg) — SteerToGoal itself does not clamp bank commands; goal producers must respect this. */
  MAX_MANOEUVRE_BANK_RAD: 1.396263,
} as const;

// -----------------------------------------------------------------------------
// 6. Terrain avoidance (safety override layer, checked after the tactical
//    layer's FlightGoal is built, before SteerToGoal runs — see 06-ai.md 4.4).
// -----------------------------------------------------------------------------

export const TerrainAvoidanceParams = {
  /** Seconds of ground track projected ahead at current velocity for terrain sampling. */
  LOOKAHEAD_SEC: 6,
  /** MINIMUM number of evenly-spaced HeightSampler.heightAt samples taken along the projected track (including t=0); the ACTUAL count used each call is `clamp(ceil(|self.vel horizontal| * LOOKAHEAD_SEC / SAMPLE_SPACING_MAX_M) + 1, SAMPLE_COUNT, SAMPLE_COUNT_MAX)` — see SAMPLE_SPACING_MAX_M below and 06-ai.md section 4.4 for why a fixed count aliases past narrow ridgelines at typical BFM speeds. */
  SAMPLE_COUNT: 5,
  /** Upper bound on the distance-adaptive sample count (see SAMPLE_COUNT), capping worst-case `heightAt` calls per aircraft per tick. */
  SAMPLE_COUNT_MAX: 40,
  /** Maximum world-space spacing, m, between consecutive samples along the projected ground track. At speeds/lookaheads where `LOOKAHEAD_SEC * |vel|` would otherwise space `SAMPLE_COUNT` points farther apart than this, more samples are added (up to `SAMPLE_COUNT_MAX`) instead of leaving gaps a narrow ridge could hide inside. */
  SAMPLE_SPACING_MAX_M: 100,
  /** Minimum acceptable clearance, m, between projected altitude and sampled terrain height at each sample point before a pull-up override engages. */
  MIN_CLEARANCE_M: 150,
  /** Clearance, m, below which the override commands maximum available pitch-up (pitchMode g_load, desiredGLoad = difficulty.maxCommandedGLoad) regardless of any other goal, including Land — an emergency GPWS-style reaction. */
  HARD_MIN_CLEARANCE_M: 60,
} as const;

/**
 * Checks the aircraft's projected ground track against `ctx.sampler` and
 * returns a replacement FlightGoal (wings-level or reduced-bank climb) if a
 * terrain conflict is found inside TerrainAvoidanceParams.LOOKAHEAD_SEC,
 * else returns undefined (no override; caller keeps its own goal). Pure
 * given (ctx, currentGoal); no allocation (writes into a pooled FlightGoal
 * the implementation owns, NOT into `currentGoal`, and returns that pooled
 * object). See 06-ai.md 4.4.
 */
export type ComputeTerrainAvoidanceGoal = (
  ctx: PilotContext,
  currentGoal: Readonly<FlightGoal>,
  dtSec: number
) => FlightGoal | undefined;

// -----------------------------------------------------------------------------
// 7. Energy state (specific energy height, used by BFM selection and
//    Extension/Disengage triggers — see 06-ai.md 4.6).
// -----------------------------------------------------------------------------

/** Specific energy expressed as an equivalent altitude, m: altitudeM + trueAirspeedMps^2 / (2*GRAVITY_MPS2). Pure. */
export type ComputeEnergyHeightM = (altitudeM: number, trueAirspeedMps: number) => number;

// -----------------------------------------------------------------------------
// 8. Threat evaluation / target selection (see 06-ai.md 4.5).
// -----------------------------------------------------------------------------

export const ThreatWeights = {
  /** Score points contributed at rangeM = 0, decaying linearly to 0 at rangeM = difficulty.saRadiusM. */
  W_RANGE: 3,
  /** Score points contributed at closureMps >= CLOSURE_NORM_MPS (clamped below -CLOSURE_NORM_MPS). */
  W_CLOSURE: 2,
  /** Score points contributed at aspectAngleRad = 0 (contact pointed directly at self), 0 at aspectAngleRad = +/-PI. */
  W_ASPECT: 4,
  /** Score points contributed when contact is >= ALT_NORM_M above self (clamped below -ALT_NORM_M, i.e. can subtract when self is higher). */
  W_ALT: 1,
  CLOSURE_NORM_MPS: 200,
  ALT_NORM_M: 3000,
  /** Contacts with |vel| below this are treated as heading 0 (north) by HeadingFromVelocity for aspect purposes. */
  MIN_SPEED_FOR_HEADING_MPS: 5,
  /** A candidate target must beat the currently-locked-on target's score by this many points before AiPilot switches targets, to prevent target flicker. */
  TARGET_SWITCH_HYSTERESIS: 1.5,
} as const;

/**
 * Score for how much attention/priority `contact` deserves as a potential
 * target, higher = more urgent. Only meaningful for identified, hostile
 * (contact.team !== self.team && contact.identified) contacts — callers must
 * filter first; this function does not re-check identification (see
 * 06-ai.md 4.5's ROE note on core.ts's Contact.identified comment). Pure, no
 * allocation.
 */
export type ScoreThreatContact = (self: PilotContext, contact: Readonly<Contact>) => number;

// -----------------------------------------------------------------------------
// 9. Weapon employment (decision only — src/ai never fires a weapon itself;
//    it only sets PilotInputs.trigger/launch/cycleWeapon/cycleTarget, which
//    src/combat, the same as for the human player, interprets). See
//    06-ai.md 4.9. Every range/angle figure below is the AI's OWN estimate
//    of its weapons' envelopes, not a read of contracts/combat.ts (which
//    src/ai never imports) — see the file header and 06-ai.md section 9.
// -----------------------------------------------------------------------------

export const AiWeaponEnvelope = {
  GUN_MIN_RANGE_M: 150,
  GUN_MAX_RANGE_M: 900,
  /** Max angle, deg, between self's nose (telemetry.headingRad/pitchRad-implied boresight) and the lead-pursuit aim point before the AI considers the gun solution good enough to hold trigger. */
  GUN_MAX_ANGLE_OFF_DEG: 6,
  /** Assumed muzzle velocity, m/s, used ONLY for the AI's own lead-pursuit aim estimate (23mm GSh-23-class analogue) — see 06-ai.md section 9; the real value lives in src/combat/src/aircraft and may differ. */
  GUN_ASSUMED_MUZZLE_VEL_MPS: 715,
  IR_MIN_RANGE_M: 500,
  IR_MAX_RANGE_M: 5500,
  /** Half-angle, deg, of the seeker field of view the AI assumes it must keep the target within before committing an IR shot. */
  IR_MAX_OFF_BORESIGHT_DEG: 30,
  RADAR_MIN_RANGE_M: 2000,
  /** Conservative "good Pk" commit range, m — deliberately well inside the missile's true maximum reach (a no-escape-zone-style estimate, not the missile's absolute range); see 06-ai.md section 9. */
  RADAR_MAX_RANGE_M: 18000,
  /** ctx.combat.lockState value required before a radar missile launch is considered. */
  RADAR_REQUIRED_LOCK: 'locked' as LockState,
  /** When ctx.combat reports the loaded missile's head-on maximum range (its catalogue envelope),
   *  the AI commits at this fraction of it instead of the fixed IR/RADAR_MAX_RANGE_M above: well
   *  inside Rmax so the shot keeps energy against a turning target. */
  IR_COMMIT_FRAC_OF_RMAX: 0.3,
  RADAR_COMMIT_FRAC_OF_RMAX: 0.45,
  /** Minimum seconds between two launches (of any weapon) at the same targetId, regardless of ammo/envelope, so the AI does not empty a magazine into one target in one salvo. */
  LAUNCH_COOLDOWN_SEC: 3.0,
} as const;

export interface WeaponEnvelopeEstimate {
  weapon: WeaponKind;
  inEnvelope: boolean;
  /** [0,1] subjective solution quality (1 = boresight/point-blank-perfect) used only to gate the AI's own launch decision — NOT a true hit-probability (that is src/combat's hitDetection/subsystemDamage, computed independently). */
  quality: number;
}

/** Pure, no allocation (returns a value type; implementations may return a pooled/reused object if desired but must not mutate shared state). See 06-ai.md 4.9. */
export type EstimateWeaponEnvelope = (
  ctx: PilotContext,
  weapon: WeaponKind,
  target: Readonly<Contact>
) => WeaponEnvelopeEstimate;

// -----------------------------------------------------------------------------
// 10. BFM/tactical trigger thresholds. Angle values are degrees (suffix
//     _DEG) unless suffixed _RAD (pre-converted for direct use as bank/offset
//     commands); distances _M; times _SEC. See 06-ai.md 4.7-4.8 for how each
//     is used.
//
//     Difficulty scaling applies ONLY to the SELECTION/GATING thresholds
//     listed here, via `difficulty.bfmSkillMultiplier` (contracts/ai.ts
//     section 1) — NOT to every field in this object. The exact, exhaustive
//     list of fields multiplied by `bfmSkillMultiplier` before use:
//       HIGH_YOYO_MIN_ANGLE_OFF_DEG, HIGH_YOYO_MAX_RANGE_M,
//       LOW_YOYO_MAX_ANGLE_OFF_DEG, LOW_YOYO_MIN_ENERGY_DEFICIT_M,
//       LOW_YOYO_MAX_RANGE_M, LAG_PURSUIT_MAX_RANGE_M,
//       LEAD_PURSUIT_MIN_ANGLE_OFF_DEG, BREAK_TURN_TRIGGER_RANGE_M,
//       BREAK_TURN_TRIGGER_ANGLE_OFF_DEG, EXTENSION_MIN_ENERGY_ADVANTAGE_M,
//       JINK_TRIGGER_RANGE_M.
//     Every OTHER field below — every goal-construction PARAMETER
//     (BASE_PURSUIT_G_LOAD, PURSUIT_ELEVATION_G_GAIN, HIGH_YOYO_BANK_SCALE,
//     LAG_PURSUIT_OFFSET_RAD, LEAD_PURSUIT_OFFSET_RAD, BREAK_TURN_THROTTLE,
//     NOTCH_BEAM_OFFSET_RAD, NOTCH_G_LOAD, JINK_PERIOD_SEC, JINK_MAX_BANK_RAD,
//     DISENGAGE_FUEL_FRAC, DISENGAGE_SAFE_RANGE_M, LAND_ABORT_THREAT_RANGE_M,
//     MIN_STATE_DWELL_SEC, BFM_MANOEUVRE_MIN_DWELL_SEC, MERGE_RANGE_M,
//     VISUAL_MANOEUVRE_RANGE_M, ENGAGE_BVR_MIN_RANGE_M) is used RAW, never
//     scaled — difficulty's effect on manoeuvre SEVERITY flows only through
//     `desiredGLoad`'s own clamp to `[minCommandedGLoad, maxCommandedGLoad]`
//     (section 1), never through these thresholds. This is a correction of
//     an earlier, over-broad drafting-pass comment that said "every
//     threshold ... is multiplied" — 06-ai.md section 4.8's own worked
//     examples and section 7's exact-value tests (e.g. PurePursuit's
//     `desiredGLoad` within `1e-6` of the raw `BASE_PURSUIT_G_LOAD=3.0`, no
//     multiplier) were always the correct, narrower behaviour; only this
//     comment was wrong.
// -----------------------------------------------------------------------------

export const BfmThresholds = {
  /** Minimum seconds in a TacticalState before a NON-safety transition out of it is allowed (prevents FSM chatter). Missile-warning->Defensive, fuel/ammo->Disengage and the Land-abort transition ignore this and act immediately. NOT difficulty-scaled. */
  MIN_STATE_DWELL_SEC: 1.5,
  /** Minimum seconds `selectBfmManoeuvre` holds its previous result before a non-`Notch` manoeuvre change is allowed (06-ai.md section 4.8's hysteresis rule, preventing tick-to-tick BFM selection oscillation near a threshold boundary). A missile-warning-triggered `Notch` is exempt and fires immediately, mirroring `MIN_STATE_DWELL_SEC`'s own exemption pattern. NOT difficulty-scaled. */
  BFM_MANOEUVRE_MIN_DWELL_SEC: 1.0,
  ENGAGE_BVR_MIN_RANGE_M: 5000,
  MERGE_RANGE_M: 3000,
  /** Below this range, Bfm/Defensive apply instead of Merge. */
  VISUAL_MANOEUVRE_RANGE_M: 1800,
  /** Difficulty-scaled. */
  HIGH_YOYO_MIN_ANGLE_OFF_DEG: 90,
  /** Difficulty-scaled. */
  HIGH_YOYO_MAX_RANGE_M: 600,
  /** desiredBankRad is multiplied by this factor during HighYoYo (partial unload/reduced bank to climb while turning less). NOT difficulty-scaled. */
  HIGH_YOYO_BANK_SCALE: 0.5,
  /** Difficulty-scaled. */
  LOW_YOYO_MAX_ANGLE_OFF_DEG: 30,
  /** Difficulty-scaled. */
  LOW_YOYO_MIN_ENERGY_DEFICIT_M: 150,
  /** Difficulty-scaled. */
  LOW_YOYO_MAX_RANGE_M: 1000,
  /** Difficulty-scaled. */
  LAG_PURSUIT_MAX_RANGE_M: 250,
  /** NOT difficulty-scaled. */
  LAG_PURSUIT_OFFSET_RAD: 0.349066,
  /** Difficulty-scaled. */
  LEAD_PURSUIT_MIN_ANGLE_OFF_DEG: 15,
  /** NOT difficulty-scaled. */
  LEAD_PURSUIT_OFFSET_RAD: 0.261799,
  /** Baseline desiredGLoad, g, for Pure/Lead/Lag pursuit before the elevation bias below is added. NOT difficulty-scaled (see section header). */
  BASE_PURSUIT_G_LOAD: 3.0,
  /** Extra desiredGLoad, g per radian of contact.elevationRad, added to BASE_PURSUIT_G_LOAD so the AI pulls harder when the target is above the horizon (azimuth-only banking cannot by itself close an elevation gap) and eases off when it is below. Result is clamped to [1, difficulty.maxCommandedGLoad]. NOT difficulty-scaled itself. */
  PURSUIT_ELEVATION_G_GAIN: 2.0,
  /** Difficulty-scaled. */
  BREAK_TURN_TRIGGER_RANGE_M: 900,
  /** Difficulty-scaled. */
  BREAK_TURN_TRIGGER_ANGLE_OFF_DEG: 30,
  /** Throttle commanded (via FlightGoal.throttleOverride) during BreakTurn — reduced from full power to tighten turn radius. NOT difficulty-scaled. */
  BREAK_TURN_THROTTLE: 0.7,
  /** NOT difficulty-scaled. */
  NOTCH_BEAM_OFFSET_RAD: 1.570796,
  /** NOT difficulty-scaled. */
  NOTCH_G_LOAD: 2.5,
  /** Self must lead the (self energy height - attacker energy height) by at least this many metres before Extension is chosen over BreakTurn. Difficulty-scaled. */
  EXTENSION_MIN_ENERGY_ADVANTAGE_M: 300,
  /** Difficulty-scaled. */
  JINK_TRIGGER_RANGE_M: 1200,
  /** Seconds a randomly-rolled Jink bank/g command is held before re-rolling. NOT difficulty-scaled. */
  JINK_PERIOD_SEC: 0.6,
  /** NOT difficulty-scaled. */
  JINK_MAX_BANK_RAD: 1.047198,
  /** NOT difficulty-scaled. */
  DISENGAGE_FUEL_FRAC: 0.25,
  /** Range, m, to the nearest hostile beyond which Disengage transitions to Rtb. NOT difficulty-scaled. */
  DISENGAGE_SAFE_RANGE_M: 9000,
  /** Range, m, inside which a new hostile contact aborts Land back to Defensive. NOT difficulty-scaled. */
  LAND_ABORT_THREAT_RANGE_M: 4000,
  /**
   * Bank command, rad, `buildBfmGoal`'s `Disengage` uses (see 06-ai.md
   * section 4.12a): `Math.sign(target.bearingRad || 1) * DISENGAGE_BANK_RAD`,
   * structurally identical to `BreakTurn`'s own bank formula but at a
   * shallower angle (disengaging is about opening range in a controllable
   * direction, not out-turning the threat). NOT difficulty-scaled.
   */
  DISENGAGE_BANK_RAD: 0.349066,
} as const;

/**
 * One tick's FSM evaluation. Pure function of its arguments (all randomness
 * the implementation needs — e.g. missile-warning notice roll — is drawn
 * from this AiPilot's own private PRNG stream, held as instance state
 * outside this function's signature). Returns `current` unchanged when no
 * transition fires. See 06-ai.md 4.7 for the full priority-ordered rule
 * list this must implement exactly.
 */
export type EvaluateTacticalTransition = (
  ctx: PilotContext,
  current: TacticalState,
  timeInStateSec: number,
  difficulty: Readonly<AiDifficultyProfile>,
  formationLeaderAlive: boolean,
  missileWarningNoticed: boolean
) => TacticalState;

/**
 * Chooses an offensive BfmManoeuvre while in TacticalState.Bfm, or a
 * defensive one while in TacticalState.Defensive (caller passes the
 * appropriate candidate set implicitly via which state it calls this from —
 * see 06-ai.md 4.8's two disjoint five/four-manoeuvre lists). Pure given its
 * arguments plus the AI's own PRNG stream (Jink only).
 */
export type SelectBfmManoeuvre = (
  ctx: PilotContext,
  target: Readonly<Contact>,
  state: TacticalState,
  difficulty: Readonly<AiDifficultyProfile>,
  previous: BfmManoeuvre | undefined,
  timeInManoeuvreSec: number
) => BfmManoeuvre;

/** Builds the FlightGoal for one BFM manoeuvre against one target. Pure given its arguments plus PRNG (Jink). See 06-ai.md 4.8 for the per-manoeuvre formula. */
export type BuildBfmGoal = (
  ctx: PilotContext,
  target: Readonly<Contact>,
  manoeuvre: BfmManoeuvre,
  difficulty: Readonly<AiDifficultyProfile>,
  out: FlightGoal
) => FlightGoal;

// -----------------------------------------------------------------------------
// 11. Top-level Pilot factory — the one thing src/core actually calls into
//     src/ai for.
// -----------------------------------------------------------------------------

export interface AiPilotSpawnParams {
  /** References contracts/aircraft.ts's AircraftDefinition.id, passed through opaquely — the AI never reads AircraftDefinition fields directly (see file header). */
  aircraftDefId: string;
  team: Team;
  difficulty: AiDifficulty;
  /** Root seed for this pilot's own private PRNG sub-stream (aim jitter, reaction jitter, patrol waypoint choice, Jink rolls). Derived by src/core from WorldConfig.seed; mulberry32-based; never Math.random. */
  seed: number;
  homeAirportId?: string;
  homeRunwayId?: string;
  /** Anchor point and radius used while in TacticalState.Patrol. Required unless `formation` is set with role 'wingman' (a wingman patrols by following its leader instead). */
  patrolCenterWorld?: Vec3Like;
  patrolRadiusM?: number;
  formation?: AiFormationSlot;
}

/** Read-only introspection of one AiPilot's current decision state — for src/core (debrief/replay log), src/hud (optional AI debug overlay) and tests. Not consulted by the AI itself as an input (it is the AI's OWN output record, not sensor data). Fields alias the AiPilot's live internal state; a caller that needs a stable snapshot must copy them out before the next `update()` call. */
export interface AiPilotDebugState {
  tacticalState: TacticalState;
  timeInStateSec: number;
  activeManoeuvre: BfmManoeuvre | undefined;
  targetId: EntityId | undefined;
  targetThreatScore: number;
  desiredGLoad: number;
  desiredBankRad: number;
  desiredAltitudeM: number;
  desiredSpeedMps: number;
  lastLaunchSimTimeSec: number;
}

export interface AiPilot extends Pilot {
  readonly debug: Readonly<AiPilotDebugState>;
}

/** Constructs one AI-controlled Pilot. Never allocates on subsequent `update()` calls — all per-tick scratch state is allocated once here, at construction. */
export type CreateAiPilot = (params: Readonly<AiPilotSpawnParams>) => AiPilot;
