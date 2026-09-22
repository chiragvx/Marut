/**
 * src/airport/validator.ts — semantic/geometric validation of an
 * already-parsed AirportLayout. Implements the exact, ordered 16-rule list
 * in 05-airport.md section 4.3. Not a hot path: this may allocate freely.
 */

import type {
  AirportFlattenZone,
  AirportIssue,
  AirportLayout,
  AirportLoadResult,
  AirportValidationError,
  AirportValidationErrorCode,
  AirportValidationOutcome,
  LoadAirportLayout,
  RunwayDef,
  ValidateAirportLayout,
} from '../contracts/airport';
import {
  APRON_MIN_POINTS,
  ILS_FREQUENCY_MAX_MHZ,
  ILS_FREQUENCY_MIN_MHZ,
  ILS_FREQUENCY_STEP_MHZ,
  ILS_GLIDESLOPE_ANGLE_MAX_RAD,
  ILS_GLIDESLOPE_ANGLE_MIN_RAD,
  RECIPROCAL_DISTANCE_TOLERANCE_FRAC,
  RECIPROCAL_DISTANCE_TOLERANCE_M,
  RECIPROCAL_HEADING_TOLERANCE_RAD,
  RUNWAY_COVERAGE_SAMPLE_COUNT,
  RUNWAY_ELEVATION_MATCH_TOLERANCE_M,
  RUNWAY_LENGTH_MAX_M,
  RUNWAY_LENGTH_MIN_M,
  RUNWAY_WIDTH_MAX_M,
  RUNWAY_WIDTH_MIN_M,
  TAXIWAY_MIN_POINTS,
} from '../contracts/airport';
import { wrapAngleSigned } from '../math';
import { pointInPolygon } from './geomUtils';
import { parseAirportLayout } from './parser';

function err(
  errors: AirportValidationError[],
  code: AirportValidationErrorCode,
  severity: 'error' | 'warning',
  path: string,
  message: string
): void {
  errors.push({ stage: 'validate', code, severity, path, message });
}

function checkDuplicateIds(items: readonly { id: string }[], category: string, errors: AirportValidationError[]): void {
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const id = items[i]!.id;
    if (seen.has(id)) {
      err(errors, 'duplicate_id', 'error', `${category}[${i}].id`, `duplicate id '${id}' in ${category}`);
    } else {
      seen.add(id);
    }
  }
}

/** The exact, fixed sample fractions from 05-airport.md section 4.3 rule 10. Length must equal RUNWAY_COVERAGE_SAMPLE_COUNT. */
const COVERAGE_SAMPLE_TS: readonly number[] = [0, 0.25, 0.5, 0.75, 1];
if (COVERAGE_SAMPLE_TS.length !== RUNWAY_COVERAGE_SAMPLE_COUNT) {
  throw new Error('COVERAGE_SAMPLE_TS must match RUNWAY_COVERAGE_SAMPLE_COUNT');
}

interface ZoneCoverage {
  zone: AirportFlattenZone;
  distM: number;
}

function coveringZonesAt(layout: AirportLayout, x: number, z: number): ZoneCoverage[] {
  const covering: ZoneCoverage[] = [];
  for (const zone of layout.flattenZones) {
    const d = Math.hypot(x - zone.centerWorldX, z - zone.centerWorldZ);
    if (d <= zone.flatRadiusM) covering.push({ zone, distM: d });
  }
  return covering;
}

export const validateAirportLayout: ValidateAirportLayout = (layout) => {
  const errors: AirportValidationError[] = [];

  // Rule 1: duplicate_id — four independent namespaces.
  checkDuplicateIds(layout.runways, 'runways', errors);
  checkDuplicateIds(layout.taxiways, 'taxiways', errors);
  checkDuplicateIds(layout.aprons, 'aprons', errors);
  checkDuplicateIds(layout.parkingSpots, 'parkingSpots', errors);

  const runwayById = new Map<string, RunwayDef>();
  for (const r of layout.runways) runwayById.set(r.id, r);

  for (let i = 0; i < layout.runways.length; i++) {
    const r = layout.runways[i]!;
    const path = `runways[${i}]`;

    // Rule 2: invalid_runway_length
    if (r.lengthM < RUNWAY_LENGTH_MIN_M || r.lengthM > RUNWAY_LENGTH_MAX_M) {
      err(errors, 'invalid_runway_length', 'error', `${path}.lengthM`, `runway '${r.id}' lengthM ${r.lengthM} out of range`);
    }
    // Rule 3: invalid_runway_width
    if (r.widthM < RUNWAY_WIDTH_MIN_M || r.widthM > RUNWAY_WIDTH_MAX_M) {
      err(errors, 'invalid_runway_width', 'error', `${path}.widthM`, `runway '${r.id}' widthM ${r.widthM} out of range`);
    }

    // Rules 4-8: reciprocal consistency.
    if (r.reciprocalId !== undefined) {
      const b = runwayById.get(r.reciprocalId);
      if (b === undefined) {
        err(errors, 'reciprocal_not_found', 'error', `${path}.reciprocalId`, `runway '${r.id}' reciprocalId '${r.reciprocalId}' not found`);
      } else {
        // Rule 5: reciprocal_not_mutual
        if (b.reciprocalId !== r.id) {
          err(errors, 'reciprocal_not_mutual', 'error', `${path}.reciprocalId`, `runway '${r.id}'/'${b.id}' reciprocal not mutual`);
        }
        // Rule 6: reciprocal_heading_mismatch
        const headingDiff = Math.abs(wrapAngleSigned(r.headingRad - (b.headingRad - Math.PI)));
        if (headingDiff > RECIPROCAL_HEADING_TOLERANCE_RAD) {
          err(errors, 'reciprocal_heading_mismatch', 'error', `${path}.headingRad`, `runway '${r.id}'/'${b.id}' heading mismatch`);
        }
        // Rule 7: reciprocal_distance_mismatch
        const distXZ = Math.hypot(r.thresholdWorldX - b.thresholdWorldX, r.thresholdWorldZ - b.thresholdWorldZ);
        const tol = Math.max(RECIPROCAL_DISTANCE_TOLERANCE_M, RECIPROCAL_DISTANCE_TOLERANCE_FRAC * r.lengthM);
        if (Math.abs(distXZ - r.lengthM) > tol || Math.abs(distXZ - b.lengthM) > tol) {
          err(errors, 'reciprocal_distance_mismatch', 'error', path, `runway '${r.id}'/'${b.id}' distance mismatch`);
        }
        // Rule 8: reciprocal_width_mismatch
        if (r.widthM !== b.widthM) {
          err(errors, 'reciprocal_width_mismatch', 'error', `${path}.widthM`, `runway '${r.id}'/'${b.id}' width mismatch`);
        }
      }
    }
  }

  // Rule 9: flatten_zone_radius_invalid
  for (let i = 0; i < layout.flattenZones.length; i++) {
    const z = layout.flattenZones[i]!;
    if (!(z.flatRadiusM > 0) || !(z.blendRadiusM >= 0)) {
      err(errors, 'flatten_zone_radius_invalid', 'error', `flattenZones[${i}]`, `zone ${i} has invalid flatRadiusM/blendRadiusM`);
    }
  }

  // Rules 10-13: per-runway coverage/elevation/ILS.
  for (let i = 0; i < layout.runways.length; i++) {
    const r = layout.runways[i]!;
    const path = `runways[${i}]`;
    const dx = Math.sin(r.headingRad);
    const dz = -Math.cos(r.headingRad);

    let t0Covering: ZoneCoverage[] | undefined;
    for (const t of COVERAGE_SAMPLE_TS) {
      const sx = r.thresholdWorldX + dx * t * r.lengthM;
      const sz = r.thresholdWorldZ + dz * t * r.lengthM;
      const covering = coveringZonesAt(layout, sx, sz);
      if (covering.length === 0) {
        // Rule 10: runway_not_flattened
        err(errors, 'runway_not_flattened', 'error', `${path}.centerline[t=${t}]`, `runway '${r.id}' not flattened at t=${t}`);
      } else if (t === 0) {
        t0Covering = covering;
      }
    }

    // Rule 11: runway_elevation_mismatch (skipped if the t=0 sample already failed rule 10).
    if (t0Covering !== undefined && t0Covering.length > 0) {
      let nearest = t0Covering[0]!;
      for (const c of t0Covering) {
        if (c.distM < nearest.distM) nearest = c;
      }
      if (Math.abs(r.elevationM - nearest.zone.elevationM) > RUNWAY_ELEVATION_MATCH_TOLERANCE_M) {
        err(errors, 'runway_elevation_mismatch', 'error', `${path}.elevationM`, `runway '${r.id}' elevation does not match its covering flatten zone`);
      }
    }

    if (r.ils !== undefined) {
      // Rule 12: ils_frequency_out_of_range
      const freq = r.ils.frequencyMhz;
      const steps = freq / ILS_FREQUENCY_STEP_MHZ;
      const stepAligned = Math.abs(Math.round(steps) - steps) <= 1e-6;
      if (freq < ILS_FREQUENCY_MIN_MHZ || freq > ILS_FREQUENCY_MAX_MHZ || !stepAligned) {
        err(errors, 'ils_frequency_out_of_range', 'error', `${path}.ils.frequencyMhz`, `runway '${r.id}' ILS frequency ${freq} invalid`);
      }
      // Rule 13: ils_glideslope_angle_out_of_range
      if (r.ils.glideslopeAngleRad !== undefined) {
        const g = r.ils.glideslopeAngleRad;
        if (g < ILS_GLIDESLOPE_ANGLE_MIN_RAD || g > ILS_GLIDESLOPE_ANGLE_MAX_RAD) {
          err(errors, 'ils_glideslope_angle_out_of_range', 'error', `${path}.ils.glideslopeAngleRad`, `runway '${r.id}' glideslope angle ${g} invalid`);
        }
      }
    }
  }

  // Rule 14: taxiway_too_few_points
  for (let i = 0; i < layout.taxiways.length; i++) {
    const t = layout.taxiways[i]!;
    if (t.points.length < TAXIWAY_MIN_POINTS) {
      err(errors, 'taxiway_too_few_points', 'error', `taxiways[${i}].points`, `taxiway '${t.id}' has too few points`);
    }
  }

  // Rule 15: apron_too_few_points
  for (let i = 0; i < layout.aprons.length; i++) {
    const a = layout.aprons[i]!;
    if (a.points.length < APRON_MIN_POINTS) {
      err(errors, 'apron_too_few_points', 'error', `aprons[${i}].points`, `apron '${a.id}' has too few points`);
    }
  }

  // Rule 16: parking_spot_outside_apron (warning).
  for (let i = 0; i < layout.parkingSpots.length; i++) {
    const p = layout.parkingSpots[i]!;
    let inAny = false;
    for (const a of layout.aprons) {
      if (pointInPolygon(p.worldX, p.worldZ, a.points)) {
        inAny = true;
        break;
      }
    }
    if (!inAny) {
      err(errors, 'parking_spot_outside_apron', 'warning', `parkingSpots[${i}]`, `parking spot '${p.id}' is outside every apron`);
    }
  }

  const hasError = errors.some((e) => e.severity === 'error');
  if (hasError) {
    return { ok: false, error: errors };
  }
  const warnings = errors.filter((e) => e.severity === 'warning');
  const outcome: AirportValidationOutcome = { layout, warnings };
  return { ok: true, value: outcome };
};

/**
 * loadAirportLayout(json) === parseAirportLayout(json) then, on success,
 * validateAirportLayout(...). (05-airport.md section 3's pseudocode reads
 * `p.value` on the parse-failure branch; that field does not exist on the
 * `{ok:false}` arm of `Result` — `p.error` is what actually carries the
 * AirportParseError[] there, so that is what this uses. Flagged as a spec
 * typo in this module's return-value report, not a contract violation.)
 */
export const loadAirportLayout: LoadAirportLayout = (json) => {
  const p = parseAirportLayout(json);
  if (!p.ok) {
    const errorList: readonly AirportIssue[] = p.error;
    return { ok: false, error: errorList };
  }
  const v = validateAirportLayout(p.value);
  if (!v.ok) {
    const errorList: readonly AirportIssue[] = v.error;
    return { ok: false, error: errorList };
  }
  const result: AirportLoadResult = { layout: v.value.layout, warnings: v.value.warnings };
  return { ok: true, value: result };
};
