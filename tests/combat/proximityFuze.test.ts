/**
 * The proximity fuze reports the true closest approach, whatever the tick boundaries: the same
 * pass, started at different fractions of a tick, gives the same miss distance.
 */
import { expect, test } from 'vitest';
import { createProjectilePool, initProjectile, stepProjectile } from '../../src/combat';
import { WEAPONS } from '../../src/catalog';
import type { CombatEnvironment, DetectableEntity } from '../../src/contracts/combat';
import type { EntityState, HeightSampler } from '../../src/contracts/core';

const FLAT: HeightSampler = { seed: 0, heightAt: () => -1e6, normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o) };
// No gravity, no air: the missile flies a straight line past the target.
const ENV: CombatEnvironment = { airDensityKgM3: 0, windWorldMps: { x: 0, y: 0, z: 0 }, gravityMps2: 0, densityAtAltitude: () => 0 };

function pass(offsetM: number, phase: number, targetVx: number): number {
  const p = { ...WEAPONS['derby']!, lethality: { ...WEAPONS['derby']!.lethality!, fuzeReliability: 1 } };
  const speed = 900;
  const dt = 1 / 120;
  const m: EntityState = {
    id: 100, kind: 'missile', team: 0, pos: { x: -2000 + phase * speed * dt, y: 5000, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: speed, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 }, alive: true, hp: 100, fuelKg: 0,
    elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0, afterburnerOn: false, flags: 0,
  };
  const tgt: DetectableEntity = { id: 2, team: 1, kind: 'aircraft', alive: true, pos: { x: 0, y: 5000, z: offsetM }, vel: { x: targetVx, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, hitEllipsoidBodyM: { x: 0.5, y: 0.5, z: 0.5 } };
  const slot = createProjectilePool(1)[0]!;
  initProjectile(slot, { kind: 'radar_missile', ownerId: 1, team: 0, posWorld: m.pos, rotWorld: m.rot, velWorld: m.vel, profile: { ...p, motorThrustN: 0, flight: undefined }, rngSeed: 7 }, 0);
  for (let i = 0; i < 2000; i++) {
    tgt.pos.x += tgt.vel.x * dt;
    const r = stepProjectile(m, slot, [tgt], FLAT, ENV, dt, m);
    if (r.outcome === 'proximity_detonation') return r.missDistanceM;
    if (r.outcome !== 'flying') return NaN;
  }
  return NaN;
}

test('the reported miss distance does not depend on the tick phase', () => {
  for (const vx of [0, -250, 250]) {
    for (let k = 0; k < 8; k++) {
      expect(pass(3, k / 8, vx)).toBeCloseTo(3, 1);
    }
  }
});
