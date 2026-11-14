/**
 * src/aircraft/massModel.ts — the CG of a mass-model aircraft (the C-17) for a fuel and cargo load,
 * as a fraction of the mean aerodynamic chord: what the load planner shows against the envelope.
 * The flight model's own bookkeeping (physics/integrator.ts cgOffsetBodyX) uses the same weights.
 */
import type { AircraftDefinition } from '../contracts/aircraft';

/**
 * CG, fraction of MAC aft of its leading edge, for `fuelKg` of fuel and `cargoKg` of cargo (at
 * `cargoCgBodyX`, default the hold's centroid). Forward of the reference CG (positive body x) is
 * a smaller fraction. Undefined without MassModelDefinition.referenceCgMac.
 */
export function cgMacFraction(def: Pick<AircraftDefinition, 'emptyMassKg' | 'massModel' | 'meanChordM'>, fuelKg: number, cargoKg = 0, cargoCgBodyX?: number): number | undefined {
  const mm = def.massModel;
  if (!mm || mm.referenceCgMac === undefined || !(def.meanChordM > 0)) return undefined;
  const mass = def.emptyMassKg + fuelKg + cargoKg;
  const dx = (def.emptyMassKg * mm.emptyCgBodyX + fuelKg * mm.fuelCgBodyX + cargoKg * (cargoCgBodyX ?? mm.cargoCgBodyX)) / mass;
  return mm.referenceCgMac - dx / def.meanChordM;
}
