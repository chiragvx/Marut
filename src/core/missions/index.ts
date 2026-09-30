/**
 * src/core/missions/index.ts — implements `LoadMissionDescriptor`
 * (contracts/sim.ts section 9) and resolves the two built-in
 * `MissionDescriptor` JSON files into real `Mission`s using module 04/05's
 * real factories. See 10-core-worker.md section 4.11.
 *
 * Also owns `buildWorldDependencies` (constructing the real
 * `WorldDependencies`, contracts/sim.ts, for a resolved `Mission`): that
 * needs a real `HeightSampler`/`AirportNavDb` built from
 * `mission.world.terrain`/`.airports`, so it lives here rather than in a
 * fifth sibling-importing file — 10-core-worker.md section 8's acceptance
 * criteria name exactly four files (this one plus the three
 * `*Adapter.ts` files) as the only src/core files allowed to import another
 * leaf module directly.
 */

import type { LoadMissionDescriptor, MissionDescriptor, WorldDependencies } from '../../contracts/sim';
import type { Mission } from '../../contracts/core';
import { DEFAULT_TERRAIN_PARAMS, THEATRE_TERRAIN_PARAMS } from '../../contracts/terrain';
import type { TerrainParams, TheatreId } from '../../contracts/terrain';
import type { AirportLayout } from '../../contracts/airport';
import { loadAirportLayout, createAirportNavDb } from '../../airport';
import { createHeightSampler } from '../../terrain';
import { flightModelAdapter } from '../flightModelAdapter';
import { createCombatAdapter } from '../combatAdapter';
import { aiPilotAdapter } from '../aiPilotAdapter';

import freeFlightRaw from './freeFlight.json';
import dogfight1v1Raw from './dogfight1v1.json';
import konkanFreeFlightRaw from './konkanFreeFlight.json';
import konkanDogfightRaw from './konkanDogfight.json';
import punjabFreeFlightRaw from './punjabFreeFlight.json';
import punjabDogfightRaw from './punjabDogfight.json';
import borderFreeFlightRaw from './borderFreeFlight.json';
import borderInterceptRaw from './borderIntercept.json';
import borderDuelRaw from './borderDuel.json';
import borderRangeRaw from './borderRange.json';
import borderStrikeRaw from './borderStrike.json';
import rangpurAfbRaw from '../../airport/layouts/rangpur-afb.json';
import konarakCoastalRaw from '../../airport/layouts/konarak-coastal.json';
import insHansaRaw from '../../airport/layouts/ins-hansa.json';
import adampurAfsRaw from '../../airport/layouts/adampur-afs.json';
import bhisianaAfsRaw from '../../airport/layouts/bhisiana-afs.json';
import pafbShahbazRaw from '../../airport/layouts/pafb-shahbaz.json';

export const loadMissionDescriptor: LoadMissionDescriptor = (
  descriptor: MissionDescriptor,
  resolveAirport: (id: string) => unknown | undefined,
  resolveTerrainParams: (raw: Readonly<Record<string, unknown>>) => unknown
): Mission => {
  const airports: unknown[] = [];
  for (const id of descriptor.airportIds) {
    const layout = resolveAirport(id);
    if (layout === undefined) {
      // Per this project's error-handling convention (00-architecture.md
      // section 13): drop + warn in dev, never throw for ordinary bad/missing
      // data. A mission that ends up with zero resolvable airports still
      // loads (its player/AI flights may resolve via explicit pos/heading
      // instead of airportId/runwayId).
      if (typeof console !== 'undefined') console.warn(`loadMissionDescriptor: unresolvable airportId '${id}', dropped`);
      continue;
    }
    airports.push(layout);
  }
  const terrain = resolveTerrainParams(descriptor.terrain);
  return {
    id: descriptor.id,
    name: descriptor.name,
    world: { seed: descriptor.seed, terrain, airports },
    playerStart: descriptor.playerStart,
    aiFlights: descriptor.aiFlights,
    ...(descriptor.groundGroups ? { groundGroups: descriptor.groundGroups } : {}),
    weather: descriptor.weather,
    objectives: descriptor.objectives,
  };
};

/** The one real `resolveAirport` this project needs: module 05's `loadAirportLayout` applied to one of the two built-in layout JSON files, by id (00-architecture.md section 9.3). */
const BUILTIN_AIRPORT_JSON: Readonly<Record<string, unknown>> = {
  'rangpur-afb': rangpurAfbRaw,
  'konarak-coastal': konarakCoastalRaw,
  'ins-hansa': insHansaRaw,
  'adampur-afs': adampurAfsRaw,
  'bhisiana-afs': bhisianaAfsRaw,
  'pafb-shahbaz': pafbShahbazRaw,
};

function resolveBuiltinAirport(id: string): AirportLayout | undefined {
  const raw = BUILTIN_AIRPORT_JSON[id];
  if (raw === undefined) return undefined;
  const result = loadAirportLayout(raw);
  if (!result.ok) {
    if (typeof console !== 'undefined') console.warn(`loadMissionDescriptor: airport layout '${id}' failed to load`, result.error);
    return undefined;
  }
  return result.value.layout;
}

/**
 * The one real `resolveTerrainParams` this project needs: `descriptor.terrain` is `{ seed }` or
 * `{ seed, theatre }` — overlay the seed onto that theatre's preset (THEATRE_TERRAIN_PARAMS), or onto
 * `DEFAULT_TERRAIN_PARAMS` when no (or an unknown) theatre is named.
 */
function resolveBuiltinTerrainParams(raw: Readonly<Record<string, unknown>>): TerrainParams {
  const base = typeof raw.theatre === 'string' && raw.theatre in THEATRE_TERRAIN_PARAMS ? THEATRE_TERRAIN_PARAMS[raw.theatre as TheatreId] : DEFAULT_TERRAIN_PARAMS;
  const seed = typeof raw.seed === 'number' ? raw.seed : base.seed;
  return { ...base, seed };
}

const BUILTIN_DESCRIPTORS = {
  'free-flight': freeFlightRaw as unknown as MissionDescriptor,
  'dogfight-1v1': dogfight1v1Raw as unknown as MissionDescriptor,
  'konkan-free': konkanFreeFlightRaw as unknown as MissionDescriptor,
  'konkan-dogfight': konkanDogfightRaw as unknown as MissionDescriptor,
  'punjab-free': punjabFreeFlightRaw as unknown as MissionDescriptor,
  'punjab-dogfight': punjabDogfightRaw as unknown as MissionDescriptor,
  'border-free': borderFreeFlightRaw as unknown as MissionDescriptor,
  'border-intercept': borderInterceptRaw as unknown as MissionDescriptor,
  'border-duel': borderDuelRaw as unknown as MissionDescriptor,
  'border-range': borderRangeRaw as unknown as MissionDescriptor,
  'border-strike': borderStrikeRaw as unknown as MissionDescriptor,
} as const satisfies Readonly<Record<string, MissionDescriptor>>;

export type BuiltinMissionId = keyof typeof BUILTIN_DESCRIPTORS;
export const BUILTIN_MISSION_IDS = Object.keys(BUILTIN_DESCRIPTORS) as BuiltinMissionId[];

export function isBuiltinMissionId(id: string): id is BuiltinMissionId {
  return id in BUILTIN_DESCRIPTORS;
}

const resolvedMissionCache = new Map<string, Mission>();

/** Resolves one of the built-in missions by id, cached. */
export function resolveBuiltinMission(id: BuiltinMissionId): Mission {
  const cached = resolvedMissionCache.get(id);
  if (cached) return cached;
  const descriptor = BUILTIN_DESCRIPTORS[id];
  if (!descriptor) throw new Error(`resolveBuiltinMission: unknown built-in mission id '${id}'`);
  const mission = loadMissionDescriptor(descriptor, resolveBuiltinAirport, resolveBuiltinTerrainParams);
  resolvedMissionCache.set(id, mission);
  return mission;
}

/**
 * Builds the real `WorldDependencies` for a resolved `Mission`, wiring the
 * three adapter files plus a real `HeightSampler`/`AirportNavDb` built from
 * `mission.world.terrain`/`.airports`. `Mission.world.terrain`/`.airports`
 * are typed `unknown`/`readonly unknown[]` at the `core.ts` level
 * (00-architecture.md section 10's generic-Mission rationale) — this module
 * is the ONE place that actually populates them (`loadMissionDescriptor`
 * above), always with real `TerrainParams`/`AirportLayout` values, so
 * casting back to those concrete types here is safe by construction.
 */
export function buildWorldDependencies(mission: Mission): WorldDependencies {
  const terrainParams = mission.world.terrain as TerrainParams;
  const airportLayouts = mission.world.airports as readonly AirportLayout[];
  const flattenZones = airportLayouts.flatMap((a) => a.flattenZones);
  const sampler = createHeightSampler(terrainParams, flattenZones);
  const navDb = createAirportNavDb(airportLayouts);
  return {
    flightModel: flightModelAdapter,
    // A FRESH CombatPort per World, never a shared singleton: see
    // combatAdapter.ts's own `createCombatAdapter` doc comment — two World
    // instances sharing one CombatPort would alias each other's entities
    // whenever their EntityPools hand out the same (index, generation) id
    // independently, which they do (both start numbering from zeroed free
    // lists), corrupting ammo/lock/RNG state across otherwise-independent
    // sims (caught via tests/integration/determinism.test.ts).
    combat: createCombatAdapter(),
    createAiPilot: aiPilotAdapter,
    sampler,
    navDb,
  };
}
