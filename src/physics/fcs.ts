/**
 * src/physics/fcs.ts — fly-by-wire control laws: pitch g/alpha-command law
 * (airborne) with trim integral, direct pitch law (on ground), roll
 * rate-command law, yaw direct law + damper, actuator rate-limiting and
 * damage-authority scaling. See docs/spec/02-flight-model.md section 4.9.
 *
 * Owns two module-private `Float64Array(MAX_ENTITIES)` tables
 * (`trimIntegralRad`, `lastGLoadRad`), indexed by the pool-slot index
 * extracted from `EntityState.id` (see `entityPoolIndex` below) — see
 * 02-flight-model.md section 9 for why this state is module-private rather
 * than part of `EntityState`/`DamageState`.
 */
import type { EntityId, PilotInputs, DamageState, QuatLike, Vec3Like } from '../contracts/core';
import { MAX_ENTITIES, ENTITY_INDEX_RADIX } from '../contracts/core';
import type { FcsLimits } from '../contracts/aircraft';
import { GROUND_LAW_PITCH_AUTHORITY_FRACTION } from '../contracts/flight';
import { Quat, clamp, lerp, rateLimitStep, bodyRateP, bodyRateQ, bodyRateR } from '../math';

/** Ki — pitch trim-integral gain, rad/(g*s). */
const FCS_TRIM_INTEGRAL_GAIN = 0.02;
/** Anti-windup clamp on trimIntegralRad, rad (~12deg). */
const FCS_TRIM_INTEGRAL_MAX_RAD = 0.2094;

/**
 * Pitch-axis qBar gain scheduling (cross-module fix; see
 * tests/integration/trimAndPerformance.test.ts / tools/lib/trimSolver.ts's
 * own extensive notes on why a FIXED-gain pitch law cannot hold across this
 * project's speed envelope).
 *
 * `FcsLimits.gLoadGain`/`pitchRateGain` set a rad-of-elevon-per-(g-error or
 * rad/s) response, but the MOMENT that elevon deflection actually produces
 * is `Cm_elevon * elevonSym * qBar * wingAreaM2 * meanChordM` (aeroForces.ts
 * 4.5) — proportional to qBar. A gain pair tuned to be stable at one
 * dynamic pressure therefore commands a torque that grows linearly with
 * qBar at any other speed: verified empirically (see the cross-module
 * review this fix is part of) that the un-scheduled loop is cleanly stable
 * at qBar corresponding to ~100 m/s sea-level TAS (the tuning point implicit
 * in tejasGeometry.ts's own gLoadGain/pitchRateGain magnitudes) but drives
 * alpha to tens of degrees within ~1 simulated second at 150+ m/s — the
 * commanded elevon deflection is unchanged but the qBar-scaled torque it
 * produces is 2-10x larger, turning a well-damped response into a violently
 * oscillating one.
 *
 * Scaling BOTH the proportional (gLoadGain) and rate (pitchRateGain) terms
 * by `(FCS_QBAR_REF_PA / qBar) ^ FCS_GAIN_SCHEDULE_EXPONENT` (clamped) keeps
 * the commanded elevon response bounded across the flight envelope, at (by
 * construction) the same magnitude tejasGeometry.ts's gains were tuned to
 * produce at the reference qBar — i.e. this reproduces the known-stable
 * low-speed response at every speed, rather than introducing a new, untuned
 * control law. It does not touch the physical alpha->CL->gLoad relationship
 * (still qBar-dependent as it must be — a faster aircraft genuinely trims at
 * a smaller alpha for the same g), only how hard the actuator is commanded
 * to respond to a given error.
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

const trimIntegralRad = new Float64Array(MAX_ENTITIES);
const lastGLoadRad = new Float64Array(MAX_ENTITIES);

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

/** Pure helper (exposed for test 16/17): the pitch g-command law's `gCmd`, before alpha-limiting. */
export function computeGCommand(pitchStick: number, fcsLimits: Pick<FcsLimits, 'maxGLoadPos' | 'maxGLoadNeg'>): number {
  return pitchStick >= 0 ? lerp(1.0, fcsLimits.maxGLoadPos, pitchStick) : lerp(1.0, fcsLimits.maxGLoadNeg, -pitchStick);
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
  qBarPa: number = FCS_QBAR_REF_PA
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

  let elevonSymCmd: number;
  if (!currentOnGround) {
    let gCmd = computeGCommand(inputs.pitch, fcsLimits);
    if (alpha > fcsLimits.maxAlphaRad) {
      gCmd = Math.min(gCmd, 1.0 - fcsLimits.alphaLimitGain * (alpha - fcsLimits.maxAlphaRad));
    }
    if (alpha < fcsLimits.minAlphaRad) {
      gCmd = Math.max(gCmd, 1.0 - fcsLimits.alphaLimitGain * (alpha - fcsLimits.minAlphaRad));
    }

    if (!transitioned) {
      // Sign fix (cross-module review; see src/aircraft/tejasGeometry.ts's
      // FcsLimits.gLoadGain comment for the full derivation this codifies):
      // the integral term is added directly into elevonSymCmd as
      // "+trimIntegralRad" below, so it only drives (gCmd - gLoad) to zero if
      // increasing elevonSym increases gLoad, i.e. if the PROPORTIONAL term's
      // own sign convention (gLoadGain) is positive. For an airframe whose
      // real aero data makes gLoadGain NEGATIVE (elevon's indirect
      // alpha/CL(alpha) effect dominates its direct CL_elevon lift), a
      // fixed-positive accumulation instead fights the proportional/rate
      // terms whenever gCmd != gLoad persists, producing an undamped,
      // non-converging gLoad oscillation instead of a trim. Scaling the
      // accumulation by sign(gLoadGain) keeps the integral's contribution to
      // elevonSymCmd aligned with the proportional term's own (airframe-
      // dependent) sign in both cases, matching standard PI-controller
      // practice of applying the same sign convention to the P and I terms.
      const trimIntegralSign = Math.sign(fcsLimits.gLoadGain) || 1;
      trimIntegralRad[entityIndex] = clamp(
        readF64(trimIntegralRad, entityIndex) + trimIntegralSign * FCS_TRIM_INTEGRAL_GAIN * (gCmd - gLoad) * dtSub,
        -FCS_TRIM_INTEGRAL_MAX_RAD,
        FCS_TRIM_INTEGRAL_MAX_RAD
      );
    } else {
      trimIntegralRad[entityIndex] = 0;
    }
    elevonSymCmd =
      gainSchedule * (fcsLimits.gLoadGain * (gCmd - gLoad) - fcsLimits.pitchRateGain * q) + readF64(trimIntegralRad, entityIndex);
  } else {
    trimIntegralRad[entityIndex] = 0;
    elevonSymCmd = inputs.pitch * fcsLimits.maxElevonRad * GROUND_LAW_PITCH_AUTHORITY_FRACTION - gainSchedule * fcsLimits.pitchRateGain * q;
  }
  elevonSymCmd = clamp(elevonSymCmd, -fcsLimits.maxElevonRad, fcsLimits.maxElevonRad);

  const pCmd = inputs.roll * fcsLimits.maxRollRateRadS;
  const elevonDiffCmd = clamp(fcsLimits.rollRateGain * (pCmd - p), -fcsLimits.maxElevonRad, fcsLimits.maxElevonRad);

  const rudderCmd = clamp(inputs.yaw * fcsLimits.maxRudderRad - fcsLimits.yawRateGain * r, -fcsLimits.maxRudderRad, fcsLimits.maxRudderRad);

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
