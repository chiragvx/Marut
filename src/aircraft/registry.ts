/**
 * src/aircraft/registry.ts — every flyable aircraft type by id. Add a new aircraft by adding its
 * definition here (aero/engine tables, geometry, stations, loadouts, sensors, signature).
 */
import type { AircraftDefinition, LoadoutPreset } from '../contracts/aircraft';
import { tejasDefinition } from './tejasDefinition';
import { f16Definition, jf17Definition } from './aggressors';

const DEFINITIONS: Readonly<Record<string, AircraftDefinition>> = {
  [tejasDefinition.id]: tejasDefinition,
  [jf17Definition.id]: jf17Definition,
  [f16Definition.id]: f16Definition,
};

/** Older ids still accepted (missions and saves from before the Mk1A). */
const ALIASES: Readonly<Record<string, string>> = {
  'tejas-mk1': 'tejas-mk1a',
};

export function getAircraftDefinition(id: string): AircraftDefinition | undefined {
  return DEFINITIONS[id] ?? DEFINITIONS[ALIASES[id] ?? ''];
}

export function listAircraftDefinitions(): readonly AircraftDefinition[] {
  return Object.values(DEFINITIONS);
}

/** The aircraft's loadout by id, else its default, else its first. */
export function getLoadout(def: AircraftDefinition, loadoutId?: string): LoadoutPreset | undefined {
  const all = def.loadouts ?? [];
  return all.find((l) => l.id === loadoutId) ?? all.find((l) => l.id === def.defaultLoadoutId) ?? all[0];
}
