# 05 — Airport Layouts

Read `docs/spec/00-architecture.md` and `docs/spec/contracts/core.ts` in full before this document; they are law. Where anything below appears to conflict with either, those two documents win — see section 9 for the one place this happened during drafting (flatten *zones*, not the general brief's "flatten polygon").

## 1. Purpose & scope

This module owns everything about **declarative airport layouts**: the JSON schema, the parser and validator that turn untrusted JSON into a typed, semantically-consistent `AirportLayout`, geometry generation for both rendering (line lists) and physics (paved-surface friction regions), ILS localiser/glideslope deviation math, PAPI light-colour math, a queryable nav database, and the two built-in layouts (`rangpur-afb`, `konarak-coastal`) whose file paths and general character are fixed by `00-architecture.md` section 9.3.

This module does **not** build the in-browser 2D airport editor (that is module 11, `src/ui/airportEditor.ts`) — module 11 imports this module's **types only**, via `src/contracts/airport.ts`, and produces/consumes plain JSON text matching the schema in section 3. This module does not touch Three.js, the DOM, or any rendering call — it only produces plain-data geometry (`LineSegmentSet` etc.) that `src/core` hands to `src/render`/`src/hud`.

Everything in `src/airport` is DOM-free, importable under Node, and deterministic: for a fixed `AirportLayout`, every function in this module is a pure function of its inputs (no `Math.random()`, no wall-clock reads, no allocation in the two functions explicitly marked hot-path in the contract).

## 2. Owned files

| path | purpose |
|---|---|
| `src/airport/schema.ts` | Re-exports the JSON schema's TS types from `../contracts/airport` and any purely-local helper types the parser needs (e.g. an internal "path" accumulator type). No new public shapes beyond the contract. |
| `src/airport/parser.ts` | `parseAirportLayout` (`ParseAirportLayout`): structural/type parse of `unknown` JSON into `AirportLayout`. |
| `src/airport/validator.ts` | `validateAirportLayout` (`ValidateAirportLayout`): semantic/geometric validation of an already-parsed `AirportLayout`. Also exports `loadAirportLayout` (`LoadAirportLayout`), the parse-then-validate convenience `src/core` actually calls. |
| `src/airport/runwayGeometry.ts` | `generateRunwayGeometry` (`GenerateRunwayGeometry`): outline/centerline-dashes/threshold-bar line lists for one runway. |
| `src/airport/taxiwayGeometry.ts` | `generateTaxiwayGeometry` (`GenerateTaxiwayGeometry`). |
| `src/airport/apronGeometry.ts` | `generateApronGeometry` (`GenerateApronGeometry`). |
| `src/airport/lights.ts` | `generateAirportLights` (`GenerateAirportLights`) and `papiColorAt` (`PapiColorAt`). |
| `src/airport/renderGeometry.ts` | `generateAirportRenderGeometry` (`GenerateAirportRenderGeometry`): composes the four generators above over one layout. |
| `src/airport/surfaceIndex.ts` | `createAirportSurfaceIndex` (`CreateAirportSurfaceIndex`): paved-region friction lookup for landing-gear physics. |
| `src/airport/ils.ts` | `ilsDeviation` (`IlsDeviationAt`): localiser/glideslope deviation math. |
| `src/airport/navDb.ts` | `createAirportNavDb` (`CreateAirportNavDb`): implements `AirportNavDbExtended` (and therefore core.ts's `AirportNavDb`) over one or more validated layouts. |
| `src/airport/layouts/rangpur-afb.json` | Built-in layout 1 (inland/plateau, single long runway, mountainous surroundings). Full content: section 5.3. |
| `src/airport/layouts/konarak-coastal.json` | Built-in layout 2 (coastal, sea level, parallel runways, ILS over water). Full content: section 5.4. |
| `src/airport/index.ts` | Barrel re-export of every function above plus the contract's types. |

## 3. Public API

Every exported function below has its full, contract-exact signature in `docs/spec/contracts/airport.ts`; this section restates each one with the file that implements it. Do not change a signature here without changing the contract — the contract is what the other 11 modules compile against.

```ts
// src/airport/parser.ts
export const parseAirportLayout: ParseAirportLayout;
// (json: unknown) => Result<AirportLayout, readonly AirportParseError[]>

// src/airport/validator.ts
export const validateAirportLayout: ValidateAirportLayout;
// (layout: AirportLayout) => Result<AirportValidationOutcome, readonly AirportValidationError[]>
export const loadAirportLayout: LoadAirportLayout;
// (json: unknown) => Result<AirportLoadResult, readonly AirportIssue[]>
// loadAirportLayout(json) is EXACTLY:
//   const p = parseAirportLayout(json);
//   if (!p.ok) return { ok: false, error: p.value /* AirportParseError[] tagged stage:'parse' */ };
//   const v = validateAirportLayout(p.value);
//   if (!v.ok) return { ok: false, error: v.error };
//   return { ok: true, value: { layout: v.value.layout, warnings: v.value.warnings } };

// src/airport/runwayGeometry.ts
export const generateRunwayGeometry: GenerateRunwayGeometry; // (runway: RunwayDef) => RunwayLineGeometry

// src/airport/taxiwayGeometry.ts
export const generateTaxiwayGeometry: GenerateTaxiwayGeometry; // (taxiway: TaxiwayDef, elevationM: number) => TaxiwayLineGeometry

// src/airport/apronGeometry.ts
export const generateApronGeometry: GenerateApronGeometry; // (apron: ApronDef, elevationM: number) => ApronLineGeometry

// src/airport/lights.ts
export const generateAirportLights: GenerateAirportLights; // (layout: AirportLayout) => readonly AirportLightPoint[]
export const papiColorAt: PapiColorAt; // (runway: RunwayDef, observerPosWorld: Vec3Like, out: PapiState) => PapiState | undefined

// src/airport/renderGeometry.ts
export const generateAirportRenderGeometry: GenerateAirportRenderGeometry; // (layout: AirportLayout) => AirportRenderGeometry

// src/airport/surfaceIndex.ts
export const createAirportSurfaceIndex: CreateAirportSurfaceIndex; // (layout: AirportLayout) => AirportSurfaceIndex

// src/airport/ils.ts
export const ilsDeviation: IlsDeviationAt; // (aircraftPosWorld: Vec3Like, ils: IlsInfo, out: IlsDeviation) => IlsDeviation

// src/airport/navDb.ts
export const createAirportNavDb: CreateAirportNavDb; // (layouts: readonly AirportLayout[]) => AirportNavDbExtended
```

`src/core` is the only consumer that calls any of these at runtime (per `00-architecture.md` section 10's dependency graph): it calls `loadAirportLayout` for every airport in the active `Mission.world.airports`, feeds the resulting `AirportLayout[]` into `createAirportNavDb` to build the `AirportNavDb` instance injected into every `PilotContext`, calls `generateAirportRenderGeometry` once per loaded airport and hands the result to `src/render`, optionally calls `createAirportSurfaceIndex` if it wires paved-friction data into gear physics (see section 9, "cross-module gap"), and calls `ilsDeviation` each emitted snapshot to fill `SnapshotHud.ILS_LOC`/`ILS_GS`.

## 4. Design & algorithms

### 4.1 Schema shape and the "elevation is flat per airport" simplification

`AirportLayout` (full shape in `contracts/airport.ts` section 1) declares: identity (`id`/`name`), a reference point (`referenceWorldX/Z`, `elevationM`), `flattenZones: readonly AirportFlattenZone[]` (the **exact** shape `00-architecture.md` section 9.2 fixes — circular zones, not a polygon; see section 9 below for why this document does not follow the general brief's looser "flatten polygon" phrasing), `runways`, `taxiways`, `aprons`, `parkingSpots`.

Every `TaxiwayDef`/`ApronDef`/`ParkingSpotDef` point is 2D (`worldX`,`worldZ`) — its elevation is always `AirportLayout.elevationM`. This is a deliberate simplification: real taxiway/apron complexes have gentle grading, but modelling per-point elevation would require every hand-authored layout (and the 2D top-down editor) to track a third coordinate nobody can usefully edit in a top-down view. Runways are the exception: each `RunwayDef` has its **own** `elevationM` (matching core.ts `RunwayInfo.elevationM`, "MSL elevation at the threshold"), because a runway's two ends legitimately sit at different elevations on a sloped strip, and this elevation is what the validator cross-checks against `flattenZones` (section 4.3).

### 4.2 Runway declaration: one `RunwayDef` per threshold/direction

A two-way physical strip is declared as **two** `RunwayDef` records — e.g. `id: "09"` and `id: "27"` — each with its own threshold position and its own `headingRad` (the heading you fly *away from* that threshold, matching core.ts `RunwayInfo.headingRad`'s doc comment exactly), linked by `reciprocalId`. This makes the parser's job trivial (each `RunwayDef` maps 1:1 to one `RunwayInfo` the nav database serves — no derivation, no pairing logic in the hot parse path) and pushes all the "do these two records actually describe the same physical strip" checking into the validator, where it belongs.

Given `RunwayDef.headingRad = h`, the along-runway unit vector is `d = forwardWorld(h) = (sin(h), 0, -cos(h))` (00-architecture.md section 3.1) and the "right of centerline" unit vector, used throughout this module, is

```
right(h) = (cos(h), 0, sin(h))
```

(derived directly from `forwardWorld(h + PI/2)`; verify: `right(0) = (1,0,0)` = east = right of due-north, matching "heading increases clockwise" — flying north, east is to your right ✓).

A one-way strip (rare — e.g. a displaced/closed reciprocal end) omits `reciprocalId` and is validated alone.

### 4.3 Validator — the exact, ordered rule list

`validateAirportLayout` runs every rule below over an already-**parsed** (type-correct) `AirportLayout` and collects every `AirportValidationError` it finds (it does not stop at the first). `Result.ok === true` iff no collected issue has `severity: 'error'`; `AirportValidationOutcome.warnings` then holds exactly the `severity: 'warning'` issues (guaranteed no errors present). On failure, `error` is the full collected array (errors **and** warnings, so a caller can log everything found in one pass).

1. **`duplicate_id`** (error) — within `runways`, within `taxiways`, within `aprons`, within `parkingSpots` (four independent namespaces — a runway id may equal a taxiway id without conflict), every `.id` must be unique. `path`: `"runways[<i>].id"` etc.
2. **`invalid_runway_length`** (error) — `lengthM` must satisfy `RUNWAY_LENGTH_MIN_M (300) <= lengthM <= RUNWAY_LENGTH_MAX_M (6000)`.
3. **`invalid_runway_width`** (error) — `RUNWAY_WIDTH_MIN_M (15) <= widthM <= RUNWAY_WIDTH_MAX_M (120)`.
4. **`reciprocal_not_found`** (error) — if `reciprocalId` is set, a `RunwayDef` with that `id` must exist in this layout.
5. **`reciprocal_not_mutual`** (error) — if runway A's `reciprocalId === B.id`, then `B.reciprocalId` must `=== A.id` (both sides must reference each other).
6. **`reciprocal_heading_mismatch`** (error) — `|wrapToPi(A.headingRad - (B.headingRad - PI))| <= RECIPROCAL_HEADING_TOLERANCE_RAD (0.02 rad, ≈1.15°)`, where `wrapToPi(x)` wraps `x` into `[-PI, PI]`.
7. **`reciprocal_distance_mismatch`** (error) — let `distXZ = hypot(A.thresholdWorldX - B.thresholdWorldX, A.thresholdWorldZ - B.thresholdWorldZ)`. Both `|distXZ - A.lengthM| <= tol` and `|distXZ - B.lengthM| <= tol` must hold, `tol = max(RECIPROCAL_DISTANCE_TOLERANCE_M (2), RECIPROCAL_DISTANCE_TOLERANCE_FRAC (0.005) * A.lengthM)`.
8. **`reciprocal_width_mismatch`** (error) — `A.widthM === B.widthM` exactly (both ends of one strip are the same pavement).
9. **`flatten_zone_radius_invalid`** (error) — every `AirportFlattenZone` must have `flatRadiusM > 0` and `blendRadiusM >= 0`.
10. **`runway_not_flattened`** (error) — for each runway, sample `RUNWAY_COVERAGE_SAMPLE_COUNT` (5) points at `t = 0, 0.25, 0.5, 0.75, 1.0` along `threshold + d*t*lengthM`; each sample must be **within `flatRadiusM` of at least one zone** — `layout.flattenZones.some(zone => hypot(sample.x - zone.centerWorldX, sample.z - zone.centerWorldZ) <= zone.flatRadiusM)`. This is an existential check ("covered by *some* zone"), **not** "covered by the *nearest* zone" — a sample can legitimately be geometrically closer to a small zone's center while still being covered only by a larger, farther zone (as both built-in layouts' runway/apron zone pairs are), so the nearest-by-raw-distance zone must never be the sole zone tested. One error per failing sample, `path`: `"runways[<i>].centerline[t=<t>]"`.
11. **`runway_elevation_mismatch`** (error) — among the zones that satisfy rule 10's coverage test for the `t=0` sample (there is always at least one, else rule 10 already fired), take the one with the smallest `hypot(...)` distance to the threshold — call it the *covering zone* — and require `|runway.elevationM - covering zone.elevationM| <= RUNWAY_ELEVATION_MATCH_TOLERANCE_M (1.0)`. Skipped for a runway whose `t=0` sample failed rule 10 (no covering zone exists to compare against).
12. **`ils_frequency_out_of_range`** (error) — if `ils` is present: `ILS_FREQUENCY_MIN_MHZ (108.10) <= frequencyMhz <= ILS_FREQUENCY_MAX_MHZ (111.95)` **and** `round(frequencyMhz / ILS_FREQUENCY_STEP_MHZ)` (i.e. `frequencyMhz / 0.05`) is within `1e-6` of an integer.
13. **`ils_glideslope_angle_out_of_range`** (error) — if `ils.glideslopeAngleRad` is present: `ILS_GLIDESLOPE_ANGLE_MIN_RAD (0.017453) <= x <= ILS_GLIDESLOPE_ANGLE_MAX_RAD (0.069813)`.
14. **`taxiway_too_few_points`** (error) — `points.length >= TAXIWAY_MIN_POINTS (2)`.
15. **`apron_too_few_points`** (error) — `points.length >= APRON_MIN_POINTS (3)`.
16. **`parking_spot_outside_apron`** (**warning**) — the spot's `(worldX, worldZ)` must be inside at least one apron polygon (point-in-polygon test, section 4.5); if not, a warning (not an error — an editor user may legitimately place a spot on a taxiway hardstand with no declared apron).

Rules 1–15 are `severity: 'error'`; rule 16 is `severity: 'warning'`. This is the complete, ordered rule list — no other numeric range or cross-reference is checked, and no rule beyond these sixteen exists.

### 4.4 Render geometry generation

**Runway** (`generateRunwayGeometry`): with `d = forwardWorld(headingRad)`, `right = right(headingRad)`, `halfWidth = widthM / 2`, threshold `T = (thresholdWorldX, elevationM, thresholdWorldZ)`:

```
c0 = T - right*halfWidth
c1 = T + right*halfWidth
c2 = T + d*lengthM + right*halfWidth
c3 = T + d*lengthM - right*halfWidth
outline.points = [c0,c1, c1,c2, c2,c3, c3,c0]                       // 8 points, closed rectangle
```

`centerlineDashes`: for `s = 0, (DASH+GAP), 2*(DASH+GAP), ...` while `s < lengthM` (`DASH = CENTERLINE_DASH_LENGTH_M` (30), `GAP = CENTERLINE_DASH_GAP_M` (20)): push `T + d*s` and `T + d*min(s + DASH, lengthM)`.

`thresholdBar`: `THRESHOLD_BAR_STRIPE_COUNT` (8) short perpendicular stripes between `t = THRESHOLD_BAR_START_OFFSET_M` (5) and `t = THRESHOLD_BAR_END_OFFSET_M` (15) along `d`, evenly spread across the width: for `i = 0..7`, `offset = -halfWidth + (i + 0.5) * (widthM / 8)`, push `T + right*offset + d*5` and `T + right*offset + d*15`.

**Taxiway** (`generateTaxiwayGeometry`): for each consecutive point pair `(p0, p1)` in `points` (elevation `= elevationM` for every point), `dir = normalize(p1 - p0)` in the XZ plane, `edgeRight = (-dir.z, 0, dir.x) * (widthM / 2)` (this is exactly `right(headingOfDir)` scaled — see the derivation in section 4.2). Push `p0+edgeRight, p1+edgeRight` then `p0-edgeRight, p1-edgeRight` into `edges.points`. **Simplification, stated once here:** edges are built per-segment independently — at a polyline vertex with a turn, the two segments' edge lines do **not** mitre into a single joint; there is a small visible gap/overlap at turns. This is acceptable for a wireframe-style placeholder renderer and avoids miter-join edge cases (near-180° turns, zero-length segments) entirely.

**Apron** (`generateApronGeometry`): `outline.points = [p0,p1, p1,p2, ..., p(n-1),p0]` (elevation `= elevationM`), `2n` points for `n` polygon vertices.

**Lights** (`generateAirportLights`), per runway `r` in `layout.runways`:
- if `r.lights?.edgeLights`: points every `EDGE_LIGHT_SPACING_M` (60) along both edges (`T + right*halfWidth + d*s` and `T - right*halfWidth + d*s` for `s = 0, 60, 120, ...` up to `lengthM`), `kind: RunwayEdge`, `colorHint: White`.
- if `r.lights?.thresholdLights`: `THRESHOLD_BAR_STRIPE_COUNT` points at `t=0` spread across the width (same offsets as the threshold bar), `kind: RunwayThreshold`, `colorHint: Green`.
- if `r.lights?.approachLights`: points every `APPROACH_LIGHT_SPACING_M` (30) from `s = -APPROACH_LIGHT_RUN_M` (-450) to `s = -30` along `d` (i.e. **before** the threshold, upstream), on the centerline, `kind: ApproachLead`, `colorHint: White`.
- if `r.lights?.papi`: 4 points at `T + d*PAPI_ORIGIN_OFFSET_FROM_THRESHOLD_M (150) + right*PAPI_LATERAL_OFFSET_FROM_CENTERLINE_M (12) + right*(i - 1.5)*PAPI_LAMP_LATERAL_SPACING_M (4)` for `i = 0..3`, `kind: Papi`, `colorHint: White` (a **static placeholder** — the live colour is `papiColorAt`, section 4.6, never baked into this point).

Then, for each taxiway `t`: points every `EDGE_LIGHT_SPACING_M` along both edges of `t`'s polyline (same edge construction as `generateTaxiwayGeometry`), `kind: TaxiwayEdge`, `colorHint: Blue`.

`generateAirportRenderGeometry` calls the four generators above once per runway/taxiway/apron and once for lights, and assembles `AirportRenderGeometry`.

### 4.5 Point-in-polygon (used by rule 16 and by `AirportSurfaceIndex`)

Standard ray-casting parity test, `pointInPolygon(x, z, poly: readonly WorldPoint2[]): boolean`:

```
inside = false
for i in 0..poly.length-1:
  j = (i + poly.length - 1) mod poly.length
  pi = poly[i]; pj = poly[j]
  if (pi.worldZ > z) !== (pj.worldZ > z):
    xCross = (pj.worldX - pi.worldX) * (z - pi.worldZ) / (pj.worldZ - pi.worldZ) + pi.worldX
    if x < xCross: inside = !inside
return inside
```

### 4.6 Paved-surface friction index

`createAirportSurfaceIndex(layout)` pre-builds exactly 3 shared `SurfaceFriction` singletons (one per `SurfaceKind`, `{kind, rollingCoeff: SURFACE_ROLLING_FRICTION_PAVED (0.02), brakingCoeff: SURFACE_BRAKING_FRICTION_PAVED_DRY (0.6)}`, differing only in `kind`) and returns an `AirportSurfaceIndex` whose `frictionAt(x, z)`:

1. For each runway `r`: `rel = (x - r.thresholdWorldX, z - r.thresholdWorldZ)`, `d = forwardWorld(r.headingRad)`, `right = right(r.headingRad)`. `along = rel.x*d.x + rel.z*d.z`, `cross = rel.x*right.x + rel.z*right.z`. If `0 <= along <= r.lengthM` and `|cross| <= r.widthM/2`: return the shared `PavedRunway` instance.
2. Else, for each taxiway `t`: for each polyline segment, compute the standard point-to-segment distance in the XZ plane; if `<= t.widthM/2` for any segment: return the shared `PavedTaxiway` instance.
3. Else, for each apron `a`: if `pointInPolygon(x, z, a.points)`: return the shared `PavedApron` instance.
4. Else: `undefined`.

Runways are checked first because pavement never legitimately overlaps between categories in a well-formed layout, and returning on first match keeps this allocation-free and branch-predictable.

### 4.7 ILS deviation math

Given `ils: IlsInfo` (core.ts: `frequencyMhz`, `localiserHeadingRad`, `glideslopeAngleRad`, `localiserOriginPos`, `glideslopeOriginPos`) — both origins are computed by `navDb.ts` from the owning `RunwayDef`/`IlsDef` exactly as follows, and this is the **only** place these origins are computed:

```
d = forwardWorld(runway.headingRad)
farEnd = threshold + d * runway.lengthM
localiserOriginPos  = farEnd    + d * (ils.localiserOffsetBeyondFarEndM ?? ILS_LOCALISER_DEFAULT_OFFSET_M)   // 300 m past the far end
glideslopeOriginPos = threshold + d * (ils.glideslopeOffsetFromThresholdM ?? ILS_GLIDESLOPE_DEFAULT_OFFSET_M) // 300 m downrange of THIS threshold, ON the extended centerline
localiserHeadingRad = runway.headingRad
glideslopeAngleRad  = ils.glideslopeAngleRad ?? ILS_DEFAULT_GLIDESLOPE_RAD   // core.ts constant, 0.05236 rad
```

**Simplification stated once:** the glideslope origin is placed exactly on the extended centerline (not offset to the side as a real glideslope antenna hut is) purely for the deviation-*angle* calculation — this keeps the vertical-plane geometry exact and matches the accuracy real ILS receivers approximate to during a stabilized approach; `generateAirportLights`/render geometry may still draw the physical antenna hut offset to the side as cosmetic detail (out of scope for this module — 08's problem if it wants that detail).

`ilsDeviation(P, ils, out)`:

```
d     = forwardWorld(ils.localiserHeadingRad)
right = right(ils.localiserHeadingRad)

// --- localiser ---
toLoc            = P - ils.localiserOriginPos
crossTrackM      = dot(toLoc, right)                 // + = aircraft right of course
distFromAntennaM = -dot(toLoc, d)                    // + = aircraft upstream of the antenna (normal case)
locAngleRad      = atan2(crossTrackM, distFromAntennaM)
locAngleDeg      = locAngleRad * 180 / PI
out.locNormalized = clamp(locAngleDeg / ILS_LOC_FULL_SCALE_DEG, -1, 1)   // ILS_LOC_FULL_SCALE_DEG = 2.5, core.ts

// --- glideslope ---
toGs           = P - ils.glideslopeOriginPos
horizRangeM    = -dot(toGs, d)                        // along-track distance from the GS origin (see note below)
heightAboveM   = toGs.y
actualAngleRad = atan2(heightAboveM, horizRangeM)
deviationRad   = actualAngleRad - ils.glideslopeAngleRad
deviationDeg   = deviationRad * 180 / PI
out.gsNormalized = clamp(deviationDeg / ILS_GS_FULL_SCALE_DEG, -1, 1)    // ILS_GS_FULL_SCALE_DEG = 0.7, core.ts

// --- validity ---
out.valid = distFromAntennaM > 0
         && distFromAntennaM <= ILS_LOC_VALID_RANGE_M
         && abs(locAngleRad) <= ILS_LOC_VALID_AZIMUTH_RAD
         && horizRangeM > 0
         && horizRangeM <= ILS_GS_VALID_RANGE_M
         && abs(atan2(crossTrackM, horizRangeM)) <= ILS_GS_VALID_AZIMUTH_RAD
if (!out.valid) { out.locNormalized = 0; out.gsNormalized = 0 }
return out
```

`horizRangeM` is the along-track projection, not the true 3D slant range — real ILS beams are also conventionally described by along-track distance from the antenna for this exact reason (cross-track deviation during a stabilized approach is tiny relative to range), so this is standard practice, not a cut corner.

**Worked example** (used verbatim as a unit-test fixture, section 7): runway threshold `(0,100,-1000)`, `headingRad=0` (⇒ `d=(0,0,-1)`, `right=(1,0,0)`), `lengthM=3000`, default offsets/angle. `localiserOriginPos = (0,100,-4300)`, `glideslopeOriginPos = (0,100,-1300)`. Aircraft at `P=(0, 362.039, 3700)` (on centerline, 5000 m upstream of the GS origin, exactly on the 3° glidepath) gives `locNormalized ≈ 0`, `gsNormalized ≈ 0`. Aircraft at `P=(50, 362.039, 3700)` (50 m right of centerline, same range/height) gives `locNormalized ≈ 0.1432`. Aircraft at `P=(0, 412.039, 3700)` (50 m high at the same range) gives `gsNormalized ≈ 0.816`.

### 4.8 PAPI colour

`PAPI_LAMP_OFFSETS_RAD = [-0.008727, -0.002909, 0.002909, 0.008727]` (±0.5° and ±1/6°, ascending). `papiColorAt(runway, P, out)`: if `!runway.lights?.papi`, return `undefined` unmodified. Else, using the same `glideslopeOriginPos`/`glideslopeAngleRad` construction as section 4.7 (with `ils.glideslopeAngleRad` defaulting to `ILS_DEFAULT_GLIDESLOPE_RAD` even when `runway.ils` is entirely absent — PAPI does not require ILS):

```
actualAngleRad = atan2((P - glideslopeOriginPos).y, -dot(P - glideslopeOriginPos, d))
for i in 0..3:
  threshold_i = glideslopeAngleRad + PAPI_LAMP_OFFSETS_RAD[i]
  out.colors[i] = (actualAngleRad >= threshold_i) ? White : Red
out.runwayId = runway.id
return out
```

On the nominal glidepath (`actualAngleRad === glideslopeAngleRad`) this always yields `[White, White, Red, Red]` (2 white + 2 red — the standard "on path" PAPI indication), regardless of `glideslopeAngleRad`'s value, because the four offsets are symmetric around 0.

### 4.9 Nav database

`createAirportNavDb(layouts)` builds a `Map<string, AirportInfo & { runwaysByDef: ... }>` internally (implementation detail) and **throws** if two layouts share the same `id` (programmer/config-error class per `00-architecture.md`'s error-handling rule — this can only happen if `src/core`'s mission loading passed a malformed `WorldConfig.airports`, which is caught by module 12's integration tests, not by ordinary players).

- `getAirport`/`listAirports`/`nearestAirport`/`getRunway` — implement core.ts's `AirportNavDb` directly by table lookup / linear scan (airport counts are small, single digits per mission — no spatial index needed).
- `nearestRunway(pos)` — linear scan over every runway of every airport, minimising `hypot(pos.x - threshold.x, pos.z - threshold.z)`; returns `{airportId, runway}` or `undefined` if zero airports are loaded.
- `approachFixes(airportId, runwayId)` — `[]` if not found; else, with `glideslopeAngleRad = runway.ils?.glideslopeAngleRad ?? ILS_DEFAULT_GLIDESLOPE_RAD` and `d = forwardWorld(runway.headingRad)`:

```
for (name, altAglM) of [("FAF", APPROACH_FAF_ALT_AGL_M=450), ("IAF", APPROACH_IAF_ALT_AGL_M=900)]:
  distM = altAglM / tan(glideslopeAngleRad)
  pos   = threshold - d*distM         // upstream of the threshold, on the extended centerline
  pos.y = runway.elevationM + altAglM
  push { name: "RW" + runway.id + "-" + name, pos, altitudeM: pos.y }
return [FAF fix, IAF fix]   // exactly 2, FAF first
```

**Worked example** (unit-test fixture, verified numerically not just by hand): runway "06" as declared in `rangpur-afb.json` (section 5.3): threshold `(0,620,0)`, `headingRad ≈ 1.0471976` (60°), `glideslopeAngleRad` default (0.05236). `tan(0.05236) ≈ 0.0524078`. FAF: `distM = 450/0.0524078 ≈ 8586.5`, `pos ≈ (-7436.1, 1070, 4293.2)`. IAF: `distM ≈ 17173.0`, `pos ≈ (-14872.2, 1520, 8586.5)`.

## 5. Data

### 5.1 Constants (all in `contracts/airport.ts`; nobody redefines these)

| constant | value | unit | justification |
|---|---|---|---|
| `ILS_LOCALISER_DEFAULT_OFFSET_M` | 300 | m | Typical real-world localiser antenna setback beyond the far runway end. |
| `ILS_GLIDESLOPE_DEFAULT_OFFSET_M` | 300 | m | Typical glideslope antenna offset downrange of the threshold. |
| `ILS_LOC_VALID_AZIMUTH_RAD` | 0.610865 | rad (35°) | ICAO Annex 10-typical front-course usable azimuth. |
| `ILS_LOC_VALID_RANGE_M` | 46300 | m (25 NM) | ICAO Annex 10-typical localiser range. |
| `ILS_GS_VALID_AZIMUTH_RAD` | 0.139626 | rad (8°) | ICAO Annex 10-typical glideslope usable azimuth. |
| `ILS_GS_VALID_RANGE_M` | 18520 | m (10 NM) | ICAO Annex 10-typical glideslope range. |
| `ILS_FREQUENCY_MIN_MHZ` / `MAX_MHZ` | 108.10 / 111.95 | MHz | Real-world ILS localiser VHF band. |
| `ILS_FREQUENCY_STEP_MHZ` | 0.05 | MHz | Real-world channel spacing (channel/VOR-vs-ILS odd/even-tenth distinction is NOT modelled — see section 9). |
| `ILS_GLIDESLOPE_ANGLE_MIN/MAX_RAD` | 0.017453 / 0.069813 | rad (1°/4°) | Real-world usable glideslope angle range. |
| `APPROACH_FAF_ALT_AGL_M` | 450 | m (≈1500 ft) | Typical final-approach-fix altitude AGL. |
| `APPROACH_IAF_ALT_AGL_M` | 900 | m (≈3000 ft) | Typical initial-approach-fix altitude AGL. |
| `PAPI_LAMP_OFFSETS_RAD` | ±0.008727, ±0.002909 | rad (±0.5°, ±1/6°) | Standard PAPI lamp angular spacing (20 arcmin steps). |
| `PAPI_ORIGIN_OFFSET_FROM_THRESHOLD_M` | 150 | m | Typical PAPI installation offset downrange of the threshold. |
| `PAPI_LAMP_LATERAL_SPACING_M` | 4 | m | Typical spacing between the 4 PAPI lamp housings. |
| `PAPI_LATERAL_OFFSET_FROM_CENTERLINE_M` | 12 | m | Typical PAPI lateral offset from the runway edge/centerline. |
| `SURFACE_ROLLING_FRICTION_PAVED` | 0.02 | dimensionless | Generic dry-asphalt rolling-resistance coefficient (not Tejas-specific; see section 9). |
| `SURFACE_BRAKING_FRICTION_PAVED_DRY` | 0.6 | dimensionless | Generic dry-asphalt tyre braking-friction coefficient. |
| `RUNWAY_LENGTH_MIN/MAX_M` | 300 / 6000 | m | Plausible fighter-strip to large-airfield bounds. |
| `RUNWAY_WIDTH_MIN/MAX_M` | 15 / 120 | m | Plausible narrow-strip to large-airfield bounds. |
| `RECIPROCAL_HEADING_TOLERANCE_RAD` | 0.02 | rad (≈1.15°) | Float-authoring tolerance, tight enough to catch real mistakes. |
| `RECIPROCAL_DISTANCE_TOLERANCE_M` / `_FRAC` | 2 / 0.005 | m / fraction | Absolute-or-relative tolerance, whichever is larger, so short and long runways both get sane tolerances. |
| `RUNWAY_ELEVATION_MATCH_TOLERANCE_M` | 1.0 | m | Numerical tolerance for "runway sits on its flatten zone's plateau". |
| `RUNWAY_COVERAGE_SAMPLE_COUNT` | 5 | count | Cheap but catches any gap bigger than 1/4 of the runway length. |
| `CENTERLINE_DASH_LENGTH_M` / `_GAP_M` | 30 / 20 | m | Realistic runway centerline dash-dash spacing, scaled for visibility from altitude. |
| `THRESHOLD_BAR_STRIPE_COUNT` | 8 | count | Standard number of threshold marking stripes. |
| `THRESHOLD_BAR_START/END_OFFSET_M` | 5 / 15 | m | Placement of the threshold stripe band just past the threshold. |
| `EDGE_LIGHT_SPACING_M` | 60 | m | Typical runway/taxiway edge light spacing. |
| `APPROACH_LIGHT_SPACING_M` / `_RUN_M` | 30 / 450 | m | Typical approach lighting system lead-in length. |
| `TAXIWAY_MIN_POINTS` / `APRON_MIN_POINTS` | 2 / 3 | count | Minimum points for a valid polyline / closed polygon. |

### 5.2 JSON schema — field reference

See `contracts/airport.ts` section 1 for the authoritative TypeScript types (`AirportLayout`, `RunwayDef`, `TaxiwayDef`, `ApronDef`, `ParkingSpotDef`, `AirportFlattenZone`, `IlsDef`, `RunwayLightsDef`). Every numeric field's unit is documented inline in that file; angles are radians, everything else is metres or MHz as named. The two layouts below are the concrete, complete, schema-valid worked examples.

### 5.3 Built-in layout 1 — `src/airport/layouts/rangpur-afb.json`

Inland/plateau airbase (620 m MSL), single long runway (heading 060°/240°, 3200 m × 45 m, concrete), mountainous surroundings, ILS on the 06 end only — exercises terrain-hugging BFM on the 24 approach and a non-trivial ILS approach on the 06 approach.

```json
{
  "id": "rangpur-afb",
  "name": "Rangpur Air Force Base",
  "referenceWorldX": 0,
  "referenceWorldZ": 0,
  "elevationM": 620,
  "flattenZones": [
    { "centerWorldX": 1385.64, "centerWorldZ": -800.00, "elevationM": 620, "flatRadiusM": 1750, "blendRadiusM": 300 },
    { "centerWorldX": 421.41, "centerWorldZ": -70.10, "elevationM": 620, "flatRadiusM": 200, "blendRadiusM": 150 }
  ],
  "runways": [
    {
      "id": "06", "thresholdWorldX": 0, "thresholdWorldZ": 0, "elevationM": 620,
      "headingRad": 1.0471976, "lengthM": 3200, "widthM": 45, "surface": "concrete",
      "reciprocalId": "24",
      "ils": { "frequencyMhz": 109.90 },
      "lights": { "edgeLights": true, "thresholdLights": true, "approachLights": true, "papi": true }
    },
    {
      "id": "24", "thresholdWorldX": 2771.28, "thresholdWorldZ": -1600.00, "elevationM": 620,
      "headingRad": 4.1887902, "lengthM": 3200, "widthM": 45, "surface": "concrete",
      "reciprocalId": "06",
      "lights": { "edgeLights": true, "thresholdLights": true, "approachLights": false, "papi": false }
    }
  ],
  "taxiways": [
    { "id": "TWY-1", "widthM": 20, "points": [ { "worldX": 321.86, "worldZ": -142.52 }, { "worldX": 421.41, "worldZ": -70.10 } ] }
  ],
  "aprons": [
    { "id": "APRON-1", "points": [ { "worldX": 361.41, "worldZ": -110.10 }, { "worldX": 481.41, "worldZ": -110.10 }, { "worldX": 481.41, "worldZ": -30.10 }, { "worldX": 361.41, "worldZ": -30.10 } ] }
  ],
  "parkingSpots": [
    { "id": "PARK-1", "worldX": 380, "worldZ": -70.10, "headingRad": 1.0471976, "type": "fighter" },
    { "id": "PARK-2", "worldX": 398, "worldZ": -70.10, "headingRad": 1.0471976, "type": "fighter" },
    { "id": "PARK-3", "worldX": 416, "worldZ": -70.10, "headingRad": 1.0471976, "type": "fighter" },
    { "id": "PARK-4", "worldX": 434, "worldZ": -70.10, "headingRad": 1.0471976, "type": "fighter" },
    { "id": "PARK-5", "worldX": 452, "worldZ": -70.10, "headingRad": 1.0471976, "type": "fighter" },
    { "id": "PARK-6", "worldX": 470, "worldZ": -70.10, "headingRad": 1.0471976, "type": "fighter" }
  ]
}
```

### 5.4 Built-in layout 2 — `src/airport/layouts/konarak-coastal.json`

Coastal airbase (8 m MSL), two parallel runways 400 m apart (heading 090°/270°, each 2800 m × 45 m, asphalt), ILS on both 09 ends for an approach over water from the west.

```json
{
  "id": "konarak-coastal",
  "name": "Konarak Coastal Air Station",
  "referenceWorldX": 60000,
  "referenceWorldZ": 45000,
  "elevationM": 8,
  "flattenZones": [
    { "centerWorldX": 60000, "centerWorldZ": 44800, "elevationM": 8, "flatRadiusM": 1550, "blendRadiusM": 300 },
    { "centerWorldX": 60000, "centerWorldZ": 45200, "elevationM": 8, "flatRadiusM": 1550, "blendRadiusM": 300 },
    { "centerWorldX": 58900, "centerWorldZ": 45000, "elevationM": 8, "flatRadiusM": 350, "blendRadiusM": 200 }
  ],
  "runways": [
    {
      "id": "09L", "thresholdWorldX": 58600, "thresholdWorldZ": 44800, "elevationM": 8,
      "headingRad": 1.5707963, "lengthM": 2800, "widthM": 45, "surface": "asphalt",
      "reciprocalId": "27L",
      "ils": { "frequencyMhz": 110.30 },
      "lights": { "edgeLights": true, "thresholdLights": true, "approachLights": true, "papi": true }
    },
    {
      "id": "27L", "thresholdWorldX": 61400, "thresholdWorldZ": 44800, "elevationM": 8,
      "headingRad": 4.7123890, "lengthM": 2800, "widthM": 45, "surface": "asphalt",
      "reciprocalId": "09L",
      "lights": { "edgeLights": true, "thresholdLights": true, "approachLights": false, "papi": false }
    },
    {
      "id": "09R", "thresholdWorldX": 58600, "thresholdWorldZ": 45200, "elevationM": 8,
      "headingRad": 1.5707963, "lengthM": 2800, "widthM": 45, "surface": "asphalt",
      "reciprocalId": "27R",
      "ils": { "frequencyMhz": 111.10 },
      "lights": { "edgeLights": true, "thresholdLights": true, "approachLights": true, "papi": true }
    },
    {
      "id": "27R", "thresholdWorldX": 61400, "thresholdWorldZ": 45200, "elevationM": 8,
      "headingRad": 4.7123890, "lengthM": 2800, "widthM": 45, "surface": "asphalt",
      "reciprocalId": "09R",
      "lights": { "edgeLights": true, "thresholdLights": true, "approachLights": false, "papi": false }
    }
  ],
  "taxiways": [
    { "id": "TWY-A", "widthM": 20, "points": [ { "worldX": 58900, "worldZ": 45000 }, { "worldX": 58900, "worldZ": 44850 }, { "worldX": 58700, "worldZ": 44850 } ] },
    { "id": "TWY-B", "widthM": 20, "points": [ { "worldX": 58900, "worldZ": 45000 }, { "worldX": 58900, "worldZ": 45150 }, { "worldX": 58700, "worldZ": 45150 } ] }
  ],
  "aprons": [
    { "id": "APRON-1", "points": [ { "worldX": 58800, "worldZ": 44950 }, { "worldX": 59000, "worldZ": 44950 }, { "worldX": 59000, "worldZ": 45050 }, { "worldX": 58800, "worldZ": 45050 } ] }
  ],
  "parkingSpots": [
    { "id": "PARK-1", "worldX": 58820, "worldZ": 45000, "headingRad": 1.5707963, "type": "fighter" },
    { "id": "PARK-2", "worldX": 58852, "worldZ": 45000, "headingRad": 1.5707963, "type": "transport" },
    { "id": "PARK-3", "worldX": 58884, "worldZ": 45000, "headingRad": 1.5707963, "type": "fighter" },
    { "id": "PARK-4", "worldX": 58916, "worldZ": 45000, "headingRad": 1.5707963, "type": "transport" },
    { "id": "PARK-5", "worldX": 58948, "worldZ": 45000, "headingRad": 1.5707963, "type": "fighter" },
    { "id": "PARK-6", "worldX": 58980, "worldZ": 45000, "headingRad": 1.5707963, "type": "transport" }
  ]
}
```

Both layouts satisfy every rule in section 4.3 as authored (verified by hand in section 4.3/4.9's worked examples and re-checked mechanically by `tests/airport/layouts.test.ts`, section 7 — named `layouts.test.ts`, not `builtinLayouts.test.ts`, to match `12-verification.md` section 2's canonical file list exactly).

## 6. Performance budget

None of this module's functions run in the 120 Hz sim hot path. Budget:

- **Load time (once per mission load):** `loadAirportLayout` + `createAirportNavDb` + `generateAirportRenderGeometry` + `createAirportSurfaceIndex` for both built-in layouts combined: **< 5 ms** on a mid-range mobile CPU. These layouts are small (≤ 4 runways, ≤ 2 taxiways, ≤ 1 apron, ≤ 6 parking spots each) — no algorithm here is worse than O(n) or O(n·m) over tiny n/m, so this is dominated by JSON.parse, not by this module's logic.
- **`ilsDeviation`:** called once per emitted snapshot (≤ 60 Hz) for the player only (not for AI aircraft, which use their own approach logic via `PilotContext.navDb`/`approachFixes`, not the HUD deviation numbers). Must be **allocation-free** (out-param, section 4.7) and complete in **< 1 μs**: it is a handful of dot products and two `atan2` calls, no loops.
- **`papiColorAt`:** called at most once per rendered frame per visible runway with `lights.papi === true` (typically 0–2 at once). Allocation-free (out-param). **< 1 μs**.
- **`AirportSurfaceIndex.frictionAt`:** documented as allocation-free and cheap (a handful of dot products per runway/taxiway, checked in declaration order) so that **if** `src/core`'s `world.ts` wires it into the 120 Hz gear-physics path (see section 9), it does not violate the "no allocation in hot paths" rule. With the built-in layouts' runway/taxiway counts (≤ 4 / ≤ 2), worst case is ~10 dot-product pairs — negligible at 120 Hz.
- **Render geometry:** total line points across both built-in layouts combined is on the order of a few hundred (runways: 8 + ~2×(lengthM/50) dash points + 16 threshold points each; taxiways/aprons: a few dozen each; lights: a few hundred across both). This is uploaded to Three.js **once** per loaded airport, not per frame — `src/render`'s own spec (module 08) owns how it turns `LineSegmentSet`s into `LineSegments` geometry.

## 7. Unit tests to write

All under `tests/airport/`, mirroring `src/airport/<file>.ts` → `tests/airport/<file>.test.ts` per `00-architecture.md`'s naming convention.

**`tests/airport/parser.test.ts`**
- `parseAirportLayout({})` → `ok === false`, `error` contains an issue with `code === 'missing_field'` and `path === 'id'`.
- `parseAirportLayout(<the rangpur-afb.json object, section 5.3>)` → `ok === true`, `value.runways.length === 2`, `value.runways[0].id === '06'`.

**`tests/airport/validator.test.ts`**
- Two runways both `id: "09"` → `validateAirportLayout` returns `ok === false` with an issue `{ code: 'duplicate_id', severity: 'error' }` at `path === 'runways[1].id'`.
- Runway A `headingRad: 0`, reciprocal B `headingRad: 3.0` (expected `~PI = 3.14159`, diff `0.1416 > 0.02` tolerance) → issue `{ code: 'reciprocal_heading_mismatch', severity: 'error' }`.
- A runway 1000 m long whose only flatten zone has `flatRadiusM: 50` centered on the threshold → issue `{ code: 'runway_not_flattened', severity: 'error' }` present for at least the `t=1.0` sample (`path` contains `"t=1"`).
- `ils.frequencyMhz: 105.0` → issue `{ code: 'ils_frequency_out_of_range', severity: 'error' }`.
- A parking spot at `(worldX: 100000, worldZ: 100000)` (far outside every apron) → `ok === true` overall (no errors elsewhere), `warnings` contains exactly one `{ code: 'parking_spot_outside_apron', severity: 'warning' }`.
- Both built-in layouts (section 5.3, 5.4), parsed then validated → `ok === true` and `warnings.length === 0` for each.

**`tests/airport/ils.test.ts`** (fixtures from section 4.7's worked example)
- On-path, on-centerline case: `ilsDeviation({x:0,y:362.039,z:3700}, ils, out)` → `out.valid === true`, `Math.abs(out.locNormalized) < 1e-6`, `Math.abs(out.gsNormalized) < 0.01`.
- 50 m right of centerline: `ilsDeviation({x:50,y:362.039,z:3700}, ils, out)` → `Math.abs(out.locNormalized - 0.1432) < 0.001`.
- 50 m above the glidepath: `ilsDeviation({x:0,y:412.039,z:3700}, ils, out)` → `Math.abs(out.gsNormalized - 0.816) < 0.01`.
- Aircraft `distFromAntennaM > ILS_LOC_VALID_RANGE_M` (e.g. `z: 60000`) → `out.valid === false`, `out.locNormalized === 0`, `out.gsNormalized === 0`.

**`tests/airport/papi.test.ts`**
- On the nominal glidepath, any `glideslopeAngleRad` → `papiColorAt(runway, onPathPos, out).colors` deep-equals `['white','white','red','red']`.
- 0.3° below the glidepath (`actualAngleRad = glideslopeAngleRad - 0.005236`) → `colors` deep-equals `['white','red','red','red']`.
- `runway.lights = { papi: false, ... }` → returns `undefined`, `out` left unmodified (assert `out` still equals its pre-call value).

**`tests/airport/runwayGeometry.test.ts`**
- Runway `headingRad: 0`, threshold `(1000,50,2000)`, `lengthM: 3000`, `widthM: 45` → `outline.points.length === 8`; `outline.points[0]` deep-equals `{x:977.5,y:50,z:2000}`; `outline.points[1]` deep-equals `{x:1022.5,y:50,z:2000}`; `outline.points[5]` (the `c2`→`c3` segment's first point) deep-equals `{x:1022.5,y:50,z:-1000}`.
- `centerlineDashes.points.length` for `lengthM: 100` (one dash-gap cycle of 50 m, so exactly 2 dashes) `=== 4`.
- `thresholdBar.points.length === 16` (8 stripes × 2 points) for any valid runway.

**`tests/airport/taxiwayGeometry.test.ts`**
- Single-segment taxiway, `points: [{worldX:0,worldZ:0},{worldX:0,worldZ:-100}]`, `widthM: 10`, `elevationM: 50` → `edges.points.length === 4`, deep-equals `[{x:5,y:50,z:0},{x:5,y:50,z:-100},{x:-5,y:50,z:0},{x:-5,y:50,z:-100}]`.

**`tests/airport/apronGeometry.test.ts`**
- Square apron `[(0,0),(10,0),(10,10),(0,10)]`, `elevationM: 20` → `outline.points.length === 8`; first segment deep-equals `[{x:0,y:20,z:0},{x:10,y:20,z:0}]`.

**`tests/airport/surfaceIndex.test.ts`**
- Runway threshold `(0,50,0)`, `headingRad: 0`, `lengthM: 1000`, `widthM: 40`: `frictionAt(0,-500)` → `{kind:'paved_runway', rollingCoeff:0.02, brakingCoeff:0.6}`. `frictionAt(30,-500)` (30 m off centerline, half-width is 20) → `undefined`. `frictionAt(0,100)` (behind the threshold) → `undefined`.
- Calling `frictionAt` twice with two different in-bounds runway points returns the **same object reference** (`Object.is`) — proves the no-allocation/shared-singleton contract.

**`tests/airport/navDb.test.ts`**
- `createAirportNavDb([rangpurLayout, konarakLayout])`: `listAirports().length === 2`; `getRunway('rangpur-afb','06')!.headingRad` within `1e-6` of `1.0471976`; `nearestAirport({x:0,y:0,z:0})!.id === 'rangpur-afb'`; `nearestRunway({x:10,y:0,z:-10})!.runway.id === '06'`.
- `createAirportNavDb([layoutA, layoutAWithSameId])` → throws.
- `approachFixes('rangpur-afb','06')`: length `=== 2`; `[0].name === 'RW06-FAF'`; `Math.abs([0].altitudeM - 1070) < 1`; `Math.abs([0].pos.x - (-7436.1)) < 1`; `[1].name === 'RW06-IAF'`; `Math.abs([1].altitudeM - 1520) < 1`.
- `approachFixes('rangpur-afb','doesnotexist')` → `[]`.

## 8. Acceptance criteria

1. `docs/spec/contracts/airport.ts` compiles standalone with `tsc --noEmit --strict` alongside `core.ts` (mechanically checked by module 12's Audit phase; already verified during drafting).
2. Every function listed in section 3 exists in `src/airport/index.ts`'s barrel export with exactly the signature given in `contracts/airport.ts`.
3. `parseAirportLayout` + `validateAirportLayout`, run over `src/airport/layouts/rangpur-afb.json` and `src/airport/layouts/konarak-coastal.json`, both return `ok === true` with zero `severity: 'error'` issues and zero `warnings`.
4. `createAirportNavDb` over both built-in layouts serves `getRunway`, `nearestAirport`, `nearestRunway`, `approachFixes` without throwing, and every `RunwayInfo` it returns has `ils !== undefined` exactly for the runway ids that declared `ils` in the source JSON: `06`, `09L`, `09R` yes; `24`, `27L`, `27R` no.
5. `ilsDeviation` and `papiColorAt` perform **zero heap allocations** across 10,000 consecutive calls with varying inputs (module 12's acceptance test: call in a loop, assert `out` reference identity unchanged, and/or a Node `--expose-gc` heap-delta check per `00-architecture.md` section 5's buffer-lifecycle testing pattern).
6. `AirportSurfaceIndex.frictionAt` returns `undefined` for every `(x,z)` more than 500 m outside every declared runway/taxiway/apron footprint of both built-in layouts, and a defined, correctly-`kind`ed result for the centre point of every declared runway, taxiway segment, and apron.
7. Every one of the 16 validator rules in section 4.3 has at least one failing-case unit test (section 7) that triggers exactly that `code`.
8. No file under `src/airport/` imports anything outside `src/contracts/*` and `src/math/*` (mechanically checked by module 12's dependency-graph lint, per `00-architecture.md` section 10).
9. No file under `src/airport/` calls `Math.random()` (grep-checked by module 12).

## 9. Open assumptions

- **"Flatten polygon" vs. `AirportFlattenZone`:** the general project brief mentions a "flatten polygon" per airport. `00-architecture.md` section 9.2 fixes the actual cross-module shape as **circular zones** (`centerWorldX/Z`, `elevationM`, `flatRadiusM`, `blendRadiusM`) shared byte-for-byte with module 04's `HeightSampler`. This document follows `00-architecture.md`, not the looser brief text, per this project's own conflict-resolution rule (architecture wins). `AirportLayout.flattenZones` is therefore `readonly AirportFlattenZone[]` — a small set of circles, not a polygon — and a real-world irregular airport footprint is approximated by 1-3 overlapping circles (as both built-in layouts do: one per runway, one for the apron/terminal area).
- **Gear/pavement friction has no wired channel to `stepAircraft`.** `00-architecture.md` section 9.1 fixes `StepAircraft`'s signature and `Environment` shape (`airDensityKgM3`, `soundSpeedMps`, `windWorldMps`, `gravityMps2`) — there is no per-position surface-friction field anywhere in that contract, and module 02 (`src/physics`) cannot import `src/airport` directly (dependency graph, section 10). This module still exposes `createAirportSurfaceIndex`/`AirportSurfaceIndex.frictionAt` as a complete, self-contained, allocation-free capability (section 4.6) because the brief explicitly asks for "physics: surface friction regions" as part of this module's own deliverable — but whether `src/core`'s `world.ts` actually threads a friction value into module 02's landing-gear code is outside this module's control; if it is not wired, module 02's gear friction model is presumably a single generic constant, and that is a limitation of the fixed cross-module contracts, not something this module can fix from module 05's side.
- **PAPI/ILS/runway-lighting/friction constants (section 5.1) are generic aviation figures, not Tejas- or India-specific** — public, precise data for real Indian air bases' ILS offsets, PAPI geometry, or pavement friction is not something this module had access to, so these are standard-practice approximations (ICAO Annex 10 typical figures for ILS reception cones; generic dry-asphalt tyre friction for the surface index) rather than measurements of any real airport.
- **Both built-in layouts are entirely fictional**, per `00-architecture.md` section 9.3's explicit statement — `rangpur-afb` and `konarak-coastal` are original place names with plausible-but-invented geometry (runway headings/lengths, elevations, taxiway/apron/parking layout), not a reproduction of Sulur AFB, HAL Bengaluru, or any other real airfield's surveyed data. Their "character" (inland/plateau/mountainous single-runway base; coastal/sea-level/parallel-runway base with an over-water ILS approach) matches `00-architecture.md`'s fixed description exactly.
- **ILS channel numbering (odd/even tenths distinguishing ILS from VOR) is not modelled** — `ils_frequency_out_of_range` only checks the real-world band and 0.05 MHz step (section 4.3 rule 12), not the further real-world constraint that only specific tenths are valid ILS (vs. VOR) channels, since this sim has no VOR/frequency-confusion gameplay to justify the extra complexity.
- **Taxiway/apron edge geometry does not mitre at polyline joints** (section 4.4) — a deliberate simplification for a placeholder wireframe renderer, stated once there and not re-litigated per-function.
- **Parking-spot type (`fighter`/`transport`/`helicopter`) is purely descriptive data** for module 06 (AI spawn placement) or module 11 (editor UI) to use however they see fit; this module does not enforce that a spawned aircraft's size matches its parking spot's declared type — no shape/size data exists on `ParkingSpotDef` to check against, and none was requested by the brief.
