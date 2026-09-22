import { describe, it, expect } from 'vitest';
import { createProjectilePool, initProjectile, stepProjectile } from '../../src/combat';
import type { CombatEnvironment, DetectableEntity, ProjectileSpawnRequest } from '../../src/contracts/combat';
import type { EntityState, HeightSampler } from '../../src/contracts/core';

const DT = 1 / 120;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function makeEntityState(overrides: Partial<EntityState> = {}): EntityState {
  return {
    id: 300,
    kind: 'missile',
    team: 0,
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    omega: { x: 0, y: 0, z: 0 },
    alive: true,
    hp: 100,
    fuelKg: 0,
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    gearPos: 0,
    throttle: 0,
    afterburnerOn: false,
    flags: 0,
    ...overrides,
  };
}

const NO_TERRAIN_SAMPLER: HeightSampler = {
  seed: 0,
  heightAt: () => -1_000_000,
  normalAt: (_x, _z, out) => { out.x = 0; out.y = 1; out.z = 0; return out; },
};
const ENV: CombatEnvironment = { airDensityKgM3: 1.225, windWorldMps: { x: 0, y: 0, z: 0 }, gravityMps2: 9.80665 };

function radarMissileSpawn(ownerId: number, targetId: number, posWorld = { x: 0, y: 0, z: 0 }, velWorld = { x: 0, y: 0, z: 0 }): ProjectileSpawnRequest {
  return { kind: 'radar_missile', ownerId, team: 0, posWorld, rotWorld: IDENTITY, velWorld, targetId };
}

describe('stepProjectile (radar_missile) guidance transitions', () => {
  it('stays on datalink when the target is beyond the active-seeker range (12001 m)', () => {
    const pool = createProjectilePool(1);
    const projectile = pool[0]!;
    initProjectile(projectile, radarMissileSpawn(1, 2), 0);
    const state = makeEntityState({ pos: { x: 0, y: 0, z: 0 }, rot: IDENTITY, vel: { x: 300, y: 0, z: 0 } });
    const target: DetectableEntity = { id: 2, team: 1, kind: 'aircraft', pos: { x: 12001, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: IDENTITY, alive: true };

    stepProjectile(state, projectile, [target], NO_TERRAIN_SAMPLER, ENV, DT, state);

    expect(projectile.guidance).toBe('radar_datalink');
  });

  it('switches to active homing within active-seeker range (11999 m) and cone', () => {
    const pool = createProjectilePool(1);
    const projectile = pool[0]!;
    initProjectile(projectile, radarMissileSpawn(1, 2), 0);
    const state = makeEntityState({ pos: { x: 0, y: 0, z: 0 }, rot: IDENTITY, vel: { x: 300, y: 0, z: 0 } });
    const target: DetectableEntity = { id: 2, team: 1, kind: 'aircraft', pos: { x: 11999, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: IDENTITY, alive: true };

    stepProjectile(state, projectile, [target], NO_TERRAIN_SAMPLER, ENV, DT, state);

    expect(projectile.guidance).toBe('radar_active');
  });
});

describe('stepProjectile (radar_missile) owner exclusion', () => {
  it('never registers a direct_hit or proximity_detonation against its own owner', () => {
    const ownerId = 1;
    const targetId = 2;
    const pool = createProjectilePool(1);
    const projectile = pool[0]!;
    initProjectile(projectile, radarMissileSpawn(ownerId, targetId, { x: 0, y: 0, z: 0 }, { x: 300, y: 0, z: 0 }), 0);
    const state = makeEntityState({ pos: { x: 0, y: 0, z: 0 }, vel: { x: 300, y: 0, z: 0 } });

    const owner: DetectableEntity = { id: ownerId, team: 0, kind: 'aircraft', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: IDENTITY, alive: true };
    const target: DetectableEntity = { id: targetId, team: 1, kind: 'aircraft', pos: { x: 5000, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: IDENTITY, alive: true };

    for (let i = 0; i < 60; i++) {
      const result = stepProjectile(state, projectile, [owner, target], NO_TERRAIN_SAMPLER, ENV, DT, state);
      expect(result.outcome).not.toBe('direct_hit');
      expect(result.outcome).not.toBe('proximity_detonation');
      if (result.outcome !== 'flying') break;
    }
  });
});
