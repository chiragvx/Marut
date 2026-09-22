/**
 * src/ui/airportEditorValidate.ts — implements ValidateEditorLayout
 * (docs/spec/11-ui.md section 4.6). All 14 rules run unconditionally and
 * independently (no short-circuiting) so the full issue set is always
 * returned in one pass.
 */
import type { EditorAirportLayout, EditorRunway, EditorRunwayIls, EditorValidationIssue, OrientedRect, ValidateEditorLayout } from '../contracts/ui';
import {
  AIRPORT_ID_MAX_LEN,
  AIRPORT_ID_MIN_LEN,
  AIRPORT_NAME_MAX_LEN,
  APRON_MIN_AREA_M2,
  EDITOR_RUNWAY_LENGTH_MAX_M,
  EDITOR_RUNWAY_LENGTH_MIN_M,
  EDITOR_RUNWAY_WIDTH_MAX_M,
  EDITOR_RUNWAY_WIDTH_MIN_M,
  EditorValidationSeverity,
  ILS_FREQ_CHANNEL_STEP_MHZ,
  ILS_FREQ_MAX_MHZ,
  ILS_FREQ_MIN_MHZ,
  ILS_GLIDESLOPE_MAX_RAD,
  ILS_GLIDESLOPE_MIN_RAD,
} from '../contracts/ui';
import { polygonAreaM2, rectanglesOverlap } from './airportEditorGeometry';

const AIRPORT_ID_PATTERN = /^[a-z0-9-]+$/;
const FREQ_CHANNEL_EPSILON = 1e-6;

function toRect(r: EditorRunway): OrientedRect {
  return { centerXM: r.centerXM, centerZM: r.centerZM, headingRad: r.headingRad, halfLengthM: r.lengthM / 2, halfWidthM: r.widthM / 2 };
}

function checkIls(r: EditorRunway, end: 'ilsPrimary' | 'ilsReciprocal', ils: EditorRunwayIls, issues: EditorValidationIssue[]): void {
  if (ils.frequencyMhz < ILS_FREQ_MIN_MHZ || ils.frequencyMhz > ILS_FREQ_MAX_MHZ) {
    issues.push({
      severity: EditorValidationSeverity.Error,
      featureType: 'runway',
      featureId: r.id,
      message: `runway ${r.id} ILS frequency ${ils.frequencyMhz}MHz outside [${ILS_FREQ_MIN_MHZ.toFixed(2)},${ILS_FREQ_MAX_MHZ.toFixed(2)}]MHz`,
    });
  } else {
    const nearestChannel = Math.round(ils.frequencyMhz / ILS_FREQ_CHANNEL_STEP_MHZ) * ILS_FREQ_CHANNEL_STEP_MHZ;
    if (Math.abs(ils.frequencyMhz - nearestChannel) > FREQ_CHANNEL_EPSILON) {
      issues.push({
        severity: EditorValidationSeverity.Warning,
        featureType: 'runway',
        featureId: r.id,
        message: `runway ${r.id} ILS frequency ${ils.frequencyMhz}MHz is not on a ${ILS_FREQ_CHANNEL_STEP_MHZ}MHz channel`,
      });
    }
  }

  if (ils.glideslopeAngleRad < ILS_GLIDESLOPE_MIN_RAD || ils.glideslopeAngleRad > ILS_GLIDESLOPE_MAX_RAD) {
    const deg = (ils.glideslopeAngleRad * 180) / Math.PI;
    issues.push({
      severity: EditorValidationSeverity.Error,
      featureType: 'runway',
      featureId: r.id,
      message: `runway ${r.id} ILS glideslope ${deg.toFixed(2)}° outside [2°,4°] (end ${end})`,
    });
  }
}

export const validateEditorLayout: ValidateEditorLayout = (layout: EditorAirportLayout) => {
  const issues: EditorValidationIssue[] = [];

  // Rules 1, 2, 5, 6, 7: per-runway length/width/ILS.
  for (const r of layout.runways) {
    if (r.lengthM < EDITOR_RUNWAY_LENGTH_MIN_M || r.lengthM > EDITOR_RUNWAY_LENGTH_MAX_M) {
      issues.push({
        severity: EditorValidationSeverity.Error,
        featureType: 'runway',
        featureId: r.id,
        message: `runway ${r.id} length ${r.lengthM}m outside [${EDITOR_RUNWAY_LENGTH_MIN_M},${EDITOR_RUNWAY_LENGTH_MAX_M}]m`,
      });
    }
    if (r.widthM < EDITOR_RUNWAY_WIDTH_MIN_M || r.widthM > EDITOR_RUNWAY_WIDTH_MAX_M) {
      issues.push({
        severity: EditorValidationSeverity.Error,
        featureType: 'runway',
        featureId: r.id,
        message: `runway ${r.id} width ${r.widthM}m outside [${EDITOR_RUNWAY_WIDTH_MIN_M},${EDITOR_RUNWAY_WIDTH_MAX_M}]m`,
      });
    }
    if (r.ilsPrimary !== undefined) checkIls(r, 'ilsPrimary', r.ilsPrimary, issues);
    if (r.ilsReciprocal !== undefined) checkIls(r, 'ilsReciprocal', r.ilsReciprocal, issues);
  }

  // Rule 3: duplicate runway ids.
  {
    const counts = new Map<string, number>();
    for (const r of layout.runways) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
    for (const [id, count] of counts) {
      if (count > 1) {
        issues.push({ severity: EditorValidationSeverity.Error, featureType: 'runway', featureId: id, message: `duplicate runway id ${id}` });
      }
    }
  }

  // Rule 4: pairwise runway overlap.
  for (let i = 0; i < layout.runways.length; i++) {
    for (let j = i + 1; j < layout.runways.length; j++) {
      const a = layout.runways[i] as EditorRunway;
      const b = layout.runways[j] as EditorRunway;
      if (rectanglesOverlap(toRect(a), toRect(b))) {
        issues.push({
          severity: EditorValidationSeverity.Error,
          featureType: 'runway',
          featureId: a.id,
          message: `runway ${a.id} overlaps runway ${b.id}`,
        });
      }
    }
  }

  // Rule 8: taxiway point count.
  for (const t of layout.taxiways) {
    if (t.points.length < 2) {
      issues.push({ severity: EditorValidationSeverity.Error, featureType: 'taxiway', featureId: t.id, message: `taxiway ${t.id} has fewer than 2 points` });
    }
  }

  // Rule 9, 10: apron point count and area.
  for (const a of layout.aprons) {
    if (a.points.length < 3) {
      issues.push({ severity: EditorValidationSeverity.Error, featureType: 'apron', featureId: a.id, message: `apron ${a.id} has fewer than 3 points` });
    } else {
      const area = polygonAreaM2(a.points);
      if (area < APRON_MIN_AREA_M2) {
        issues.push({
          severity: EditorValidationSeverity.Warning,
          featureType: 'apron',
          featureId: a.id,
          message: `apron ${a.id} area ${area}m² is very small`,
        });
      }
    }
  }

  // Rule 11: duplicate ids, taxiways and aprons checked separately.
  {
    const taxiwayCounts = new Map<string, number>();
    for (const t of layout.taxiways) taxiwayCounts.set(t.id, (taxiwayCounts.get(t.id) ?? 0) + 1);
    for (const [id, count] of taxiwayCounts) {
      if (count > 1) {
        issues.push({ severity: EditorValidationSeverity.Error, featureType: 'taxiway', featureId: id, message: `duplicate taxiway id ${id}` });
      }
    }
    const apronCounts = new Map<string, number>();
    for (const a of layout.aprons) apronCounts.set(a.id, (apronCounts.get(a.id) ?? 0) + 1);
    for (const [id, count] of apronCounts) {
      if (count > 1) {
        issues.push({ severity: EditorValidationSeverity.Error, featureType: 'apron', featureId: id, message: `duplicate apron id ${id}` });
      }
    }
  }

  // Rule 12: at least one runway.
  if (layout.runways.length === 0) {
    issues.push({ severity: EditorValidationSeverity.Error, featureType: 'airport', message: 'airport must have at least one runway' });
  }

  // Rule 13: airport id charset/length.
  if (layout.id.length < AIRPORT_ID_MIN_LEN || layout.id.length > AIRPORT_ID_MAX_LEN || !AIRPORT_ID_PATTERN.test(layout.id)) {
    issues.push({ severity: EditorValidationSeverity.Error, featureType: 'airport', message: 'airport id must be 2-40 lowercase letters, digits or hyphens' });
  }

  // Rule 14: airport name length.
  if (layout.name.length === 0 || layout.name.length > AIRPORT_NAME_MAX_LEN) {
    issues.push({ severity: EditorValidationSeverity.Error, featureType: 'airport', message: 'airport name must be 1-80 characters' });
  }

  return issues;
};
