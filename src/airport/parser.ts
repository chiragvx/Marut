/**
 * src/airport/parser.ts — structural/type parse of untrusted JSON into a
 * typed AirportLayout. Does NOT check semantic/geometric consistency (see
 * validator.ts). Not a hot path: this may allocate freely.
 */

import type {
  AirportFlattenZone,
  AirportLayout,
  AirportParseError,
  AirportParseErrorCode,
  ApronDef,
  IlsDef,
  ParkingSpotDef,
  ParseAirportLayout,
  RunwayDef,
  RunwayLightsDef,
  TaxiwayDef,
  WorldPoint2,
} from '../contracts/airport';
import { ParkingSpotType, RunwaySurface } from '../contracts/airport';

type ErrList = AirportParseError[];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function joinPath(prefix: string, key: string): string {
  return prefix.length === 0 ? key : `${prefix}.${key}`;
}

function pushErr(errors: ErrList, code: AirportParseErrorCode, path: string, message: string): void {
  errors.push({ stage: 'parse', code, path, message });
}

function readString(obj: Record<string, unknown>, key: string, path: string, errors: ErrList): string | undefined {
  const v = obj[key];
  const p = joinPath(path, key);
  if (v === undefined) {
    pushErr(errors, 'missing_field', p, `missing required field '${key}'`);
    return undefined;
  }
  if (typeof v !== 'string') {
    pushErr(errors, 'wrong_type', p, `expected string for '${key}'`);
    return undefined;
  }
  return v;
}

function readOptionalString(obj: Record<string, unknown>, key: string, path: string, errors: ErrList): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    pushErr(errors, 'wrong_type', joinPath(path, key), `expected string for '${key}'`);
    return undefined;
  }
  return v;
}

function readNumber(obj: Record<string, unknown>, key: string, path: string, errors: ErrList): number | undefined {
  const v = obj[key];
  const p = joinPath(path, key);
  if (v === undefined) {
    pushErr(errors, 'missing_field', p, `missing required field '${key}'`);
    return undefined;
  }
  if (typeof v !== 'number' || Number.isNaN(v)) {
    pushErr(errors, 'wrong_type', p, `expected number for '${key}'`);
    return undefined;
  }
  return v;
}

function readOptionalNumber(obj: Record<string, unknown>, key: string, path: string, errors: ErrList): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || Number.isNaN(v)) {
    pushErr(errors, 'wrong_type', joinPath(path, key), `expected number for '${key}'`);
    return undefined;
  }
  return v;
}

function readBoolean(obj: Record<string, unknown>, key: string, path: string, errors: ErrList): boolean | undefined {
  const v = obj[key];
  const p = joinPath(path, key);
  if (v === undefined) {
    pushErr(errors, 'missing_field', p, `missing required field '${key}'`);
    return undefined;
  }
  if (typeof v !== 'boolean') {
    pushErr(errors, 'wrong_type', p, `expected boolean for '${key}'`);
    return undefined;
  }
  return v;
}

function readEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: ErrList,
  allowed: readonly T[]
): T | undefined {
  const v = obj[key];
  const p = joinPath(path, key);
  if (v === undefined) {
    pushErr(errors, 'missing_field', p, `missing required field '${key}'`);
    return undefined;
  }
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    pushErr(errors, 'invalid_enum_value', p, `invalid value for '${key}'`);
    return undefined;
  }
  return v as T;
}

function readObjectArray<T>(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: ErrList,
  itemParser: (item: unknown, itemPath: string, errors: ErrList) => T | undefined
): readonly T[] | undefined {
  const v = obj[key];
  const p = joinPath(path, key);
  if (v === undefined) {
    pushErr(errors, 'missing_field', p, `missing required field '${key}'`);
    return undefined;
  }
  if (!Array.isArray(v)) {
    pushErr(errors, 'wrong_type', p, `expected array for '${key}'`);
    return undefined;
  }
  const result: T[] = [];
  let ok = true;
  for (let i = 0; i < v.length; i++) {
    const parsed = itemParser(v[i], `${p}[${i}]`, errors);
    if (parsed === undefined) ok = false;
    else result.push(parsed);
  }
  return ok ? result : undefined;
}

function parseWorldPoint2(item: unknown, path: string, errors: ErrList): WorldPoint2 | undefined {
  if (!isPlainObject(item)) {
    pushErr(errors, 'not_an_object', path, 'expected an object');
    return undefined;
  }
  const worldX = readNumber(item, 'worldX', path, errors);
  const worldZ = readNumber(item, 'worldZ', path, errors);
  if (worldX === undefined || worldZ === undefined) return undefined;
  return { worldX, worldZ };
}

function parseFlattenZone(item: unknown, path: string, errors: ErrList): AirportFlattenZone | undefined {
  if (!isPlainObject(item)) {
    pushErr(errors, 'not_an_object', path, 'expected an object');
    return undefined;
  }
  const centerWorldX = readNumber(item, 'centerWorldX', path, errors);
  const centerWorldZ = readNumber(item, 'centerWorldZ', path, errors);
  const elevationM = readNumber(item, 'elevationM', path, errors);
  const flatRadiusM = readNumber(item, 'flatRadiusM', path, errors);
  const blendRadiusM = readNumber(item, 'blendRadiusM', path, errors);
  if (
    centerWorldX === undefined ||
    centerWorldZ === undefined ||
    elevationM === undefined ||
    flatRadiusM === undefined ||
    blendRadiusM === undefined
  ) {
    return undefined;
  }
  return { centerWorldX, centerWorldZ, elevationM, flatRadiusM, blendRadiusM };
}

function parseIlsDef(item: unknown, path: string, errors: ErrList): IlsDef | undefined {
  if (!isPlainObject(item)) {
    pushErr(errors, 'not_an_object', path, 'expected an object');
    return undefined;
  }
  const frequencyMhz = readNumber(item, 'frequencyMhz', path, errors);
  const glideslopeAngleRad = readOptionalNumber(item, 'glideslopeAngleRad', path, errors);
  const localiserOffsetBeyondFarEndM = readOptionalNumber(item, 'localiserOffsetBeyondFarEndM', path, errors);
  const glideslopeOffsetFromThresholdM = readOptionalNumber(item, 'glideslopeOffsetFromThresholdM', path, errors);
  if (frequencyMhz === undefined) return undefined;
  const result: IlsDef = { frequencyMhz };
  if (glideslopeAngleRad !== undefined) result.glideslopeAngleRad = glideslopeAngleRad;
  if (localiserOffsetBeyondFarEndM !== undefined) result.localiserOffsetBeyondFarEndM = localiserOffsetBeyondFarEndM;
  if (glideslopeOffsetFromThresholdM !== undefined) result.glideslopeOffsetFromThresholdM = glideslopeOffsetFromThresholdM;
  return result;
}

function parseRunwayLightsDef(item: unknown, path: string, errors: ErrList): RunwayLightsDef | undefined {
  if (!isPlainObject(item)) {
    pushErr(errors, 'not_an_object', path, 'expected an object');
    return undefined;
  }
  const edgeLights = readBoolean(item, 'edgeLights', path, errors);
  const thresholdLights = readBoolean(item, 'thresholdLights', path, errors);
  const approachLights = readBoolean(item, 'approachLights', path, errors);
  const papi = readBoolean(item, 'papi', path, errors);
  if (edgeLights === undefined || thresholdLights === undefined || approachLights === undefined || papi === undefined) {
    return undefined;
  }
  return { edgeLights, thresholdLights, approachLights, papi };
}

function parseRunway(item: unknown, path: string, errors: ErrList): RunwayDef | undefined {
  if (!isPlainObject(item)) {
    pushErr(errors, 'not_an_object', path, 'expected an object');
    return undefined;
  }
  const id = readString(item, 'id', path, errors);
  const thresholdWorldX = readNumber(item, 'thresholdWorldX', path, errors);
  const thresholdWorldZ = readNumber(item, 'thresholdWorldZ', path, errors);
  const elevationM = readNumber(item, 'elevationM', path, errors);
  const headingRad = readNumber(item, 'headingRad', path, errors);
  const lengthM = readNumber(item, 'lengthM', path, errors);
  const widthM = readNumber(item, 'widthM', path, errors);
  const surface = readEnum(item, 'surface', path, errors, [RunwaySurface.Asphalt, RunwaySurface.Concrete]);
  const reciprocalId = readOptionalString(item, 'reciprocalId', path, errors);

  let ils: IlsDef | undefined;
  let ilsFailed = false;
  const ilsRaw = item['ils'];
  if (ilsRaw !== undefined) {
    ils = parseIlsDef(ilsRaw, joinPath(path, 'ils'), errors);
    if (ils === undefined) ilsFailed = true;
  }

  let lights: RunwayLightsDef | undefined;
  let lightsFailed = false;
  const lightsRaw = item['lights'];
  if (lightsRaw !== undefined) {
    lights = parseRunwayLightsDef(lightsRaw, joinPath(path, 'lights'), errors);
    if (lights === undefined) lightsFailed = true;
  }

  if (
    id === undefined ||
    thresholdWorldX === undefined ||
    thresholdWorldZ === undefined ||
    elevationM === undefined ||
    headingRad === undefined ||
    lengthM === undefined ||
    widthM === undefined ||
    surface === undefined ||
    ilsFailed ||
    lightsFailed
  ) {
    return undefined;
  }

  const result: RunwayDef = { id, thresholdWorldX, thresholdWorldZ, elevationM, headingRad, lengthM, widthM, surface };
  if (reciprocalId !== undefined) result.reciprocalId = reciprocalId;
  if (ils !== undefined) result.ils = ils;
  if (lights !== undefined) result.lights = lights;
  return result;
}

function parseTaxiway(item: unknown, path: string, errors: ErrList): TaxiwayDef | undefined {
  if (!isPlainObject(item)) {
    pushErr(errors, 'not_an_object', path, 'expected an object');
    return undefined;
  }
  const id = readString(item, 'id', path, errors);
  const widthM = readNumber(item, 'widthM', path, errors);
  const points = readObjectArray(item, 'points', path, errors, parseWorldPoint2);
  if (id === undefined || widthM === undefined || points === undefined) return undefined;
  return { id, widthM, points };
}

function parseApron(item: unknown, path: string, errors: ErrList): ApronDef | undefined {
  if (!isPlainObject(item)) {
    pushErr(errors, 'not_an_object', path, 'expected an object');
    return undefined;
  }
  const id = readString(item, 'id', path, errors);
  const points = readObjectArray(item, 'points', path, errors, parseWorldPoint2);
  if (id === undefined || points === undefined) return undefined;
  return { id, points };
}

function parseParkingSpot(item: unknown, path: string, errors: ErrList): ParkingSpotDef | undefined {
  if (!isPlainObject(item)) {
    pushErr(errors, 'not_an_object', path, 'expected an object');
    return undefined;
  }
  const id = readString(item, 'id', path, errors);
  const worldX = readNumber(item, 'worldX', path, errors);
  const worldZ = readNumber(item, 'worldZ', path, errors);
  const headingRad = readNumber(item, 'headingRad', path, errors);
  const type = readEnum(item, 'type', path, errors, [
    ParkingSpotType.Fighter,
    ParkingSpotType.Transport,
    ParkingSpotType.Helicopter,
  ]);
  if (id === undefined || worldX === undefined || worldZ === undefined || headingRad === undefined || type === undefined) {
    return undefined;
  }
  return { id, worldX, worldZ, headingRad, type };
}

export const parseAirportLayout: ParseAirportLayout = (json) => {
  const errors: ErrList = [];

  if (!isPlainObject(json)) {
    pushErr(errors, 'not_an_object', '', 'root value must be an object');
    return { ok: false, error: errors };
  }

  const id = readString(json, 'id', '', errors);
  const name = readString(json, 'name', '', errors);
  const referenceWorldX = readNumber(json, 'referenceWorldX', '', errors);
  const referenceWorldZ = readNumber(json, 'referenceWorldZ', '', errors);
  const elevationM = readNumber(json, 'elevationM', '', errors);
  const flattenZones = readObjectArray(json, 'flattenZones', '', errors, parseFlattenZone);
  const runways = readObjectArray(json, 'runways', '', errors, parseRunway);
  const taxiways = readObjectArray(json, 'taxiways', '', errors, parseTaxiway);
  const aprons = readObjectArray(json, 'aprons', '', errors, parseApron);
  const parkingSpots = readObjectArray(json, 'parkingSpots', '', errors, parseParkingSpot);

  if (errors.length > 0) return { ok: false, error: errors };

  const layout: AirportLayout = {
    id: id!,
    name: name!,
    referenceWorldX: referenceWorldX!,
    referenceWorldZ: referenceWorldZ!,
    elevationM: elevationM!,
    flattenZones: flattenZones!,
    runways: runways!,
    taxiways: taxiways!,
    aprons: aprons!,
    parkingSpots: parkingSpots!,
  };
  return { ok: true, value: layout };
};
