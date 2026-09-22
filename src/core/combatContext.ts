/**
 * src/core/combatContext.ts — `WorldCombatTickContext`, a private extension
 * of the pinned `CombatTickContext` (contracts/sim.ts) shared between
 * `world.ts` (which builds the concrete object) and `combatAdapter.ts`
 * (which consumes the extra fields). Not part of any contract file — see
 * 10-core-worker.md section 9 item 11's own note that `combatAdapter.ts`
 * legitimately needs a couple of things `CombatTickContext` alone does not
 * expose (there: a per-entity `WeaponsState` cache and a static loadout;
 * here, additionally: the mission seed for `createWeaponsState`'s RNG
 * sub-seed, and each aircraft's current `PilotInputs`, which `updateSensors`/
 * `fireWeapons` (contracts/combat.ts) both require and which `World` is the
 * only place that owns).
 */

import type { EntityId, PilotInputs } from '../contracts/core';
import type { CombatTickContext } from '../contracts/sim';

export interface WorldCombatTickContext extends CombatTickContext {
  readonly missionSeed: number;
  /** This tick's PilotInputs for a live aircraft entity (whatever `setPlayerInput`/`Pilot.update` last wrote), or `undefined` if `id` is not a live aircraft. */
  getInputs(id: EntityId): PilotInputs | undefined;
  /** `AircraftTelemetry.altAglM` for a live aircraft entity, computed this tick's step 3 (10-core-worker.md section 4.1) — `UpdateSensors` (contracts/combat.ts) needs it and `CombatTickContext` alone does not expose telemetry. 0 if `id` is not a live aircraft. */
  getAltAglM(id: EntityId): number;
}
