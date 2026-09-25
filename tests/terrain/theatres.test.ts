/**
 * tests/terrain/theatres.test.ts — the three Indian theatres (Konkan coast, Punjab plains, Ladakh).
 * Checks each terrain stays inside its declared LOD height bounds, that its home airbase sits on
 * dry, flat ground at the layout's elevation, that the water is where the map says it is, and
 * (through the real World) that touching water is a crash even with the gear down.
 */
import { describe, expect, test } from 'vitest';
import type { PilotInputs } from '../../src/contracts/core';
import { SIM_DT_SEC, EntityFlag } from '../../src/contracts/core';
import { THEATRE_TERRAIN_PARAMS, type TheatreId } from '../../src/contracts/terrain';
import type { AirportLayout } from '../../src/contracts/airport';
import { createHeightSampler } from '../../src/terrain';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { Quat } from '../../src/math';

const MISSION_FOR: Readonly<Record<TheatreId, 'konkan-free' | 'punjab-free' | 'ladakh-free'>> = {
  konkan: 'konkan-free',
  punjab: 'punjab-free',
  ladakh: 'ladakh-free',
};

function theatreSampler(id: TheatreId) {
  const mission = resolveBuiltinMission(MISSION_FOR[id]);
  const layouts = mission.world.airports as readonly AirportLayout[];
  return { sampler: createHeightSampler(THEATRE_TERRAIN_PARAMS[id], layouts.flatMap((a) => a.flattenZones)), layout: layouts[0]! };
}

describe.each(['konkan', 'punjab', 'ladakh'] as const)('theatre %s', (id) => {
  test('stays within its declared height bounds (2 km grid over the whole world)', () => {
    const { sampler } = theatreSampler(id);
    const bounds = THEATRE_TERRAIN_PARAMS[id].heightBoundsM!;
    for (let x = -100000; x <= 100000; x += 2000) {
      for (let z = -100000; z <= 100000; z += 2000) {
        const h = sampler.heightAt(x, z);
        expect(h).toBeGreaterThanOrEqual(bounds.minM);
        expect(h).toBeLessThanOrEqual(bounds.maxM);
      }
    }
  });

  test('home airbase runways are dry and at the layout elevation', () => {
    const { sampler, layout } = theatreSampler(id);
    expect(layout.runways.length).toBeGreaterThan(0);
    for (const r of layout.runways) {
      for (let f = 0; f <= 1; f += 0.25) {
        const x = r.thresholdWorldX + Math.sin(r.headingRad) * r.lengthM * f;
        const z = r.thresholdWorldZ - Math.cos(r.headingRad) * r.lengthM * f;
        expect(sampler.heightAt(x, z)).toBeCloseTo(r.elevationM, 3);
        expect(sampler.isWaterAt?.(x, z) ?? false).toBe(false);
      }
    }
  });
});

describe('theatre landforms', () => {
  test('Konkan is mostly sea to the west, with land and hills to the east', () => {
    const { sampler } = theatreSampler('konkan');
    let water = 0;
    let n = 0;
    for (let x = -100000; x <= 100000; x += 2000) {
      for (let z = -100000; z <= 100000; z += 2000) {
        n++;
        if (sampler.isWaterAt!(x, z)) water++;
      }
    }
    expect(water / n).toBeGreaterThan(0.6);
    expect(water / n).toBeLessThan(0.8);
    expect(sampler.isWaterAt!(-50000, 0)).toBe(true);
    expect(sampler.heightAt(-50000, 0)).toBe(0);
    expect(sampler.isWaterAt!(95000, 0)).toBe(false);
    expect(sampler.heightAt(95000, 0)).toBeGreaterThan(300);
  });

  test('Punjab is flat farmland with river water', () => {
    const { sampler } = theatreSampler('punjab');
    let water = 0;
    for (let x = -100000; x <= 100000; x += 250) {
      if (sampler.isWaterAt!(x, 30000)) water++;
    }
    expect(water).toBeGreaterThan(0); // the Sutlej crosses z = 30 km
    // Away from the rivers the plain varies by only a few metres.
    for (let z = -60000; z <= -20000; z += 5000) {
      expect(Math.abs(sampler.heightAt(-40000, z) - 234)).toBeLessThan(6);
    }
  });

  test('Ladakh has valley floors near 3,000-3,500 m and peaks above 5,500 m', () => {
    const { sampler } = theatreSampler('ladakh');
    let peak = -Infinity;
    for (let x = -60000; x <= 60000; x += 1000) {
      for (let z = -60000; z <= 60000; z += 1000) peak = Math.max(peak, sampler.heightAt(x, z));
    }
    expect(peak).toBeGreaterThan(5500);
    expect(sampler.heightAt(-10000, 5000)).toBeCloseTo(3256, 0); // Leh
    expect(sampler.isWaterAt).toBeUndefined();
  });
});

describe('water is a crash surface', () => {
  test('a gentle gear-down touchdown on the sea destroys the aircraft', () => {
    const mission = resolveBuiltinMission('konkan-free');
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const id = world.getPlayerEntityId();
    const s = world.getEntityState(id)!;
    // 45 km offshore, heading east, gear down, sinking at 1 m/s from 6 m.
    Quat.fromYawPitchRoll(Math.PI / 2, 0.08, 0, s.rot);
    s.pos.x = 0;
    s.pos.z = 0;
    s.pos.y = 6;
    s.vel.x = 75;
    s.vel.y = -1;
    s.vel.z = 0;
    s.gearPos = 1;
    s.flags = (s.flags | EntityFlag.GearDownCommanded) & ~EntityFlag.OnGround;
    const inputs: PilotInputs = {
      pitch: 0, roll: 0, yaw: 0, throttle: 0.3, afterburner: false, brakes: 0, gearDown: true,
      airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false,
    };
    for (let tick = 0; tick < 6 / SIM_DT_SEC && world.getEntityState(id)!.alive; tick++) {
      world.setPlayerInput(id, inputs);
      world.stepOnce();
    }
    expect(world.getEntityState(id)!.alive).toBe(false);
  });
});
