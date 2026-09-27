import { describe, expect, test } from 'vitest';
import type { AirportLayout } from '../../src/contracts/airport';
import { EntityFlag } from '../../src/contracts/core';
import type { ShowcaseFrame } from '../../src/contracts/render';
import { resolveBuiltinMission } from '../../src/core';
import { BASES, baseInfo } from '../../src/core/missions/catalogue';
import { activeRunway } from '../../src/airport/taxiGraph';
import { approachScene, departureScene, nightDepartureScene, taxiScene, type ShowcaseScene } from '../../src/ui/showcase';

function sceneFor(baseId: 'bathinda' | 'hansa', make: typeof approachScene): { scene: ShowcaseScene; layout: AirportLayout; runwayId: string } {
  const base = baseInfo(baseId);
  const mission = resolveBuiltinMission(base.freeMissionId);
  const layout = (mission.world.airports as readonly AirportLayout[]).find((a) => a.id === base.airportId)!;
  const wind = mission.weather.windWorldMps;
  const rwyId = activeRunway(layout, { x: wind.x, z: wind.z });
  const runway = layout.runways.find((r) => r.id === rwyId) ?? layout.runways[0]!;
  return { scene: make(layout, runway), layout, runwayId: runway.id };
}

/** The jet's length on screen, as a fraction of the view height. */
function jetScreenFraction(fr: ShowcaseFrame): number {
  const a = fr.aircraft[0]!;
  const d = Math.hypot(a.pos.x - fr.camPos.x, a.pos.y - fr.camPos.y, a.pos.z - fr.camPos.z);
  return 13.2 / d / (2 * Math.tan((fr.fovDeg * Math.PI) / 360));
}

describe.each([
  // name, base, scene, lowest camera above the field (m), camera looks down at the jet throughout
  ['Bathinda approach', 'bathinda', approachScene, 80, true],
  ['Bathinda taxi', 'bathinda', taxiScene, 1, false],
  ['Bathinda night take-off', 'bathinda', nightDepartureScene, 2, false],
  ['INS Hansa departure', 'hansa', departureScene, 80, true],
] as const)('menu cinematic: %s', (_name, baseId, make, minCamAgl, looksDown) => {
  const { scene, layout } = sceneFor(baseId, make);

  test('camera stays above the ground, everything finite, the jet on its wheels or flying', () => {
    for (let t = 0; t <= scene.durationSec; t += 0.5) {
      const fr = scene.frame(t);
      for (const v of [fr.camPos, fr.lookAt, fr.aircraft[0]!.pos]) {
        expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true);
      }
      expect(Number.isFinite(fr.fovDeg) && fr.fovDeg > 2 && fr.fovDeg < 60).toBe(true);
      expect(fr.camPos.y - layout.elevationM).toBeGreaterThanOrEqual(minCamAgl);
      // On the ground the wheels touch the runway (the gear legs' contact points are 1.1 m below the origin).
      expect(fr.aircraft[0]!.pos.y - layout.elevationM).toBeGreaterThanOrEqual(1.1 - 1e-9);
      // The passes over the base never tilt up into empty sky.
      if (looksDown) expect(fr.lookAt.y).toBeLessThanOrEqual(fr.camPos.y);
    }
    // By the end the jet fills a useful part of the frame.
    expect(jetScreenFraction(scene.frame(scene.durationSec * 0.85))).toBeGreaterThan(0.05);
  });

  test('the jet has its lights on and carries a loadout', () => {
    const fr = scene.frame(scene.durationSec * 0.5);
    expect(fr.aircraft[0]!.flags & EntityFlag.Lights).toBeTruthy();
    expect(fr.aircraft[0]!.stores).toBeGreaterThan(0);
  });
});

describe('menu cinematic shots', () => {
  test('the approach touches down a few hundred metres past the threshold, not on it', () => {
    const { scene, layout, runwayId } = sceneFor('bathinda', approachScene);
    const rw = layout.runways.find((r) => r.id === runwayId)!;
    const along = (x: number, z: number): number => (x - rw.thresholdWorldX) * Math.sin(rw.headingRad) - (z - rw.thresholdWorldZ) * Math.cos(rw.headingRad);
    let touchdown: number | undefined;
    for (let t = 0; t <= scene.durationSec && touchdown === undefined; t += 0.05) {
      const j = scene.frame(t).aircraft[0]!.pos;
      if (j.y - layout.elevationM < 1.1 + 0.01) touchdown = along(j.x, j.z);
    }
    expect(touchdown).toBeGreaterThan(250);
    expect(touchdown).toBeLessThan(450);
    // It flares: sinking far slower just before touchdown than on the glide path.
    let glideSink = 0;
    let lastSink = Infinity;
    for (let t = 0; t <= scene.durationSec; t += 0.05) {
      const fr = scene.frame(t);
      const h = fr.aircraft[0]!.pos.y - layout.elevationM - 1.1;
      if (t < 1) glideSink = -fr.aircraft[0]!.vel.y;
      if (h > 0 && h < 0.3) lastSink = -fr.aircraft[0]!.vel.y;
    }
    expect(lastSink).toBeLessThan(glideSink * 0.3);
  });

  test('the taxi shot keeps the jet on a taxiway, rolling, and stops short of the camera', () => {
    const { scene } = sceneFor('bathinda', taxiScene);
    const end = scene.frame(scene.durationSec);
    const d = Math.hypot(end.aircraft[0]!.pos.x - end.camPos.x, end.aircraft[0]!.pos.z - end.camPos.z);
    expect(d).toBeGreaterThan(20);
    expect(end.camPos.y).toBeLessThan(end.aircraft[0]!.pos.y + 2);
    expect(Math.hypot(end.aircraft[0]!.vel.x, end.aircraft[0]!.vel.z)).toBeGreaterThan(5);
    expect(end.aircraft[0]!.afterburner).toBe(false);
  });

  test('the night take-off is at nightfall, on afterburner, and climbs away with the gear up', () => {
    const { scene, layout } = sceneFor('bathinda', nightDepartureScene);
    expect(scene.timeOfDayH).toBeGreaterThan(18.5);
    const end = scene.frame(scene.durationSec);
    expect(end.aircraft[0]!.afterburner).toBe(true);
    expect(end.aircraft[0]!.gearPos).toBe(0);
    expect(end.aircraft[0]!.pos.y - layout.elevationM).toBeGreaterThan(100);
  });

  test('only INS Hansa is marked as not fully tested', () => {
    expect(BASES.filter((b) => b.untested).map((b) => b.id)).toEqual(['hansa']);
  });
});
