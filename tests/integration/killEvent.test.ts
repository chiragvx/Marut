/**
 * tests/integration/killEvent.test.ts — shooting an aircraft down sends one `kill` event credited to
 * the shooter (the debrief's kill count and the objective tracker's "Destroyed n / m" count them).
 */
import { describe, expect, test } from 'vitest';
import { EntityKindCode, SNAPSHOT_FLOATS, SnapshotEntity, SnapshotHeader, entityFieldOffset, type PilotInputs, type SimEvent } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';

const inputs = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.8, afterburner: false, brakes: 0, gearDown: false,
  airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...over,
});

describe('kill events', () => {
  test('guns kill a bandit held 300 m ahead: one kill for the player, then a crash', () => {
    const mission = resolveBuiltinMission('dogfight-1v1');
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const id = world.getPlayerEntityId();
    const events: SimEvent[] = [];
    const drained: SimEvent[] = [];
    const snap = new Float64Array(SNAPSHOT_FLOATS);
    world.writeSnapshot(snap);
    let banditId = -1;
    for (let i = 0; i < snap[SnapshotHeader.ENTITY_COUNT_OFFSET]!; i++) {
      const eid = snap[entityFieldOffset(i, SnapshotEntity.ID)]!;
      if (snap[entityFieldOffset(i, SnapshotEntity.KIND)] === EntityKindCode.aircraft && eid !== id) banditId = eid;
    }
    expect(banditId).toBeGreaterThanOrEqual(0);

    for (let t = 0; t < 360; t++) {
      // Hold the bandit 300 m dead ahead, flying with the player.
      const p = world.getEntityState(id)!;
      const b = world.getEntityState(banditId);
      if (b && b.alive) {
        const fx = 1 - 2 * (p.rot.y * p.rot.y + p.rot.z * p.rot.z);
        const fy = 2 * (p.rot.x * p.rot.y + p.rot.w * p.rot.z);
        const fz = 2 * (p.rot.x * p.rot.z - p.rot.w * p.rot.y);
        b.pos.x = p.pos.x + fx * 300; b.pos.y = p.pos.y + fy * 300; b.pos.z = p.pos.z + fz * 300;
        b.vel.x = p.vel.x; b.vel.y = p.vel.y; b.vel.z = p.vel.z;
        b.rot.x = p.rot.x; b.rot.y = p.rot.y; b.rot.z = p.rot.z; b.rot.w = p.rot.w;
      }
      world.setPlayerInput(id, inputs({ trigger: true }));
      world.stepOnce();
      const n = world.drainEvents(drained);
      events.push(...drained.slice(0, n));
    }
    const kills = events.filter((e) => e.type === 'kill');
    expect(kills).toEqual([{ type: 'kill', targetId: banditId, sourceId: id }]);
    expect(events.some((e) => e.type === 'crash' && e.entityId === banditId)).toBe(true);
    expect(world.getEntityState(banditId)?.alive ?? false).toBe(false);
  });
});
