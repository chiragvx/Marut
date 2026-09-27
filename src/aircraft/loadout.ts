/**
 * src/aircraft/loadout.ts — the player's store fit: a preset, or a custom fit chosen per station.
 *
 * A custom fit is checked against the aircraft's stations: each station takes only the stores in
 * its `accepts` list that the game has built (catalogue weapons and fuel tanks), and at most its
 * `maxCount`. Anything else is dropped, so a stale or hand-edited fit can never produce an
 * impossible aircraft. The gun always keeps its default load.
 */
import type { AircraftDefinition, LoadoutPreset } from '../contracts/aircraft';
import { FUEL_TANKS, WEAPONS } from '../catalog';
import { getLoadout } from './registry';

export type LoadoutFit = LoadoutPreset['fit'];

/** Id of a resolved custom fit. */
export const CUSTOM_LOADOUT_ID = 'custom';

/** A store the game can draw and simulate (a catalogue weapon or fuel tank). */
export function isBuiltStore(id: string): boolean {
  return WEAPONS[id] !== undefined || FUEL_TANKS[id] !== undefined;
}

/** Display name of a store. */
export function storeName(id: string): string {
  return WEAPONS[id]?.name ?? FUEL_TANKS[id]?.name ?? id;
}

/** `fit` with every entry the aircraft cannot carry removed, and the gun's default load kept. */
export function sanitizeFit(def: AircraftDefinition, fit: LoadoutFit): Record<string, { store: string; count: number }> {
  const out: Record<string, { store: string; count: number }> = {};
  const base = getLoadout(def);
  for (const st of def.stations ?? []) {
    if (!st.accepts.some((a) => WEAPONS[a]?.kind !== 'gun')) {
      // A gun station: always its default load.
      const g = base?.fit[st.id];
      if (g) out[st.id] = { ...g };
      continue;
    }
    const f = fit[st.id];
    if (!f || !st.accepts.includes(f.store) || !isBuiltStore(f.store)) continue;
    const count = Math.min(st.maxCount, Math.floor(f.count));
    if (count >= 1) out[st.id] = { store: f.store, count };
  }
  return out;
}

/**
 * The fit an aircraft flies with: a custom fit (validated) when given, else the preset `loadoutId`,
 * else the aircraft's default.
 */
export function resolveLoadout(def: AircraftDefinition, loadoutId?: string, custom?: LoadoutFit): LoadoutPreset | undefined {
  if (custom) return { id: CUSTOM_LOADOUT_ID, name: 'Custom', fit: sanitizeFit(def, custom) };
  return getLoadout(def, loadoutId);
}

export interface TankLoad {
  count: number;
  /** Fuel in all tanks when full, kg. */
  fuelKg: number;
  /** Empty tanks' mass, kg, and drag area, m^2 (all tanks). */
  shellKg: number;
  dragAreaM2: number;
}

/** The drop tanks in a fit (FUEL_TANKS stores), full. */
export function loadoutTanks(preset: LoadoutPreset | undefined): TankLoad {
  const t: TankLoad = { count: 0, fuelKg: 0, shellKg: 0, dragAreaM2: 0 };
  if (!preset) return t;
  for (const f of Object.values(preset.fit)) {
    const tank = f ? FUEL_TANKS[f.store] : undefined;
    if (!tank || !f) continue;
    t.count += f.count;
    t.fuelKg += f.count * tank.capacityKg;
    t.shellKg += f.count * tank.emptyMassKg;
    t.dragAreaM2 += f.count * tank.dragAreaM2;
  }
  return t;
}

/** Mass the fit adds to the clean aircraft, kg: weapons as carried, tanks full. */
export function loadoutMassKg(preset: LoadoutPreset | undefined): number {
  if (!preset) return 0;
  let kg = 0;
  for (const f of Object.values(preset.fit)) {
    if (!f) continue;
    const w = WEAPONS[f.store];
    if (w && w.kind !== 'gun') kg += f.count * w.carriageMassKg;
    const tank = FUEL_TANKS[f.store];
    if (tank) kg += f.count * (tank.capacityKg + tank.emptyMassKg);
  }
  return kg;
}

export interface StationChoice {
  stationId: string;
  /** Stores this station can carry that the game has built. */
  stores: readonly string[];
  maxCount: number;
}

/** The choices for each store station (the gun excluded), in the aircraft's station order. */
export function stationChoices(def: AircraftDefinition): StationChoice[] {
  return (def.stations ?? [])
    .map((st) => ({ stationId: st.id, stores: st.accepts.filter((a) => isBuiltStore(a) && WEAPONS[a]?.kind !== 'gun'), maxCount: st.maxCount }))
    .filter((c) => c.stores.length > 0);
}
