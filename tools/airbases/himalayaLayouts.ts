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
 * so the zones only state the elevation for the validator (one per runway coverage sample), and
 * never reach the valley walls.
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
  for (const t of L['taxiways'] as { points: Pt[] }[]) t.points.forEach(mv);
  for (const a of L['aprons'] as { points: Pt[] }[]) a.points.forEach(mv);
  for (const p of L['parkingSpots'] as Pt[]) mv(p);
  for (const s of (L['structures'] as Pt[] | undefined) ?? []) mv(s);
  if (notes.attribution) L['attribution'] = `${L['attribution'] as string} ${notes.attribution}`;
  return L;
}

const md = readFileSync(DOC, 'utf8');
const pads = padBoxes();
for (const a of AIRFIELDS) {
  if (!a.layoutId) continue;
  const pad = pads.find((p) => p.id === a.id)!;
  const [ox, oz] = geo(a.lat, a.lon);
  const src = docBlock(md, a.layoutId);
  const L = place(src, ox, oz, a.id === 'fukche' ? { surface: 'asphalt', attribution: 'The real strip is graded gravel; drawn as asphalt until layouts have a gravel surface.' } : {});
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
  // Then a disc on every structure no zone covers yet, as big as fits in the pad (so the validator
  // knows they stand on level ground).
  for (const s of (L['structures'] as Pt[] | undefined) ?? []) {
    if (zones.some((z) => Math.hypot(s.worldX - z.centerWorldX, s.worldZ - z.centerWorldZ) <= z.flatRadiusM)) continue;
    const dx = s.worldX - pad.x, dz = s.worldZ - pad.z;
    const al = dx * pad.dx + dz * pad.dz, cr = dx * pad.rx + dz * pad.rz;
    const rs = Math.min(300, pad.halfAlong - Math.abs(al), cr - pad.c0, pad.c1 - cr) - 5;
    if (rs < 1) throw new Error(`${a.id}: structure at ${s.worldX}, ${s.worldZ} is outside the level pad`);
    zones.push({ centerWorldX: s.worldX, centerWorldZ: s.worldZ, elevationM: a.elev, flatRadiusM: Math.floor(rs), blendRadiusM: 0 });
  }
  L['flattenZones'] = zones;
  if (L['elevationM'] !== a.elev) throw new Error(`${a.id}: layout elevation ${String(L['elevationM'])} != pad ${a.elev}`);
  writeFileSync(`${OUT}/${a.layoutId}.json`, JSON.stringify(L, null, 1) + '\n', 'utf8');
  console.log(`${OUT}/${a.layoutId}.json at ${r1(ox)}, ${r1(oz)}, zones r ${Math.floor(r)} m`);
}
