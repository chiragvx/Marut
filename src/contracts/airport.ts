/**
 * =============================================================================
 * TEJAS SIM — AIRPORT CONTRACT (docs/spec/contracts/airport.ts)
 * =============================================================================
 * Owner: module 05 (docs/spec/05-airport.md). Imports ONLY from './core'.
 * Contains interfaces, `as const` objects + derived unions, plain constants,
 * and bare function-signature type aliases (`export type Foo = (...) => Bar`).
 * NO class bodies, NO function bodies. Must compile standalone with
 * `tsc --noEmit --strict` alongside the other contracts/*.ts files.
 *
 * Full design rationale, worked numeric examples, and the two built-in
 * layouts' complete JSON live in docs/spec/05-airport.md — that document is
 * normative for anything this file's comments summarise tersely.
 * =============================================================================
 */

import type { Result, Vec3Like, AirportNavDb, RunwayInfo, IlsInfo } from './core';

// -----------------------------------------------------------------------------
// 1. Declarative JSON schema types (AirportLayout and its parts).
// -----------------------------------------------------------------------------

export const RunwaySurface = {
  Asphalt: 'asphalt',
  Concrete: 'concrete',
} as const;
export type RunwaySurface = (typeof RunwaySurface)[keyof typeof RunwaySurface];

export const ParkingSpotType = {
  Fighter: 'fighter',
  Transport: 'transport',
  Helicopter: 'helicopter',
} as const;
export type ParkingSpotType = (typeof ParkingSpotType)[keyof typeof ParkingSpotType];

/** A flat, 2-field world-plane point used by taxiway/apron polylines/polygons. Elevation for these features is always AirportLayout.elevationM (see 05-airport.md section 4.1). */
export interface WorldPoint2 {
  worldX: number;
  worldZ: number;
}

export interface IlsDef {
  /** MHz. Must satisfy ILS_FREQUENCY_MIN_MHZ..ILS_FREQUENCY_MAX_MHZ and be a multiple of 0.05 MHz (see 05-airport.md section 4.3). */
  frequencyMhz: number;
  /** Radians above horizontal. Omit to use core.ts's ILS_DEFAULT_GLIDESLOPE_RAD. Range if present: ILS_GLIDESLOPE_ANGLE_MIN_RAD..ILS_GLIDESLOPE_ANGLE_MAX_RAD. */
  glideslopeAngleRad?: number;
  /** Metres the localiser antenna sits beyond the FAR end of this runway direction (i.e. beyond the reciprocal threshold), measured along the extended centerline. Omit for ILS_LOCALISER_DEFAULT_OFFSET_M. */
  localiserOffsetBeyondFarEndM?: number;
  /** Metres downrange from THIS threshold, along the centerline, of the glideslope deviation-angle reference origin. Omit for ILS_GLIDESLOPE_DEFAULT_OFFSET_M. */
  glideslopeOffsetFromThresholdM?: number;
}

export interface RunwayLightsDef {
  edgeLights: boolean;
  thresholdLights: boolean;
  approachLights: boolean;
  papi: boolean;
}

/**
 * One threshold/direction of a physical runway strip. A two-way strip is
 * declared as TWO RunwayDef entries (e.g. id "09" and id "27") whose
 * `reciprocalId` fields point at each other; see 05-airport.md section 4.2
 * for the exact geometric consistency rules the validator enforces between
 * a reciprocal pair. A one-way strip omits `reciprocalId`.
 */
export interface RunwayDef {
  /** e.g. "09L". Unique among this layout's runways. */
  id: string;
  thresholdWorldX: number;
  thresholdWorldZ: number;
  /** MSL elevation at the threshold, m. */
  elevationM: number;
  /** Centerline heading FROM this threshold (direction of landing roll / takeoff), rad, world heading convention (00-architecture.md section 3.1). Matches core.ts RunwayInfo.headingRad exactly. */
  headingRad: number;
  lengthM: number;
  widthM: number;
  surface: RunwaySurface;
  /** id of the RunwayDef representing the opposite end of the SAME physical strip, if declared. */
  reciprocalId?: string;
  ils?: IlsDef;
  lights?: RunwayLightsDef;
}

export interface TaxiwayDef {
  id: string;
  widthM: number;
  /** Centerline polyline, world (x,z), >= 2 points, in traversal order. */
  points: readonly WorldPoint2[];
}

export interface ApronDef {
  id: string;
  /** Closed polygon, world (x,z), >= 3 points, winding order irrelevant, do NOT repeat the first point at the end. */
  points: readonly WorldPoint2[];
}

export interface ParkingSpotDef {
  id: string;
  worldX: number;
  worldZ: number;
  /** Nose-out heading, rad, world heading convention. */
  headingRad: number;
  type: ParkingSpotType;
}

/**
 * Terrain-flattening zone. EXACT shape fixed by 00-architecture.md section
 * 9.2 — module 04's HeightSampler consumes this same shape; do not add or
 * rename fields here.
 */
export interface AirportFlattenZone {
  centerWorldX: number;
  centerWorldZ: number;
  elevationM: number;
  flatRadiusM: number;
  blendRadiusM: number;
}

export interface AirportLayout {
  /** Must equal the JSON file's basename without extension, e.g. "rangpur-afb". */
  id: string;
  name: string;
  referenceWorldX: number;
  referenceWorldZ: number;
  /** MSL elevation of the airport's primary reference point, m. Also the elevation used for every taxiway/apron/parking-spot point (see section 4.1). */
  elevationM: number;
  flattenZones: readonly AirportFlattenZone[];
  runways: readonly RunwayDef[];
  taxiways: readonly TaxiwayDef[];
  aprons: readonly ApronDef[];
  parkingSpots: readonly ParkingSpotDef[];
}

// -----------------------------------------------------------------------------
// 2. Parse/validate error types and factory-function signatures.
// -----------------------------------------------------------------------------

export const AirportParseErrorCode = {
  NotAnObject: 'not_an_object',
  MissingField: 'missing_field',
  WrongType: 'wrong_type',
  EmptyArray: 'empty_array',
  InvalidEnumValue: 'invalid_enum_value',
} as const;
export type AirportParseErrorCode = (typeof AirportParseErrorCode)[keyof typeof AirportParseErrorCode];

export interface AirportParseError {
  stage: 'parse';
  code: AirportParseErrorCode;
  /** Dot/bracket JSON path from the document root, e.g. "runways[2].headingRad". */
  path: string;
  message: string;
}

export const AirportValidationErrorCode = {
  DuplicateId: 'duplicate_id',
  InvalidRunwayLength: 'invalid_runway_length',
  InvalidRunwayWidth: 'invalid_runway_width',
  ReciprocalNotFound: 'reciprocal_not_found',
  ReciprocalNotMutual: 'reciprocal_not_mutual',
  ReciprocalHeadingMismatch: 'reciprocal_heading_mismatch',
  ReciprocalDistanceMismatch: 'reciprocal_distance_mismatch',
  ReciprocalWidthMismatch: 'reciprocal_width_mismatch',
  FlattenZoneRadiusInvalid: 'flatten_zone_radius_invalid',
  RunwayNotFlattened: 'runway_not_flattened',
  RunwayElevationMismatch: 'runway_elevation_mismatch',
  IlsFrequencyOutOfRange: 'ils_frequency_out_of_range',
  IlsGlideslopeAngleOutOfRange: 'ils_glideslope_angle_out_of_range',
  TaxiwayTooFewPoints: 'taxiway_too_few_points',
  ApronTooFewPoints: 'apron_too_few_points',
  ParkingSpotOutsideApron: 'parking_spot_outside_apron',
} as const;
export type AirportValidationErrorCode = (typeof AirportValidationErrorCode)[keyof typeof AirportValidationErrorCode];

export interface AirportValidationError {
  stage: 'validate';
  code: AirportValidationErrorCode;
  /** 'error' entries make the layout unusable (Result.ok === false); 'warning' entries do not. */
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export type AirportIssue = AirportParseError | AirportValidationError;

/** Structural + type-level parse of raw JSON into an AirportLayout. Does NOT check semantic/geometric consistency (see ValidateAirportLayout). No allocation guarantees required (parsing is not a hot path). */
export type ParseAirportLayout = (json: unknown) => Result<AirportLayout, readonly AirportParseError[]>;

export interface AirportValidationOutcome {
  layout: AirportLayout;
  /** Only severity:'warning' entries; guaranteed empty of severity:'error' entries when Result.ok === true. */
  warnings: readonly AirportValidationError[];
}

/** Semantic/geometric validation of an already-parsed AirportLayout. See 05-airport.md section 4.2-4.3 for every rule. */
export type ValidateAirportLayout = (layout: AirportLayout) => Result<AirportValidationOutcome, readonly AirportValidationError[]>;

export interface AirportLoadResult {
  layout: AirportLayout;
  warnings: readonly AirportValidationError[];
}

/** Convenience composition of ParseAirportLayout then ValidateAirportLayout. This is what src/core calls when loading a Mission's airport JSON. */
export type LoadAirportLayout = (json: unknown) => Result<AirportLoadResult, readonly AirportIssue[]>;

// -----------------------------------------------------------------------------
// 3. Render geometry (line lists). Consumers (src/render, via src/core) import
//    ONLY the types in this section from src/contracts/airport.ts; the
//    generator FUNCTIONS below are implemented in src/airport and called by
//    src/core, which hands the resulting plain-data objects to src/render.
// -----------------------------------------------------------------------------

export interface LineSegmentSet {
  /** Even length; points[2i]/points[2i+1] form one line segment. World-frame, absolute float64 (consumer applies floating-origin rebase per 00-architecture.md section 7). No allocation contract implied on the TYPE; generator functions may allocate once per call (not a hot path — geometry is built once per loaded airport, not per tick). */
  points: readonly Vec3Like[];
}

export interface RunwayLineGeometry {
  runwayId: string;
  /** Closed rectangle, 4 segments, 8 points. */
  outline: LineSegmentSet;
  centerlineDashes: LineSegmentSet;
  thresholdBar: LineSegmentSet;
}

export interface TaxiwayLineGeometry {
  taxiwayId: string;
  /** Two parallel edge lines, built per-polyline-segment (no mitred joins; see 05-airport.md section 4.4). */
  edges: LineSegmentSet;
}

export interface ApronLineGeometry {
  apronId: string;
  /** Closed polygon outline, N segments, 2N points. */
  outline: LineSegmentSet;
}

export const LightKind = {
  RunwayEdge: 'runway_edge',
  RunwayThreshold: 'runway_threshold',
  ApproachLead: 'approach_lead',
  Papi: 'papi',
  TaxiwayEdge: 'taxiway_edge',
} as const;
export type LightKind = (typeof LightKind)[keyof typeof LightKind];

export const LightColor = {
  White: 'white',
  Red: 'red',
  Green: 'green',
  Amber: 'amber',
  Blue: 'blue',
} as const;
export type LightColor = (typeof LightColor)[keyof typeof LightColor];

export interface AirportLightPoint {
  pos: Vec3Like;
  kind: LightKind;
  /** Static hint. For kind === 'papi' this is a neutral placeholder ('white'); the live per-lamp colour is computed every frame by PapiColorAt, not baked into this geometry (see section 5). */
  colorHint: LightColor;
}

export interface AirportRenderGeometry {
  airportId: string;
  runways: readonly RunwayLineGeometry[];
  taxiways: readonly TaxiwayLineGeometry[];
  aprons: readonly ApronLineGeometry[];
  lights: readonly AirportLightPoint[];
}

export type GenerateRunwayGeometry = (runway: RunwayDef) => RunwayLineGeometry;
export type GenerateTaxiwayGeometry = (taxiway: TaxiwayDef, elevationM: number) => TaxiwayLineGeometry;
export type GenerateApronGeometry = (apron: ApronDef, elevationM: number) => ApronLineGeometry;
export type GenerateAirportLights = (layout: AirportLayout) => readonly AirportLightPoint[];
/** Composes GenerateRunwayGeometry/GenerateTaxiwayGeometry/GenerateApronGeometry/GenerateAirportLights over one AirportLayout. */
export type GenerateAirportRenderGeometry = (layout: AirportLayout) => AirportRenderGeometry;

// -----------------------------------------------------------------------------
// 4. Physics geometry: paved-surface friction regions.
// -----------------------------------------------------------------------------

export const SurfaceKind = {
  PavedRunway: 'paved_runway',
  PavedTaxiway: 'paved_taxiway',
  PavedApron: 'paved_apron',
} as const;
export type SurfaceKind = (typeof SurfaceKind)[keyof typeof SurfaceKind];

export interface SurfaceFriction {
  kind: SurfaceKind;
  /** Dimensionless rolling-resistance coefficient. */
  rollingCoeff: number;
  /** Dimensionless dry braking-friction coefficient (max achievable mu before skid/ABS). */
  brakingCoeff: number;
}

export interface AirportSurfaceIndex {
  /** Returns the paved surface at world (x,z), or undefined outside every declared paved region (caller falls back to its own off-airport/natural-terrain friction model — out of this module's scope). No allocation: implementations return a reference to one of 3 pre-built shared SurfaceFriction instances (one per SurfaceKind), never a fresh object per call — callers must treat the result as read-only. */
  frictionAt(worldX: number, worldZ: number): SurfaceFriction | undefined;
}
export type CreateAirportSurfaceIndex = (layout: AirportLayout) => AirportSurfaceIndex;

// -----------------------------------------------------------------------------
// 5. ILS deviation and PAPI.
// -----------------------------------------------------------------------------

export interface IlsDeviation {
  /** [-1,1]. + = aircraft is right of the localiser course. 0 when !valid. */
  locNormalized: number;
  /** [-1,1]. + = aircraft is above the nominal glidepath. 0 when !valid. */
  gsNormalized: number;
  /** false when the aircraft is outside the modelled reception cone/range (see the ILS_LOC_VALID_ and ILS_GS_VALID_ constants below); consumer should then treat the needles as flagged/off rather than centred. */
  valid: boolean;
}
/**
 * Writes into `out` and returns it (never allocates): src/core calls this
 * once per emitted Snapshot (SNAPSHOT_HZ = 60/s, inside the same cadence as
 * the fixed-step loop) to fill the Snapshot HUD block's ILS_LOC/ILS_GS
 * fields (writing 0,0 into the snapshot when !valid or no ILS tuned), so it
 * follows this project's "mutable out-param" hot-path convention.
 */
export type IlsDeviationAt = (aircraftPosWorld: Vec3Like, ils: IlsInfo, out: IlsDeviation) => IlsDeviation;

/** 4 lamps, index 0..3, ordered by ascending individual threshold angle (index 0 = lowest threshold = "reddest" lamp, turns white soonest when climbing above path; index 3 = highest threshold, stays red longest). On the nominal glidepath this is exactly [white,white,red,red]. See 05-airport.md section 4.6 for the full derivation. */
export interface PapiState {
  runwayId: string;
  colors: readonly [LightColor, LightColor, LightColor, LightColor];
}
/** Writes into `out` and returns it (never allocates: `out.colors`' 4 slots are overwritten in place). Returns undefined WITHOUT modifying `out` when runway.lights?.papi is not true. Called by src/hud once per rendered frame (a render hot path per 00-architecture.md section 2), hence the out-param. */
export type PapiColorAt = (runway: RunwayDef, observerPosWorld: Vec3Like, out: PapiState) => PapiState | undefined;

// -----------------------------------------------------------------------------
// 6. Nav database (extends core.ts's read-only AirportNavDb with the extra
//    queries this module's own consumers need; PilotContext.navDb is typed
//    as the narrower core.ts AirportNavDb, which this is structurally
//    assignable to).
// -----------------------------------------------------------------------------

export interface ApproachFix {
  /** e.g. "RW09L-FAF", "RW09L-IAF". */
  name: string;
  pos: Vec3Like;
  altitudeM: number;
}

export interface AirportNavDbExtended extends AirportNavDb {
  nearestRunway(pos: Vec3Like): { airportId: string; runway: RunwayInfo } | undefined;
  /** [] if the airport or runway id does not exist. Exactly 2 fixes when found: index 0 = FAF, index 1 = IAF (see section 4.7). */
  approachFixes(airportId: string, runwayId: string): readonly ApproachFix[];
}
/** Builds a queryable nav database from one or more already-VALIDATED AirportLayouts. THROWS (programmer-error class per 00-architecture.md "Error handling") if two layouts share the same `id` — that is a caller/mission-config bug, not ordinary bad data. */
export type CreateAirportNavDb = (layouts: readonly AirportLayout[]) => AirportNavDbExtended;

// -----------------------------------------------------------------------------
// 7. Constants. Every magic number used by this module's algorithms is named
//    here; nobody redefines these locally. Units in the name/comment.
// -----------------------------------------------------------------------------

export const ILS_LOCALISER_DEFAULT_OFFSET_M = 300;
export const ILS_GLIDESLOPE_DEFAULT_OFFSET_M = 300;
/** ICAO Annex 10-typical front-course azimuth half-angle, rad (35 deg). */
export const ILS_LOC_VALID_AZIMUTH_RAD = 0.610865;
/** ICAO Annex 10-typical localiser usable range, m (25 NM). */
export const ILS_LOC_VALID_RANGE_M = 46300;
/** ICAO Annex 10-typical glideslope azimuth half-angle, rad (8 deg). */
export const ILS_GS_VALID_AZIMUTH_RAD = 0.139626;
/** ICAO Annex 10-typical glideslope usable range, m (10 NM). */
export const ILS_GS_VALID_RANGE_M = 18520;

export const ILS_FREQUENCY_MIN_MHZ = 108.1;
export const ILS_FREQUENCY_MAX_MHZ = 111.95;
export const ILS_FREQUENCY_STEP_MHZ = 0.05;
export const ILS_GLIDESLOPE_ANGLE_MIN_RAD = 0.017453; // 1 deg
export const ILS_GLIDESLOPE_ANGLE_MAX_RAD = 0.069813; // 4 deg

/** Final approach fix altitude above threshold elevation, m (~1500 ft). */
export const APPROACH_FAF_ALT_AGL_M = 450;
/** Initial approach fix altitude above threshold elevation, m (~3000 ft). */
export const APPROACH_IAF_ALT_AGL_M = 900;

/** Angular offsets (rad) of the 4 PAPI lamp thresholds relative to the nominal glideslope angle: ±0.5 deg and ±1/6 deg, ascending. */
export const PAPI_LAMP_OFFSETS_RAD: readonly [number, number, number, number] = [-0.008727, -0.002909, 0.002909, 0.008727];
export const PAPI_ORIGIN_OFFSET_FROM_THRESHOLD_M = 150;
export const PAPI_LAMP_LATERAL_SPACING_M = 4;
export const PAPI_LATERAL_OFFSET_FROM_CENTERLINE_M = 12;

export const SURFACE_ROLLING_FRICTION_PAVED = 0.02;
export const SURFACE_BRAKING_FRICTION_PAVED_DRY = 0.6;

export const RUNWAY_LENGTH_MIN_M = 300;
export const RUNWAY_LENGTH_MAX_M = 6000;
export const RUNWAY_WIDTH_MIN_M = 15;
export const RUNWAY_WIDTH_MAX_M = 120;
export const RECIPROCAL_HEADING_TOLERANCE_RAD = 0.02;
export const RECIPROCAL_DISTANCE_TOLERANCE_M = 2;
export const RECIPROCAL_DISTANCE_TOLERANCE_FRAC = 0.005;
export const RUNWAY_ELEVATION_MATCH_TOLERANCE_M = 1.0;
export const RUNWAY_COVERAGE_SAMPLE_COUNT = 5;

export const CENTERLINE_DASH_LENGTH_M = 30;
export const CENTERLINE_DASH_GAP_M = 20;
export const THRESHOLD_BAR_STRIPE_COUNT = 8;
export const THRESHOLD_BAR_START_OFFSET_M = 5;
export const THRESHOLD_BAR_END_OFFSET_M = 15;
export const EDGE_LIGHT_SPACING_M = 60;
export const APPROACH_LIGHT_SPACING_M = 30;
export const APPROACH_LIGHT_RUN_M = 450;

export const TAXIWAY_MIN_POINTS = 2;
export const APRON_MIN_POINTS = 3;

/** The two built-in layouts' file paths, fixed by 00-architecture.md section 9.3. */
export const BUILTIN_AIRPORT_LAYOUT_PATHS: readonly [string, string] = [
  'src/airport/layouts/rangpur-afb.json',
  'src/airport/layouts/konarak-coastal.json',
];
