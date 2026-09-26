/**
 * src/airport/taxiGraph.ts — an airbase's taxi network as a graph, and routes through it, for
 * taxi guidance (src/hud/taxiGuide.ts).
 *
 * Nodes are the points of the taxiway centrelines as painted (smoothed through bends by
 * pavementGeometry.ts's smoothTaxiway, junctions merged), plus one node per parking spot joined to
 * the nearest taxiway point. A node on (or within a few metres of) a runway centreline is a runway
 * entry. Routes are shortest paths (Dijkstra; the graphs are a few thousand nodes at most).
 */
import type { AirportLayout, RunwayDef } from '../contracts/airport';
import { smoothTaxiway } from './pavementGeometry';

export interface TaxiGraph {
  nodes: [number, number][];
  adj: { to: number; len: number }[][];
  /** Nodes on a runway: the runway (a direction of it) and the distance from that direction's threshold. */
  entries: { node: number; runwayId: string; alongM: number }[];
  /** Parking spots (stands): node, spot id, stand number, heading (nose out). */
  stands: { node: number; spotId: string; number: number; headingRad: number }[];
}

export interface TaxiRoute {
  points: [number, number][];
  /** Index into points where the runway holding point is (routes to a runway), or -1. */
  holdIndex: number;
  /** "31", or "" for a route to a stand. */
  runwayId: string;
  /** The destination stand's number (route to a stand), or 0. */
  standNumber: number;
}

/** Distance of the runway-holding position from the runway centreline beyond its half width, m (matches the painted hold lines). */
export const HOLD_BEYOND_EDGE_M = 52.5;

export function buildTaxiGraph(L: AirportLayout): TaxiGraph {
  const nodes: [number, number][] = [];
  const adj: { to: number; len: number }[][] = [];
  const index = new Map<string, number>();
  const key = (x: number, z: number): string => `${Math.round(x * 2)},${Math.round(z * 2)}`;
  const node = (x: number, z: number): number => {
    const k = key(x, z);
    let n = index.get(k);
    if (n === undefined) {
      n = nodes.length;
      nodes.push([x, z]);
      adj.push([]);
      index.set(k, n);
    }
    return n;
  };
  const link = (a: number, b: number, costMul = 1): void => {
    if (a === b) return;
    const len = Math.hypot(nodes[a]![0] - nodes[b]![0], nodes[a]![1] - nodes[b]![1]) * costMul;
    if (!adj[a]!.some((e) => e.to === b)) adj[a]!.push({ to: b, len });
    if (!adj[b]!.some((e) => e.to === a)) adj[b]!.push({ to: a, len });
  };

  const seen = new Map<string, number>();
  for (const t of L.taxiways) for (const p of t.points) seen.set(key(p.worldX, p.worldZ), (seen.get(key(p.worldX, p.worldZ)) ?? 0) + 1);
  const fixed = (x: number, z: number, isEnd: boolean): boolean => isEnd || (seen.get(key(x, z)) ?? 0) > 1;
  for (const t of L.taxiways) {
    const pts = smoothTaxiway(t.points, fixed);
    let prev = -1;
    for (const [x, z] of pts) {
      const n = node(x, z);
      if (prev >= 0) link(prev, n);
      prev = n;
    }
  }
  // Dead ends that stop just short of another taxiway (the map's junction point was simplified
  // away): join them onto it by splitting the nearest segment.
  for (let i = 0; i < nodes.length; i++) {
    if (adj[i]!.length !== 1) continue;
    const [x, z] = nodes[i]!;
    let best: { a: number; b: number; t: number; d: number } | undefined;
    for (let a = 0; a < nodes.length; a++) {
      for (const e of adj[a]!) {
        const b = e.to;
        if (b < a || a === i || b === i || a === adj[i]![0]!.to || b === adj[i]![0]!.to) continue;
        const [ax, az] = nodes[a]!;
        const [bx, bz] = nodes[b]!;
        const ux = bx - ax;
        const uz = bz - az;
        const l2 = ux * ux + uz * uz || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - ax) * ux + (z - az) * uz) / l2));
        const d = Math.hypot(x - (ax + ux * t), z - (az + uz * t));
        if (d < 8 && (!best || d < best.d)) best = { a, b, t, d };
      }
    }
    if (!best) continue;
    const [ax, az] = nodes[best.a]!;
    const [bx, bz] = nodes[best.b]!;
    const m = node(ax + (bx - ax) * best.t, az + (bz - az) * best.t);
    // Replace a-b by a-m-b.
    adj[best.a] = adj[best.a]!.filter((e) => e.to !== best!.b);
    adj[best.b] = adj[best.b]!.filter((e) => e.to !== best!.a);
    link(best.a, m);
    link(m, best.b);
    link(i, m);
  }
  const taxiNodeCount = nodes.length;

  // Stands: each parking spot joined to the nearest taxiway point (the shelter's spur).
  const stands: TaxiGraph['stands'] = [];
  for (const p of L.parkingSpots) {
    let best = -1;
    let bd = 80;
    for (let i = 0; i < taxiNodeCount; i++) {
      const d = Math.hypot(nodes[i]![0] - p.worldX, nodes[i]![1] - p.worldZ);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best < 0) continue;
    const n = node(p.worldX, p.worldZ);
    link(n, best);
    stands.push({ node: n, spotId: p.id, number: parseInt(p.id.replace(/\D/g, ''), 10) || 0, headingRad: p.headingRad });
  }

  // Runway entries.
  const entries: TaxiGraph['entries'] = [];
  for (let i = 0; i < taxiNodeCount; i++) {
    const [x, z] = nodes[i]!;
    for (const r of L.runways) {
      const f = runwayFrame(r);
      const dx = x - r.thresholdWorldX;
      const dz = z - r.thresholdWorldZ;
      const along = dx * f.fx + dz * f.fz;
      const across = Math.abs(dx * f.rx + dz * f.rz);
      if (across < r.widthM / 2 + 5 && along > -30 && along < r.lengthM + 30) entries.push({ node: i, runwayId: r.id, alongM: along });
    }
  }
  // Along each runway, between its entries (taxiing on a runway costs three times as much, so
  // routes use one only where the taxiways do not connect otherwise).
  for (const r of L.runways) {
    const on = entries.filter((e) => e.runwayId === r.id).sort((a, b) => a.alongM - b.alongM);
    for (let k = 1; k < on.length; k++) link(on[k - 1]!.node, on[k]!.node, 3);
  }
  return { nodes, adj, entries, stands };
}

function runwayFrame(r: RunwayDef): { fx: number; fz: number; rx: number; rz: number } {
  return { fx: Math.sin(r.headingRad), fz: -Math.cos(r.headingRad), rx: Math.cos(r.headingRad), rz: Math.sin(r.headingRad) };
}

/** The graph node nearest (x, z), or -1 if none within maxM. */
export function nearestNode(g: TaxiGraph, x: number, z: number, maxM = 200): number {
  let best = -1;
  let bd = maxM;
  for (let i = 0; i < g.nodes.length; i++) {
    const d = Math.hypot(g.nodes[i]![0] - x, g.nodes[i]![1] - z);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Shortest paths from `from`: distances and predecessors. */
function dijkstra(g: TaxiGraph, from: number): { dist: Float64Array; prev: Int32Array } {
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[from] = 0;
  // Binary heap of [dist, node].
  const heap: [number, number][] = [[0, from]];
  const push = (e: [number, number]): void => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]![0] <= heap[i]![0]) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  while (heap.length > 0) {
    const [d, u] = pop();
    if (done[u]) continue;
    done[u] = 1;
    for (const e of g.adj[u]!) {
      const nd = d + e.len;
      if (nd < dist[e.to]!) {
        dist[e.to] = nd;
        prev[e.to] = u;
        push([nd, e.to]);
      }
    }
  }
  return { dist, prev };
}

function pathTo(g: TaxiGraph, prev: Int32Array, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (let n = to; n >= 0; n = prev[n]!) out.push(g.nodes[n]!);
  return out.reverse();
}

/**
 * Route from (x, z) to the runway `runwayId` for a full-length departure: to the reachable entry
 * nearest that direction's threshold. holdIndex marks the holding point (HOLD_BEYOND_EDGE_M
 * outside the runway edge) on the way in.
 */
export function routeToRunway(g: TaxiGraph, L: AirportLayout, x: number, z: number, runwayId: string): TaxiRoute | undefined {
  const start = nearestNode(g, x, z);
  const r = L.runways.find((q) => q.id === runwayId);
  if (start < 0 || !r) return undefined;
  const { dist, prev } = dijkstra(g, start);
  let best: { node: number; along: number } | undefined;
  for (const e of g.entries) {
    if (e.runwayId !== runwayId || !Number.isFinite(dist[e.node]!)) continue;
    if (!best || e.alongM < best.along) best = { node: e.node, along: e.alongM };
  }
  if (!best) return undefined;
  const points = pathTo(g, prev, best.node);
  const f = runwayFrame(r);
  const hold = r.widthM / 2 + HOLD_BEYOND_EDGE_M;
  let holdIndex = -1;
  for (let i = points.length - 1; i >= 0; i--) {
    const [px, pz] = points[i]!;
    const across = Math.abs((px - r.thresholdWorldX) * f.rx + (pz - r.thresholdWorldZ) * f.rz);
    if (across >= hold) {
      holdIndex = i;
      break;
    }
  }
  return { points, holdIndex, runwayId, standNumber: 0 };
}

/** Route from (x, z) to the nearest stand (by taxi distance). */
export function routeToStand(g: TaxiGraph, x: number, z: number): TaxiRoute | undefined {
  const start = nearestNode(g, x, z);
  if (start < 0) return undefined;
  const { dist, prev } = dijkstra(g, start);
  let best: TaxiGraph['stands'][number] | undefined;
  for (const s of g.stands) if (Number.isFinite(dist[s.node]!) && dist[s.node]! > 1 && (!best || dist[s.node]! < dist[best.node]!)) best = s;
  if (!best) return undefined;
  return { points: pathTo(g, prev, best.node), holdIndex: -1, runwayId: '', standNumber: best.number };
}

/** The runway direction to take off on: most headwind from `wind` (world m/s); calm = the first listed. */
export function activeRunway(L: AirportLayout, wind: { x: number; z: number }): string | undefined {
  let best: RunwayDef | undefined;
  let bs = -Infinity;
  for (const r of L.runways) {
    const f = runwayFrame(r);
    // Headwind: wind blowing against the take-off direction.
    const s = -(wind.x * f.fx + wind.z * f.fz);
    if (s > bs + 1e-6) {
      bs = s;
      best = r;
    }
  }
  return best?.id;
}
