/**
 * src/core/flightModelAdapter.ts — adapts module 02/03's real exports
 * (`stepAircraft`, `computeTelemetry`, the `tejasDefinition` registry) to
 * `FlightModelPort` (contracts/sim.ts section 3.3). See 10-core-worker.md
 * section 9 items 1-2.
 *
 * `computeTelemetry`: 10-core-worker.md section 9 item 2 flagged uncertainty
 * over whether module 02 would export a standalone telemetry function
 * (contracts/flight.ts's pinned skeleton only pins `StepAircraft`) and gave a
 * degraded fallback formula for that case. `src/physics/index.ts` DOES
 * export a real `computeTelemetry` (implementing `ComputeTelemetry`,
 * contracts/flight.ts), so this adapter uses it directly — the degraded
 * fallback never needs to run.
 */

import type { AircraftTelemetry, DamageState, EntityState, PilotInputs } from '../contracts/core';
import type { FlightModelPort, SimEnvironment } from '../contracts/sim';
import type { AircraftDefinition } from '../contracts/aircraft';
import type { Environment } from '../contracts/flight';
import { tejasDefinition } from '../aircraft';
import { stepAircraft, computeTelemetry as realComputeTelemetry } from '../physics';

const DEFINITIONS: Readonly<Record<string, AircraftDefinition>> = {
  [tejasDefinition.id]: tejasDefinition,
};

function toFlightEnvironment(env: SimEnvironment): Environment {
  // SimEnvironment (contracts/sim.ts) and Environment (contracts/flight.ts)
  // are field-for-field identical by design (10-core-worker.md section 3.3's
  // doc comment) — a straight structural pass-through, no copy needed.
  return env;
}

export const flightModelAdapter: FlightModelPort = {
  hasDefinition(aircraftDefId: string): boolean {
    return Object.prototype.hasOwnProperty.call(DEFINITIONS, aircraftDefId);
  },

  step(aircraftDefId: string, state: EntityState, damage: DamageState, inputs: PilotInputs, env: SimEnvironment, dtSec: number, out: EntityState): void {
    const def = DEFINITIONS[aircraftDefId];
    if (!def) throw new Error(`flightModelAdapter.step: unknown aircraftDefId '${aircraftDefId}'`);
    stepAircraft(state, damage, inputs, toFlightEnvironment(env), def, dtSec, out);
  },

  computeTelemetry(aircraftDefId: string, state: EntityState, damage: DamageState, env: SimEnvironment, out: AircraftTelemetry): void {
    const def = DEFINITIONS[aircraftDefId];
    if (!def) throw new Error(`flightModelAdapter.computeTelemetry: unknown aircraftDefId '${aircraftDefId}'`);
    realComputeTelemetry(state, def, toFlightEnvironment(env), damage, out);
  },

  maxFuelKg(aircraftDefId: string): number {
    const def = DEFINITIONS[aircraftDefId];
    return def ? def.maxFuelKg : 0;
  },

  dropTankLoad(aircraftDefId: string): { count: number; fuelKg: number } {
    const def = DEFINITIONS[aircraftDefId];
    if (!def || !def.dropTank) return { count: 0, fuelKg: 0 };
    let count = 0;
    for (const h of def.hardpoints) if (h.type === 'fuel_tank') count++;
    return { count, fuelKg: count * def.dropTank.capacityKg };
  },
};
