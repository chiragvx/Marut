/**
 * tests/aircraft/aircraftData.test.ts — aircraft definitions against the shared catalogue: every
 * station's stores exist, every loadout fits its stations, and the registry resolves ids/aliases.
 * Plus: the player spawns as the Tejas Mk1A with its default loadout's weapons.
 */
import { describe, expect, test } from 'vitest';
import { getAircraftDefinition, getLoadout, listAircraftDefinitions } from '../../src/aircraft';
import { FUEL_TANKS, RADARS, WEAPONS, storeKind } from '../../src/catalog';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';

describe.each(listAircraftDefinitions().map((d) => [d.id, d] as const))('aircraft %s', (_id, def) => {
  test('every store a station accepts is in the catalogue', () => {
    for (const st of def.stations ?? []) for (const s of st.accepts) expect(storeKind(s), `${st.id}: ${s}`).toBeDefined();
  });

  test('every loadout fits its stations (accepted store, count within the rack)', () => {
    for (const l of def.loadouts ?? []) {
      for (const [stationId, fit] of Object.entries(l.fit)) {
        const st = def.stations?.find((s) => s.id === stationId);
        expect(st, `${l.id}: station ${stationId}`).toBeDefined();
        expect(st!.accepts).toContain(fit.store);
        expect(fit.count).toBeGreaterThan(0);
        expect(fit.count).toBeLessThanOrEqual(st!.maxCount);
      }
    }
  });

  test('its sensors and default loadout resolve', () => {
    if (def.sensors?.radar) expect(RADARS[def.sensors.radar]).toBeDefined();
    expect(getLoadout(def)).toBeDefined();
  });
});

test('the Tejas Mk1A: id, alias, stations, sensors', () => {
  const def = getAircraftDefinition('tejas-mk1a')!;
  expect(def.displayName).toBe('HAL Tejas Mk1A');
  expect(getAircraftDefinition('tejas-mk1')).toBe(def);
  // Eight hardpoints plus the internal gun; no wingtip rails.
  expect(def.stations!.filter((s) => s.id !== 'gun').length).toBe(8);
  expect(def.stations!.some((s) => s.id.includes('wingtip'))).toBe(false);
  expect(def.sensors?.radar).toBe('elm-2052');
  expect(def.sensors?.iff).toBe(true);
  // The flight model's hardpoints are the default loadout's view: two wing tanks.
  expect(def.hardpoints.filter((h) => h.type === 'fuel_tank').length).toBe(2);
  expect(FUEL_TANKS['tank-1200l']!.capacityKg).toBe(def.dropTank!.capacityKg);
  expect(WEAPONS['r-73']!.kind).toBe('ir_missile');
  expect(WEAPONS['derby']!.kind).toBe('radar_missile');
});

test('the player spawns as the Mk1A with its default CAP loadout (220 rounds, 4 ASRAAM, 2 Astra Mk1)', () => {
  const mission = resolveBuiltinMission('border-free');
  const world = createWorld(buildWorldDependencies(mission));
  world.loadMission(mission);
  world.stepOnce();
  const cs = world.getCombatStatus(world.getPlayerEntityId())!;
  expect(cs.ammoGun).toBe(220);
  expect(cs.missilesIr).toBe(4);
  expect(cs.missilesRadar).toBe(2);
  // The loaded missiles' envelopes reach the AI and HUD.
  expect(cs.irMissileRangeM).toBe(35000);
  expect(cs.radarMissileRangeM).toBe(160000);
});
