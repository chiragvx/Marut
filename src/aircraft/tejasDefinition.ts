/**
 * src/aircraft/tejasDefinition.ts — assembles the HAL Tejas Mk1A
 * `AircraftDefinition` (airframe and flight data from the Mk1; stations,
 * loadouts, sensors and signature per the Mk1A). Pure data, built once at module load, never
 * mutated. See docs/spec/03-tejas-data.md section 3.
 */
import type { AircraftDefinition } from '../contracts/aircraft';
import {
  massKg,
  emptyMassKg,
  maxFuelKg,
  dropTank,
  inertiaBodyKgM2,
  cgOffsetBodyM,
  wingAreaM2,
  wingSpanM,
  meanChordM,
  hardpoints,
  gear,
  fcsLimits,
  stations,
  loadouts,
  defaultLoadoutId,
  sensors,
  signature,
} from './tejasGeometry';
import { aero } from './tejasAeroTables';
import { engine } from './tejasEngineTables';
import wireframeJson from './tejasWireframe.json';
import type { WireframeModel } from './wireframeTypes';

const wireframe = wireframeJson as unknown as WireframeModel;

export const tejasDefinition: AircraftDefinition = {
  id: 'tejas-mk1a',
  displayName: 'HAL Tejas Mk1A',
  stations,
  loadouts,
  defaultLoadoutId,
  sensors,
  signature,
  massKg,
  emptyMassKg,
  maxFuelKg,
  dropTank,
  inertiaBodyKgM2,
  cgOffsetBodyM,
  wingAreaM2,
  wingSpanM,
  meanChordM,
  hardpoints,
  wireframe,
  aero,
  engine,
  gear,
  fcsLimits,
};
