/**
 * src/physics/fcs.ts — fly-by-wire control laws: pitch g/alpha-command law (airborne, a cascaded
 * outer g/alpha-error-loop -> inner pitch-rate-loop, see FCS_PITCH_OUTER_LOOP_GAIN's doc comment)
 * with trim integral, pitch rate-command law (on ground), roll rate-command law, yaw direct law +
 * damper, actuator rate-limiting and damage-authority scaling. See docs/spec/02-flight-model.md
 * section 4.9.
 *
 * Owns several module-private `Float64Array(MAX_ENTITIES)` tables (`trimIntegralRad`,
 * `lastGLoadRad`, `shapedPitchStick`, `shapedRollStick`, `shapedPitchRateCmd`), indexed by the
 * pool-slot index extracted from `EntityState.id` (see `entityPoolIndex` below) — see
 * 02-flight-model.md section 9 for why this state is module-private rather than part of
 * `EntityState`/`DamageState`.
 */
import type { EntityId, PilotInputs, DamageState, QuatLike, Vec3Like } from '../contracts/core';
import { MAX_ENTITIES, ENTITY_INDEX_RADIX } from '../contracts/core';
import type { FcsLimits } from '../contracts/aircraft';
import { GROUND_LAW_MAX_ROTATION_RATE_RAD_S } from '../contracts/flight';
import { Quat, clamp, lerp, rateLimitStep, bodyRateP, bodyRateQ, bodyRateR } from '../math';

/**
 * Ki — pitch trim-integral gain, rad/(g*s). Raised from 0.02: at that rate a low-speed g error
 * (e.g. 1.15g hands-off at 110 m/s after a disturbance) took ~10-15s to trim out, which the pilot
 * sees as the nose slowly rising on its own. 0.1 settles the same case in ~5s with no pull-up
 * oscillation (checked across 65-160 m/s, 20-100% stick, 500/3000 m).
 */
const FCS_TRIM_INTEGRAL_GAIN = 0.1;
/** Anti-windup clamp on trimIntegralRad, rad (~12deg). */
const FCS_TRIM_INTEGRAL_MAX_RAD = 0.2094;
/**
 * Trim-integral anti-windup (stepFcs): the error the integral accumulates is clamped to this band,
 * g, bounding how fast it can move (0.1*0.5 = 0.05 rad/s of elevon), and it is frozen outright
 * while the g path is pinned at its pitch-rate cap. It still has to close LARGE steady errors (a
 * steep sustained turn's leftover offset under the proportional loops can exceed 1g), so it cannot
 * simply ignore big errors -- that failed every sustained turn past ~60deg of bank.
 */
const FCS_TRIM_INTEGRATE_MAX_ERROR_G = 0.5;

/**
 * Max onset rate of the FCS-shaped pitch/roll stick, in stick-fraction (-1..1) units per second —
 * quadruplex-FBW-style command shaping on the PILOT's raw demand itself (distinct from
 * gLoadGain/pitchRateGain/rollRateGain above, which damp the AIRCRAFT's measured rate/response,
 * not the pilot's input). Previously a raw, instantaneous stick value fed straight into
 * computeGCommand/pCmd with no shaping at all — only playerPilot.ts's keyboard-specific
 * KEYBOARD_AXIS_RAMP_RATE_PER_SEC=2.5 (0->full in 0.4s) gave keyboard players any onset lag, and
 * gamepad/mouse/touch got none whatsoever. Live-testing (holding a full pitch key) showed this
 * produced a classic underdamped step-response ring even on keyboard: a full pull crossed the
 * commanded +8.0g ceiling at 393ms then overshot to a peak of +9.49g (+18.6%) by 597ms; a full
 * push overshot the -3.0g ceiling to -4.74g (+58%) — the felt "very sensitive" controls.
 *
 * Split into a separate pitch/roll rate after a SECOND round of live-testing (holding the
 * pitch-up key continuously) showed the original shared value of 2.0 (0.5s to full deflection)
 * was still nowhere near slow enough on the pitch axis specifically: even with that shaping,
 * angle of attack rocketed from 0.8deg to 32.2deg in just 1.25s of a sustained pull, blowing
 * straight through the ~24-26deg alpha limiter (FcsLimits.maxAlphaRad) into a genuine stall --
 * the alpha limiter only reacts AFTER alpha crosses the line, so it cannot itself prevent an
 * overshoot fast enough when the commanded g is still ramping up quickly underneath it. Slowing
 * PITCH specifically to 1s onset (roll is left at the original rate: it wasn't implicated by
 * this report and a full-authority roll doesn't carry the same stall risk pitch does) gives the
 * alpha limiter roughly twice as long to catch and arrest the buildup before it can run away.
 * Still does not touch steady-state trim -- see tools/sim-check.ts re-validation after this was
 * added, both when this constant was introduced and when it was split/slowed further.
 */
const FCS_PITCH_STICK_SHAPE_RATE_PER_SEC = 1.0;
const FCS_ROLL_STICK_SHAPE_RATE_PER_SEC = 2.0;

/**
 * GROUND LAW ONLY now (the airborne limiter is the rate-path design documented at
 * FCS_ALPHA_LOOP_GAIN_PER_S). Kept for the ground law's rotation taper; history follows.
 *
 * Look-ahead time, s, used to anticipate alpha for the alpha limiter (stepFcs, below): rather
 * than comparing raw `alpha` against fcsLimits.maxAlphaRad/minAlphaRad, the limiter compares
 * `alpha + q*ALPHA_LIMIT_ANTICIPATION_SEC` (q = body-frame pitch rate, positive = nose up, the
 * standard "q-feedback" proxy for alpha rate real FBW alpha protection uses, since alpha-dot
 * itself isn't directly available here).
 *
 * Added after slowing the stick onset (FCS_PITCH_STICK_SHAPE_RATE_PER_SEC, above) turned out NOT
 * to be sufficient by itself: live-testing a sustained full pull still let alpha overshoot the
 * ~24-26deg limit by roughly 20deg (peaking at 45.6deg / 6.8g) before reversing into a violent
 * oscillation (down to -1.2g within a fraction of a second) — the limiter is REACTIVE on raw
 * alpha alone, so by the time alpha actually crosses the line it can already be rising too fast
 * for a same-instant gCmd reduction to arrest it in time. Comparing against the RATE-PREDICTED
 * alpha instead triggers the exact same limiter formula earlier, while alpha is still climbing,
 * giving the closed loop time to actually respond before the aircraft leaves the aero model's
 * validated envelope. 0.3s is a modest anticipation window — enough to meaningfully pull the
 * trigger point earlier without being so aggressive it clips ordinary maneuvering; re-tune here
 * (not the stick-shape rate above) if alpha protection still isn't catching a sustained pull in
 * time, since this constant is what actually targets that failure mode.
 */
const ALPHA_LIMIT_ANTICIPATION_SEC = 0.3;

/**
 * GROUND LAW ONLY now, like ALPHA_LIMIT_ANTICIPATION_SEC above; the airborne g-command blend this
 * describes was replaced by the rate-path limiter (FCS_ALPHA_LOOP_GAIN_PER_S), which removed the
 * relay behaviour this band only softened. History follows.
 *
 * Width, rad (~2deg), of the blend band the alpha limiter (stepFcs, below) ramps the raw
 * g-command DOWN to its "1.0 - alphaLimitGain*overshoot" target over, instead of assigning that
 * target outright the instant anticipated alpha first crosses the limit.
 *
 * Added after live-testing a genuinely SUSTAINED high-AoA hold (not just a quick pull): a large,
 * ~8-10s-period oscillation that never damped out (gLoad cycling roughly 3g-9g, alpha 8-27deg).
 * Root cause was the un-blended assignment itself: right at the crossing (overshoot=0) its target
 * evaluates to ~1.0, so a hard pull commanding gCmd=8 would SNAP straight down to ~1.0 the instant
 * alphaAnticipated first touched the limit, then snap back to 8 the instant it receded below it a
 * moment later -- a relay/bang-bang oscillator, not a limiter. Blending over a small band keeps
 * the command continuous with the raw pilot demand at overshoot=0 (no snap) while still reaching
 * the exact same, already-tuned target once overshoot exceeds this width, so no protection is
 * lost far from the boundary -- confirmed necessary by a regression this band fixes:
 * tests/integration/spawnFlyLand.test.ts's 25s scripted climb only grazes the limit slightly, and
 * a plain (unblended) linear reduction proportional to overshoot was too weak that close to the
 * boundary to hold it, letting alpha drift enough to crash on landing much later in the flight.
 */
const ALPHA_LIMIT_BLEND_RAD = 0.035;

/**
 * Airborne alpha limiter as a pitch-RATE path (stepFcs's air branch): the limiter asks for
 * `qCmdAlpha = pathRate + FCS_ALPHA_LOOP_GAIN_PER_S * (maxAlphaRad - alpha)`, and the outer loop
 * flies whichever of that and the pilot's g path asks for LESS pitch rate (mirrored for
 * minAlphaRad). `pathRate` (the flight path's own pitch-plane turn rate, `(gLoad - upY)*g/V`) is
 * the feedforward that makes alpha itself obey `alphaDot = q - pathRate -> K*(max - alpha)`: a
 * smooth first-order approach to the limit with time constant 1/K, with the aircraft settling AT
 * the limit in a sustained pull rather than below it.
 *
 * Replaces an earlier limiter that cut the g-COMMAND from the pilot's demand (up to 8g) to ~1g
 * across a 2deg band of rate-anticipated alpha (`alpha + 0.3*q`). That was effectively a
 * ~200 g/rad switch whose input swung +-10deg with q alone; behind the elevon rate limit it formed
 * a limit cycle -- live report "bobbing under 200 kt pulling hard", reproduced in the real World
 * (free-flight weather on) as alpha cycling 17.5-21deg every ~0.45s with the elevons slamming
 * -12..+23deg at their rate limit. It only showed with gusts/turbulence on: undisturbed, the loop
 * sat on a marginal equilibrium, which is why stepAircraft-only probes never saw it.
 */
const FCS_ALPHA_LOOP_GAIN_PER_S = 2.5;
/**
 * Lead (alpha-rate damping) on the alpha path, s: the limiter acts on `alpha + T*alphaDot`, so a
 * fast pull at higher speed starts easing off before alpha reaches the limit rather than after.
 * Without it a hard pull at ~130 m/s overshot the 22deg limit to ~31deg: the unstable airframe and
 * rate-limited elevons cannot reverse a 40deg/s pitch rate instantly.
 */
const FCS_ALPHA_LOOP_LEAD_SEC = 0.5;
/** Floor on true airspeed, m/s, for the pathRate feedforward's 1/V (never reached in real flight). */
const FCS_PATH_RATE_MIN_TAS_MPS = 20;
/**
 * Converts an alpha error into the trim integral's g-error units while the alpha limiter is
 * flying (stepFcs), g per rad -- roughly this airframe's low-speed CL_alpha*qBar*S/W, so the
 * integral trims alpha onto the limit at a similar rate to how it trims g elsewhere.
 */
const FCS_ALPHA_TRIM_G_PER_RAD = 10;

/**
 * Pitch-axis qBar gain scheduling (cross-module fix; see
 * tests/integration/trimAndPerformance.test.ts / tools/lib/trimSolver.ts's
 * own extensive notes on why a FIXED-gain pitch law cannot hold across this
 * project's speed envelope).
 *
 * `FcsLimits.pitchRateGain` sets a rad-of-elevon-per-(rad/s of rate error)
 * response (airborne AND ground laws both now use it as their sole inner-loop gain — see
 * FCS_PITCH_OUTER_LOOP_GAIN's doc comment for the airborne law's own outer/inner restructuring),
 * but the MOMENT that elevon deflection actually produces is `Cm_elevon * elevonSym * qBar *
 * wingAreaM2 * meanChordM` (aeroForces.ts 4.5) — proportional to qBar. A gain tuned to be stable
 * at one dynamic pressure therefore commands a torque that grows linearly with qBar at any other
 * speed: verified empirically (see the cross-module review this fix is part of) that the
 * un-scheduled loop is cleanly stable at qBar corresponding to ~100 m/s sea-level TAS (the tuning
 * point implicit in tejasGeometry.ts's own gain magnitudes) but drives alpha to tens of degrees
 * within ~1 simulated second at 150+ m/s — the commanded elevon deflection is unchanged but the
 * qBar-scaled torque it produces is 2-10x larger, turning a well-damped response into a violently
 * oscillating one.
 *
 * Scaling the rate (pitchRateGain) term by `(FCS_QBAR_REF_PA / qBar) ^
 * FCS_GAIN_SCHEDULE_EXPONENT` (clamped) keeps the commanded elevon response bounded across the
 * flight envelope, at (by construction) the same magnitude tejasGeometry.ts's gain was tuned to
 * produce at the reference qBar — i.e. this reproduces the known-stable low-speed response at
 * every speed, rather than introducing a new, untuned control law. It does not touch the physical
 * alpha->CL->gLoad relationship (still qBar-dependent as it must be — a faster aircraft genuinely
 * trims at a smaller alpha for the same g), only how hard the actuator is commanded to respond to
 * a given error.
 *
 * The exponent is empirically 1.5, not the naive 1.0 a pure
 * torque-per-error normalization would suggest: `elevonSymCmd` is also
 * subject to `maxElevonRateRadS` (the actuator's own rate limit, unaffected
 * by this schedule). At high qBar a merely-1/qBar-scaled command can still
 * be large enough, for long enough, that the RATE-LIMITED surface spends
 * many consecutive substeps ramping toward it — effectively a fixed-rate
 * ramp regardless of the softened gain — during which the qBar-scaled
 * moment this module's own doc comment above describes still integrates
 * into a large, overshooting alpha excursion before the surface (and hence
 * the command) can catch up and reverse. The steeper exponent verified
 * empirically (direct simulation, sea-level 100-472 m/s, this cross-module
 * pass) keeps the commanded elevon small enough, early enough, that the
 * rate limit is no longer the binding constraint at the top of the
 * envelope, closing that gap; 1.0 alone left ~300 m/s+ still diverging.
 *
 * `FCS_QBAR_REF_PA` = 0.5 * RHO0_KG_M3 * 100^2 (sea-level, 100 m/s — squarely
 * inside the low/mid-speed regime already confirmed stable). The schedule is
 * clamped to [FCS_GAIN_SCHEDULE_MIN, FCS_GAIN_SCHEDULE_MAX] so it neither
 * blows up as qBar -> 0 (low speed/near-stall) nor silently zeroes control
 * authority at the top of the envelope — some genuine reduction in
 * closed-loop bandwidth at the extreme high-q corner is an acceptable,
 * physically-reasonable trade-off for staying bounded, exactly what a real
 * qBar-scheduled FCS does.
 */
const FCS_QBAR_REF_PA = 6125; // 0.5 * 1.225 * 100^2
const FCS_GAIN_SCHEDULE_EXPONENT = 1.5;
const FCS_GAIN_SCHEDULE_MIN = 0.02;
const FCS_GAIN_SCHEDULE_MAX = 4;
const FCS_QBAR_FLOOR_PA = 1;

/**
 * `qBarPa` defaults to `FCS_QBAR_REF_PA` (schedule multiplier of exactly 1,
 * i.e. no scaling) so every existing caller that does not pass it — every
 * fixture in tests/physics/fcs.test.ts, all of which use synthetic
 * plants/gains rather than the real Tejas aero data — keeps its exact
 * current behaviour. `src/physics/integrator.ts` passes the substep's real
 * `qBar` (aeroForces.ts's `AirspeedFrame.qBar`) for actual flight.
 */
function pitchGainSchedule(qBarPa: number): number {
  return clamp(
    Math.pow(FCS_QBAR_REF_PA / Math.max(qBarPa, FCS_QBAR_FLOOR_PA), FCS_GAIN_SCHEDULE_EXPONENT),
    FCS_GAIN_SCHEDULE_MIN,
    FCS_GAIN_SCHEDULE_MAX
  );
}

/**
 * A SEPARATE, gentler qBar schedule for the airborne inner rate loop only (FCS_PITCH_INNER_
 * LOOP_GAIN's own doc comment has the full rationale/derivation) — `FCS_PITCH_INNER_QBAR_
 * EXPONENT` (1.0) vs. `pitchGainSchedule`'s 1.5, same reference/floor/clamp bounds otherwise.
 */
function pitchInnerLoopSchedule(qBarPa: number): number {
  return clamp(
    Math.pow(FCS_QBAR_REF_PA / Math.max(qBarPa, FCS_QBAR_FLOOR_PA), FCS_PITCH_INNER_QBAR_EXPONENT),
    FCS_GAIN_SCHEDULE_MIN,
    FCS_GAIN_SCHEDULE_MAX
  );
}

/**
 * Airborne pitch law restructuring: outer g-command loop -> target pitch rate -> inner
 * rate-command loop (`FcsLimits.pitchRateGain`), replacing an earlier single-loop formula that
 * drove elevonSymCmd directly off `(gCmd-gLoad)` via `FcsLimits.gLoadGain`. Root-caused
 * (control-theory + real-FBW-architecture analysis, this pass) to actuator POSITION/RATE
 * SATURATION, not underdamped gains: live-testing a sustained hard pull showed gLoad cycling
 * ~3g-9g and elevon swinging near its full +-25deg travel in a non-decaying ~0.6-0.8s-period
 * pattern, while the linearized loop's own damping ratio (zeta 0.58-0.92 across 100-160 m/s,
 * computed from the real Cm_elevon/Cm_q/inertia data) is healthy -- gains were never the problem.
 * The actual commanded elevon POSITION for a realistic g-error (`gLoadGain*(gCmd-gLoad)`) was ~2x
 * maxElevonRad, so the surface railed at its travel/rate limit and rang at very nearly the linear
 * plant's own natural frequency (predicted damped period 0.64-0.74s almost exactly matches the
 * observed 0.6-0.8s) instead of settling -- every prior attempt that only retuned
 * gLoadGain/pitchRateGain/the gain-schedule ceiling failed or made it worse for exactly this
 * reason (this module's other doc comments' "prior attempts" notes cover those individually).
 *
 * The fix mirrors the pattern this file's own roll law (`pCmd = rollStickShaped*maxRollRateRadS;
 * elevonDiffCmd = rollRateGain*(pCmd-p)`) and the ground pitch law (below,
 * `GROUND_LAW_MAX_ROTATION_RATE_RAD_S`) already use: an outer loop picks a TARGET RATE for a fast,
 * self-limiting inner rate loop to track, instead of feeding a position-scale error straight into
 * the actuator. Once q reaches the target, `(qCmd-q)` goes to zero and the command settles --
 * structurally incapable of demanding more than the actuator can track IF the target itself stays
 * within what `pitchRateGain` can hold at `maxElevonRad` in steady state, which
 * `FCS_PITCH_RATE_CMD_SATURATION_MARGIN`/`FCS_MAX_PITCH_RATE_CMD_RAD_S` below exist to guarantee.
 *
 * `FCS_PITCH_OUTER_LOOP_GAIN` (rad/s of target q per g of error, "Kgq") sizes a representative
 * full-aft-stick pull (7g: 1g trim to tejasGeometry.ts's maxGLoadPos=8) to land close to (not
 * exceeding) the reference-speed (100 m/s, gainSchedule=1) saturation-safe cap below
 * (`0.75*maxElevonRad/(1*|pitchRateGain|)` = 0.818 rad/s): `0.818/7 ~= 0.12`.
 *
 * `FCS_PITCH_RATE_CMD_SATURATION_MARGIN` (0.75) leaves 25% elevon-travel headroom -- computed each
 * substep as `margin*maxElevonRad/(gainSchedule*|pitchRateGain|)` -- above the pure `qCmd` term
 * (which this formula sizes to land exactly at `maxElevonRad` with q=0), for the `(qCmd-q)`
 * error's own `q` component and any transient overshoot before the inner loop fully converges.
 * Naturally gets STRICTER at low speed (gainSchedule up to 4 near stall: cap ~11.7deg/s, matching
 * the ground law's own 10deg/s -- a reassuring, independently-derived consistency) and looser at
 * high speed (gainSchedule down to 0.02: the formula alone would allow deg/s figures no real
 * aircraft should ever be commanded, which `FCS_MAX_PITCH_RATE_CMD_RAD_S` (60deg/s -- a
 * deliberately much gentler absolute ceiling than roll's own maxRollRateRadS=300deg/s, since pitch
 * should never be that aggressive) exists to additionally bound.
 *
 * `FCS_PITCH_RATE_CMD_ONSET_RAD_S2` rate-limits the shaped target itself (module state
 * `shapedPitchRateCmd` below, reset at ground/air transitions like `shapedPitchStick`/
 * `shapedRollStick`) -- defence in depth on top of the cap: even within the capped range, `gLoad`
 * (an unshaped, measured quantity that can move quickly mid-maneuver) feeds directly into qCmd's
 * raw value every substep, so bounding how fast the TARGET itself can change keeps the inner loop
 * from ever being asked to jump instantly -- the same rationale FCS_PITCH_STICK_SHAPE_RATE_PER_SEC
 * applies to the raw stick further upstream of gCmd.
 */
const FCS_PITCH_OUTER_LOOP_GAIN = 0.12;
const FCS_PITCH_RATE_CMD_SATURATION_MARGIN = 0.75;
const FCS_MAX_PITCH_RATE_CMD_RAD_S = 1.0472; // 60 deg/s
const FCS_PITCH_RATE_CMD_ONSET_RAD_S2 = 5;

/**
 * FCS_PITCH_INNER_QBAR_EXPONENT/FCS_PITCH_INNER_LOOP_GAIN_MULT — sizing the AIRBORNE inner rate
 * loop's own qBar schedule/gain (`pitchInnerLoopSchedule`, `stepFcs`'s airborne branch), found
 * empirically necessary (this pass, direct trim-convergence tracing across the speed/altitude
 * envelope, tools/lib/trimSolver.ts's own `findGCommandTrim`) after the cascaded outer/inner
 * restructuring above initially FAILED tests/integration/trimAndPerformance.test.ts
 * (vmax_sl/vmax_11000/turn_5000_m06 stopped converging) despite passing every unit test.
 *
 * Root cause: reusing `pitchGainSchedule`'s existing 1.5-exponent schedule (tuned for the OLD
 * law, where a much LARGER proportional-on-g-error term dominated and `pitchRateGain` was only a
 * secondary damping correction) left the new inner loop, now the SOLE source of elevon authority,
 * too weak at high dynamic pressure to counter this airframe's own open-loop instability
 * (relaxed static stability, Cm_alpha>0 -- tejasAeroTables.ts) during a transient: direct tracing
 * at 300 m/s sea level from a deliberately-disturbed seed state (gLoad initially ~4.4, per
 * findGCommandTrim's own settle methodology) showed q accelerating in the WRONG direction for
 * over a second, continuing to diverge even well AFTER the outer loop had already reversed
 * qCmdAir's sign to correct it -- the inner loop's commanded correction was simply too small,
 * too late, not a sign or saturation bug.
 *
 * A 1.5-exponent schedule shrinks the elevon commanded for a GIVEN error roughly as 1/qBar^1.5,
 * which (since aero MOMENT is itself proportional to qBar) makes the resulting CORRECTIVE torque
 * for that error shrink as 1/qBar^0.5 -- while the airframe's own DESTABILIZING moment
 * (Cm_alpha*alpha*qBar, unscheduled, a real physical quantity this control law cannot soften) only
 * GROWS with qBar. The 1.5 exponent was chosen for the OLD law specifically to avoid a DIFFERENT
 * failure mode (a merely-1/qBar-scaled command still saturating maxElevonRateRadS for long enough
 * to blow through the alpha limiter, see FCS_GAIN_SCHEDULE_EXPONENT's own doc comment) that does
 * not apply the same way to a bounded, self-limiting rate-command loop; carrying it over
 * unmodified to the inner rate loop traded that saturation risk for a stability-margin one.
 *
 * `FCS_PITCH_INNER_QBAR_EXPONENT=1.0` (not 1.5) keeps the CORRECTIVE TORQUE for a given rate error
 * exactly independent of qBar (rather than shrinking with it), matching general gain-scheduled-FBW
 * practice of rolling off RATE/damping gains more gently than proportional/position gains, since
 * damping/disturbance-rejection needs do not shrink with dynamic pressure the way position-error
 * authority needs do. `FCS_PITCH_INNER_LOOP_GAIN_MULT=2` (found by direct empirical sweep, same
 * tracing methodology, across sea-level and 11000m at 60-600 m/s) gives this now-qBar-independent
 * torque enough absolute margin to arrest this specific airframe's instability within roughly 1-2s
 * from a large disturbed transient, matching (usually improving on) the OLD law's own settle time
 * where the old law converged at all. Both constants are LOCAL to the inner loop's own gain
 * computation (`pitchInnerLoopSchedule`, below) -- `pitchGainSchedule`'s original 1.5-exponent
 * schedule is unchanged and still used, unmodified, by the OUTER loop's own qCmdCapRadS derivation
 * above and by the ground law below, neither of which showed this failure mode.
 *
 * Residual known gap (matches the OLD law's own behavior at the same conditions, not a regression):
 * sea-level conditions above roughly 400-450 m/s (Mach 1.2+ at sea level, well outside this
 * airframe's realistic operating envelope and past where tejasAeroTables.ts's data was validated)
 * still fail to reach a clean trim under either law -- the OLD law settles into a stable-but-wrong
 * equilibrium there (confirmed by direct comparison, same tracing), while this restructured law
 * can still show a slower-settling or non-settling transient at those SAME extreme conditions.
 * tools/lib/trimSolver.ts's `findVmax` bisects up to 600 m/s at any altitude (VMAX_BISECT_MAX_MPS)
 * so it does probe this region, but only ever as intermediate bisection candidates far outside
 * every named performance target's tolerance band -- confirmed (this pass) not to affect
 * `checkPerformanceTarget`'s actual pass/fail for vmax_sl/vmax_11000/turn_5000_m06 or any other
 * named target, all of which trim within the realistic envelope this fix targets.
 */
const FCS_PITCH_INNER_QBAR_EXPONENT = 1.0;
const FCS_PITCH_INNER_LOOP_GAIN_MULT = 2;

const trimIntegralRad = new Float64Array(MAX_ENTITIES);
const lastGLoadRad = new Float64Array(MAX_ENTITIES);
/** FCS_PITCH_STICK_SHAPE_RATE_PER_SEC/FCS_ROLL_STICK_SHAPE_RATE_PER_SEC-limited pitch/roll stick, module-private per-slot state like trimIntegralRad/lastGLoadRad above. */
const shapedPitchStick = new Float64Array(MAX_ENTITIES);
const shapedRollStick = new Float64Array(MAX_ENTITIES);
/** FCS_PITCH_RATE_CMD_ONSET_RAD_S2-limited target pitch rate for the airborne law's outer loop, module-private per-slot state like the above. */
const shapedPitchRateCmd = new Float64Array(MAX_ENTITIES);

/** `noUncheckedIndexedAccess`-safe read of a Float64Array slot (never actually undefined for an in-range index; the array is fixed-size and zero-initialized). */
function readF64(arr: Float64Array, index: number): number {
  return arr[index] ?? 0;
}

/**
 * Extracts the entity pool's index (low-order digits, base
 * ENTITY_INDEX_RADIX) out of a packed `EntityId`, matching
 * `contracts/core.ts`'s documented pack scheme (plain arithmetic, never
 * bitwise — see that file's `EntityId` doc comment). `src/core` owns the
 * real `packEntityId`/`unpackEntityId`; this module cannot import
 * `src/core` (00-architecture.md section 10), so it re-derives just the
 * index component it needs from the same documented scheme.
 */
export function entityPoolIndex(id: EntityId): number {
  return id % ENTITY_INDEX_RADIX;
}

/** Read-back accessor for `computeTelemetry` (4.11) — see the module doc comment. */
export function getLastGLoad(entityIndex: number): number {
  return readF64(lastGLoadRad, entityIndex);
}

/** Non-contract test accessor for the trim-integral state (section 7 tests 16/16b/16c). */
export function getTrimIntegralRad(entityIndex: number): number {
  return readF64(trimIntegralRad, entityIndex);
}

/** `src/core` calls this whenever it recycles a pooled entity-pool slot for a newly-spawned aircraft (section 9). Safe to call for a never-used index. */
export function resetFcsTrimState(entityIndex: number): void {
  trimIntegralRad[entityIndex] = 0;
  lastGLoadRad[entityIndex] = 0;
  shapedPitchStick[entityIndex] = 0;
  shapedRollStick[entityIndex] = 0;
  shapedPitchRateCmd[entityIndex] = 0;
}

/**
 * Writes an explicit (trimIntegralRad, lastGLoadRad) pair into a pool slot.
 * Non-contract, like `getTrimIntegralRad`/`getLastGLoad` above: this module's
 * state is process-wide, keyed only by pool INDEX, not by which `World`
 * instance owns that index (00-architecture.md's own topology assumes
 * exactly one `World` per sim-worker process, which is why this is safe in
 * production). `tools/lib/worldAdapter.ts` uses this to give each
 * independently-created `World` its own save/restore of this slot around
 * every step, so two `World`s sharing a process (e.g.
 * tests/integration/determinism.test.ts's/tools/sim-check.ts's `determinism`
 * mode's worldA/worldB, stepped in an INTERLEAVED tick-by-tick pattern for
 * direct comparison) do not silently overwrite each other's trim-integral
 * history on a shared index every other tick — see that file's own comment
 * for the full mechanism.
 */
export function setFcsTrimState(entityIndex: number, trimIntegralRadValue: number, lastGLoadRadValue: number): void {
  trimIntegralRad[entityIndex] = trimIntegralRadValue;
  lastGLoadRad[entityIndex] = lastGLoadRadValue;
}

/**
 * Pure helper (exposed for test 16/17): the pitch g-command law's `gCmd`, before alpha-limiting.
 * `neutralG` is the load factor commanded with the stick centred (see `neutralGReference`); full
 * aft/forward stick still commands maxGLoadPos/maxGLoadNeg exactly.
 */
export function computeGCommand(pitchStick: number, fcsLimits: Pick<FcsLimits, 'maxGLoadPos' | 'maxGLoadNeg'>, neutralG = 1.0): number {
  return pitchStick >= 0 ? lerp(neutralG, fcsLimits.maxGLoadPos, pitchStick) : lerp(neutralG, fcsLimits.maxGLoadNeg, -pitchStick);
}

/** Bank angle, rad (33deg), beyond which the neutral-stick reference stops compensating for bank. */
const FCS_BANK_COMPENSATION_MAX_RAD = 0.5760;
const COS_BANK_COMPENSATION_MAX = Math.cos(FCS_BANK_COMPENSATION_MAX_RAD);

const scratchBodyAxis: Vec3Like = { x: 0, y: 0, z: 0 };
const BODY_FORWARD: Vec3Like = { x: 1, y: 0, z: 0 };
const BODY_UP: Vec3Like = { x: 0, y: 1, z: 0 };

/**
 * Neutral-stick load-factor reference, `cos(theta)/cos(phi)` (pitch attitude theta, bank phi), with
 * the bank term only applied up to FCS_BANK_COMPENSATION_MAX_RAD -- the flight-path-stable
 * neutral point modern g-command FBW laws use. A centred stick then holds the current flight path
 * (and altitude in a gentle banked turn) instead of commanding a flat 1g.
 *
 * A flat 1g reference made the aircraft pitch up on its own: in a climb of angle gamma, holding a
 * straight path only needs cos(gamma) g, so the extra `1 - cos(gamma)` g kept curving the path
 * upward -- live report "natural pitch up in level flight", reproduced headless as a hands-off
 * 110 m/s cruise whose flight-path angle drifted 3.7deg -> 10.5deg over 60s and still rising.
 */
export function neutralGReference(rot: Readonly<QuatLike>): number {
  Quat.rotate(rot, BODY_FORWARD, scratchBodyAxis);
  const sinTheta = clamp(scratchBodyAxis.y, -1, 1);
  const cosTheta = Math.sqrt(1 - sinTheta * sinTheta);
  if (cosTheta < 1e-3) return 0; // vertical: no gravity component along the body normal
  Quat.rotate(rot, BODY_UP, scratchBodyAxis);
  const cosPhi = scratchBodyAxis.y / cosTheta;
  if (cosPhi >= COS_BANK_COMPENSATION_MAX) return cosTheta / cosPhi;
  return cosTheta;
}

const scratchNonGravWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchNonGravBody: Vec3Like = { x: 0, y: 0, z: 0 };

export interface FcsSurfaces {
  elevonL: number;
  elevonR: number;
  rudder: number;
}

/**
 * Runs one substep of the FCS (4.9) and writes the new elevonL/elevonR/
 * rudder positions into `surfaces` (rate-limited toward this substep's
 * commands). `alpha` and `omega` are THIS substep's values (computed
 * earlier in the same substep, per 4.2's ordering). `totalForceWorld` is
 * the substep's summed force (used for the gLoad calc); it is READ ONLY.
 * `currentOnGround` is `(out.flags & EntityFlag.OnGround) !== 0` as of
 * THIS substep (after 4.8 already ran); `wasOnGroundAtEntry` is that same
 * flag as of the START of the whole `stepAircraft` call. Allocation-free.
 */
export function stepFcs(
  entityIndex: number,
  surfaces: FcsSurfaces,
  currentOnGround: boolean,
  wasOnGroundAtEntry: boolean,
  alpha: number,
  omega: Readonly<Vec3Like>,
  totalForceWorld: Readonly<Vec3Like>,
  rot: Readonly<QuatLike>,
  massKg: number,
  gravityMps2: number,
  inputs: PilotInputs,
  damage: DamageState,
  fcsLimits: FcsLimits,
  dtSub: number,
  qBarPa: number = FCS_QBAR_REF_PA,
  tasMps: number = 100
): void {
  const gainSchedule = pitchGainSchedule(qBarPa);
  // gLoad = dot(rotateInverse(rot, totalForceWorld - gravityWorld), (0,1,0)) / (massKg*g)
  const gravityForceWorldY = -massKg * gravityMps2;
  scratchNonGravWorld.x = totalForceWorld.x;
  scratchNonGravWorld.y = totalForceWorld.y - gravityForceWorldY;
  scratchNonGravWorld.z = totalForceWorld.z;
  Quat.rotateInverse(rot, scratchNonGravWorld, scratchNonGravBody);
  const gLoad = scratchNonGravBody.y / (massKg * gravityMps2);
  lastGLoadRad[entityIndex] = gLoad;

  if (!damage.hydraulicsOk) {
    trimIntegralRad[entityIndex] = 0;
    return; // surfaces frozen at their last commanded position
  }

  const p = bodyRateP(omega);
  const q = bodyRateQ(omega);
  const r = bodyRateR(omega);
  const transitioned = currentOnGround !== wasOnGroundAtEntry;

  // Reset the onset-shaped sticks to 0 right at a ground/air transition, same idea as
  // trimIntegralRad's own transition reset below: holding full aft stick through a whole ground
  // roll fully ramps shapedPitchStick to 1 well before liftoff (it only takes
  // FCS_PITCH_STICK_SHAPE_RATE_PER_SEC's own ~1s), so without this, the INSTANT control hands off
  // to a different law, that law would receive an already-fully-ramped stick with no onset
  // shaping left to apply, regardless of how gentle the just-ended law's own response was. First
  // tried as the fix for a post-liftoff q spike reported during the ground-law rewrite below --
  // it wasn't the actual cause of that spike (see the ground law's own gainSchedule comment for
  // what was), but forcing a fresh onset ramp on whichever law is newly entered is a reasonable
  // improvement in its own right, so it's kept: giving a freshly-engaged law the SAME onset
  // protection a fresh input would get, instead of skipping it purely because the stick happened
  // to already be at full deflection when the underlying law changed shape.
  if (transitioned) {
    shapedPitchStick[entityIndex] = 0;
    shapedRollStick[entityIndex] = 0;
    shapedPitchRateCmd[entityIndex] = 0;
  }
  shapedPitchStick[entityIndex] = rateLimitStep(readF64(shapedPitchStick, entityIndex), inputs.pitch, FCS_PITCH_STICK_SHAPE_RATE_PER_SEC, dtSub);
  shapedRollStick[entityIndex] = rateLimitStep(readF64(shapedRollStick, entityIndex), inputs.roll, FCS_ROLL_STICK_SHAPE_RATE_PER_SEC, dtSub);
  const pitchStickShaped = readF64(shapedPitchStick, entityIndex);
  const rollStickShaped = readF64(shapedRollStick, entityIndex);

  let elevonSymCmd: number;
  // Anticipated (rate-predicted) alpha for the GROUND law's rotation taper, per
  // ALPHA_LIMIT_ANTICIPATION_SEC's doc comment (the airborne limiter uses its own rate path).
  const alphaAnticipated = alpha + q * ALPHA_LIMIT_ANTICIPATION_SEC;
  if (!currentOnGround) {
    const gCmd = computeGCommand(pitchStickShaped, fcsLimits, neutralGReference(rot));
    // Alpha limiter as a pitch-rate path (see FCS_ALPHA_LOOP_GAIN_PER_S's doc comment). Skipped
    // entirely when the player disabled the limiter in Settings (PilotInputs.alphaLimiterDisabled);
    // AI pilots never set that flag.
    const limiterOn = !inputs.alphaLimiterDisabled;
    Quat.rotate(rot, BODY_UP, scratchBodyAxis);
    const bodyUpWorldY = scratchBodyAxis.y;
    const gOverV = gravityMps2 / Math.max(tasMps, FCS_PATH_RATE_MIN_TAS_MPS);
    // Pitch-plane turn rate of the flight path at the CURRENT load factor.
    const pathRateRadS = (gLoad - bodyUpWorldY) * gOverV;
    let qCmdAlphaMax = Infinity;
    let qCmdAlphaMin = -Infinity;
    if (limiterOn) {
      // alphaDot ~= q - pathRate; leading alpha by FCS_ALPHA_LOOP_LEAD_SEC of it damps the approach.
      const alphaLead = alpha + FCS_ALPHA_LOOP_LEAD_SEC * (q - pathRateRadS);
      qCmdAlphaMax = pathRateRadS + FCS_ALPHA_LOOP_GAIN_PER_S * (fcsLimits.maxAlphaRad - alphaLead);
      qCmdAlphaMin = pathRateRadS + FCS_ALPHA_LOOP_GAIN_PER_S * (fcsLimits.minAlphaRad - alphaLead);
    }

    // OUTER LOOP (g path): g-error -> a target pitch rate, capped and onset-shaped so the INNER
    // loop below is never asked to reach further than maxElevonRad can hold in steady state — see
    // FCS_PITCH_OUTER_LOOP_GAIN's doc comment for the full saturation analysis this sizes itself
    // against. Uses the INNER loop's own gain/schedule (pitchInnerLoopSchedule,
    // FCS_PITCH_INNER_LOOP_GAIN_MULT — see that constant's doc comment) in this cap's
    // denominator, so the steady-state algebra (elevonSymCmd = innerGain*qCmdAir at q=0) actually
    // lands at `margin*maxElevonRad` against the gain the inner loop below actually applies.
    const innerSchedule = pitchInnerLoopSchedule(qBarPa);
    const qCmdCapRadS = Math.min(
      (FCS_PITCH_RATE_CMD_SATURATION_MARGIN * fcsLimits.maxElevonRad) /
        (FCS_PITCH_INNER_LOOP_GAIN_MULT * innerSchedule * Math.abs(fcsLimits.pitchRateGain)),
      FCS_MAX_PITCH_RATE_CMD_RAD_S
    );
    // Feedforward: the pitch rate the COMMANDED load factor needs to hold a steady turn,
    // (gCmd - bodyUpWorldY)*g/V, so the proportional term only has to correct transients. Without
    // it the steady-state pitch rate of every sustained turn had to come from a multi-g
    // (gCmd - gLoad) error, which the trim integral then closed by winding up -- the source of the
    // hard-pull windup documented at trimErrorG below.
    const qCmdGRaw = clamp((gCmd - bodyUpWorldY) * gOverV + FCS_PITCH_OUTER_LOOP_GAIN * (gCmd - gLoad), -qCmdCapRadS, qCmdCapRadS);
    shapedPitchRateCmd[entityIndex] = rateLimitStep(
      readF64(shapedPitchRateCmd, entityIndex),
      qCmdGRaw,
      FCS_PITCH_RATE_CMD_ONSET_RAD_S2,
      dtSub
    );
    const qCmdG = readF64(shapedPitchRateCmd, entityIndex);
    // Fly whichever path asks for less pitch rate. The alpha path is deliberately NOT onset-shaped
    // (that lag is exactly what a limiter can't afford); it is still bounded by the same cap.
    const qCmdAir = clamp(clamp(qCmdG, qCmdAlphaMin, qCmdAlphaMax), -qCmdCapRadS, qCmdCapRadS);
    // While the alpha path is being flown, the trim integral tracks the ALPHA error instead of the
    // g error (the pilot is asking for more g than the limit allows, so integrating the g error
    // would wind it straight into its clamp). Without this it froze, and the inner rate loop's
    // own proportional error left alpha settling ~3deg PAST maxAlphaRad in a sustained pull.
    //
    // And integrate at a bounded rate, frozen while the g path is saturated (anti-windup, see
    // FCS_TRIM_INTEGRATE_MAX_ERROR_G). A hard pull asks for up to 8g from ~1-2g; integrating that transient
    // error wound the integral to ~9-12deg of nose-up elevon within ~1s of every hard pull -- a
    // bias the inner loop then fought, overshooting the commanded pitch rate by 2-3x and driving
    // alpha through the limit. This was the root of the low-speed hard-pull "bobbing" (reproduced
    // in the real World: pitch rate reversing 30-40 times in a 10s pull).
    const alphaLimitActive = qCmdG > qCmdAlphaMax || qCmdG < qCmdAlphaMin;
    const rawTrimErrorG = alphaLimitActive
      ? FCS_ALPHA_TRIM_G_PER_RAD * ((qCmdG > qCmdAlphaMax ? fcsLimits.maxAlphaRad : fcsLimits.minAlphaRad) - alpha)
      : gCmd - gLoad;
    const gPathSaturated = !alphaLimitActive && Math.abs(qCmdGRaw) >= qCmdCapRadS;
    const trimErrorG = gPathSaturated ? 0 : clamp(rawTrimErrorG, -FCS_TRIM_INTEGRATE_MAX_ERROR_G, FCS_TRIM_INTEGRATE_MAX_ERROR_G);

    if (transitioned) {
      trimIntegralRad[entityIndex] = 0;
    } else {
      // Sign (cross-module review; see src/aircraft/tejasGeometry.ts's FcsLimits.gLoadGain
      // comment for the full derivation this codifies): the integral term is added directly into
      // elevonSymCmd below, alongside the inner rate loop's own
      // FCS_PITCH_INNER_LOOP_GAIN_MULT*innerSchedule*pitchRateGain*(qCmdAir-q) term, so it only
      // drives (gCmd-gLoad) to zero if
      // increasing elevonSym increases gLoad -- an AIRFRAME property (the real aero's net
      // elevon->alpha->CL->gLoad effect), not a tuning knob of whichever control-law structure
      // happens to be driving elevonSymCmd's other terms. `fcsLimits.gLoadGain` is no longer used
      // as a direct multiplier anywhere in this formula (superseded by the outer/inner-loop
      // restructuring — see FCS_PITCH_OUTER_LOOP_GAIN's own doc comment above), but it still
      // correctly encodes that airframe sign (its own extensive derivation in tejasGeometry.ts
      // covers why it must be negative for this specific aircraft) and is kept specifically to
      // source it here, via Math.sign, exactly as before.
      const trimIntegralSign = Math.sign(fcsLimits.gLoadGain) || 1;
      trimIntegralRad[entityIndex] = clamp(
        readF64(trimIntegralRad, entityIndex) + trimIntegralSign * FCS_TRIM_INTEGRAL_GAIN * trimErrorG * dtSub,
        -FCS_TRIM_INTEGRAL_MAX_RAD,
        FCS_TRIM_INTEGRAL_MAX_RAD
      );
    }
    // INNER LOOP: rate error -> elevon, the same self-limiting structural pattern the roll law
    // and the ground pitch law (below) already use — a single gain on (target-actual) instead of
    // a raw position-scale proportional term. FCS_PITCH_INNER_LOOP_GAIN_MULT/
    // FCS_PITCH_INNER_QBAR_EXPONENT (see that constant's own doc comment) size this specifically
    // for disturbance-rejection authority against this airframe's open-loop instability, distinct
    // from `gainSchedule`'s own (steeper-rolloff) schedule used by the outer loop's cap above and
    // by the ground law below.
    elevonSymCmd =
      FCS_PITCH_INNER_LOOP_GAIN_MULT * innerSchedule * fcsLimits.pitchRateGain * (qCmdAir - q) + readF64(trimIntegralRad, entityIndex);
  } else {
    trimIntegralRad[entityIndex] = 0;
    // RATE-command law (same structure as the roll law just below: qCmd from the stick, gain on
    // the rate ERROR, not a raw position command) -- rewritten from an earlier direct-position
    // formula (`-stick*maxElevonRad*GROUND_LAW_PITCH_AUTHORITY_FRACTION - gainSchedule*
    // pitchRateGain*q`) that had two problems, both found live-testing a sustained full-aft-stick
    // rotation from brakes-release:
    //
    // (1) SIGN: that formula's direct term was missing a negation. This project's mandatory
    // elevon sign convention (tejasGeometry.ts's gLoadGain comment, 00-architecture.md section
    // 6.2) is "+elevonSym = trailing-edge-down = NOSE-DOWN moment"; the air law's gCmd term gets
    // this right because gLoadGain is itself negative, but the old ground law mapped the raw
    // stick straight through with a positive coefficient, so pulling up commanded NOSE-DOWN the
    // entire ground roll. Inherited verbatim from docs/spec/02-flight-model.md section 4.9's own
    // worked formula (also fixed there) -- it predates this project's later "sign fix" review
    // passes on gLoadGain/pitchRateGain/yawRateGain (tejasGeometry.ts's own extensive history of
    // those), which swept GAIN CONSTANTS by checking for closed-loop divergence from a
    // stick-centered trim; that method cannot catch a wrong-signed DIRECT proportional term like
    // this one, since it's hard-clamped to +-maxElevonRad and produces no divergence to detect --
    // it just stably pushes the aircraft the wrong way. See the rudder fix below for the other
    // instance of this exact same class of bug.
    //
    // (2) UNBOUNDED RATE: with (1) fixed, the aircraft rotated the right way but violently --
    // pitch running from 1deg to 24deg in under 3s (q spiking past 19deg/s) well before actually
    // leaving the ground, handing an already-overcooked high-alpha, high-rate state to the air
    // law's alpha limiter at the exact instant of the ground/air transition. A fixed POSITION
    // command has no target rate to settle at -- only ever-growing damping error as q builds --
    // so nothing bounded how fast rotation could accelerate before the aircraft simply left the
    // ground mid-runaway. Capping alpha the way the air law does (tried first) didn't fix this:
    // the runaway acceleration happens mostly BELOW maxAlphaRad, while alpha is still climbing
    // through it, so by the time an alpha-based cap engaged, rotational momentum had already
    // built up too far to arrest in time. A rate-command law is self-limiting by construction:
    // once q reaches qCmdGround the (qCmdGround-q) error goes to zero and the command settles to
    // whatever holds that rate steady, instead of continuing to accelerate --
    // GROUND_LAW_MAX_ROTATION_RATE_RAD_S's own doc comment has the live-tested numbers and why
    // 10deg/s was chosen. Also tapers qCmdGround toward zero (not negative -- avoid an active
    // nose-down push while still substantially on the ground, which risks a nose-gear slam) as
    // alphaAnticipated approaches/exceeds maxAlphaRad, as a second line of defence against a
    // rotation held long enough post-liftoff to still climb alpha past the limit at the target
    // rate; not gated by minAlphaRad/the symmetric case, since a ground rotation excursion only
    // ever runs away in the nose-up direction.
    let qCmdGround = pitchStickShaped * GROUND_LAW_MAX_ROTATION_RATE_RAD_S;
    if (!inputs.alphaLimiterDisabled && alphaAnticipated > fcsLimits.maxAlphaRad) {
      const overshootRad = alphaAnticipated - fcsLimits.maxAlphaRad;
      const blend = clamp(overshootRad / ALPHA_LIMIT_BLEND_RAD, 0, 1);
      qCmdGround = lerp(qCmdGround, 0, blend);
    }
    // gainSchedule (see its own doc comment above): a fixed pitchRateGain would let the ACTUAL
    // torque this produces grow unboundedly with qBar as speed builds through the roll -- the
    // exact same instability gainSchedule exists to prevent for the airborne law above, just
    // rediscovered here: the first version of this rate-command law omitted it and still showed
    // q overshooting the 10deg/s target by 3x+ (past 30-40deg/s) while STILL on the ground and
    // well before any ground/air transition, ruling out the transition handoff as the cause.
    elevonSymCmd = gainSchedule * fcsLimits.pitchRateGain * (qCmdGround - q);
  }
  elevonSymCmd = clamp(elevonSymCmd, -fcsLimits.maxElevonRad, fcsLimits.maxElevonRad);

  const pCmd = rollStickShaped * fcsLimits.maxRollRateRadS;
  const elevonDiffCmd = clamp(fcsLimits.rollRateGain * (pCmd - p), -fcsLimits.maxElevonRad, fcsLimits.maxElevonRad);

  // Negated, same bug class and same root cause as the ground pitch law above (found auditing
  // for other instances after that fix): tejasGeometry.ts's yawRateGain comment establishes
  // "+rudder (trailing-edge LEFT) produces +wy / a NOSE-LEFT moment" (Cn_rudder<0), while
  // PilotInputs.yaw's own doc comment is "+1 = nose-right command". The un-negated direct term
  // (inputs.yaw*maxRudderRad) therefore commanded +rudder -- nose-LEFT -- for a pilot pressing
  // right rudder. The damping term (-yawRateGain*r) was already correctly signed since
  // yawRateGain itself went through the gain-constant review; only this direct term, inherited
  // from the same spec formula (docs/spec/02-flight-model.md section 4.9, also fixed there), was
  // never checked by that review for the reason explained above.
  const rudderCmd = clamp(-inputs.yaw * fcsLimits.maxRudderRad - fcsLimits.yawRateGain * r, -fcsLimits.maxRudderRad, fcsLimits.maxRudderRad);

  const healthL = damage.controlSurfaces.elevonL;
  const healthR = damage.controlSurfaces.elevonR;
  const healthRudder = damage.controlSurfaces.rudder;

  const elevonLCmd = clamp(elevonSymCmd + elevonDiffCmd / 2, -fcsLimits.maxElevonRad * healthL, fcsLimits.maxElevonRad * healthL);
  const elevonRCmd = clamp(elevonSymCmd - elevonDiffCmd / 2, -fcsLimits.maxElevonRad * healthR, fcsLimits.maxElevonRad * healthR);
  const rudderCmdFinal = clamp(rudderCmd, -fcsLimits.maxRudderRad * healthRudder, fcsLimits.maxRudderRad * healthRudder);

  surfaces.elevonL = rateLimitStep(surfaces.elevonL, elevonLCmd, fcsLimits.maxElevonRateRadS * healthL, dtSub);
  surfaces.elevonR = rateLimitStep(surfaces.elevonR, elevonRCmd, fcsLimits.maxElevonRateRadS * healthR, dtSub);
  surfaces.rudder = rateLimitStep(surfaces.rudder, rudderCmdFinal, fcsLimits.maxRudderRateRadS * healthRudder, dtSub);
}
