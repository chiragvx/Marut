/**
 * tests/hud/airbaseMarkers.test.ts — the HUD's airbase list built from the mission's layouts.
 */
import { describe, expect, test } from 'vitest';
import { resolveBuiltinMission } from '../../src/core/missions/index';
import type { AirportLayout } from '../../src/contracts/airport';
import { buildHudAirbases } from '../../src/hud/airbaseMarkers';

const bases = (id: string) => buildHudAirbases(resolveBuiltinMission(id as never).world.airports as readonly AirportLayout[]);

describe('buildHudAirbases', () => {
  test('border theatre: a friendly and a hostile base, with runway pairs and facilities', () => {
    const b = bases('border-free');
    const friendly = b.find((x) => x.id === 'bhisiana-afs')!;
    const hostile = b.find((x) => x.id === 'pafb-shahbaz')!;
    expect(friendly.side).toBe('friendly');
    expect(hostile.side).toBe('hostile');
    expect(friendly.runways).toBe('31/13');
    const kinds = new Set(friendly.facilities.map((f) => f.kind));
    for (const k of ['runway', 'stand', 'hangar', 'tower', 'fuel', 'arms'] as const) expect(kinds.has(k)).toBe(true);
    // One fuel label for the whole depot, one munitions label for the magazines.
    expect(friendly.facilities.filter((f) => f.kind === 'fuel').length).toBe(1);
    expect(friendly.facilities.filter((f) => f.kind === 'arms').length).toBe(1);
  });

  test("a base with no side (the player's home base) counts as friendly", () => {
    const [hansa] = bases('konkan-free');
    expect(hansa!.side).toBe('friendly');
    expect(hansa!.runways).toBe('08/26');
    expect(hansa!.facilities.filter((f) => f.kind === 'stand').length).toBe(6);
  });
});
