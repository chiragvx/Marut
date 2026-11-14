/**
 * src/aircraft/c17Definition.ts — the Boeing C-17A Globemaster III as a player-flyable
 * AircraftDefinition: four engines (`engines`), slats/flaps with externally blown flaps
 * (`highLift`), spoilers with ground lift dump (`spoilers`), a fuel/cargo mass model (`massModel`)
 * and a transport FCS. All flight data is in c17Data.ts with its sources.
 *
 * No weapons stations (self-protection flares only: IAF fit, AN/ALE-47 + AN/AAR-47 [P] DSCA; the
 * flare count is the pack's 120 [E], section 7). Drawn with the default model until the C-17 GLB is
 * wired to the renderer (renderModel absent).
 */
import type { AircraftDefinition } from '../contracts/aircraft';
import { tejasDefinition } from './tejasDefinition';
import {
  c17Aero,
  c17ContactPoints,
  c17EmptyMassKg,
  c17Engine,
  c17Engines,
  c17FcsLimits,
  c17Gear,
  c17HighLift,
  c17InertiaBodyKgM2,
  c17MassKg,
  c17MassModel,
  c17MaxFuelKg,
  c17MaxTakeoffMassKg,
  c17MeanChordM,
  c17Placards,
  c17Spoilers,
  c17WingAreaM2,
  c17WingSpanM,
} from './c17Data';

export const c17Definition: AircraftDefinition = {
  id: 'c-17',
  displayName: 'Boeing C-17A Globemaster III',
  stations: [],
  loadouts: [{ id: 'cargo', name: 'Cargo (no weapons)', fit: {} }],
  defaultLoadoutId: 'cargo',
  hardpoints: [],
  sensors: { iff: true, maws: true, countermeasures: { chaff: 0, flares: 120 } },
  // [E] a large transport: tens of m^2 nose-on, hundreds broadside; the hit ellipsoid spans the
  // fuselage length and the wing.
  signature: { rcsNoseOnM2: 40, rcsBroadsideM2: 200, hitEllipsoidBodyM: { x: 26.5, y: 4.5, z: 25.9 } },
  massKg: c17MassKg,
  emptyMassKg: c17EmptyMassKg,
  maxFuelKg: c17MaxFuelKg,
  maxTakeoffMassKg: c17MaxTakeoffMassKg,
  inertiaBodyKgM2: c17InertiaBodyKgM2,
  cgOffsetBodyM: { x: 0, y: 0, z: 0 },
  wingAreaM2: c17WingAreaM2,
  wingSpanM: c17WingSpanM,
  meanChordM: c17MeanChordM,
  // The placeholder wireframe (render fallback) is the Tejas's.
  wireframe: tejasDefinition.wireframe,
  aero: c17Aero,
  engine: c17Engine,
  engines: c17Engines,
  highLift: c17HighLift,
  spoilers: c17Spoilers,
  massModel: c17MassModel,
  placards: c17Placards,
  gear: c17Gear,
  fcsLimits: c17FcsLimits,
  airframeContactPointsBodyM: c17ContactPoints,
};
