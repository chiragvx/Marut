import { describe, expect, test } from 'vitest';
import type { AirportLayout } from '../../src/contracts/airport';
import { EntityFlag } from '../../src/contracts/core';
import type { ShowcaseFrame } from '../../src/contracts/render';
import { resolveBuiltinMission } from '../../src/core';
import { baseInfo } from '../../src/core/missions/catalogue';
import { activeRunway } from '../../src/airport/taxiGraph';
import { approachScene, departureScene, type ShowcaseScene } from '../../src/ui/showcase';

function sceneFor(baseId: 'bathinda' | 'hansa', make: typeof approachScene): { scene: ShowcaseScene; layout: AirportLayout } {
  const base = baseInfo(baseId);
  const mission = resolveBuiltinMission(base.freeMissionId);
  const layout = (mission.world.airports as readonly AirportLayout[]).find((a) => a.id === base.airportId)!;
  const wind = mission.weather.windWorldMps;
  const rwyId = activeRunway(layout, { x: wind.x, z: wind.z });
  const runway = layout.runways.find((r) => r.id === rwyId) ?? layout.runways[0]!;
  return { scene: make(layout, runway), layout };
}

/** The jet's length on screen, as a fraction of the view height. */
function jetScreenFraction(fr: ShowcaseFrame): number {
  const a = fr.aircraft[0]!;
  const d = Math.hypot(a.pos.x - fr.camPos.x, a.pos.y - fr.camPos.y, a.pos.z - fr.camPos.z);
  return 13.2 / d / (2 * Math.tan((fr.fovDeg * Math.PI) / 360));
}

describe.each([
  ['Bathinda approach', 'bathinda', approachScene],
  ['INS Hansa departure', 'hansa', departureScene],
] as const)('menu cinematic: %s', (_name, baseId, make) => {
  const { scene, layout } = sceneFor(baseId, make);

  test('camera stays above the field, finite, and closes in on the jet', () => {
    for (let t = 0; t <= scene.durationSec; t += 0.5) {
      const fr = scene.frame(t);
      for (const v of [fr.camPos, fr.lookAt, fr.aircraft[0]!.pos]) {
        expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true);
      }
      expect(fr.camPos.y - layout.elevationM).toBeGreaterThan(80);
      expect(fr.aircraft[0]!.pos.y - layout.elevationM).toBeGreaterThanOrEqual(1);
    }
    // Opens wide on the base; by the end the jet fills a useful part of the frame.
    expect(scene.frame(0).fovDeg).toBeGreaterThan(35);
    expect(jetScreenFraction(scene.frame(scene.durationSec * 0.85))).toBeGreaterThan(0.05);
  });

  test('the jet has its lights on and carries a loadout', () => {
    const fr = scene.frame(scene.durationSec * 0.5);
    expect(fr.aircraft[0]!.flags & EntityFlag.Lights).toBeTruthy();
    expect(fr.aircraft[0]!.flags & EntityFlag.LightsStrobe).toBeTruthy();
    expect(fr.aircraft[0]!.stores).toBeGreaterThan(0);
  });
});
