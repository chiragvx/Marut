/**
 * src/airport/lights.ts — static light-point geometry (05-airport.md
 * section 4.4) and the live PAPI lamp-colour solve (section 4.8).
 * `generateAirportLights` is not a hot path. `papiColorAt` IS a per-frame
 * render hot path (called by src/hud): allocation-free, writes into `out`.
 */

import type { Vec3Like } from '../contracts/core';
import { ILS_DEFAULT_GLIDESLOPE_RAD } from '../contracts/core';
import type { AirportLightPoint, GenerateAirportLights, PapiColorAt, PapiState } from '../contracts/airport';
import {
  APPROACH_LIGHT_RUN_M,
  APPROACH_LIGHT_SPACING_M,
  EDGE_LIGHT_SPACING_M,
  ILS_GLIDESLOPE_DEFAULT_OFFSET_M,
  LightColor,
  LightKind,
  PAPI_LAMP_LATERAL_SPACING_M,
  PAPI_LAMP_OFFSETS_RAD,
  PAPI_LATERAL_OFFSET_FROM_CENTERLINE_M,
  PAPI_ORIGIN_OFFSET_FROM_THRESHOLD_M,
  THRESHOLD_BAR_STRIPE_COUNT,
} from '../contracts/airport';

export const generateAirportLights: GenerateAirportLights = (layout) => {
  const points: AirportLightPoint[] = [];

  for (const r of layout.runways) {
    const h = r.headingRad;
    const dx = Math.sin(h);
    const dz = -Math.cos(h);
    const rx = Math.cos(h);
    const rz = Math.sin(h);
    const Tx = r.thresholdWorldX;
    const Ty = r.elevationM;
    const Tz = r.thresholdWorldZ;
    const halfWidth = r.widthM / 2;

    if (r.lights?.edgeLights) {
      for (let s = 0; s <= r.lengthM; s += EDGE_LIGHT_SPACING_M) {
        points.push({
          pos: { x: Tx + rx * halfWidth + dx * s, y: Ty, z: Tz + rz * halfWidth + dz * s },
          kind: LightKind.RunwayEdge,
          colorHint: LightColor.White,
        });
        points.push({
          pos: { x: Tx - rx * halfWidth + dx * s, y: Ty, z: Tz - rz * halfWidth + dz * s },
          kind: LightKind.RunwayEdge,
          colorHint: LightColor.White,
        });
      }
    }

    if (r.lights?.thresholdLights) {
      for (let i = 0; i < THRESHOLD_BAR_STRIPE_COUNT; i++) {
        const offset = -halfWidth + (i + 0.5) * (r.widthM / THRESHOLD_BAR_STRIPE_COUNT);
        points.push({
          pos: { x: Tx + rx * offset, y: Ty, z: Tz + rz * offset },
          kind: LightKind.RunwayThreshold,
          colorHint: LightColor.Green,
        });
      }
    }

    if (r.lights?.approachLights) {
      for (let s = -APPROACH_LIGHT_RUN_M; s <= -APPROACH_LIGHT_SPACING_M; s += APPROACH_LIGHT_SPACING_M) {
        points.push({
          pos: { x: Tx + dx * s, y: Ty, z: Tz + dz * s },
          kind: LightKind.ApproachLead,
          colorHint: LightColor.White,
        });
      }
    }

    if (r.lights?.papi) {
      for (let i = 0; i < 4; i++) {
        const lateral = PAPI_LATERAL_OFFSET_FROM_CENTERLINE_M + (i - 1.5) * PAPI_LAMP_LATERAL_SPACING_M;
        points.push({
          pos: {
            x: Tx + dx * PAPI_ORIGIN_OFFSET_FROM_THRESHOLD_M + rx * lateral,
            y: Ty,
            z: Tz + dz * PAPI_ORIGIN_OFFSET_FROM_THRESHOLD_M + rz * lateral,
          },
          kind: LightKind.Papi,
          colorHint: LightColor.White,
        });
      }
    }
  }

  for (const t of layout.taxiways) {
    const halfWidth = t.widthM / 2;
    for (let i = 0; i < t.points.length - 1; i++) {
      const p0 = t.points[i]!;
      const p1 = t.points[i + 1]!;
      const segDx = p1.worldX - p0.worldX;
      const segDz = p1.worldZ - p0.worldZ;
      const segLen = Math.hypot(segDx, segDz);
      const dirX = segLen === 0 ? 0 : segDx / segLen;
      const dirZ = segLen === 0 ? 0 : segDz / segLen;
      const edgeRightX = -dirZ * halfWidth;
      const edgeRightZ = dirX * halfWidth;

      for (let s = 0; s <= segLen; s += EDGE_LIGHT_SPACING_M) {
        const px = p0.worldX + dirX * s;
        const pz = p0.worldZ + dirZ * s;
        points.push({
          pos: { x: px + edgeRightX, y: layout.elevationM, z: pz + edgeRightZ },
          kind: LightKind.TaxiwayEdge,
          colorHint: LightColor.Blue,
        });
        points.push({
          pos: { x: px - edgeRightX, y: layout.elevationM, z: pz - edgeRightZ },
          kind: LightKind.TaxiwayEdge,
          colorHint: LightColor.Blue,
        });
      }
    }
  }

  return points;
};

export const papiColorAt: PapiColorAt = (runway, observerPosWorld, out) => {
  if (!runway.lights?.papi) return undefined;

  const h = runway.headingRad;
  const dx = Math.sin(h);
  const dz = -Math.cos(h);
  const gsOffset = runway.ils?.glideslopeOffsetFromThresholdM ?? ILS_GLIDESLOPE_DEFAULT_OFFSET_M;
  const gsAngle = runway.ils?.glideslopeAngleRad ?? ILS_DEFAULT_GLIDESLOPE_RAD;

  const gsOx = runway.thresholdWorldX + dx * gsOffset;
  const gsOy = runway.elevationM;
  const gsOz = runway.thresholdWorldZ + dz * gsOffset;

  const toGsX = observerPosWorld.x - gsOx;
  const toGsY = observerPosWorld.y - gsOy;
  const toGsZ = observerPosWorld.z - gsOz;
  const actualAngleRad = Math.atan2(toGsY, -(toGsX * dx + toGsZ * dz));

  const off = PAPI_LAMP_OFFSETS_RAD;
  const colors = out.colors as [LightColor, LightColor, LightColor, LightColor];
  colors[0] = actualAngleRad >= gsAngle + off[0] ? LightColor.White : LightColor.Red;
  colors[1] = actualAngleRad >= gsAngle + off[1] ? LightColor.White : LightColor.Red;
  colors[2] = actualAngleRad >= gsAngle + off[2] ? LightColor.White : LightColor.Red;
  colors[3] = actualAngleRad >= gsAngle + off[3] ? LightColor.White : LightColor.Red;
  out.runwayId = runway.id;
  return out;
};

/** Local re-export kept for consumers that only import from this file. */
export type { PapiState, Vec3Like };
