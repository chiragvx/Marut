import { describe, it, expect } from 'vitest';
import { irDetectionRangeM, createProjectilePool, initProjectile, stepProjectile } from '../../src/combat';
import type { CombatEnvironment, DetectableEntity, ProjectileSpawnRequest } from '../../src/contracts/combat';
import type { EntityState, HeightSampler } from '../../src/contracts/core';

describe('irDetectionRangeM', () => {
  it('matches the four tabulated cases from 07-combat.md section 7', () => {
    expect(irDetectionRangeM(0, false)).toBeCloseTo(8000, 6);
    expect(irDetectionRangeM(Math.PI, false)).toBeCloseTo(2000, 6);
    expect(irDetectionRangeM(Math.PI / 2, false)).toBeCloseTo(5000, 6);
    expect(irDetectionRangeM(Math.PI / 2, true)).toBeCloseTo(7500, 6);
  });
});

const DT = 1 / 120;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function makeEntityState(overrides: Partial<EntityState> = {}): EntityState {
  return {
    id: 200,
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

describe('stepProjectile (ir_missile) owner exclusion', () => {
  it('never registers a direct_hit or proximity_detonation against its own owner', () => {
    const ownerId = 1;
    const targetId = 2;
    const pool = createProjectilePool(1);
    const projectile = pool[0]!;
    const spec: ProjectileSpawnRequest = {
      kind: 'ir_missile',
      ownerId,
      team: 0,
      posWorld: { x: 0, y: 0, z: 0 },
      rotWorld: IDENTITY,
      velWorld: { x: 300, y: 0, z: 0 },
      targetId,
    };
    initProjectile(projectile, spec, 0);
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
