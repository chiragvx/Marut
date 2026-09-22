/**
 * src/ui/airportEditorGameLayout.ts — converts the airport editor's local
 * `EditorAirportLayout` (contracts/ui.ts) into the real `AirportLayout`
 * shape the game's airport loader (contracts/airport.ts's
 * ParseAirportLayout / ValidateAirportLayout / LoadAirportLayout,
 * implemented by src/airport) actually accepts.
 *
 * contracts/ui.ts section 5's note on `EditorAirportLayoutExport` flags that
 * reconciling the editor's local field names with contracts/airport.ts's
 * real schema was left as an integration-time task. This file does that
 * reconciliation using ONLY types/const values imported from
 * src/contracts/airport.ts (never from src/airport/* itself) so it stays
 * inside 00-architecture.md section 10's dependency rule that src/ui may
 * import from src/contracts/* only, never another leaf module's src/*.
 *
 * src/core (module 10) is expected to call `toGameAirportLayout` from the
 * airport editor's "Test Fly" handler (`AirportEditorCallbacks.
 * onLaunchMission`), then feed the result through `parseAirportLayout` +
 * `validateAirportLayout` (or the composed `loadAirportLayout`) from
 * src/airport before starting a mission at that layout — see
 * tests/ui/airportEditorGameLayout.test.ts, which round-trips this exact
 * conversion through the real loader.
 */
import type { EditorAirportLayout, EditorRunway } from '../contracts/ui';
import type { AirportFlattenZone, AirportLayout, ApronDef, RunwayDef, TaxiwayDef } from '../contracts/airport';
import { RunwaySurface } from '../contracts/airport';
import { computeFlattenZones, runwayDesignator } from './airportEditorGeometry';

/** (sin h, -cos h) world X/Z — forwardWorld() from 00-architecture.md section 3.1. */
function forwardXZ(headingRad: number): { xM: number; zM: number } {
  return { xM: Math.sin(headingRad), zM: -Math.cos(headingRad) };
}

function wrap0to2pi(rad: number): number {
  const twoPi = Math.PI * 2;
  return ((rad % twoPi) + twoPi) % twoPi;
}

/**
 * Expands one physical EditorRunway (one record, two named ends) into the
 * two RunwayDef entries contracts/airport.ts actually wants — one per
 * threshold, linked by `reciprocalId`. `r.headingRad` is, per EditorRunway's
 * own doc comment, "heading of the PRIMARY end's approach/landing
 * direction" — i.e. exactly RunwayDef's "centerline heading FROM this
 * threshold" for the primary record, so the primary threshold sits at
 * `center - forward*halfLength` (the point that heading is measured FROM)
 * and the reciprocal threshold at `center + forward*halfLength`.
 */
function toRunwayDefs(r: EditorRunway): readonly [RunwayDef, RunwayDef] {
  const fwd = forwardXZ(r.headingRad);
  const halfLenM = r.lengthM / 2;
  const primaryId = `${r.id}-${runwayDesignator(r.headingRad)}`;
  const reciprocalId = `${r.id}-${runwayDesignator(r.headingRad + Math.PI)}`;

  const primary: RunwayDef = {
    id: primaryId,
    thresholdWorldX: r.centerXM - fwd.xM * halfLenM,
    thresholdWorldZ: r.centerZM - fwd.zM * halfLenM,
    elevationM: r.elevationM,
    headingRad: r.headingRad,
    lengthM: r.lengthM,
    widthM: r.widthM,
    surface: RunwaySurface.Asphalt,
    reciprocalId,
  };
  const reciprocal: RunwayDef = {
    id: reciprocalId,
    thresholdWorldX: r.centerXM + fwd.xM * halfLenM,
    thresholdWorldZ: r.centerZM + fwd.zM * halfLenM,
    elevationM: r.elevationM,
    headingRad: wrap0to2pi(r.headingRad + Math.PI),
    lengthM: r.lengthM,
    widthM: r.widthM,
    surface: RunwaySurface.Asphalt,
    reciprocalId: primaryId,
  };
  if (r.ilsPrimary !== undefined) {
    primary.ils = { frequencyMhz: r.ilsPrimary.frequencyMhz, glideslopeAngleRad: r.ilsPrimary.glideslopeAngleRad };
  }
  if (r.ilsReciprocal !== undefined) {
    reciprocal.ils = { frequencyMhz: r.ilsReciprocal.frequencyMhz, glideslopeAngleRad: r.ilsReciprocal.glideslopeAngleRad };
  }
  return [primary, reciprocal];
}

/**
 * `EditorAirportLayout` -> `AirportLayout`. Pure; allocates a fresh object
 * (not a hot path — runs once per "Test Fly" click / editor-authored
 * mission load, never per sim tick).
 */
export function toGameAirportLayout(layout: EditorAirportLayout): AirportLayout {
  const runways: RunwayDef[] = [];
  for (const r of layout.runways) {
    const [primary, reciprocal] = toRunwayDefs(r);
    runways.push(primary, reciprocal);
  }

  const taxiways: TaxiwayDef[] = layout.taxiways.map((t) => ({
    id: t.id,
    widthM: t.widthM,
    points: t.points.map((p) => ({ worldX: p.xM, worldZ: p.zM })),
  }));

  const aprons: ApronDef[] = layout.aprons.map((a) => ({
    id: a.id,
    points: a.points.map((p) => ({ worldX: p.xM, worldZ: p.zM })),
  }));

  // EditorFlattenZone mirrors AirportFlattenZone field-for-field (contracts/ui.ts's own
  // doc comment), so this map is a straight re-typing, not a field reconciliation.
  const flattenZones: AirportFlattenZone[] = computeFlattenZones(layout).map((z) => ({
    centerWorldX: z.centerWorldX,
    centerWorldZ: z.centerWorldZ,
    elevationM: z.elevationM,
    flatRadiusM: z.flatRadiusM,
    blendRadiusM: z.blendRadiusM,
  }));

  return {
    id: layout.id,
    name: layout.name,
    referenceWorldX: layout.referenceXM,
    referenceWorldZ: layout.referenceZM,
    elevationM: layout.elevationM,
    flattenZones,
    runways,
    taxiways,
    aprons,
    parkingSpots: [],
  };
}
