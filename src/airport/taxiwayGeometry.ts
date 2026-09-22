/**
 * src/airport/taxiwayGeometry.ts — two parallel edge lines per taxiway
 * (05-airport.md section 4.4). Built per-polyline-segment independently: no
 * mitred joints at turns (deliberate simplification, stated once here).
 */

import type { Vec3Like } from '../contracts/core';
import type { GenerateTaxiwayGeometry, TaxiwayLineGeometry } from '../contracts/airport';

export const generateTaxiwayGeometry: GenerateTaxiwayGeometry = (taxiway, elevationM) => {
  const halfWidth = taxiway.widthM / 2;
  const points: Vec3Like[] = [];

  for (let i = 0; i < taxiway.points.length - 1; i++) {
    const p0 = taxiway.points[i]!;
    const p1 = taxiway.points[i + 1]!;
    const segDx = p1.worldX - p0.worldX;
    const segDz = p1.worldZ - p0.worldZ;
    const segLen = Math.hypot(segDx, segDz);
    const dirX = segLen === 0 ? 0 : segDx / segLen;
    const dirZ = segLen === 0 ? 0 : segDz / segLen;
    const edgeRightX = -dirZ * halfWidth;
    const edgeRightZ = dirX * halfWidth;

    points.push({ x: p0.worldX + edgeRightX, y: elevationM, z: p0.worldZ + edgeRightZ });
    points.push({ x: p1.worldX + edgeRightX, y: elevationM, z: p1.worldZ + edgeRightZ });
    points.push({ x: p0.worldX - edgeRightX, y: elevationM, z: p0.worldZ - edgeRightZ });
    points.push({ x: p1.worldX - edgeRightX, y: elevationM, z: p1.worldZ - edgeRightZ });
  }

  const result: TaxiwayLineGeometry = { taxiwayId: taxiway.id, edges: { points } };
  return result;
};
