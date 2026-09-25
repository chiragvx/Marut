/**
 * src/terrain/theatreShapes.ts — theatre landforms (coast, river plains).
 *
 * Each builder turns a `TerrainShape` into a RawTerrainHeightFn using the same noise fields the
 * generic band terrain uses (domain-warped fbm and ridged noise, normalised here to [-1,1] and
 * [0,1]). The shapes set the large-scale form deterministically — where the shoreline, rivers and
 * rivers are — so airports can be placed on known ground, and the noise only adds detail.
 */
import type {
  CoastShape,
  EstuarySpec,
  Noise2D,
  PlainsShape,
  RawTerrainHeightFn,
  TerrainShape,
  Vec2Like,
  WarpFn,
} from '../contracts/terrain';
import { RIVER_FLOATS, packRiver, riverField, type RiverField } from './riverMath';

export interface ShapeNoiseFields {
  /** Domain-warped fbm, normalised to roughly [-1,1]. */
  fbmN: Noise2D;
  /** Domain-warped ridged noise, normalised to [0,1]. */
  ridgeN: Noise2D;
  /** Raw [-1,1] simplex noise used for 1D meanders (sampled at (t, laneOffset)). */
  meander: Noise2D;
  warp: WarpFn;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = (x - e0) / (e1 - e0);
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Shoreline X and headland weight (0 = beach, 1 = rocky headland) at `z`. Shared with src/render via buildCoastProfile. */
export function coastLineAt(s: CoastShape, meander: Noise2D, z: number, out: Vec2Like): Vec2Like {
  const f = s.shoreWiggleFreq;
  const headland = smoothstep(0.2, 0.45, meander(z * s.headlandFreq, 71.9));
  out.x = s.shorelineXM + s.shoreWiggleM * (0.7 * meander(z * f, 11.3) + 0.3 * meander(z * f * 3.1, 29.7)) - s.headlandProtrusionM * headland;
  out.z = headland;
  return out;
}

interface EstuaryPre {
  e: EstuarySpec;
  ux: number;
  uz: number;
  lane: number;
  phase0: number;
}

function buildCoast(s: CoastShape, n: ShapeNoiseFields, scratch: Vec2Like): RawTerrainHeightFn {
  const line: Vec2Like = { x: 0, z: 0 };
  const estuaries: EstuaryPre[] = s.estuaries.map((e, i) => {
    const lane = 91.3 + i * 13.7;
    return { e, ux: Math.sin(e.headingRad), uz: -Math.cos(e.headingRad), lane, phase0: n.meander(0, lane) };
  });
  return (x, z) => {
    coastLineAt(s, n.meander, z, line);
    const headland = line.z;
    const d = x - line.x;
    n.warp(x, z, scratch);
    const fb = n.fbmN(scratch.x, scratch.z);
    let h: number;
    if (d < 0) {
      // Continental shelf, deepening offshore (shallow rock shelf off the headlands), plus islands.
      h = Math.max(d * (0.01 - 0.006 * headland), -60);
      if (s.islandHeightM > 0) {
        const isl = Math.max(0, n.fbmN(x * 0.45 + 5000, z * 0.45) - 0.42) / 0.58;
        if (isl > 0) {
          // The -4 m offset sinks each island's fringe below the water; applied only where there is an island.
          const islandH = s.islandHeightM * isl * Math.sqrt(isl) * smoothstep(-30000, -3000, d) - 4;
          if (islandH > h) h = islandH;
        }
      }
    } else {
      const plain = (s.plainRiseMPerKm * d) / 1000;
      const relief = s.plainReliefM * (0.5 + 0.5 * fb) * smoothstep(0, 2000, d);
      const hillsT = smoothstep(s.hillsStartM, s.hillsStartM + s.hillsRampM, d);
      // Escarpment: ridged spurs on the scarp face, a gentler Deccan plateau behind it.
      const scarp = hillsT * (1 - smoothstep(s.hillsStartM + s.hillsRampM, s.hillsStartM + s.hillsRampM + 8000, d));
      const hills = hillsT * s.hillsHeightM * (0.85 + 0.06 * fb) + scarp * s.hillsHeightM * 0.45 * n.ridgeN(scratch.x, scratch.z);
      // Flat-topped laterite plateaus (mesas) on the coastal plain: steep sides, flat tops.
      const mesa = s.plateauHeightM * smoothstep(0.08, 0.2, n.fbmN(scratch.x * 0.5 + 1234, scratch.z * 0.5)) * smoothstep(1500, 4000, d) * (1 - hillsT);
      // Beach (rises over ~250 m) or headland cliff (rises over ~90 m).
      const beach = smoothstep(0, 250, d) * (1.5 + plain + relief);
      const cliff = s.headlandHeightM * (0.75 + 0.25 * fb) * smoothstep(0, 90, d) + smoothstep(0, 250, d) * (plain + relief);
      h = beach + (cliff - beach) * headland + mesa + hills;
    }
    for (const es of estuaries) {
      const e = es.e;
      const px = x - e.mouthX;
      const pz = z - e.mouthZ;
      const u = px * es.ux + pz * es.uz;
      if (u < 0 || u > e.lengthM) continue;
      const v = px * -es.uz + pz * es.ux;
      const c = e.meanderAmpM * (n.meander(u * e.meanderFreq, es.lane) - es.phase0) * smoothstep(0, 8000, u);
      const halfW = 0.5 * (e.inlandWidthM + (e.mouthWidthM - e.inlandWidthM) * Math.exp(-u / e.taperM)) * (1 - smoothstep(e.lengthM * 0.8, e.lengthM, u));
      const dist = Math.abs(v - c);
      if (dist > halfW + e.bankWidthM) continue;
      const bed = -4;
      const hr = bed + (h - bed) * smoothstep(halfW, halfW + e.bankWidthM, dist);
      if (hr < h) h = hr;
    }
    return h;
  };
}

function buildPlains(s: PlainsShape, waterLevelM: number, seed: number, n: ShapeNoiseFields, scratch: Vec2Like): RawTerrainHeightFn {
  // Rivers are pure maths (riverMath.ts), shared with the ground shader so water edges match.
  const packed = new Float32Array(s.rivers.length * RIVER_FLOATS);
  s.rivers.forEach((r, i) => packRiver(r, i, seed, packed, i * RIVER_FLOATS));
  const f: RiverField = { water: 0, belt: 0, bar: 0 };
  // Heights relative to the water: channels below it, sandbars just above, the belt terrace
  // (khadar) ~2.2 m above, then a ~200 m bluff up to the plain.
  const TERRACE = 2.2;
  const BAR = 0.8;
  return (x, z) => {
    n.warp(x, z, scratch);
    let h = s.baseElevationM + s.reliefM * n.fbmN(scratch.x, scratch.z);
    for (let i = 0; i < s.rivers.length; i++) {
      riverField(packed, i * RIVER_FLOATS, x, z, f);
      if (f.belt < -200) continue;
      const terrace = waterLevelM + TERRACE + 0.5 * n.meander(x / 700, z / 700 + i * 13.1);
      const t = f.belt >= 0 ? 1 : 1 - (-f.belt / 200) * (-f.belt / 200) * (3 - 2 * (-f.belt / 200));
      let hr = h + (terrace - h) * t;
      if (f.bar > 0 && f.water <= 0) hr = Math.min(hr, waterLevelM + BAR);
      if (f.water > 0) hr = waterLevelM - Math.min(3, 0.5 + f.water * 0.02);
      if (hr < h) h = hr;
    }
    return h;
  };
}

export function buildShapedHeight(shape: TerrainShape, waterLevelM: number | undefined, fields: ShapeNoiseFields, seed = 0): RawTerrainHeightFn {
  const scratch: Vec2Like = { x: 0, z: 0 };
  switch (shape.kind) {
    case 'coast':
      return buildCoast(shape, fields, scratch);
    case 'plains':
      return buildPlains(shape, waterLevelM ?? shape.baseElevationM - 8, seed, fields, scratch);
  }
}
