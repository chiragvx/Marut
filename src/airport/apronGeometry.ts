/**
 * src/airport/apronGeometry.ts — closed polygon outline for one apron
 * (05-airport.md section 4.4).
 */

import type { Vec3Like } from '../contracts/core';
import type { ApronLineGeometry, GenerateApronGeometry } from '../contracts/airport';

export const generateApronGeometry: GenerateApronGeometry = (apron, elevationM) => {
  const pts = apron.points;
  const points: Vec3Like[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i]!;
    const p1 = pts[(i + 1) % pts.length]!;
    points.push({ x: p0.worldX, y: elevationM, z: p0.worldZ });
    points.push({ x: p1.worldX, y: elevationM, z: p1.worldZ });
  }
  const result: ApronLineGeometry = { apronId: apron.id, outline: { points } };
  return result;
};
