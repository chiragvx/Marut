/**
 * src/ui/airportEditorGeometry.ts — pure geometry helpers for the airport
 * editor (docs/spec/11-ui.md sections 4.5.1, 4.5.5). No DOM access.
 */
import type {
  ComputeFlattenZones,
  EditorFlattenZone,
  EditorPoint,
  OrientedRect,
  PolygonAreaM2,
  PolygonCentroid,
  RectanglesOverlap,
  RunwayDesignator,
} from '../contracts/ui';
import { APRON_FLATTEN_BLEND_M, APRON_FLATTEN_MARGIN_M, RUNWAY_FLATTEN_BLEND_M, RUNWAY_FLATTEN_MARGIN_M } from '../contracts/ui';

/** heading -> 2-digit runway designator: round(degrees/10) mod 36, 0 mapped to 36. */
export const runwayDesignator: RunwayDesignator = (headingRad) => {
  const deg = ((headingRad * 180) / Math.PI % 360 + 360) % 360;
  let num = Math.round(deg / 10) % 36;
  if (num === 0) num = 36;
  return String(num).padStart(2, '0');
};

/** (sin h, -cos h) world X/Z components — matches forwardWorld() from 00-architecture.md §3.1. */
function forwardXZ(headingRad: number): EditorPoint {
  return { xM: Math.sin(headingRad), zM: -Math.cos(headingRad) };
}
/** forward rotated +90°. */
function rightXZ(headingRad: number): EditorPoint {
  return { xM: Math.cos(headingRad), zM: Math.sin(headingRad) };
}

export const rectanglesOverlap: RectanglesOverlap = (a: OrientedRect, b: OrientedRect) => {
  const forwardA = forwardXZ(a.headingRad);
  const rightA = rightXZ(a.headingRad);
  const forwardB = forwardXZ(b.headingRad);
  const rightB = rightXZ(b.headingRad);
  const axes = [forwardA, rightA, forwardB, rightB];

  const dx = b.centerXM - a.centerXM;
  const dz = b.centerZM - a.centerZM;

  for (const axis of axes) {
    const d = dx * axis.xM + dz * axis.zM;
    const ra =
      a.halfLengthM * Math.abs(forwardA.xM * axis.xM + forwardA.zM * axis.zM) +
      a.halfWidthM * Math.abs(rightA.xM * axis.xM + rightA.zM * axis.zM);
    const rb =
      b.halfLengthM * Math.abs(forwardB.xM * axis.xM + forwardB.zM * axis.zM) +
      b.halfWidthM * Math.abs(rightB.xM * axis.xM + rightB.zM * axis.zM);
    if (Math.abs(d) > ra + rb) return false;
  }
  return true;
};

export const polygonAreaM2: PolygonAreaM2 = (points) => {
  const n = points.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const p0 = points[i] as EditorPoint;
    const p1 = points[(i + 1) % n] as EditorPoint;
    sum += p0.xM * p1.zM - p1.xM * p0.zM;
  }
  return Math.abs(sum) * 0.5;
};

export const polygonCentroid: PolygonCentroid = (points, out) => {
  let sumX = 0;
  let sumZ = 0;
  for (const p of points) {
    sumX += p.xM;
    sumZ += p.zM;
  }
  const n = Math.max(1, points.length);
  out.xM = sumX / n;
  out.zM = sumZ / n;
  return out;
};

const centroidScratch: EditorPoint = { xM: 0, zM: 0 };

export const computeFlattenZones: ComputeFlattenZones = (layout) => {
  const zones: EditorFlattenZone[] = [];

  for (const r of layout.runways) {
    zones.push({
      centerWorldX: r.centerXM,
      centerWorldZ: r.centerZM,
      elevationM: r.elevationM,
      flatRadiusM: Math.hypot(r.lengthM / 2, r.widthM / 2) + RUNWAY_FLATTEN_MARGIN_M,
      blendRadiusM: RUNWAY_FLATTEN_BLEND_M,
    });
  }

  for (const p of layout.aprons) {
    const c = polygonCentroid(p.points, centroidScratch);
    let maxDist = 0;
    for (const pt of p.points) {
      const dist = Math.hypot(pt.xM - c.xM, pt.zM - c.zM);
      if (dist > maxDist) maxDist = dist;
    }
    zones.push({
      centerWorldX: c.xM,
      centerWorldZ: c.zM,
      elevationM: p.elevationM,
      flatRadiusM: maxDist + APRON_FLATTEN_MARGIN_M,
      blendRadiusM: APRON_FLATTEN_BLEND_M,
    });
  }

  return zones;
};
