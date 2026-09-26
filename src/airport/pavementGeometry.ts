/**
 * src/airport/pavementGeometry.ts — one triangle mesh of an airbase's paved surfaces (aprons,
 * stopways, shelter pads, blast pads, taxiways, runways), with per-vertex surface coordinates the
 * pavement shader (src/render/airfieldPavement.ts) draws markings from.
 *
 * Triangles are emitted in draw order — aprons, shelter pads, blast pads, taxiways, runways — and
 * the mesh is drawn without depth writes, so later surfaces cover earlier ones where they overlap
 * (a taxiway over an apron edge, a runway over the taxiway that joins it) with no z-fighting.
 *
 * Per vertex:
 *  - position: world x, y (layout elevation + a few cm), z.
 *  - surf = (kind, u, v, p):
 *      runway:      u = metres along from the first threshold, v = metres across (right +), p = 0
 *      taxiway:     u = metres along the centreline, v = metres across, p = half width
 *      blast pad:   u, v in the nearest runway's frame (u < 0 before its first threshold, > length beyond)
 *      shelter pad: u = metres out from the door (negative inside), v = across
 *      apron:       u = world x, v = world z (slab joints)
 *  - extra: runway (length, width, designator code of the first end, of the other end); taxiway
 *    (direction x, z of the centreline, 0, 0);
 *    blast pad (runway length, runway width, 0, 0). Designator code = number * 10 + letter
 *    (0 none, 1 L, 2 R, 3 C), e.g. 15R -> 152.
 */
import type { AirportLayout, RunwayDef } from '../contracts/airport';

export const PavementKind = {
  Apron: 0,
  ShelterPad: 1,
  BlastPad: 2,
  Taxiway: 3,
  Runway: 4,
} as const;

export interface PavementGeometry {
  positions: Float32Array;
  surf: Float32Array;
  extra: Float32Array;
  indices: Uint32Array;
}

/** Height of the pavement above the flattened ground, m. */
const LIFT_M = 0.04;
/**
 * Longest straight run of a strip between vertices, m. The ground is drawn curving away with the
 * earth (atmCurve, per vertex), and a long pavement triangle is interpolated straight across that
 * curve: a 2.7 km runway quad sags up to 14 cm below the finely tessellated ground near the camera
 * and disappears into it. Cut into 80 m pieces, the error is under a millimetre.
 */
const MAX_PIECE_M = 80;
const JOIN_SEGMENTS = 10;

export function designatorCode(id: string): number {
  const n = parseInt(id.replace(/\D/g, ''), 10) || 0;
  const s = id.replace(/[0-9]/g, '').toUpperCase();
  return n * 10 + (s === 'L' ? 1 : s === 'R' ? 2 : s === 'C' ? 3 : 0);
}

/** Triangulates a simple polygon (either winding) by ear clipping. Returns index triples into pts. */
export function triangulate(pts: readonly [number, number][]): number[] {
  const n = pts.length;
  if (n < 3) return [];
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  const ccw = area > 0;
  const idx = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p: [number, number], a: [number, number], b: [number, number], c: [number, number]): boolean => {
    const d1 = cross(a, b, p);
    const d2 = cross(b, c, p);
    const d3 = cross(c, a, p);
    return ccw ? d1 >= 0 && d2 >= 0 && d3 >= 0 : d1 <= 0 && d2 <= 0 && d3 <= 0;
  };
  let guard = n * n;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length]!;
      const ib = idx[i]!;
      const ic = idx[(i + 1) % idx.length]!;
      const a = pts[ia]!;
      const b = pts[ib]!;
      const c = pts[ic]!;
      const cr = cross(a, b, c);
      if (ccw ? cr <= 1e-9 : cr >= -1e-9) continue; // reflex or degenerate
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inside(pts[j]!, a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // not simple: give up on the rest
  }
  if (idx.length === 3) out.push(idx[0]!, idx[1]!, idx[2]!);
  return out;
}

export function buildPavementGeometry(layouts: readonly AirportLayout[]): PavementGeometry {
  const pos: number[] = [];
  const surf: number[] = [];
  const extra: number[] = [];
  const index: number[] = [];
  const vert = (x: number, y: number, z: number, kind: number, u: number, v: number, p: number, e0 = 0, e1 = 0, e2 = 0, e3 = 0): number => {
    pos.push(x, y, z);
    surf.push(kind, u, v, p);
    extra.push(e0, e1, e2, e3);
    return pos.length / 3 - 1;
  };

  for (const L of layouts) {
    const y = L.elevationM + LIFT_M;
    // One entry per physical runway (the direction with the lower designator; one-way strips too).
    const runways: RunwayDef[] = [];
    for (const r of L.runways) {
      if (r.reciprocalId !== undefined) {
        const b = L.runways.find((x) => x.id === r.reciprocalId);
        if (b && designatorCode(b.id) < designatorCode(r.id)) continue;
      }
      runways.push(r);
    }
    const frame = (r: RunwayDef) => ({ fx: Math.sin(r.headingRad), fz: -Math.cos(r.headingRad), rx: Math.cos(r.headingRad), rz: Math.sin(r.headingRad) });

    const polygon = (points: readonly { worldX: number; worldZ: number }[], kind: number, uv: (x: number, z: number) => [number, number], e: [number, number, number, number] = [0, 0, 0, 0]): void => {
      const pts = points.map((p) => [p.worldX, p.worldZ] as [number, number]);
      const tri = triangulate(pts);
      const base = pos.length / 3;
      for (const [x, z] of pts) {
        const [u, v] = uv(x, z);
        vert(x, y, z, kind, u, v, 0, ...e);
      }
      for (const t of tri) index.push(base + t);
    };

    const aprons = L.aprons.filter((a) => (a.kind ?? 'apron') === 'apron' || a.kind === 'stopway');
    const pads = L.aprons.filter((a) => a.kind === 'shelter_pad');
    const blast = L.aprons.filter((a) => a.kind === 'blast_pad');

    for (const a of aprons) polygon(a.points, PavementKind.Apron, (x, z) => [x, z]);

    for (const a of pads) {
      // The pad's frame: the door is on its shorter axis nearer the matching shelter; fall back to
      // the polygon's own axes (p0 -> p1 runs from the back of the shelter out past the door).
      const p0 = a.points[0]!;
      const p1 = a.points[1]!;
      const p3 = a.points[3] ?? a.points[a.points.length - 1]!;
      const len = Math.hypot(p1.worldX - p0.worldX, p1.worldZ - p0.worldZ) || 1;
      const ux = (p1.worldX - p0.worldX) / len;
      const uz = (p1.worldZ - p0.worldZ) / len;
      const mx = (p0.worldX + p3.worldX) / 2;
      const mz = (p0.worldZ + p3.worldZ) / 2;
      const shelter = (L.structures ?? []).find((s) => s.kind === 'shelter' && Math.abs((s.worldX - mx) * -uz + (s.worldZ - mz) * ux) < 3 && (s.worldX - mx) * ux + (s.worldZ - mz) * uz > 0 && (s.worldX - mx) * ux + (s.worldZ - mz) * uz < len);
      const doorU = shelter ? (shelter.worldX - mx) * ux + (shelter.worldZ - mz) * uz + shelter.lengthM / 2 : len - 30;
      polygon(a.points, PavementKind.ShelterPad, (x, z) => [(x - mx) * ux + (z - mz) * uz - doorU, (x - mx) * -uz + (z - mz) * ux]);
    }

    for (const a of blast) {
      // Frame of the nearest runway.
      let cx = 0;
      let cz = 0;
      for (const p of a.points) {
        cx += p.worldX / a.points.length;
        cz += p.worldZ / a.points.length;
      }
      let best = runways[0];
      let bd = Infinity;
      for (const r of runways) {
        const f = frame(r);
        const dx = cx - r.thresholdWorldX;
        const dz = cz - r.thresholdWorldZ;
        const d = Math.abs(dx * f.rx + dz * f.rz);
        if (d < bd) {
          bd = d;
          best = r;
        }
      }
      if (!best) continue;
      const r = best;
      const f = frame(r);
      polygon(a.points, PavementKind.BlastPad, (x, z) => [(x - r.thresholdWorldX) * f.fx + (z - r.thresholdWorldZ) * f.fz, (x - r.thresholdWorldX) * f.rx + (z - r.thresholdWorldZ) * f.rz], [r.lengthM, r.widthM, 0, 0]);
    }

    for (const t of L.taxiways) {
      const P = t.points;
      const hw = t.widthM / 2;
      let u = 0;
      for (let i = 0; i < P.length - 1; i++) {
        const a = P[i]!;
        const b = P[i + 1]!;
        const len = Math.hypot(b.worldX - a.worldX, b.worldZ - a.worldZ);
        if (len < 1e-3) continue;
        const dx = (b.worldX - a.worldX) / len;
        const dz = (b.worldZ - a.worldZ) / len;
        const nx = -dz;
        const nz = dx;
        const pieces = Math.max(1, Math.ceil(len / MAX_PIECE_M));
        let l0 = vert(a.worldX + nx * hw, y, a.worldZ + nz * hw, PavementKind.Taxiway, u, hw, hw, dx, dz);
        let r0 = vert(a.worldX - nx * hw, y, a.worldZ - nz * hw, PavementKind.Taxiway, u, -hw, hw, dx, dz);
        for (let k = 1; k <= pieces; k++) {
          const s = (len * k) / pieces;
          const cx = a.worldX + dx * s;
          const cz = a.worldZ + dz * s;
          const l1 = vert(cx + nx * hw, y, cz + nz * hw, PavementKind.Taxiway, u + s, hw, hw, dx, dz);
          const r1 = vert(cx - nx * hw, y, cz - nz * hw, PavementKind.Taxiway, u + s, -hw, hw, dx, dz);
          index.push(l0, l1, r0, r0, l1, r1);
          l0 = l1;
          r0 = r1;
        }
        u += len;
      }
      // Round joins and ends: a disc at every point, v measured across the mean direction so the
      // centreline carries on through the join.
      let uAt = 0;
      for (let i = 0; i < P.length; i++) {
        const p = P[i]!;
        const prev = P[Math.max(0, i - 1)]!;
        const next = P[Math.min(P.length - 1, i + 1)]!;
        if (i > 0) uAt += Math.hypot(p.worldX - prev.worldX, p.worldZ - prev.worldZ);
        let dx = next.worldX - prev.worldX;
        let dz = next.worldZ - prev.worldZ;
        const dl = Math.hypot(dx, dz) || 1;
        dx /= dl;
        dz /= dl;
        const c = vert(p.worldX, y, p.worldZ, PavementKind.Taxiway, uAt, 0, hw, dx, dz);
        const ring: number[] = [];
        for (let k = 0; k < JOIN_SEGMENTS; k++) {
          const ang = (k / JOIN_SEGMENTS) * Math.PI * 2;
          const ox = Math.cos(ang) * hw;
          const oz = Math.sin(ang) * hw;
          ring.push(vert(p.worldX + ox, y, p.worldZ + oz, PavementKind.Taxiway, uAt + ox * dx + oz * dz, ox * -dz + oz * dx, hw, dx, dz));
        }
        for (let k = 0; k < JOIN_SEGMENTS; k++) index.push(c, ring[(k + 1) % JOIN_SEGMENTS]!, ring[k]!);
      }
    }

    for (const r of runways) {
      const f = frame(r);
      const hw = r.widthM / 2;
      const other = r.reciprocalId !== undefined ? L.runways.find((x) => x.id === r.reciprocalId) : undefined;
      const e: [number, number, number, number] = [r.lengthM, r.widthM, designatorCode(r.id), other ? designatorCode(other.id) : 0];
      const ax = r.thresholdWorldX;
      const az = r.thresholdWorldZ;
      const pieces = Math.max(1, Math.ceil(r.lengthM / MAX_PIECE_M));
      let l0 = vert(ax + f.rx * hw, y, az + f.rz * hw, PavementKind.Runway, 0, hw, 0, ...e);
      let r0 = vert(ax - f.rx * hw, y, az - f.rz * hw, PavementKind.Runway, 0, -hw, 0, ...e);
      for (let k = 1; k <= pieces; k++) {
        const s = (r.lengthM * k) / pieces;
        const cx = ax + f.fx * s;
        const cz = az + f.fz * s;
        const l1 = vert(cx + f.rx * hw, y, cz + f.rz * hw, PavementKind.Runway, s, hw, 0, ...e);
        const r1 = vert(cx - f.rx * hw, y, cz - f.rz * hw, PavementKind.Runway, s, -hw, 0, ...e);
        index.push(l0, l1, r0, r0, l1, r1);
        l0 = l1;
        r0 = r1;
      }
    }
  }
  return {
    positions: Float32Array.from(pos),
    surf: Float32Array.from(surf),
    extra: Float32Array.from(extra),
    indices: Uint32Array.from(index),
  };
}
