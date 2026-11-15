/**
 * tools/airbases/himalayaLayouts.ts — writes the Himalaya theatre's airport layouts
 * (src/airport/layouts/ngari-gunsa.json, simikot.json, fukche-alg.json).
 *
 *     npx vite-node tools/airbases/himalayaLayouts.ts
 *
 * Source: the ready-made layout blocks in docs/spec/himalaya-airfields.md (sections 1.7, 2.7, 3.8;
 * OpenStreetMap geometry, (c) OpenStreetMap contributors, ODbL, plus generic facilities), whose
 * points are metres from the runway midpoint (x east, z south, true north up, real size). Each is
 * moved, unrotated and unscaled, onto its pad in the procedural terrain
 * (src/terrain/himalaya/layout.ts AIRFIELDS: the runway midpoint), and given flatten zones that
 * sit inside that pad: the terrain there is already exactly level (src/terrain/himalaya/height.ts),
 * so the zones only state the elevation for the validator (one per runway coverage sample) and for
 * the terrain mesh, which holds every vertex near a zone down to its elevation (so no coarse LOD
 * triangle buries pavement: hence zones over every point of every runway, taxiway and apron), and
 * never reach the valley walls.
 *
 * Fukche's runway, taxiway and dispersal are unpaved (surface 'dirt').
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { AIRFIELDS, geo } from '../../src/terrain/himalaya/layout';
import { padBoxes } from '../../src/terrain/himalaya/height';

const DOC = 'docs/spec/himalaya-airfields.md';
const OUT = 'src/airport/layouts';

type Json = Record<string, unknown>;
interface Pt { worldX: number; worldZ: number }

/** The ```json block in the doc whose layout id is `id`. */
function docBlock(md: string, id: string): Json {
  const re = /```json\r?\n([\s\S]*?)\r?\n```/g;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    const j = JSON.parse(m[1]!) as Json;
    if (j['id'] === id) return j;
  }
  throw new Error(`no layout block '${id}' in ${DOC}`);
}

const r1 = (v: number): number => Math.round(v * 10) / 10;

function place(src: Json, ox: number, oz: number, notes: { surface?: string; attribution?: string }): Json {
  const L = JSON.parse(JSON.stringify(src)) as Json;
  const mv = (p: Pt): void => { p.worldX = r1(p.worldX + ox); p.worldZ = r1(p.worldZ + oz); };
  L['referenceWorldX'] = r1(ox);
  L['referenceWorldZ'] = r1(oz);
  for (const r of L['runways'] as Json[]) {
    r['thresholdWorldX'] = r1((r['thresholdWorldX'] as number) + ox);
    r['thresholdWorldZ'] = r1((r['thresholdWorldZ'] as number) + oz);
    if (notes.surface) r['surface'] = notes.surface;
  }
  for (const t of L['taxiways'] as { points: Pt[]; surface?: string }[]) {
    t.points.forEach(mv);
    if (notes.surface) t.surface = notes.surface;
  }
  for (const a of L['aprons'] as { points: Pt[]; kind?: string; surface?: string }[]) {
    a.points.forEach(mv);
    if (notes.surface && (a.kind ?? 'apron') === 'apron') a.surface = notes.surface;
  }
  for (const p of L['parkingSpots'] as Pt[]) mv(p);
  for (const s of (L['structures'] as Pt[] | undefined) ?? []) mv(s);
  if (notes.attribution) L['attribution'] = `${L['attribution'] as string} ${notes.attribution}`;
  return L;
}

/** Points over all of a layout's runways, taxiways (straight segments) and aprons, ~4 m apart. */
function pavementPoints(L: Json): Pt[] {
  const out: Pt[] = [];
  const strip = (ax: number, az: number, bx: number, bz: number, hw: number): void => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / 4));
    const m = Math.max(1, Math.ceil((2 * hw) / 4));
    const lx = len > 0 ? -(bz - az) / len : 1, lz = len > 0 ? (bx - ax) / len : 0;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= m; j++) {
        const c = -hw + (2 * hw * j) / m;
        out.push({ worldX: ax + ((bx - ax) * i) / n + lx * c, worldZ: az + ((bz - az) * i) / n + lz * c });
      }
    }
  };
  for (const r of L['runways'] as Json[]) {
    const tx = r['thresholdWorldX'] as number, tz = r['thresholdWorldZ'] as number;
    const h = r['headingRad'] as number, len = r['lengthM'] as number;
    strip(tx, tz, tx + Math.sin(h) * len, tz - Math.cos(h) * len, (r['widthM'] as number) / 2);
  }
  for (const t of L['taxiways'] as { points: Pt[]; widthM: number }[]) {
    for (let i = 0; i + 1 < t.points.length; i++) strip(t.points[i]!.worldX, t.points[i]!.worldZ, t.points[i + 1]!.worldX, t.points[i + 1]!.worldZ, t.widthM / 2);
  }
  for (const a of L['aprons'] as { points: Pt[] }[]) {
    const P = a.points;
    const xs = P.map((p) => p.worldX), zs = P.map((p) => p.worldZ);
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 4) {
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += 4) {
        let inside = false;
        for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
          const pi = P[i]!, pj = P[j]!;
          if (pi.worldZ > z !== pj.worldZ > z && x < ((pj.worldX - pi.worldX) * (z - pi.worldZ)) / (pj.worldZ - pi.worldZ) + pi.worldX) inside = !inside;
        }
        if (inside) out.push({ worldX: x, worldZ: z });
      }
    }
    out.push(...P);
  }
  return out;
}

/**
 * Simikot town: flat-roofed houses (1-3 storeys) packed on the terrace north of the strip, between
 * the airport buildings and the hillside (the real town wraps the north side right up to the fence).
 * Deterministic. Positions are metres from the runway midpoint in the runway's frame (along the
 * heading, `c` to the right = south), turned into world offsets.
 */
function simikotTown(headingRad: number, ox: number, oz: number): Json[] {
  let seed = 2971;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const ax = Math.sin(headingRad), az = -Math.cos(headingRad);
  const rx = Math.cos(headingRad), rz = Math.sin(headingRad);
  const out: Json[] = [];
  let k = 0;
  for (let c = -175; c >= -320; c -= 26) {
    for (let a = -350; a <= 330; a += 24) {
      if (rnd() < 0.42) continue;
      const aa = a + (rnd() - 0.5) * 10, cc = c + (rnd() - 0.5) * 10;
      const w = 6 + rnd() * 6, l = 8 + rnd() * 8;
      const storeys = rnd() < 0.55 ? 1 : rnd() < 0.8 ? 2 : 3;
      out.push({
        id: `TOWN-${++k}`, kind: 'building',
        worldX: r1(ox + ax * aa + rx * cc), worldZ: r1(oz + az * aa + rz * cc),
        headingRad: Math.round((headingRad + (rnd() < 0.5 ? 0 : Math.PI / 2) + (rnd() - 0.5) * 0.25) * 1e4) / 1e4,
        widthM: r1(w), lengthM: r1(l), heightM: storeys * 3 + 0.5, group: 'town',
      });
    }
  }
  return out;
}

const md = readFileSync(DOC, 'utf8');
const pads = padBoxes();
for (const a of AIRFIELDS) {
  if (!a.layoutId) continue;
  const pad = pads.find((p) => p.id === a.id)!;
  const [ox, oz] = geo(a.lat, a.lon);
  const src = docBlock(md, a.layoutId);
  const L = place(src, ox, oz, a.id === 'fukche' ? { surface: 'dirt', attribution: 'Runway, taxiway and dispersal are unpaved (graded earth), as the real strip is.' } : {});
  if (a.id === 'simikot') {
    L['structures'] = [...((L['structures'] as Json[] | undefined) ?? []), ...simikotTown((a.headingDeg * Math.PI) / 180, ox, oz)];
    L['attribution'] = `${L['attribution'] as string} The town's houses are generic, placed by code.`;
  }
  // Flatten zones: discs on the runway centreline at the validator's coverage samples (the middle
  // first: the airfield mask centres on zone 0), as big as fits inside the level pad.
  const rw = (L['runways'] as Json[])[0]!;
  const len = rw['lengthM'] as number;
  const hd = rw['headingRad'] as number;
  const tx = rw['thresholdWorldX'] as number, tz = rw['thresholdWorldZ'] as number;
  const r = Math.min(300, -pad.c0 - 5, pad.c1 - 5, pad.halfAlong - len / 2 - 5);
  const zones = [0.5, 0, 0.25, 0.75, 1].map((t) => ({
    centerWorldX: r1(tx + Math.sin(hd) * len * t),
    centerWorldZ: r1(tz - Math.cos(hd) * len * t),
    elevationM: a.elev,
    flatRadiusM: Math.floor(r),
    blendRadiusM: 0,
  }));
  // Then a disc on every structure and every point of pavement (runways, taxiways, aprons, on a
  // 4 m grid) no zone covers yet, as big as fits in the pad (so the validator knows they stand on
  // level ground, and the terrain mesh keeps all of it at or below the pavement).
  const need: Pt[] = [...((L['structures'] as Pt[] | undefined) ?? []), ...pavementPoints(L)];
  for (const s of need) {
    if (zones.some((z) => Math.hypot(s.worldX - z.centerWorldX, s.worldZ - z.centerWorldZ) <= z.flatRadiusM)) continue;
    const dx = s.worldX - pad.x, dz = s.worldZ - pad.z;
    const al = dx * pad.dx + dz * pad.dz, cr = dx * pad.rx + dz * pad.rz;
    const rs = Math.min(300, pad.halfAlong - Math.abs(al), cr - pad.c0, pad.c1 - cr) - 5;
    if (rs < 1) throw new Error(`${a.id}: structure or pavement at ${s.worldX}, ${s.worldZ} is outside the level pad`);
    zones.push({ centerWorldX: r1(s.worldX), centerWorldZ: r1(s.worldZ), elevationM: a.elev, flatRadiusM: Math.floor(rs), blendRadiusM: 0 });
  }
  L['flattenZones'] = zones;
  if (L['elevationM'] !== a.elev) throw new Error(`${a.id}: layout elevation ${String(L['elevationM'])} != pad ${a.elev}`);
  writeFileSync(`${OUT}/${a.layoutId}.json`, JSON.stringify(L, null, 1) + '\n', 'utf8');
  console.log(`${OUT}/${a.layoutId}.json at ${r1(ox)}, ${r1(oz)}, zones r ${Math.floor(r)} m`);
}
