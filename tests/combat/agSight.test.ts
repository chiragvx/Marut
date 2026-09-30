/**
 * tests/combat/agSight.test.ts — the air-to-ground sight predicts where a store really lands (it
 * matches flying the same store with stepProjectile), and the CCRP solution's signs.
 */
import { describe, expect, it } from 'vitest';
import { ccrpSolution, createProjectilePool, initProjectile, isaDensityKgM3, predictImpact, stepProjectile } from '../../src/combat';
import { WEAPONS } from '../../src/catalog';
import type { CombatEnvironment, ProjectileKind, WeaponProfile } from '../../src/contracts/combat';
import type { EntityState, HeightSampler } from '../../src/contracts/core';

const FLAT: HeightSampler = { seed: 0, heightAt: () => 200, normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o) };
const ENV: CombatEnvironment = { airDensityKgM3: 1.225, windWorldMps: { x: 0, y: 0, z: 0 }, gravityMps2: 9.80665, densityAtAltitude: isaDensityKgM3 };

/** Flies store `p` from a jet at `alt` m, `speed` m/s, heading north, nose `pitchDeg`: where it lands. */
function fly(p: WeaponProfile, alt: number, speed: number, pitchDeg: number): { x: number; z: number; t: number } {
  const th = (pitchDeg * Math.PI) / 180;
  const fwd = { x: 0, y: Math.sin(th), z: -Math.cos(th) };
  const vel = { x: 0, y: fwd.y * speed, z: fwd.z * speed };
  const kind: ProjectileKind = p.kind === 'bomb' ? 'bomb' : p.kind === 'rocket' ? 'rocket' : 'bullet';
  const launch = p.kind === 'bomb' ? { x: 0, y: -p.launchSpeedMps, z: 0 } : { x: fwd.x * p.launchSpeedMps, y: fwd.y * p.launchSpeedMps, z: fwd.z * p.launchSpeedMps };
  const m: EntityState = {
    id: 9, kind: 'missile', team: 0, pos: { x: 0, y: alt, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: vel.x + launch.x, y: vel.y + launch.y, z: vel.z + launch.z },
    omega: { x: 0, y: 0, z: 0 }, alive: true, hp: 100, fuelKg: 0, elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0, afterburnerOn: false, flags: 0,
  };
  const slot = createProjectilePool(1)[0]!;
  initProjectile(slot, { kind, ownerId: 1, team: 0, posWorld: m.pos, rotWorld: m.rot, velWorld: m.vel, profile: p }, 0);
  const dt = 1 / 120;
  for (let t = 0; t < 120; t += dt) {
    const r = stepProjectile(m, slot, [], FLAT, ENV, dt, m);
    if (r.outcome === 'terrain_impact') return { x: r.impactPos!.x, z: r.impactPos!.z, t };
    if (r.outcome !== 'flying') break;
  }
  return { x: NaN, z: NaN, t: NaN };
}

function predicted(p: WeaponProfile, alt: number, speed: number, pitchDeg: number) {
  const th = (pitchDeg * Math.PI) / 180;
  const fwd = { x: 0, y: Math.sin(th), z: -Math.cos(th) };
  const out = { valid: false, impact: { x: 0, y: 0, z: 0 }, tofSec: 0 };
  predictImpact(p, { x: 0, y: alt, z: 0 }, { x: 0, y: fwd.y * speed, z: fwd.z * speed }, fwd, FLAT, isaDensityKgM3, out);
  return out;
}

describe('impact prediction', () => {
  for (const [id, alt, speed, pitch, tol] of [
    ['hsld-250', 1200, 220, 0, 25],
    ['hsld-450', 6000, 250, 0, 60],
    ['hsld-450', 1500, 230, -30, 20],
    ['hsld-250r', 250, 230, 0, 15],
    ['b8m1', 1000, 200, -20, 20],
    ['gsh-23', 600, 200, -20, 10],
  ] as const) {
    it(`${id} from ${alt} m, ${speed} m/s, ${pitch} deg: the pipper is where it lands (within ${tol} m)`, () => {
      const p = WEAPONS[id]!;
      const real = fly(p, alt, speed, pitch);
      const pred = predicted(p, alt, speed, pitch);
      expect(pred.valid).toBe(true);
      expect(Math.hypot(pred.impact.x - real.x, pred.impact.z - real.z)).toBeLessThan(tol);
      expect(Math.abs(pred.tofSec - real.t)).toBeLessThan(0.3);
    });
  }

  it('a retarded bomb falls far shorter than a low-drag one', () => {
    const ld = predicted(WEAPONS['hsld-250']!, 100, 230, 0);
    const rt = predicted(WEAPONS['hsld-250r']!, 100, 230, 0);
    expect(-rt.impact.z).toBeLessThan(-ld.impact.z * 0.8);
    expect(rt.tofSec).toBeGreaterThan(ld.tofSec);
  });

  it('no gun pipper beyond where the rounds go (they self-destruct after 3 s)', () => {
    expect(predicted(WEAPONS['gsh-23']!, 3000, 200, 60).valid).toBe(false);
    expect(predicted(WEAPONS['gsh-23']!, 2200, 200, -10).valid).toBe(false);
  });
});

describe('CCRP', () => {
  it('time to release is the along-track distance over ground speed; cross-track + = right', () => {
    const out = { timeToReleaseSec: 0, crossTrackM: 0 };
    // Flying north (-z) at 200 m/s; predicted impact at z = -1000; target 2 km further north, 50 m east.
    ccrpSolution({ x: 0, y: 0, z: -1000 }, { x: 50, y: 0, z: -3000 }, { x: 0, y: 0, z: -200 }, out);
    expect(out.timeToReleaseSec).toBeCloseTo(10, 6);
    expect(out.crossTrackM).toBeCloseTo(50, 6); // east of a northbound track = right
    ccrpSolution({ x: 0, y: 0, z: -1000 }, { x: -30, y: 0, z: -900 }, { x: 0, y: 0, z: -200 }, out);
    expect(out.timeToReleaseSec).toBeCloseTo(-0.5, 6);
    expect(out.crossTrackM).toBeCloseTo(-30, 6);
  });
});
