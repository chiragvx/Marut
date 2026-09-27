/**
 * src/aircraft/index.ts — barrel re-export. `tejasDefinition` is the ONE
 * runtime value every other module imports from this module (see
 * docs/spec/03-tejas-data.md section 2).
 */
export { tejasDefinition } from './tejasDefinition';
export { getAircraftDefinition, listAircraftDefinitions, getLoadout } from './registry';
export { resolveLoadout, sanitizeFit, loadoutTanks, loadoutMassKg, stationChoices, storeName, isBuiltStore, CUSTOM_LOADOUT_ID, type LoadoutFit, type TankLoad, type StationChoice } from './loadout';
