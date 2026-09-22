/**
 * src/airport/schema.ts — re-exports the JSON-schema TS types from
 * ../contracts/airport (no new public shapes beyond the contract), plus a
 * small local helper type parser.ts uses while walking untrusted JSON.
 */

export type {
  WorldPoint2,
  IlsDef,
  RunwayLightsDef,
  RunwayDef,
  TaxiwayDef,
  ApronDef,
  ParkingSpotDef,
  AirportFlattenZone,
  AirportLayout,
} from '../contracts/airport';
export { RunwaySurface, ParkingSpotType } from '../contracts/airport';

/** Dot/bracket JSON path accumulated while descending into an `unknown` document, e.g. "runways[2].headingRad". */
export type JsonPath = string;
