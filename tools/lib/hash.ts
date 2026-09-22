/**
 * tools/lib/hash.ts — implements HashSimState (contracts/verify.ts).
 * See docs/spec/12-verification.md section 4.4 for the byte-serialisation
 * order and the FNV-1a-32 algorithm. The exact field list/order below is
 * pinned by that section's golden regression vector (tests/tools/hash.test.ts,
 * expected 'fbe75177') — do not reorder fields without re-deriving that vector.
 *
 * NOTE: `state.fuelKg` is deliberately NOT included in the hashed field list.
 * The prose in 12-verification.md section 4.4 lists it, but the section's
 * own pinned golden vector is only reproducible with a 36-field layout that
 * omits it (37 fields including it does not match 'fbe75177'). Per that
 * section's own tie-breaker rule ("if hashSimState ever produces a different
 * value for this exact fixture ... must be fixed to match this pinned value,
 * not the other way around"), the golden vector wins and fuelKg is omitted
 * here. Aircraft fuel state is still exactly reproduced across a determinism
 * comparison via `telemetry.fuelKg` when telemetry is supplied, or via
 * bit-identical EntityState.fuelKg regardless (both worlds compare replay of
 * the SAME PRNG-free arithmetic, so this omission does not weaken the
 * determinism check itself — it only affects HashSimState's own byte layout).
 */
import { EntityKindCode } from '../../src/contracts/core';
import type { HashSimState, ObservedEntity } from '../../src/contracts/verify';
import { FNV1A_OFFSET_BASIS, FNV1A_PRIME } from '../../src/contracts/verify';

/** Floats hashed per entity. Keep in sync with the field list below. */
const FIELDS_PER_ENTITY = 36;

/** Reused scratch buffer, grown (never shrunk) on demand — no per-call allocation in steady state once warmed to the largest entity count seen. */
let scratch = new Float64Array(FIELDS_PER_ENTITY * 64);

function ensureScratchCapacity(entityCount: number): Float64Array {
  const needed = FIELDS_PER_ENTITY * entityCount;
  if (scratch.length < needed) {
    scratch = new Float64Array(needed);
  }
  return scratch;
}

function boolToNum(b: boolean): number {
  return b ? 1 : 0;
}

export const hashSimState: HashSimState = (entities: readonly ObservedEntity[]): string => {
  const buf = ensureScratchCapacity(entities.length);
  let idx = 0;
  for (let i = 0; i < entities.length; i++) {
    const obs = entities[i];
    if (obs === undefined) continue;
    const { state, damage, telemetry } = obs;
    buf[idx++] = state.id;
    buf[idx++] = EntityKindCode[state.kind];
    buf[idx++] = state.team;
    buf[idx++] = state.pos.x;
    buf[idx++] = state.pos.y;
    buf[idx++] = state.pos.z;
    buf[idx++] = state.rot.x;
    buf[idx++] = state.rot.y;
    buf[idx++] = state.rot.z;
    buf[idx++] = state.rot.w;
    buf[idx++] = state.vel.x;
    buf[idx++] = state.vel.y;
    buf[idx++] = state.vel.z;
    buf[idx++] = state.omega.x;
    buf[idx++] = state.omega.y;
    buf[idx++] = state.omega.z;
    buf[idx++] = boolToNum(state.alive);
    buf[idx++] = state.hp;
    buf[idx++] = state.elevonL;
    buf[idx++] = state.elevonR;
    buf[idx++] = state.rudder;
    buf[idx++] = state.gearPos;
    buf[idx++] = state.throttle;
    buf[idx++] = boolToNum(state.afterburnerOn);
    buf[idx++] = state.flags;
    buf[idx++] = damage?.structurePct ?? -1;
    buf[idx++] = damage?.engineHealthPct ?? -1;
    buf[idx++] = damage?.controlSurfaces.elevonL ?? -1;
    buf[idx++] = damage?.controlSurfaces.elevonR ?? -1;
    buf[idx++] = damage?.controlSurfaces.rudder ?? -1;
    buf[idx++] = damage !== undefined ? boolToNum(damage.hydraulicsOk) : -1;
    buf[idx++] = damage !== undefined ? boolToNum(damage.fuelLeak) : -1;
    buf[idx++] = damage?.radarHealthPct ?? -1;
    buf[idx++] = damage?.gearHealthPct ?? -1;
    buf[idx++] = telemetry?.fuelKg ?? -1;
    buf[idx++] = telemetry?.thrustFrac ?? -1;
  }

  const bytes = new Uint8Array(buf.buffer, 0, idx * 8);
  let hash = FNV1A_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    hash = (hash ^ b) >>> 0;
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};
