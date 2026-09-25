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
  Noise2D,
  PlainsShape,
  RawTerrainHeightFn,
  TerrainShape,
  Vec2Like,
  WarpFn,
} from '../contracts/terrain';

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

function buildCoast(s: CoastShape, n: ShapeNoiseFields, scratch: Vec2Like): RawTerrainHeightFn {
  return (x, z) => {
    const f = s.shoreWiggleFreq;
    const shoreX = s.shorelineXM + s.shoreWiggleM * (0.7 * n.meander(z * f, 11.3) + 0.3 * n.meander(z * f * 3.1, 29.7));
    const d = x - shoreX;
    n.warp(x, z, scratch);
    const fb = n.fbmN(scratch.x, scratch.z);
    if (d < 0) {
      // Continental shelf, deepening offshore, plus a scatter of islands near the coast.
      let h = Math.max(d * 0.01, -60);
      if (s.islandHeightM > 0) {
        const isl = Math.max(0, n.fbmN(x * 0.45 + 5000, z * 0.45) - 0.42) / 0.58;
        if (isl > 0) {
          // The -4 m offset sinks each island's fringe below the water; applied only where there is an island.
          const islandH = s.islandHeightM * isl * Math.sqrt(isl) * smoothstep(-30000, -3000, d) - 4;
          if (islandH > h) h = islandH;
        }
      }
      return h;
    }
    const plain = (s.plainRiseMPerKm * d) / 1000;
    const relief = s.plainReliefM * (0.5 + 0.5 * fb) * smoothstep(0, 2000, d);
    const hillsT = smoothstep(s.hillsStartM, s.hillsStartM + s.hillsRampM, d);
    const hills = hillsT * s.hillsHeightM * (0.45 + 0.55 * n.ridgeN(scratch.x, scratch.z) + 0.25 * fb);
    // Beach: rise from the waterline over the first ~250 m.
    return smoothstep(0, 250, d) * (1.5 + plain + relief) + hills;
  };
}

function buildPlains(s: PlainsShape, waterLevelM: number, n: ShapeNoiseFields, scratch: Vec2Like): RawTerrainHeightFn {
  // Precompute each river's unit direction and meander phase at its origin (so the meander is zero there).
  const rivers = s.rivers.map((r, i) => {
    const dx = r.x1 - r.x0;
    const dz = r.z1 - r.z0;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const lane = 17.3 + i * 41.7;
    return { r, ux: dx / len, uz: dz / len, lane, phase0: n.meander(0, lane) };
  });
  return (x, z) => {
    n.warp(x, z, scratch);
    let h = s.baseElevationM + s.reliefM * n.fbmN(scratch.x, scratch.z);
    for (const rv of rivers) {
      const r = rv.r;
      const px = x - r.x0;
      const pz = z - r.z0;
      const u = px * rv.ux + pz * rv.uz;
      const v = px * -rv.uz + pz * rv.ux;
      const f = r.meanderFreq;
      const c = r.meanderAmpM * (n.meander(u * f, rv.lane) - rv.phase0) + 0.35 * r.meanderAmpM * n.meander(u * f * 2.7, rv.lane + 5);
      const dist = Math.abs(v - c);
      const halfW = 0.5 * r.widthM * (1 + 0.25 * n.meander(u * f * 1.7, rv.lane + 9));
      if (dist > halfW + r.bankWidthM) continue;
      // Braided channel: sandbars poke just above the water in places.
      const bar = 7 * Math.max(0, n.meander(x / 350, z / 350 + rv.lane) - 0.4);
      const bed = waterLevelM - 3 + bar;
      const t = smoothstep(halfW, halfW + r.bankWidthM, dist);
      const hr = bed + (h - bed) * t;
      if (hr < h) h = hr;
    }
    return h;
  };
}

export function buildShapedHeight(shape: TerrainShape, waterLevelM: number | undefined, fields: ShapeNoiseFields): RawTerrainHeightFn {
  const scratch: Vec2Like = { x: 0, z: 0 };
  switch (shape.kind) {
    case 'coast':
      return buildCoast(shape, fields, scratch);
    case 'plains':
      return buildPlains(shape, waterLevelM ?? shape.baseElevationM - 8, fields, scratch);
  }
}
