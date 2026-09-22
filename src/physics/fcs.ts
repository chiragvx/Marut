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
  dtSub: number
): void {
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
      trimIntegralRad[entityIndex] = clamp(
        readF64(trimIntegralRad, entityIndex) + FCS_TRIM_INTEGRAL_GAIN * (gCmd - gLoad) * dtSub,
        -FCS_TRIM_INTEGRAL_MAX_RAD,
        FCS_TRIM_INTEGRAL_MAX_RAD
      );
    } else {
      trimIntegralRad[entityIndex] = 0;
    }
    elevonSymCmd = fcsLimits.gLoadGain * (gCmd - gLoad) - fcsLimits.pitchRateGain * q + readF64(trimIntegralRad, entityIndex);
  } else {
    trimIntegralRad[entityIndex] = 0;
    elevonSymCmd = inputs.pitch * fcsLimits.maxElevonRad * GROUND_LAW_PITCH_AUTHORITY_FRACTION - fcsLimits.pitchRateGain * q;
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
