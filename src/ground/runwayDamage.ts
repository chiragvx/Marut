/**
 * src/ground/runwayDamage.ts — runway cratering. A warhead going off on a runway's pavement leaves a
 * crater; with its heave and debris it makes a wider patch unusable. A runway is closed when no
 * minimum operating strip (MOS: MOS_LENGTH_M x MOS_WIDTH_M of clean pavement, along the runway) is
 * left anywhere on it. Both ends of a physical strip (a RunwayDef and its reciprocal) are one strip.
 */
import type { SimEvent, Vec3Like } from '../contracts/core';
import type { AirportLayout } from '../contracts/airport';
import type { WarheadProfile } from '../contracts/ground';

/** A fighter needs this much clean runway, m (length along it, width across it). */
export const MOS_LENGTH_M = 1200;
export const MOS_WIDTH_M = 15;
/** Heave and debris round a crater make this many crater radii unusable. */
export const CRATER_DENIAL_FACTOR = 2;

/** Crater radius, m, of a warhead going off on concrete: grows with the cube root of the charge; a penetrator goes off under the slab and lifts more of it. */
export function craterRadiusM(w: WarheadProfile): number {
  return 1.6 * Math.cbrt(w.explosiveKg) * (w.penetrator ? 1.5 : 1);
}

export interface RunwayCrater {
  /** Along the strip from its first threshold, and across it (right of the centreline), m. */
  s: number;
  c: number;
  radiusM: number;
}

export interface RunwayStrip {
  airportId: string;
  /** The first end's id, and "15R/33L" for messages. */
  runwayId: string;
  name: string;
  x0: number;
  z0: number;
  /** Unit vector along the strip (from the first threshold), in x/z. */
  ux: number;
  uz: number;
  lengthM: number;
  widthM: number;
  elevationM: number;
  craters: RunwayCrater[];
  closed: boolean;
}

export class RunwayDamage {
  readonly strips: RunwayStrip[] = [];

  /** The airport's runways (one strip per physical runway). */
  addAirport(layout: Partial<AirportLayout>): void {
    const seen = new Set<string>();
    for (const r of layout.runways ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (r.reciprocalId) seen.add(r.reciprocalId);
      this.strips.push({
        airportId: layout.id ?? '',
        runwayId: r.id,
        name: r.reciprocalId ? `${r.id}/${r.reciprocalId}` : r.id,
        x0: r.thresholdWorldX,
        z0: r.thresholdWorldZ,
        ux: Math.sin(r.headingRad),
        uz: -Math.cos(r.headingRad),
        lengthM: r.lengthM,
        widthM: r.widthM,
        elevationM: r.elevationM,
        craters: [],
        closed: false,
      });
    }
  }

  /** A warhead went off at `pos` on the ground: a crater on any runway it is on (and a runwayClosed event when that closes it). */
  impact(pos: Vec3Like, w: WarheadProfile, out: SimEvent[]): void {
    const r = craterRadiusM(w);
    for (const st of this.strips) {
      const dx = pos.x - st.x0, dz = pos.z - st.z0;
      const s = dx * st.ux + dz * st.uz;
      const c = dx * -st.uz + dz * st.ux;
      if (s < -r || s > st.lengthM + r || Math.abs(c) > st.widthM / 2 + r * 0.5) continue;
      st.craters.push({ s, c, radiusM: r });
      out.push({ type: 'runwayCrater', airportId: st.airportId, runwayId: st.runwayId, pos: { x: pos.x, y: pos.y, z: pos.z }, radiusM: r });
      if (!st.closed && longestUsableM(st) < MOS_LENGTH_M) {
        st.closed = true;
        out.push({ type: 'runwayClosed', airportId: st.airportId, runwayName: st.name });
      }
    }
  }

  /** Whether the airport's runways (or the one with that end id) are all closed. False when it has none. */
  isClosed(airportId: string, runwayId?: string): boolean {
    let any = false;
    for (const st of this.strips) {
      if (st.airportId !== airportId) continue;
      if (runwayId !== undefined && st.runwayId !== runwayId && !st.name.split('/').includes(runwayId)) continue;
      any = true;
      if (!st.closed) return false;
    }
    return any;
  }

  /** Whether (x, z) is inside a crater (a wheel there at speed is a wrecked jet). */
  inCrater(x: number, z: number): boolean {
    for (const st of this.strips) {
      if (st.craters.length === 0) continue;
      const dx = x - st.x0, dz = z - st.z0;
      const s = dx * st.ux + dz * st.uz;
      const c = dx * -st.uz + dz * st.ux;
      for (const k of st.craters) if ((s - k.s) ** 2 + (c - k.c) ** 2 < k.radiusM * k.radiusM) return true;
    }
    return false;
  }
}

/**
 * The longest stretch of the strip, m, along which some lane MOS_WIDTH_M wide (inside the pavement)
 * is clear of every crater's unusable patch.
 */
export function longestUsableM(st: RunwayStrip): number {
  const laneHalf = Math.min(MOS_WIDTH_M, st.widthM) / 2;
  const span = st.widthM / 2 - laneHalf;
  let best = 0;
  const blocked: [number, number][] = [];
  for (let lane = -span; lane <= span + 1e-6; lane += 1) {
    blocked.length = 0;
    for (const k of st.craters) {
      const d = k.radiusM * CRATER_DENIAL_FACTOR;
      // The patch (a disc) cuts the lane where it reaches into it.
      const off = Math.max(0, Math.abs(k.c - lane) - laneHalf);
      if (off >= d) continue;
      const h = Math.sqrt(d * d - off * off);
      blocked.push([k.s - h, k.s + h]);
    }
    blocked.sort((a, b) => a[0] - b[0]);
    let from = 0;
    for (const [a, b] of blocked) {
      if (a > from) best = Math.max(best, Math.min(a, st.lengthM) - from);
      from = Math.max(from, b);
      if (from >= st.lengthM) break;
    }
    if (from < st.lengthM) best = Math.max(best, st.lengthM - from);
    if (best >= st.lengthM) return best;
  }
  return best;
}
