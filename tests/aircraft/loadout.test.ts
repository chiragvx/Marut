import { describe, expect, test } from 'vitest';
import { tejasDefinition } from '../../src/aircraft';
import { loadoutMassKg, loadoutTanks, resolveLoadout, sanitizeFit, stationChoices } from '../../src/aircraft/loadout';
import {
  SNAPSHOT_FLOATS,
  STORE_IDS,
  SnapshotEntity,
  SnapshotHeader,
  entityFieldOffset,
  storeSlotAt,
  storeSlotCode,
  storeSlotCount,
  storeSlotTwin,
} from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';

const def = tejasDefinition;

describe('custom loadouts', () => {
  test('each station offers only built stores it accepts, gun excluded', () => {
    const c = stationChoices(def);
    expect(c.map((s) => s.stationId)).toEqual(['wing-outer-l', 'wing-outer-r', 'wing-mid-l', 'wing-mid-r', 'wing-inner-l', 'wing-inner-r', 'centreline', 'intake-pod']);
    expect(c.find((s) => s.stationId === 'wing-inner-l')!.stores).toEqual(['tank-1200l', 'astra-mk1', 'derby-er', 'derby', 'hsld-450', 'hsld-250', 'hsld-250r', 'griffin-lgb', 'hammer-250', 'rudram-1']);
    expect(c.find((s) => s.stationId === 'centreline')!.stores).toEqual(['tank-725l', 'hsld-450', 'hsld-250', 'griffin-lgb']);
    expect(c.find((s) => s.stationId === 'intake-pod')!.stores).toEqual(['litening']);
    expect(c.find((s) => s.stationId === 'wing-outer-r')!.maxCount).toBe(2);
  });

  test('drops what a station cannot carry, caps counts, keeps the gun', () => {
    const fit = sanitizeFit(def, {
      'wing-outer-l': { store: 'tank-1200l', count: 1 }, // not accepted outboard
      'wing-outer-r': { store: 'r-73', count: 3 }, // over the twin rail's two
      'wing-mid-l': { store: 'meteor', count: 1 }, // not built
      'wing-mid-r': { store: 'derby', count: 0 }, // empty
      'wing-inner-l': { store: 'astra-mk1', count: 1 },
      centreline: { store: 'tank-725l', count: 1 },
      gun: { store: 'gsh-23', count: 5 }, // the gun keeps its full load
    });
    expect(fit).toEqual({
      gun: { store: 'gsh-23', count: 220 },
      'wing-outer-r': { store: 'r-73', count: 2 },
      'wing-inner-l': { store: 'astra-mk1', count: 1 },
      centreline: { store: 'tank-725l', count: 1 },
    });
  });

  test('a custom fit wins over the preset id; no fit gives the default', () => {
    expect(resolveLoadout(def, 'cap-legacy', { 'wing-mid-l': { store: 'derby', count: 2 } })!.id).toBe('custom');
    expect(resolveLoadout(def, 'cap-legacy')!.id).toBe('cap-legacy');
    expect(resolveLoadout(def)!.id).toBe('cap');
  });

  test('tanks of different sizes add up by type', () => {
    const t = loadoutTanks(resolveLoadout(def, undefined, { 'wing-inner-l': { store: 'tank-1200l', count: 1 }, centreline: { store: 'tank-725l', count: 1 } }));
    expect(t).toEqual({ count: 2, fuelKg: 960 + 580, shellKg: 140 + 95, dragAreaM2: 0.075 + 0.055 });
    expect(loadoutMassKg(resolveLoadout(def, 'clean'))).toBe(0);
  });
});

describe('a custom fit in the running sim', () => {
  test('the player carries exactly the custom fit, with the right tanks', () => {
    const base = resolveBuiltinMission('konkan-free');
    const mission = {
      ...base,
      playerStart: {
        ...base.playerStart,
        loadout: {
          'wing-outer-l': { store: 'r-73', count: 1 },
          'wing-outer-r': { store: 'r-73', count: 1 },
          'wing-mid-l': { store: 'derby', count: 2 },
          'wing-mid-r': { store: 'derby', count: 2 },
          centreline: { store: 'tank-725l', count: 1 },
        },
      },
    };
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const id = world.getPlayerEntityId();
    world.stepOnce();
    const st = world.getEntityState(id)!;
    expect(st.dropTankCount).toBe(1);
    expect(st.dropTankFuelKg).toBeCloseTo(580, 1);
    expect(st.dropTankShellKg).toBe(95);

    const snap = new Float64Array(SNAPSHOT_FLOATS);
    world.writeSnapshot(snap);
    const n = snap[SnapshotHeader.ENTITY_COUNT_OFFSET]!;
    let packedA = -1;
    let packedB = -1;
    for (let i = 0; i < n; i++) {
      if (snap[entityFieldOffset(i, SnapshotEntity.ID)] !== id) continue;
      packedA = snap[entityFieldOffset(i, SnapshotEntity.STORES)]!;
      packedB = snap[entityFieldOffset(i, SnapshotEntity.STORES_B)]!;
    }
    const slot = (k: number) => {
      const s = storeSlotAt(packedA, packedB, k);
      return [STORE_IDS[storeSlotCode(s)], storeSlotCount(s), storeSlotTwin(s)];
    };
    expect(slot(0)).toEqual(['r-73', 1, false]);
    expect(slot(2)).toEqual(['derby', 2, true]);
    expect(slot(4)).toEqual(['', 0, false]);
    expect(slot(6)).toEqual(['tank-725l', 1, false]);
  });
});
