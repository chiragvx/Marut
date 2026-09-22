/**
 * src/airport/ils.ts — localiser/glideslope deviation math (05-airport.md
 * section 4.7). Allocation-free: writes into `out` and returns it, called up
 * to 60 Hz per src/core.
 */

import type { IlsInfo } from '../contracts/core';
import { ILS_GS_FULL_SCALE_DEG, ILS_LOC_FULL_SCALE_DEG } from '../contracts/core';
import type { IlsDeviationAt } from '../contracts/airport';
import { ILS_GS_VALID_AZIMUTH_RAD, ILS_GS_VALID_RANGE_M, ILS_LOC_VALID_AZIMUTH_RAD, ILS_LOC_VALID_RANGE_M } from '../contracts/airport';
import { clamp } from '../math';

export const ilsDeviation: IlsDeviationAt = (aircraftPosWorld, ils, out) => {
  const h = ils.localiserHeadingRad;
  const dx = Math.sin(h);
  const dz = -Math.cos(h);
  const rx = Math.cos(h);
  const rz = Math.sin(h);

  const px = aircraftPosWorld.x;
  const py = aircraftPosWorld.y;
  const pz = aircraftPosWorld.z;

  // --- localiser ---
  const toLocX = px - ils.localiserOriginPos.x;
  const toLocZ = pz - ils.localiserOriginPos.z;
  const crossTrackM = toLocX * rx + toLocZ * rz;
  const distFromAntennaM = -(toLocX * dx + toLocZ * dz);
  const locAngleRad = Math.atan2(crossTrackM, distFromAntennaM);
  const locAngleDeg = (locAngleRad * 180) / Math.PI;
  let locNormalized = clamp(locAngleDeg / ILS_LOC_FULL_SCALE_DEG, -1, 1);

  // --- glideslope ---
  const toGsX = px - ils.glideslopeOriginPos.x;
  const toGsY = py - ils.glideslopeOriginPos.y;
  const toGsZ = pz - ils.glideslopeOriginPos.z;
  const horizRangeM = -(toGsX * dx + toGsZ * dz);
  const heightAboveM = toGsY;
  const actualAngleRad = Math.atan2(heightAboveM, horizRangeM);
  const deviationRad = actualAngleRad - ils.glideslopeAngleRad;
  const deviationDeg = (deviationRad * 180) / Math.PI;
  let gsNormalized = clamp(deviationDeg / ILS_GS_FULL_SCALE_DEG, -1, 1);

  // --- validity ---
  const gsAzimuthRad = Math.atan2(crossTrackM, horizRangeM);
  const valid =
    distFromAntennaM > 0 &&
    distFromAntennaM <= ILS_LOC_VALID_RANGE_M &&
    Math.abs(locAngleRad) <= ILS_LOC_VALID_AZIMUTH_RAD &&
    horizRangeM > 0 &&
    horizRangeM <= ILS_GS_VALID_RANGE_M &&
    Math.abs(gsAzimuthRad) <= ILS_GS_VALID_AZIMUTH_RAD;

  if (!valid) {
    locNormalized = 0;
    gsNormalized = 0;
  }

  out.locNormalized = locNormalized;
  out.gsNormalized = gsNormalized;
  out.valid = valid;
  return out;
};

/** Local re-export kept for tests that want the IlsInfo type without a second import line. */
export type { IlsInfo };
