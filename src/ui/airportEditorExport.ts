/**
 * src/ui/airportEditorExport.ts — implements ExportEditorLayout,
 * ImportEditorLayout, EncodeLayoutToUrlHash, DecodeLayoutFromUrlHash
 * (docs/spec/11-ui.md section 4.7).
 */
import type {
  DecodeLayoutFromUrlHash,
  EditorApron,
  EditorAirportLayout,
  EditorPoint,
  EditorRunway,
  EditorRunwayIls,
  EditorTaxiway,
  EncodeLayoutToUrlHash,
  ExportEditorLayout,
  ImportEditorLayout,
} from '../contracts/ui';
import { EDITOR_LAYOUT_FORMAT_VERSION } from '../contracts/ui';
import type { Result } from '../contracts/core';
import { computeFlattenZones, runwayDesignator } from './airportEditorGeometry';
import { validateEditorLayout } from './airportEditorValidate';

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const exportEditorLayout: ExportEditorLayout = (layout) => {
  const flattenZones = computeFlattenZones(layout);
  const obj = {
    formatVersion: EDITOR_LAYOUT_FORMAT_VERSION,
    id: layout.id,
    name: layout.name,
    referenceXM: layout.referenceXM,
    referenceZM: layout.referenceZM,
    elevationM: layout.elevationM,
    runways: layout.runways.map((r) => ({
      id: r.id,
      centerXM: r.centerXM,
      centerZM: r.centerZM,
      headingRad: r.headingRad,
      lengthM: r.lengthM,
      widthM: r.widthM,
      elevationM: r.elevationM,
      ilsPrimary: r.ilsPrimary,
      ilsReciprocal: r.ilsReciprocal,
      primaryDesignator: runwayDesignator(r.headingRad),
      reciprocalDesignator: runwayDesignator(r.headingRad + Math.PI),
    })),
    taxiways: layout.taxiways,
    aprons: layout.aprons,
    flattenZones,
  };
  return JSON.stringify(obj, null, 2);
};

function parseIls(v: unknown, path: string): Result<EditorRunwayIls | undefined, string> {
  if (v === undefined) return { ok: true, value: undefined };
  if (!isPlainObject(v)) return { ok: false, error: `missing or invalid field ${path}` };
  if (!isFiniteNumber(v.frequencyMhz)) return { ok: false, error: `missing or invalid field ${path}.frequencyMhz` };
  if (!isFiniteNumber(v.glideslopeAngleRad)) return { ok: false, error: `missing or invalid field ${path}.glideslopeAngleRad` };
  return { ok: true, value: { frequencyMhz: v.frequencyMhz, glideslopeAngleRad: v.glideslopeAngleRad } };
}

function parseRunway(v: unknown, index: number): Result<EditorRunway, string> {
  const path = `runways[${index}]`;
  if (!isPlainObject(v)) return { ok: false, error: `missing or invalid field ${path}` };
  if (!isString(v.id)) return { ok: false, error: `missing or invalid field ${path}.id` };
  if (!isFiniteNumber(v.centerXM)) return { ok: false, error: `missing or invalid field ${path}.centerXM` };
  if (!isFiniteNumber(v.centerZM)) return { ok: false, error: `missing or invalid field ${path}.centerZM` };
  if (!isFiniteNumber(v.headingRad)) return { ok: false, error: `missing or invalid field ${path}.headingRad` };
  if (!isFiniteNumber(v.lengthM)) return { ok: false, error: `missing or invalid field ${path}.lengthM` };
  if (!isFiniteNumber(v.widthM)) return { ok: false, error: `missing or invalid field ${path}.widthM` };
  if (!isFiniteNumber(v.elevationM)) return { ok: false, error: `missing or invalid field ${path}.elevationM` };
  const primary = parseIls(v.ilsPrimary, `${path}.ilsPrimary`);
  if (!primary.ok) return primary;
  const reciprocal = parseIls(v.ilsReciprocal, `${path}.ilsReciprocal`);
  if (!reciprocal.ok) return reciprocal;
  const runway: EditorRunway = {
    id: v.id,
    centerXM: v.centerXM,
    centerZM: v.centerZM,
    headingRad: v.headingRad,
    lengthM: v.lengthM,
    widthM: v.widthM,
    elevationM: v.elevationM,
  };
  if (primary.value !== undefined) runway.ilsPrimary = primary.value;
  if (reciprocal.value !== undefined) runway.ilsReciprocal = reciprocal.value;
  return { ok: true, value: runway };
}

function parsePoints(v: unknown, path: string): Result<EditorPoint[], string> {
  if (!Array.isArray(v)) return { ok: false, error: `missing or invalid field ${path}` };
  const points: EditorPoint[] = [];
  for (let i = 0; i < v.length; i++) {
    const p: unknown = v[i];
    if (!isPlainObject(p) || !isFiniteNumber(p.xM) || !isFiniteNumber(p.zM)) {
      return { ok: false, error: `missing or invalid field ${path}[${i}]` };
    }
    points.push({ xM: p.xM, zM: p.zM });
  }
  return { ok: true, value: points };
}

function parseTaxiway(v: unknown, index: number): Result<EditorTaxiway, string> {
  const path = `taxiways[${index}]`;
  if (!isPlainObject(v)) return { ok: false, error: `missing or invalid field ${path}` };
  if (!isString(v.id)) return { ok: false, error: `missing or invalid field ${path}.id` };
  if (!isFiniteNumber(v.widthM)) return { ok: false, error: `missing or invalid field ${path}.widthM` };
  const points = parsePoints(v.points, `${path}.points`);
  if (!points.ok) return points;
  return { ok: true, value: { id: v.id, widthM: v.widthM, points: points.value } };
}

function parseApron(v: unknown, index: number): Result<EditorApron, string> {
  const path = `aprons[${index}]`;
  if (!isPlainObject(v)) return { ok: false, error: `missing or invalid field ${path}` };
  if (!isString(v.id)) return { ok: false, error: `missing or invalid field ${path}.id` };
  if (!isFiniteNumber(v.elevationM)) return { ok: false, error: `missing or invalid field ${path}.elevationM` };
  const points = parsePoints(v.points, `${path}.points`);
  if (!points.ok) return points;
  return { ok: true, value: { id: v.id, elevationM: v.elevationM, points: points.value } };
}

/**
 * Reads only id, name, referenceXM, referenceZM, elevationM,
 * runways[].{...}, taxiways, aprons — any other top-level or per-runway key
 * (flattenZones, primaryDesignator, reciprocalDesignator, ...) is read and
 * discarded, never copied into the result. This is what lets this one
 * function accept both ExportEditorLayout's output and the reduced
 * URL-hash shape through one code path.
 */
export const importEditorLayout: ImportEditorLayout = (json) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'missing or invalid field root' };
  }

  if (parsed.formatVersion !== EDITOR_LAYOUT_FORMAT_VERSION) {
    return { ok: false, error: `unsupported formatVersion ${String(parsed.formatVersion)}, expected ${EDITOR_LAYOUT_FORMAT_VERSION}` };
  }

  if (!isString(parsed.id)) return { ok: false, error: 'missing or invalid field id' };
  if (!isString(parsed.name)) return { ok: false, error: 'missing or invalid field name' };
  if (!isFiniteNumber(parsed.elevationM)) return { ok: false, error: 'missing or invalid field elevationM' };
  if (!Array.isArray(parsed.runways)) return { ok: false, error: 'missing or invalid field runways' };
  if (!Array.isArray(parsed.taxiways)) return { ok: false, error: 'missing or invalid field taxiways' };
  if (!Array.isArray(parsed.aprons)) return { ok: false, error: 'missing or invalid field aprons' };

  const referenceXM = isFiniteNumber(parsed.referenceXM) ? parsed.referenceXM : 0;
  const referenceZM = isFiniteNumber(parsed.referenceZM) ? parsed.referenceZM : 0;

  const runways: EditorRunway[] = [];
  for (let i = 0; i < parsed.runways.length; i++) {
    const r = parseRunway(parsed.runways[i], i);
    if (!r.ok) return r;
    runways.push(r.value);
  }

  const taxiways: EditorTaxiway[] = [];
  for (let i = 0; i < parsed.taxiways.length; i++) {
    const t = parseTaxiway(parsed.taxiways[i], i);
    if (!t.ok) return t;
    taxiways.push(t.value);
  }

  const aprons: EditorApron[] = [];
  for (let i = 0; i < parsed.aprons.length; i++) {
    const a = parseApron(parsed.aprons[i], i);
    if (!a.ok) return a;
    aprons.push(a.value);
  }

  const built: EditorAirportLayout = {
    id: parsed.id,
    name: parsed.name,
    referenceXM,
    referenceZM,
    elevationM: parsed.elevationM,
    runways,
    taxiways,
    aprons,
  };

  const issues = validateEditorLayout(built);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    return { ok: false, error: errors.map((i) => i.message).join('; ') };
  }

  return { ok: true, value: built };
};

function bytesToBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(hash: string): Uint8Array {
  let b64 = hash.replace(/^#/, '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const encodeLayoutToUrlHash: EncodeLayoutToUrlHash = (layout) => {
  const json = JSON.stringify({
    formatVersion: EDITOR_LAYOUT_FORMAT_VERSION,
    id: layout.id,
    name: layout.name,
    referenceXM: layout.referenceXM,
    referenceZM: layout.referenceZM,
    elevationM: layout.elevationM,
    runways: layout.runways,
    taxiways: layout.taxiways,
    aprons: layout.aprons,
  });
  return bytesToBase64Url(json);
};

export const decodeLayoutFromUrlHash: DecodeLayoutFromUrlHash = (hash) => {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(hash);
  } catch {
    return { ok: false, error: 'invalid share link' };
  }
  let json: string;
  try {
    json = new TextDecoder().decode(bytes);
  } catch {
    return { ok: false, error: 'invalid share link' };
  }
  return importEditorLayout(json);
};
