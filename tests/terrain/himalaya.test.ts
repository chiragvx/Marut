/**
 * tests/terrain/himalaya.test.ts — the Himalaya theatre: its three airport layouts load cleanly and
 * sit exactly on their level pads, the lakes are water at their own levels, the game's sampler is
 * the terrain lab's height function, and the Free Flight starts (parked, runway, air) are sound.
 */
import { describe, expect, test } from 'vitest';
import type { AirportLayout } from '../../src/contracts/airport';
import { THEATRE_TERRAIN_PARAMS } from '../../src/contracts/terrain';
import { loadAirportLayout } from '../../src/airport';
import { createHeightSampler, terrainProfileFor, buildChunkGeometry, OCCLUSION_RADIUS_M, LAND_LEN_AT_ZERO, LAND_LEN_PER_V } from '../../src/terrain';
import { heightAt as labHeightAt, padBoxes, lakeShapes } from '../../src/terrain/himalaya/height';
import { buildAlpineEnvironment } from '../../src/terrain/himalaya';
import { AIRFIELDS, geo } from '../../src/terrain/himalaya/layout';
import { resolveBuiltinMission } from '../../src/core';
import * as core from '../../src/core';
import { createRealWorld, adaptWorldToHandle } from '../../tools/lib/worldAdapter';
import { buildHudAirbases, homeAirportIdFor } from '../../src/hud/airbaseMarkers';
import { freeFlightMission, BASES } from '../../src/core/missions/catalogue';
import ngari from '../../src/airport/layouts/ngari-gunsa.json';
import simikot from '../../src/airport/layouts/simikot.json';
import fukche from '../../src/airport/layouts/fukche-alg.json';

const RAW: Readonly<Record<string, unknown>> = { 'ngari-gunsa': ngari, simikot, 'fukche-alg': fukche };
const params = THEATRE_TERRAIN_PARAMS.himalaya;

function layout(id: string): AirportLayout {
  const r = loadAirportLayout(RAW[id]);
  if (!r.ok) throw new Error(`${id}: ${JSON.stringify(r.error)}`);
  return r.value.layout;
}
const layouts = Object.keys(RAW).map(layout);
const sampler = createHeightSampler(params, layouts.flatMap((l) => l.flattenZones));

describe('Himalaya airport layouts', () => {
  test.each(Object.keys(RAW))('%s loads with no errors and no warnings', (id) => {
    const r = loadAirportLayout(RAW[id]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.warnings ?? []).toEqual([]);
  });

  test.each(Object.keys(RAW))('%s: runway thresholds, pavement, stands and buildings sit on the terrain (1 m)', (id) => {
    const L = layout(id);
    const at = (x: number, z: number): void => {
      expect(Math.abs(sampler.heightAt(x, z) - L.elevationM)).toBeLessThan(1);
      expect(Math.abs(labHeightAt(x, z) - L.elevationM)).toBeLessThan(1);
      expect(sampler.isWaterAt?.(x, z) ?? false).toBe(false);
    };
    for (const r of L.runways) {
      expect(r.elevationM).toBe(L.elevationM);
      for (let f = 0; f <= 1; f += 0.125) at(r.thresholdWorldX + Math.sin(r.headingRad) * r.lengthM * f, r.thresholdWorldZ - Math.cos(r.headingRad) * r.lengthM * f);
    }
    for (const z of L.flattenZones) expect(z.elevationM).toBe(L.elevationM);
    for (const t of L.taxiways) for (const p of t.points) at(p.worldX, p.worldZ);
    for (const a of L.aprons) for (const p of a.points) at(p.worldX, p.worldZ);
    for (const p of L.parkingSpots) at(p.worldX, p.worldZ);
    for (const s of L.structures ?? []) at(s.worldX, s.worldZ);
  });

  test('each layout sits on the pad of the airfield that names it, at its elevation', () => {
    for (const a of AIRFIELDS.filter((f) => f.layoutId)) {
      const L = layout(a.layoutId!);
      const [x, z] = geo(a.lat, a.lon);
      expect(L.referenceWorldX).toBeCloseTo(x, 0);
      expect(L.referenceWorldZ).toBeCloseTo(z, 0);
      expect(L.elevationM).toBe(a.elev);
      const pad = padBoxes().find((p) => p.id === a.id)!;
      expect(L.runways[0]!.headingRad).toBeCloseTo((a.headingDeg * Math.PI) / 180, 3);
      expect(pad.elev).toBe(a.elev);
    }
  });
});

describe('Himalaya terrain', () => {
  test('the game sampler is the terrain lab height function (no flatten zone changes anything)', () => {
    for (let i = 0; i < 400; i++) {
      const x = -95000 + ((i * 7919) % 190000);
      const z = -95000 + ((i * 104729) % 190000);
      expect(sampler.groundHeightAt!(x, z)).toBe(labHeightAt(x, z));
    }
  });

  test('lakes are water at their own levels; the plateau round them is dry', () => {
    const lakes = lakeShapes();
    expect(lakes.length).toBe(2);
    for (const l of lakes) {
      expect(sampler.isWaterAt!(l.x, l.z)).toBe(true);
      expect(sampler.heightAt(l.x, l.z)).toBe(l.level);
      expect(sampler.groundHeightAt!(l.x, l.z)).toBeLessThan(l.level - 10);
      expect(sampler.waterLevelAt!(l.x, l.z)).toBe(l.level);
    }
    // Mansarovar (4,590 m) and Rakshastal (4,575 m) differ.
    expect(lakes[0]!.level).not.toBe(lakes[1]!.level);
    // Two lake radii out, on the side away from the other lake: ground, above the water.
    for (const l of lakes) {
      const o = lakes.find((k) => k !== l)!;
      const away = Math.sign(l.x - o.x);
      const x = l.x + away * l.rx * 2.1, z = l.z;
      expect(sampler.isWaterAt!(x, z)).toBe(false);
      expect(sampler.heightAt(x, z)).toBeGreaterThan(l.level);
    }
    // No other water on the map (2 km grid).
    let water = 0;
    for (let x = -100000; x <= 100000; x += 2000) for (let z = -100000; z <= 100000; z += 2000) if (sampler.isWaterAt!(x, z) && sampler.waterLevelAt!(x, z) === -Infinity) water++;
    expect(water).toBe(0);
  });

  test('chunk meshes: vertices are the sampler heights; the ring relief read off the grid matches 4 exact samples', () => {
    const p = terrainProfileFor('high', params);
    const s = createHeightSampler(params, []);
    for (const depth of [7, 4]) {
      const size = 200000 / 2 ** depth;
      const key = { depth, cx: Math.floor((-80000 + 100000) / size), cz: Math.floor((-88000 + 100000) / size) };
      const g = buildChunkGeometry(s, key, p.chunkGridQuads);
      const nVerts = (p.chunkGridQuads + 1) ** 2;
      let worst = 0;
      for (let v = 0; v < nVerts; v += 7) {
        const x = g.positions[v * 3]!, y = g.positions[v * 3 + 1]!, z = g.positions[v * 3 + 2]!;
        expect(y).toBeCloseTo(s.groundHeightAt!(x, z), 2);
        const len = Math.hypot(g.normals[v * 3]!, g.normals[v * 3 + 1]!, g.normals[v * 3 + 2]!);
        if (len >= 1) continue; // water
        const r = OCCLUSION_RADIUS_M;
        const ring = (s.groundHeightAt!(x + r, z) + s.groundHeightAt!(x - r, z) + s.groundHeightAt!(x, z + r) + s.groundHeightAt!(x, z - r)) / 4;
        const exact = Math.min(0.98, Math.max(0.3, LAND_LEN_AT_ZERO - (LAND_LEN_PER_V * (ring - y)) / r));
        if (depth === 7) worst = Math.max(worst, Math.abs(len - exact));
      }
      // Fine chunks (65 m grid): the linear read of the grid is within a few hundredths of exact.
      if (depth === 7) expect(worst).toBeLessThan(0.08);
    }
  });

  test('extra LOD depth and draw distance for the 7 km relief', () => {
    const p = terrainProfileFor('high', params);
    expect(p.maxLodDepth).toBe(7);
    expect(p.streamRadiusChunks * 781.25).toBeGreaterThanOrEqual(140000);
    expect(terrainProfileFor('high', THEATRE_TERRAIN_PARAMS.border).maxLodDepth).toBe(5);
  });

  test('the renderer gets the lakes and a dryness field that is wet in the south and dry in Tibet', () => {
    const env = buildAlpineEnvironment();
    expect(env.lakes.length).toBe(2);
    const d = env.dry;
    const at = (x: number, z: number): number => d.data[Math.round((z - d.originM) / d.stepM) * d.n + Math.round((x - d.originM) / d.stepM)]!;
    const [nx, nz] = geo(29.6, 80.3); // Pithoragarh hills
    const [tx, tz] = geo(32.1, 80.05); // Ngari
    expect(at(nx, nz)).toBeLessThan(80);
    expect(at(tx, tz)).toBeGreaterThan(220);
  });
});

describe('Himalaya missions', () => {
  test('himalaya-free starts on the Fukche strip with the three airfields', () => {
    const m = resolveBuiltinMission('himalaya-free');
    expect((m.world.airports as AirportLayout[]).map((a) => a.id).sort()).toEqual(['fukche-alg', 'ngari-gunsa', 'simikot']);
    expect(m.playerStart.airportId).toBe('fukche-alg');
    expect(m.playerStart.runwayId).toBe('14');
  });

  test('Fukche is a Free Flight base; its parked, runway and air starts resolve, the air start well clear of the ground', () => {
    const base = BASES.find((b) => b.id === 'fukche')!;
    expect(base.untested).toBe(true);
    expect(base.locked).toBeFalsy();
    const L = layout('fukche-alg');
    expect(L.parkingSpots.some((p) => p.id === base.parkingSpotId)).toBe(true);
    expect(freeFlightMission('fukche', 'parked').playerStart.parkingSpotId).toBe(base.parkingSpotId);
    expect(['14', '32']).toContain(freeFlightMission('fukche', 'runway').playerStart.runwayId);
    const air = freeFlightMission('fukche', 'air').playerStart;
    const pos = air.pos!;
    // Along the 9 km to the threshold the ground stays far below.
    const dx = Math.sin(air.headingRad!), dz = -Math.cos(air.headingRad!);
    for (let d = 0; d <= 9000; d += 250) expect(pos.y - sampler.heightAt(pos.x + dx * d, pos.z + dz * d)).toBeGreaterThan(1500);
  });

  test.each(['tejas-mk1', 'c-17'])('a %s on the Fukche runway (himalaya-free, &jet=) settles on its gear: no crash', (jet) => {
    const m0 = resolveBuiltinMission('himalaya-free');
    const { loadout: _l, loadoutId: _i, ...start } = m0.playerStart;
    const r = createRealWorld(core, { ...m0, playerStart: { ...start, aircraftId: jet } }, 42);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const h = adaptWorldToHandle(r.value);
    const types: string[] = [];
    for (let i = 0; i < 240; i++) {
      h.stepFixed();
      for (const e of h.drainEvents()) types.push(e.type);
    }
    expect(types).not.toContain('crash');
    expect(types).not.toContain('missionEnded');
  });

  test('the HUD home base (default nav airport) is the start airport in every Himalaya mission and Fukche start', () => {
    const home = (m: ReturnType<typeof resolveBuiltinMission>): string | undefined =>
      buildHudAirbases(m.world.airports as AirportLayout[], homeAirportIdFor(m.playerStart, m.world.airports as AirportLayout[])).find((b) => b.home)?.id;
    expect(home(resolveBuiltinMission('himalaya-free'))).toBe('fukche-alg');
    expect(home(resolveBuiltinMission('himalaya-ngari'))).toBe('ngari-gunsa');
    expect(home(resolveBuiltinMission('himalaya-simikot'))).toBe('simikot'); // air start: the nearest field
    for (const s of ['parked', 'runway', 'air'] as const) expect(home(freeFlightMission('fukche', s))).toBe('fukche-alg');
  });

  test('the dev starts at Ngari and Simikot resolve; the Simikot air start is clear of the ravine walls', () => {
    expect(resolveBuiltinMission('himalaya-ngari').playerStart.runwayId).toBe('33');
    const s = resolveBuiltinMission('himalaya-simikot').playerStart;
    const dx = Math.sin(s.headingRad!), dz = -Math.cos(s.headingRad!);
    for (let d = 0; d <= 3000; d += 250) expect(s.pos!.y - sampler.heightAt(s.pos!.x + dx * d, s.pos!.z + dz * d)).toBeGreaterThan(300);
  });
});
