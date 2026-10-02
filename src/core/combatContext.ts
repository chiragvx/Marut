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

import type { Contact, EntityId, PilotInputs, Vec3Like } from '../contracts/core';
import type { CombatTickContext } from '../contracts/sim';
import type { LoadoutPreset } from '../contracts/aircraft';
import type { GroundTargetSet, RunwayDamage } from '../ground';
import type { AdSiteSpec, AdUnitSpec } from '../combat';

export interface WorldCombatTickContext extends CombatTickContext {
  readonly missionSeed: number;
  /** This tick's PilotInputs for a live aircraft entity (whatever `setPlayerInput`/`Pilot.update` last wrote), or `undefined` if `id` is not a live aircraft. */
  getInputs(id: EntityId): PilotInputs | undefined;
  /** `AircraftTelemetry.altAglM` for a live aircraft entity, computed this tick's step 3 (10-core-worker.md section 4.1) — `UpdateSensors` (contracts/combat.ts) needs it and `CombatTickContext` alone does not expose telemetry. 0 if `id` is not a live aircraft. */
  getAltAglM(id: EntityId): number;
  /** The aircraft type id of a live aircraft entity (AircraftDefinition.id), or undefined. */
  getAircraftDefId(id: EntityId): string | undefined;
  /** The store fit of a live aircraft (the player's preset or custom fit, from the mission), or undefined = its type's default. */
  getLoadout?(id: EntityId): LoadoutPreset | undefined;
  /** The mission's ground targets (units and airbase structures): weapons hit and damage them. */
  readonly ground?: GroundTargetSet;
  /** The mission's airport runways and their craters. */
  readonly runways?: RunwayDamage;
  /** The mission's air-defence sites and their units (a new object per mission load). */
  readonly airDefence?: { sites: readonly AdSiteSpec[]; units: readonly AdUnitSpec[] };
}

/**
 * Extra surface the concrete `CombatPort` (`combatAdapter.ts`) exposes
 * BEYOND the pinned `CombatPort` interface (contracts/sim.ts), so `World`
 * can read back the per-observer `Contact` list `CombatPort` computed via
 * `updateSensors` on this tick's step 6 and feed it into the NEXT tick's AI
 * `PilotContext` (step 2) — see 10-core-worker.md section 4.1 step 2 ("contacts
 * = ... whatever CombatPort populated via CombatTickContext/CombatStatus on
 * the previous tick's step 6") and section 9 item 6, which names this exact
 * mechanism ("the adapter also exposes a getContacts(id): readonly Contact[]
 * method beyond the pinned CombatPort interface") as the one this
 * integration pass should use. Not part of any contract file — nothing
 * outside `src/core` observes it.
 */
/** Ground re-arming: refills aircraft `id`'s weapon stations to at least `frac` (0..1) of their full load. */
export interface CombatPortWithRearm {
  rearm(id: EntityId, frac: number): void;
  /** How fully armed aircraft `id` is: the lowest station fill fraction, 0..1 (1 if unknown). */
  armedFrac(id: EntityId): number;
}

/** Air defences: seconds a site (mission ground group) has been suppressed (silenced by an ARM, or its radars destroyed). */
export interface CombatPortWithAirDefence {
  siteSuppressedSec(siteId: string): number;
}

/** The route's target steerpoint became active: load its aim points as aircraft `id`'s designated point (pre-planned target). */
export interface CombatPortWithBriefing {
  loadBriefedTarget(id: EntityId, points: readonly Vec3Like[]): void;
  /** Aircraft `id` crashed: the shooter that hit it recently (its kill), if any. Forgets the hit. */
  creditCrash(id: EntityId, simTimeSec: number): EntityId | undefined;
  /** An AI strike sortie: select aircraft `id`'s air-to-ground store and designate `point`. False until its weapon system exists (call again next tick). */
  armStrike(id: EntityId, point: Vec3Like): boolean;
}

/** Stores still on aircraft `id`'s station `hardpointId` (undefined until combat has seen the aircraft, or no such weapon station). */
export interface CombatPortWithStores {
  stationCount(id: EntityId, hardpointId: string): number | undefined;
}

export interface CombatPortWithContacts {
  /** Sensor contacts visible to aircraft `id` as of the most recent `CombatPort.step` call, most-threatening first (whatever order `updateSensors` produced), or an empty array if `id` has never been observed as a live aircraft by combat. Never allocates when `id` has no entry. */
  getContacts(id: EntityId): readonly Contact[];
}
