import { describe, it, expect } from 'vitest';
import { createProjectilePool, initProjectile, stepProjectile, GUN_ARM_DISTANCE_M, GUN_BULLET_MAX_LIFETIME_SEC } from '../../src/combat';
import type { CombatEnvironment, DetectableEntity, ProjectileSpawnRequest } from '../../src/contracts/combat';
import type { EntityState, HeightSampler } from '../../src/contracts/core';

const DT = 1 / 120;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function makeEntityState(overrides: Partial<EntityState> = {}): EntityState {
  return {
    id: 100,
    kind: 'bullet',
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
  normalAt: (_x, _z, out) => {
    out.x = 0; out.y = 1; out.z = 0;
    return out;
  },
};

const ENV: CombatEnvironment = { airDensityKgM3: 1.225, windWorldMps: { x: 0, y: 0, z: 0 }, gravityMps2: 9.80665 };

function bulletSpawn(ownerId: number, posWorld = { x: 0, y: 0, z: 0 }, velWorld = { x: 715, y: 0, z: 0 }): ProjectileSpawnRequest {
  return { kind: 'bullet', ownerId, team: 0, posWorld, rotWorld: IDENTITY, velWorld };
}

describe('stepProjectile (bullet)', () => {
  it('drops under gravity roughly as expected after 1.0s and exceeds the arm distance', () => {
    const pool = createProjectilePool(1);
    const projectile = pool[0]!;
    initProjectile(projectile, bulletSpawn(1), 0);
    const state = makeEntityState({ pos: { x: 0, y: 0, z: 0 }, vel: { x: 715, y: 0, z: 0 } });

    for (let i = 0; i < 120; i++) {
      const result = stepProjectile(state, projectile, [], NO_TERRAIN_SAMPLER, ENV, DT, state);
      expect(result.outcome).toBe('flying');
    }

    expect(state.pos.y).toBeLessThan(0);
    expect(state.pos.y).toBeGreaterThanOrEqual(-5.5);
    expect(state.pos.y).toBeLessThanOrEqual(-4.5);
    expect(projectile.distanceTravelledM).toBeGreaterThan(GUN_ARM_DISTANCE_M);
  });

  it('expires once age exceeds GUN_BULLET_MAX_LIFETIME_SEC', () => {
    const pool = createProjectilePool(1);
    const projectile = pool[0]!;
    initProjectile(projectile, bulletSpawn(1), 0);
    const state = makeEntityState({ pos: { x: 0, y: 0, z: 0 }, vel: { x: 715, y: 0, z: 0 } });

    const maxTicks = Math.ceil(GUN_BULLET_MAX_LIFETIME_SEC / DT) + 5;
    let lastOutcome = 'flying';
    for (let i = 0; i < maxTicks && lastOutcome !== 'expired'; i++) {
      const result = stepProjectile(state, projectile, [], NO_TERRAIN_SAMPLER, ENV, DT, state);
      lastOutcome = result.outcome;
    }
    expect(lastOutcome).toBe('expired');
  });

  it('never registers a direct_hit against its own owner, even while unarmed', () => {
    const pool = createProjectilePool(1);
    const projectile = pool[0]!;
    const ownerId = 1;
    initProjectile(projectile, bulletSpawn(ownerId, { x: 0, y: 0, z: 0 }), 0);
    const state = makeEntityState({ pos: { x: 0, y: 0, z: 0 }, vel: { x: 715, y: 0, z: 0 } });

    const owner: DetectableEntity = {
      id: ownerId,
      team: 0,
      kind: 'aircraft',
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      rot: IDENTITY,
      alive: true,
    };

    for (let i = 0; i < 30; i++) {
      const result = stepProjectile(state, projectile, [owner], NO_TERRAIN_SAMPLER, ENV, DT, state);
      expect(result.outcome).not.toBe('direct_hit');
    }
  });
});
