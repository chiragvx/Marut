/**
 * src/aircraft/tejasDefinition.ts — assembles the HAL Tejas Mk1
 * `AircraftDefinition`. Pure data, built once at module load, never
 * mutated. See docs/spec/03-tejas-data.md section 3.
 */
import type { AircraftDefinition } from '../contracts/aircraft';
import {
  massKg,
  emptyMassKg,
  maxFuelKg,
  inertiaBodyKgM2,
  cgOffsetBodyM,
  wingAreaM2,
  wingSpanM,
  meanChordM,
  hardpoints,
  gear,
  fcsLimits,
} from './tejasGeometry';
import { aero } from './tejasAeroTables';
import { engine } from './tejasEngineTables';
import wireframeJson from './tejasWireframe.json';
import type { WireframeModel } from './wireframeTypes';

const wireframe = wireframeJson as unknown as WireframeModel;

export const tejasDefinition: AircraftDefinition = {
  id: 'tejas-mk1',
  massKg,
  emptyMassKg,
  maxFuelKg,
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
