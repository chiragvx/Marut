import { describe, expect, it } from 'vitest';
import { HUD_BLOCK_START, SNAPSHOT_FLOATS, SnapshotHeader, SnapshotHud, entityFieldOffset, SnapshotEntity } from '../../src/contracts/core';
import { createHudSnapshotFrame, ingestHudSnapshotFrame } from '../../src/hud/snapshotView';

describe('hud snapshotView', () => {
  it('parses tick/entity/hud fields out of a hand-built snapshot buffer', () => {
    const view = new Float64Array(SNAPSHOT_FLOATS);
    view[SnapshotHeader.TICK_OFFSET] = 42;
    view[SnapshotHeader.ENTITY_COUNT_OFFSET] = 1;
    view[SnapshotHeader.PLAYER_INDEX_OFFSET] = 0;
    view[entityFieldOffset(0, SnapshotEntity.ID)] = 777;
    view[entityFieldOffset(0, SnapshotEntity.POS_X)] = 10;
    view[HUD_BLOCK_START + SnapshotHud.IAS_MPS] = 123.4;

    const out = createHudSnapshotFrame();
    ingestHudSnapshotFrame(view, out, 0);

    expect(out.tick).toBe(42);
    expect(out.id[0]).toBe(777);
    expect(out.posX[0]).toBe(10);
    expect(out.hud[SnapshotHud.IAS_MPS]).toBe(123.4);
  });
});
