/**
 * src/airport/renderGeometry.ts — composes runwayGeometry/taxiwayGeometry/
 * apronGeometry/lights over one AirportLayout (05-airport.md section 4.4).
 */

import type { AirportRenderGeometry, GenerateAirportRenderGeometry } from '../contracts/airport';
import { generateApronGeometry } from './apronGeometry';
import { generateAirportLights } from './lights';
import { generateRunwayGeometry } from './runwayGeometry';
import { generateTaxiwayGeometry } from './taxiwayGeometry';

export const generateAirportRenderGeometry: GenerateAirportRenderGeometry = (layout) => {
  const runways = layout.runways.map((r) => generateRunwayGeometry(r));
  const taxiways = layout.taxiways.map((t) => generateTaxiwayGeometry(t, layout.elevationM));
  const aprons = layout.aprons.map((a) => generateApronGeometry(a, layout.elevationM));
  const lights = generateAirportLights(layout);

  const result: AirportRenderGeometry = { airportId: layout.id, runways, taxiways, aprons, lights };
  return result;
};
