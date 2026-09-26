/**
 * src/airport/airfieldAids.ts — where an airbase's visual aids go (pure; drawn by src/render):
 *
 * - Taxiway edge lights: blue, both sides of every taxiway, every 30 m (closer round bends).
 * - PAPI: four lamps beside each runway end with them (RunwayLightsDef.papi), on the left 300 m in,
 *   each set to a glide angle (outermost 2.5 deg ... nearest the runway 3.5 deg): on the 3 deg glide
 *   path the pilot sees two white and two red.
 * - Windsocks: one near each runway end, on the left, clear of the strip.
 * - Signs: red mandatory signs ("13-31") both sides of each taxiway at the runway holding point;
 *   yellow direction signs before taxiway junctions, pointing along the branch towards each runway
 *   end ("<- 31"); runway distance-remaining boards every 300 m along both edges.
 * - Floodlight masts: a few round each large apron, on open ground.
 */
import type { AirportLayout, RunwayDef } from '../contracts/airport';
import { buildTaxiGraph, HOLD_BEYOND_EDGE_M, shortestDistances } from './taxiGraph';
import { smoothTaxiway } from './pavementGeometry';

export type SignStyle = 'mandatory' | 'direction' | 'distance';

export interface AirfieldSign {
  x: number;
  z: number;
  /** The direction the readable face looks (towards the traffic that reads it), rad. */
  headingRad: number;
  text: string;
  style: SignStyle;
}

export interface AirfieldAids {
  groundY: number;
  taxiEdgeLights: [number, number][];
  papi: { x: number; z: number; approachX: number; approachZ: number; angleRad: number }[];
  windsocks: [number, number][];
  signs: AirfieldSign[];
  floodlights: [number, number][];
}

const D2R = Math.PI / 180;
const EDGE_SPACING_M = 30;
const EDGE_SPACING_BEND_M = 15;
const PAPI_ANGLES_DEG = [3.5, 3.17, 2.83, 2.5]; // nearest the runway first

const heading = (dx: number, dz: number): number => Math.atan2(dx, -dz);

function frame(r: RunwayDef): { fx: number; fz: number; rx: number; rz: number } {
  return { fx: Math.sin(r.headingRad), fz: -Math.cos(r.headingRad), rx: Math.cos(r.headingRad), rz: Math.sin(r.headingRad) };
}

export function buildAirfieldAids(L: AirportLayout): AirfieldAids {
  const aids: AirfieldAids = { groundY: L.elevationM, taxiEdgeLights: [], papi: [], windsocks: [], signs: [], floodlights: [] };

  // --- Taxiway edge lights ----------------------------------------------------------------------
  const key = (x: number, z: number): string => `${Math.round(x * 2)},${Math.round(z * 2)}`;
  const seen = new Map<string, number>();
  for (const t of L.taxiways) for (const p of t.points) seen.set(key(p.worldX, p.worldZ), (seen.get(key(p.worldX, p.worldZ)) ?? 0) + 1);
  const fixed = (x: number, z: number, isEnd: boolean): boolean => isEnd || (seen.get(key(x, z)) ?? 0) > 1;
  const onRunway = (x: number, z: number, margin: number): boolean =>
    L.runways.some((r) => {
      const f = frame(r);
      const dx = x - r.thresholdWorldX;
      const dz = z - r.thresholdWorldZ;
      const a = dx * f.fx + dz * f.fz;
      return a > -margin && a < r.lengthM + margin && Math.abs(dx * f.rx + dz * f.rz) < r.widthM / 2 + margin;
    });
  const pavedAt = (x: number, z: number): boolean => {
    for (const t of L.taxiways) {
      const hw = t.widthM / 2;
      for (let i = 1; i < t.points.length; i++) {
        const a = t.points[i - 1]!;
        const b = t.points[i]!;
        const ux = b.worldX - a.worldX;
        const uz = b.worldZ - a.worldZ;
        const l2 = ux * ux + uz * uz || 1e-9;
        const s = Math.max(0, Math.min(1, ((x - a.worldX) * ux + (z - a.worldZ) * uz) / l2));
        if (Math.hypot(x - (a.worldX + ux * s), z - (a.worldZ + uz * s)) < hw - 0.5) return true;
      }
    }
    return false;
  };
  const lightKeys = new Set<string>();
  for (const t of L.taxiways) {
    const pts = smoothTaxiway(t.points, fixed);
    const off = t.widthM / 2 + 1;
    let since = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1]!;
      const [bx, bz] = pts[i]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      const bend = i + 1 < pts.length && Math.abs(Math.atan2(pts[i + 1]![0] - bx, -(pts[i + 1]![1] - bz)) - heading(dx, dz)) > 3 * D2R;
      const spacing = bend ? EDGE_SPACING_BEND_M : EDGE_SPACING_M;
      for (let s = spacing - since; s <= len; s += spacing) {
        const cx = ax + dx * s;
        const cz = az + dz * s;
        for (const side of [-1, 1]) {
          const x = cx - dz * off * side;
          const z = cz + dx * off * side;
          // Not on the runway, not in the middle of another taxiway (junctions), no duplicates.
          if (onRunway(x, z, 3) || pavedAt(x, z)) continue;
          const k = `${Math.round(x / 4)},${Math.round(z / 4)}`;
          if (lightKeys.has(k)) continue;
          lightKeys.add(k);
          aids.taxiEdgeLights.push([x, z]);
        }
        since = len - s;
      }
      since = Math.min(since, spacing);
    }
  }

  // --- Runways: PAPI, windsocks, distance boards ------------------------------------------------
  for (const r of L.runways) {
    const f = frame(r);
    const hw = r.widthM / 2;
    if (r.lights?.papi) {
      for (let k = 0; k < 4; k++) {
        const out = hw + 15 + k * 9;
        aids.papi.push({ x: r.thresholdWorldX + f.fx * 300 - f.rx * out, z: r.thresholdWorldZ + f.fz * 300 - f.rz * out, approachX: -f.fx, approachZ: -f.fz, angleRad: PAPI_ANGLES_DEG[k]! * D2R });
      }
    }
    for (const [along, out] of [[180, 90], [180, -90], [260, 90], [260, -90], [120, 130], [120, -130], [320, 140], [320, -140]] as const) {
      const x = r.thresholdWorldX + f.fx * along - f.rx * (hw + Math.abs(out)) * Math.sign(out);
      const z = r.thresholdWorldZ + f.fz * along - f.rz * (hw + Math.abs(out)) * Math.sign(out);
      const clearOfStructures = (L.structures ?? []).every((s) => Math.hypot(s.worldX - x, s.worldZ - z) > Math.max(s.widthM, s.lengthM) * 0.6 + 12);
      if (clearOfStructures && !pavedAt(x, z) && !onRunway(x, z, 40)) {
        aids.windsocks.push([x, z]);
        break;
      }
    }
    // Distance remaining (thousands of feet), each board facing traffic rolling this way, on the left.
    const ft = r.lengthM / 0.3048;
    for (let n = Math.floor(ft / 1000); n >= 1; n--) {
      const along = r.lengthM - n * 304.8;
      if (along < 150) continue;
      aids.signs.push({ x: r.thresholdWorldX + f.fx * along - f.rx * (hw + 20), z: r.thresholdWorldZ + f.fz * along - f.rz * (hw + 20), headingRad: r.headingRad + Math.PI, text: String(n), style: 'distance' });
    }
  }

  // --- Signs from the taxi network ---------------------------------------------------------------
  const g = buildTaxiGraph(L);
  // Physical runway name, lower designator first ("13-31").
  const runwayName = (r: RunwayDef): string => {
    const other = r.reciprocalId ? L.runways.find((q) => q.id === r.reciprocalId) : undefined;
    const ids = [r.id, other?.id].filter((x): x is string => !!x);
    ids.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    return ids.join('-');
  };
  // Holding points: where a taxiway crosses a runway's holding distance, a red sign on each side.
  const holdKeys = new Set<string>();
  for (const t of L.taxiways) {
    const pts = smoothTaxiway(t.points, fixed);
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1]!;
      const [bx, bz] = pts[i]!;
      for (const r of L.runways) {
        const f = frame(r);
        const hd = r.widthM / 2 + HOLD_BEYOND_EDGE_M;
        const acr = (x: number, z: number): number => (x - r.thresholdWorldX) * f.rx + (z - r.thresholdWorldZ) * f.rz;
        const alo = (x: number, z: number): number => (x - r.thresholdWorldX) * f.fx + (z - r.thresholdWorldZ) * f.fz;
        const a0 = acr(ax, az);
        const a1 = acr(bx, bz);
        for (const side of [-1, 1]) {
          const h = side * hd;
          if ((a0 - h) * (a1 - h) > 0 || a0 === a1) continue;
          const s = (h - a0) / (a1 - a0);
          const x = ax + (bx - ax) * s;
          const z = az + (bz - az) * s;
          const along = alo(x, z);
          if (along < -60 || along > r.lengthM + 60) continue;
          const k = `${Math.round(x / 20)},${Math.round(z / 20)}`;
          if (holdKeys.has(k)) continue;
          holdKeys.add(k);
          // Facing the traffic coming from outside towards the runway.
          const inX = -Math.sign(h) * f.rx;
          const inZ = -Math.sign(h) * f.rz;
          const face = heading(-inX, -inZ);
          const w = (L.taxiways.find((q) => q === t)?.widthM ?? 16) / 2 + 6;
          for (const lr of [-1, 1]) {
            aids.signs.push({ x: x - inX * 3 + -inZ * w * lr, z: z - inZ * 3 + inX * w * lr, headingRad: face, text: runwayName(r), style: 'mandatory' });
          }
        }
      }
    }
  }
  // Direction signs: before each junction, on the left of each approach, pointing along the branch
  // that leads (shortest) to each runway end.
  const ends = L.runways.map((r) => {
    let best = -1;
    let bd = Infinity;
    for (const e of g.entries) {
      if (e.runwayId !== r.id) continue;
      if (e.alongM < bd) {
        bd = e.alongM;
        best = e.node;
      }
    }
    return { id: r.id, node: best };
  });
  const distFrom = ends.map((e) => (e.node >= 0 ? shortestDistances(g, e.node) : undefined));
  const entryNodes = new Set(g.entries.map((e) => e.node));
  for (let j = 0; j < g.nodes.length; j++) {
    const nb = g.adj[j]!;
    if (nb.length < 3 || entryNodes.has(j)) continue;
    const [jx, jz] = g.nodes[j]!;
    if (onRunway(jx, jz, 20)) continue;
    for (const inc of nb) {
      const [ix, iz] = g.nodes[inc.to]!;
      const inLen = Math.hypot(jx - ix, jz - iz);
      if (inLen < 25) continue;
      const inH = heading(jx - ix, jz - iz); // travel direction arriving at the junction
      const labels: { dh: number; text: string }[] = [];
      ends.forEach((end, ei) => {
        const dist = distFrom[ei];
        if (!dist) return;
        let bestK = -1;
        let bestD = dist[j]!;
        for (const out of nb) {
          if (out.to === inc.to) continue;
          const d = out.len + dist[out.to]!;
          if (d <= bestD + 1e-6) {
            bestD = d;
            bestK = out.to;
          }
        }
        if (bestK < 0) return;
        const [ox, oz] = g.nodes[bestK]!;
        let dh = heading(ox - jx, oz - jz) - inH;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        const arrow = Math.abs(dh) < 25 * D2R ? '^' : dh < 0 ? '<' : '>';
        labels.push({ dh, text: arrow === '>' ? `${end.id}>` : arrow === '<' ? `<${end.id}` : `^${end.id}` });
      });
      if (labels.length === 0) continue;
      labels.sort((a, b) => a.dh - b.dh);
      const text = labels.map((l) => l.text).join(' ');
      // 20 m before the junction, on the left of the approach, facing it.
      const ux = (jx - ix) / inLen;
      const uz = (jz - iz) / inLen;
      const back = Math.min(20, inLen * 0.5);
      aids.signs.push({ x: jx - ux * back + uz * 14, z: jz - uz * back - ux * 14, headingRad: inH + Math.PI, text, style: 'direction' });
    }
  }

  // --- Floodlight masts: a few round each large apron -------------------------------------------
  // Along the apron's outline every ~150 m, 12 m outside it, only on open ground (not on any
  // taxiway, apron or runway strip) and at least 120 m from any other mast; at most 4 per apron.
  const aprons = L.aprons.filter((a) => (a.kind ?? 'apron') === 'apron' && a.points.length >= 3);
  const inPoly = (pts: readonly { worldX: number; worldZ: number }[], x: number, z: number): boolean => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const p = pts[i]!;
      const q = pts[j]!;
      if (p.worldZ > z !== q.worldZ > z && x < ((q.worldX - p.worldX) * (z - p.worldZ)) / (q.worldZ - p.worldZ) + p.worldX) inside = !inside;
    }
    return inside;
  };
  const onAnyApron = (x: number, z: number): boolean => L.aprons.some((a) => a.points.length >= 3 && inPoly(a.points, x, z));
  for (const a of aprons) {
    let area = 0;
    for (let i = 0; i < a.points.length; i++) {
      const p = a.points[i]!;
      const q = a.points[(i + 1) % a.points.length]!;
      area += p.worldX * q.worldZ - q.worldX * p.worldZ;
    }
    if (Math.abs(area) / 2 < 20000) continue;
    const sign = area > 0 ? 1 : -1; // outward normal side for this winding
    let placed = 0;
    let carry = 75;
    for (let i = 0; i < a.points.length && placed < 4; i++) {
      const p = a.points[i]!;
      const q = a.points[(i + 1) % a.points.length]!;
      const len = Math.hypot(q.worldX - p.worldX, q.worldZ - p.worldZ);
      if (len < 1e-3) continue;
      const dx = (q.worldX - p.worldX) / len;
      const dz = (q.worldZ - p.worldZ) / len;
      for (let t = carry; t < len && placed < 4; t += 150) {
        // Outward normal: for counter-clockwise (x, z) winding it is (dz, -dx).
        const x = p.worldX + dx * t + dz * 12 * sign;
        const z = p.worldZ + dz * t - dx * 12 * sign;
        if (onAnyApron(x, z) || pavedAt(x, z) || onRunway(x, z, 80)) continue;
        if (aids.floodlights.some(([fx, fz]) => Math.hypot(fx - x, fz - z) < 120)) continue;
        if ((L.structures ?? []).some((st) => Math.hypot(st.worldX - x, st.worldZ - z) < Math.max(st.widthM, st.lengthM) * 0.6 + 8)) continue;
        aids.floodlights.push([x, z]);
        placed++;
      }
      carry = Math.max(0, 150 - (len % 150));
    }
  }
  return aids;
}
