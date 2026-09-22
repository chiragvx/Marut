/**
 * src/airport/runwayGeometry.ts — outline/centerline-dashes/threshold-bar
 * line lists for one runway (05-airport.md section 4.4). Not a hot path:
 * called once per loaded airport, may allocate.
 */

import type { Vec3Like } from '../contracts/core';
import type { GenerateRunwayGeometry, RunwayLineGeometry } from '../contracts/airport';
import {
  CENTERLINE_DASH_GAP_M,
  CENTERLINE_DASH_LENGTH_M,
  THRESHOLD_BAR_END_OFFSET_M,
  THRESHOLD_BAR_START_OFFSET_M,
  THRESHOLD_BAR_STRIPE_COUNT,
} from '../contracts/airport';

export const generateRunwayGeometry: GenerateRunwayGeometry = (runway) => {
  const h = runway.headingRad;
  const dx = Math.sin(h);
  const dz = -Math.cos(h);
  const rx = Math.cos(h);
  const rz = Math.sin(h);
  const halfWidth = runway.widthM / 2;
  const Tx = runway.thresholdWorldX;
  const Ty = runway.elevationM;
  const Tz = runway.thresholdWorldZ;
  const L = runway.lengthM;

  const c0: Vec3Like = { x: Tx - rx * halfWidth, y: Ty, z: Tz - rz * halfWidth };
  const c1: Vec3Like = { x: Tx + rx * halfWidth, y: Ty, z: Tz + rz * halfWidth };
  const c2: Vec3Like = { x: Tx + dx * L + rx * halfWidth, y: Ty, z: Tz + dz * L + rz * halfWidth };
  const c3: Vec3Like = { x: Tx + dx * L - rx * halfWidth, y: Ty, z: Tz + dz * L - rz * halfWidth };

  const outline: Vec3Like[] = [c0, c1, c1, c2, c2, c3, c3, c0];

  const centerlineDashes: Vec3Like[] = [];
  const dashCycle = CENTERLINE_DASH_LENGTH_M + CENTERLINE_DASH_GAP_M;
  for (let s = 0; s < L; s += dashCycle) {
    const sEnd = Math.min(s + CENTERLINE_DASH_LENGTH_M, L);
    centerlineDashes.push({ x: Tx + dx * s, y: Ty, z: Tz + dz * s });
    centerlineDashes.push({ x: Tx + dx * sEnd, y: Ty, z: Tz + dz * sEnd });
  }

  const thresholdBar: Vec3Like[] = [];
  for (let i = 0; i < THRESHOLD_BAR_STRIPE_COUNT; i++) {
    const offset = -halfWidth + (i + 0.5) * (runway.widthM / THRESHOLD_BAR_STRIPE_COUNT);
    thresholdBar.push({
      x: Tx + rx * offset + dx * THRESHOLD_BAR_START_OFFSET_M,
      y: Ty,
      z: Tz + rz * offset + dz * THRESHOLD_BAR_START_OFFSET_M,
    });
    thresholdBar.push({
      x: Tx + rx * offset + dx * THRESHOLD_BAR_END_OFFSET_M,
      y: Ty,
      z: Tz + rz * offset + dz * THRESHOLD_BAR_END_OFFSET_M,
    });
  }

  const result: RunwayLineGeometry = {
    runwayId: runway.id,
    outline: { points: outline },
    centerlineDashes: { points: centerlineDashes },
    thresholdBar: { points: thresholdBar },
  };
  return result;
};
