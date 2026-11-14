/**
 * src/airport/surfaces.ts — paved vs unpaved surfaces (contracts/airport.ts RunwaySurface).
 */
import { RunwaySurface } from '../contracts/airport';

/** True for dirt and gravel; absent (taxiways, aprons) or asphalt/concrete is paved. */
export function isUnpaved(surface: RunwaySurface | undefined): boolean {
  return surface === RunwaySurface.Dirt || surface === RunwaySurface.Gravel;
}
