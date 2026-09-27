/**
 * tests/integration/storesSnapshot.test.ts — what the renderer is told each aircraft carries (the
 * snapshot's STORES field, through the real World): the loadout on each pylon, missiles leaving
 * their pylon when fired (and the missile in flight carrying its store code), drop tanks gone once
 * jettisoned, and the AI flying without tanks.
 */
import { describe, expect, test } from 'vitest';
import type { PilotInputs } from '../../src/contracts/core';
import {
  ENTITY_STRIDE,
  EntityKindCode,
  HEADER_FLOATS,
  SNAPSHOT_FLOATS,
  STORE_IDS,
  SnapshotEntity,
  SnapshotHeader,
  entityFieldOffset,
  packStoreSlot,
  storeSlotAt,
  storeSlotCode,
  storeSlotCount,
  storeSlotTwin,
} from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';

const inputs = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.8, afterburner: false, brakes: 0, gearDown: false,
  airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...over,
});

/** Slot order = the Tejas's stations without the gun. */
const SLOT = { outerL: 0, outerR: 1, midL: 2, midR: 3, innerL: 4, innerR: 5, centreline: 6 };

function setup() {
  const mission = resolveBuiltinMission('dogfight-1v1');
  const world = createWorld(buildWorldDependencies(mission));
  world.loadMission(mission);
  const id = world.getPlayerEntityId();
  const snap = new Float64Array(SNAPSHOT_FLOATS);
  const entities = () => {
    world.writeSnapshot(snap);
    const n = snap[SnapshotHeader.ENTITY_COUNT_OFFSET]!;
    return Array.from({ length: n }, (_, i) => ({
      id: snap[entityFieldOffset(i, SnapshotEntity.ID)]!,
      kind: snap[entityFieldOffset(i, SnapshotEntity.KIND)]!,
      stores: snap[entityFieldOffset(i, SnapshotEntity.STORES)]!,
    }));
  };
  const player = () => entities().find((e) => e.id === id)!;
  return { world, id, entities, player };
}

const slot = (packed: number, k: number) => {
  const s = storeSlotAt(packed, k);
  return { store: STORE_IDS[storeSlotCode(s)], count: storeSlotCount(s), twin: storeSlotTwin(s) };
};

describe('snapshot STORES field', () => {
  test('packs and unpacks losslessly across all eight slots', () => {
    let packed = 0;
    for (let k = 0; k < 8; k++) packed += packStoreSlot(k % 7, k % 4, k % 2 === 1) * Math.pow(64, k);
    expect(Number.isSafeInteger(packed)).toBe(true);
    for (let k = 0; k < 8; k++) {
      const s = storeSlotAt(packed, k);
      expect([storeSlotCode(s), storeSlotCount(s), storeSlotTwin(s)]).toEqual([k % 7, k % 4, k % 2 === 1]);
    }
    expect(ENTITY_STRIDE).toBe(27);
    expect(entityFieldOffset(0, SnapshotEntity.STORES)).toBe(HEADER_FLOATS + 26);
  });

  test('the player carries the CAP fit: twin ASRAAM outboard, Astra in the middle, tanks inboard', () => {
    const { player } = setup();
    const p = player().stores;
    expect(slot(p, SLOT.outerL)).toEqual({ store: 'asraam', count: 2, twin: true });
    expect(slot(p, SLOT.outerR)).toEqual({ store: 'asraam', count: 2, twin: true });
    expect(slot(p, SLOT.midL)).toEqual({ store: 'astra-mk1', count: 1, twin: false });
    expect(slot(p, SLOT.midR)).toEqual({ store: 'astra-mk1', count: 1, twin: false });
    expect(slot(p, SLOT.innerL)).toEqual({ store: 'tank-1200l', count: 1, twin: false });
    expect(slot(p, SLOT.innerR)).toEqual({ store: 'tank-1200l', count: 1, twin: false });
    expect(slot(p, SLOT.centreline).store).toBe('');
  });

  test('the AI shows its missiles but no tanks (it flies without them)', () => {
    const { entities, id } = setup();
    const ai = entities().filter((e) => e.kind === EntityKindCode.aircraft && e.id !== id);
    expect(ai.length).toBeGreaterThan(0);
    for (const e of ai) {
      expect(slot(e.stores, SLOT.outerL).count).toBe(2);
      expect(slot(e.stores, SLOT.innerL)).toEqual({ store: 'tank-1200l', count: 0, twin: false });
    }
  });

  test('jettisoned tanks leave their pylons', () => {
    const { world, id, player } = setup();
    world.setPlayerInput(id, inputs({ jettisonTanks: true }));
    world.stepOnce();
    expect(slot(player().stores, SLOT.innerL).count).toBe(0);
    expect(slot(player().stores, SLOT.innerR).count).toBe(0);
    expect(slot(player().stores, SLOT.outerL).count).toBe(2);
  });

  test('a fired missile leaves its pylon and flies as its own store type', () => {
    const { world, id, player, entities } = setup();
    const before = player().stores;
    const loaded = (p: number) => [0, 1, 2, 3].reduce((n, k) => n + slot(p, k).count, 0);
    let missile: { stores: number } | undefined;
    // Designate the bandit ahead, select the Astra (radar), and fire once locked (launch is lock-gated).
    for (let t = 0; t < 3600 && !missile; t++) {
      world.setPlayerInput(id, inputs({ cycleTarget: t % 120 === 1, cycleWeapon: t === 3, launch: t > 10 && t % 20 === 0 }));
      world.stepOnce();
      missile = entities().find((e) => e.kind === EntityKindCode.missile);
    }
    expect(missile).toBeDefined();
    expect(loaded(player().stores)).toBe(loaded(before) - 1);
    expect(['asraam', 'astra-mk1']).toContain(STORE_IDS[missile!.stores]);
  });
});
