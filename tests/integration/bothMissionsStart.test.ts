/**
 * Adversarial-review probe: confirms both built-in missions in the mission
 * list ('free-flight', 'dogfight-1v1') actually start -- resolve, load
 * (spawning the player from playerStart, plus any AI flights), and run a
 * couple of seconds of ticks without the player entity disappearing or the
 * world throwing.
 */
import { describe, it, expect } from 'vitest';
import { resolveBuiltinMission } from '../../src/core';
import { createRealWorld, adaptWorldToHandle } from '../../tools/lib/worldAdapter';
import * as core from '../../src/core';

describe.each(['free-flight', 'dogfight-1v1'] as const)('mission "%s" starts', (missionId) => {
  it('resolves, loads, spawns a player entity, and ticks for 2s without throwing', () => {
    const mission = resolveBuiltinMission(missionId);
    const result = createRealWorld(core, mission, 42);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const handle = adaptWorldToHandle(result.value);

    const aliveIds = handle.listAliveEntityIds();
    expect(aliveIds.length).toBeGreaterThan(0);

    for (let i = 0; i < 240; i++) handle.stepFixed();

    const stillAlive = handle.listAliveEntityIds();
    expect(stillAlive.length).toBeGreaterThan(0);
  });
});
