/**
 * tests/combat/rigidStores.test.ts — free-fall bombs and rockets fly as rigid bodies: released at
 * the aircraft's angle of attack the fins swing them into the airflow, a retarded bomb's ballute
 * opens and holds it steep, wind carries a bomb downwind and turns a rocket upwind, and the
 * air-to-ground sight predicts all of it (it flies the same body from the same release).
 */
import { describe, expect, it } from 'vitest';
import { createProjectilePool, initProjectile, isaDensityKgM3, predictImpact, releaseRatesInto, stepProjectile } from '../../src/combat';
import { WEAPONS } from '../../src/catalog';
import { stepStoreBody } from '../../src/physics';
import { Quat } from '../../src/math';
import type { CombatEnvironment, ProjectileKind } from '../../src/contracts/combat';
import { EntityFlag, type EntityState, type HeightSampler, type Vec3Like } from '../../src/contracts/core';

const GROUND_M = 200;
const FLAT: HeightSampler = { seed: 0, heightAt: () => GROUND_M, normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o) };
const STILL = { x: 0, y: 0, z: 0 };

interface Release {
  id: string;
  /** Release altitude above the (flat, 200 m) ground, m; speed m/s; flight-path angle and angle of attack, deg. */
  agl: number;
  speed: number;
  pathDeg: number;
  aoaDeg: number;
  wind?: Vec3Like;
}

interface Flown {
  impact: { x: number; z: number };
  tofSec: number;
  speedAtImpact: number;
  /** Angle between the nose and the airflow, deg: at release, 1.5 s later, and the largest. */
  alpha0: number;
  alpha15: number;
  /** Nose pitch at impact, deg (negative = nose down). */
  pitchAtImpact: number;
  tailOpenAtSec: number;
}

/** The jet flies north (-z), wings level; the store leaves as fireWeapons releases it. */
function release(r: Release) {
  const p = WEAPONS[r.id]!;
  const g = (r.pathDeg * Math.PI) / 180;
  const vel = { x: 0, y: Math.sin(g) * r.speed, z: -Math.cos(g) * r.speed };
  const rot = { x: 0, y: 0, z: 0, w: 1 };
  Quat.fromYawPitchRoll(0, ((r.pathDeg + r.aoaDeg) * Math.PI) / 180, 0, rot);
  const fwd = { x: 0, y: 0, z: 0 };
  const down = { x: 0, y: 0, z: 0 };
  Quat.rotate(rot, { x: 1, y: 0, z: 0 }, fwd);
  Quat.rotate(rot, { x: 0, y: -1, z: 0 }, down);
  const omega = releaseRatesInto(p, STILL, { x: 0, y: 0, z: 0 });
  return { p, vel, rot, fwd, down, omega, pos: { x: 0, y: GROUND_M + r.agl, z: 0 }, wind: r.wind ?? STILL };
}

function alphaDeg(s: EntityState, wind: Vec3Like): number {
  const n = { x: 0, y: 0, z: 0 };
  Quat.rotate(s.rot, { x: 1, y: 0, z: 0 }, n);
  const vx = s.vel.x - wind.x, vy = s.vel.y - wind.y, vz = s.vel.z - wind.z;
  const v = Math.hypot(vx, vy, vz);
  return (Math.acos(Math.max(-1, Math.min(1, (n.x * vx + n.y * vy + n.z * vz) / v))) * 180) / Math.PI;
}

function fly(r: Release): Flown {
  const rel = release(r);
  const { p } = rel;
  const env: CombatEnvironment = { airDensityKgM3: 1.225, windWorldMps: rel.wind, gravityMps2: 9.80665, densityAtAltitude: isaDensityKgM3, stepFreeBody: stepStoreBody };
  const launch = p.kind === 'bomb' ? rel.down : rel.fwd;
  const m: EntityState = {
    id: 9, kind: 'missile', team: 0, pos: { ...rel.pos }, rot: { ...rel.rot },
    vel: { x: rel.vel.x + launch.x * p.launchSpeedMps, y: rel.vel.y + launch.y * p.launchSpeedMps, z: rel.vel.z + launch.z * p.launchSpeedMps },
    omega: { ...rel.omega }, alive: true, hp: 100, fuelKg: 0, elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0, afterburnerOn: false, flags: 0,
  };
  const slot = createProjectilePool(1)[0]!;
  initProjectile(slot, { kind: p.kind as ProjectileKind, ownerId: 1, team: 0, posWorld: m.pos, rotWorld: m.rot, velWorld: m.vel, profile: p }, 0);
  const dt = 1 / 120;
  const out: Flown = { impact: { x: NaN, z: NaN }, tofSec: NaN, speedAtImpact: NaN, alpha0: alphaDeg(m, rel.wind), alpha15: NaN, pitchAtImpact: NaN, tailOpenAtSec: NaN };
  for (let i = 1; i < 120 / dt; i++) {
    const res = stepProjectile(m, slot, [], FLAT, env, dt, m);
    if (i === Math.round(1.5 / dt)) out.alpha15 = alphaDeg(m, rel.wind);
    if ((m.flags & EntityFlag.TailOpen) !== 0 && Number.isNaN(out.tailOpenAtSec)) out.tailOpenAtSec = i * dt;
    if (res.outcome === 'terrain_impact') {
      const n = { x: 0, y: 0, z: 0 };
      Quat.rotate(m.rot, { x: 1, y: 0, z: 0 }, n);
      out.impact = { x: res.impactPos!.x, z: res.impactPos!.z };
      out.tofSec = i * dt;
      out.speedAtImpact = Math.hypot(m.vel.x, m.vel.y, m.vel.z);
      out.pitchAtImpact = (Math.asin(n.y) * 180) / Math.PI;
      return out;
    }
    if (res.outcome !== 'flying') break;
  }
  return out;
}

function predict(r: Release) {
  const rel = release(r);
  const out = { valid: false, impact: { x: 0, y: 0, z: 0 }, tofSec: 0 };
  predictImpact(rel.p, rel.pos, rel.vel, rel.fwd, FLAT, isaDensityKgM3, out, rel.down, { rot: rel.rot, omegaBody: rel.omega, step: stepStoreBody, windWorldMps: rel.wind });
  return out;
}

describe('rigid-body bombs and rockets', () => {
  const CASES: (Release & { tol: number })[] = [
    { id: 'hsld-250', agl: 1000, speed: 220, pathDeg: 0, aoaDeg: 4, tol: 3 },
    { id: 'hsld-450', agl: 5800, speed: 250, pathDeg: 0, aoaDeg: 5, tol: 4 },
    { id: 'hsld-450', agl: 1300, speed: 230, pathDeg: -30, aoaDeg: 2, tol: 3 },
    { id: 'hsld-250r', agl: 50, speed: 230, pathDeg: 0, aoaDeg: 4, tol: 3 },
    { id: 'mk-82-se', agl: 80, speed: 250, pathDeg: 0, aoaDeg: 3, tol: 3 },
    { id: 'mk-82', agl: 2800, speed: 280, pathDeg: 0, aoaDeg: 3, wind: { x: 15, y: 0, z: 0 }, tol: 4 },
    { id: 'b8m1', agl: 800, speed: 200, pathDeg: -20, aoaDeg: 3, tol: 5 },
    { id: 'b8m1', agl: 1300, speed: 220, pathDeg: -30, aoaDeg: 5, wind: { x: 10, y: 0, z: 0 }, tol: 5 },
  ];
  for (const c of CASES) {
    it(`${c.id}, ${c.agl} m AGL, ${c.speed} m/s, path ${c.pathDeg} deg, AoA ${c.aoaDeg} deg${c.wind ? ', crosswind' : ''}: the pipper is where it lands (${c.tol} m)`, () => {
      const real = fly(c);
      const pred = predict(c);
      expect(pred.valid).toBe(true);
      expect(Math.hypot(pred.impact.x - real.impact.x, pred.impact.z - real.impact.z)).toBeLessThan(c.tol);
      expect(Math.abs(pred.tofSec - real.tofSec)).toBeLessThan(0.1);
    });
  }

  it('a bomb released at the jet’s angle of attack swings into the airflow and lands nose-down', () => {
    const f = fly({ id: 'hsld-250', agl: 1000, speed: 220, pathDeg: 0, aoaDeg: 5 });
    expect(f.alpha0).toBeGreaterThan(4);
    expect(f.alpha15).toBeLessThan(1);
    expect(f.pitchAtImpact).toBeLessThan(-25);
  });

  it('a retarded bomb opens its ballute, slows hard and falls behind a low-drag one', () => {
    const ld = fly({ id: 'hsld-250', agl: 60, speed: 230, pathDeg: 0, aoaDeg: 3 });
    const rt = fly({ id: 'hsld-250r', agl: 60, speed: 230, pathDeg: 0, aoaDeg: 3 });
    expect(rt.tailOpenAtSec).toBeGreaterThan(0.25);
    expect(rt.tailOpenAtSec).toBeLessThan(0.4);
    expect(Number.isNaN(ld.tailOpenAtSec)).toBe(true);
    expect(rt.speedAtImpact).toBeLessThan(ld.speedAtImpact * 0.75);
    expect(-rt.impact.z).toBeLessThan(-ld.impact.z * 0.85);
    expect(rt.pitchAtImpact).toBeLessThan(ld.pitchAtImpact);
  });

  it('a crosswind carries a bomb downwind, and turns a burning rocket into it (upwind)', () => {
    const wind = { x: 12, y: 0, z: 0 };
    const bomb = fly({ id: 'mk-82', agl: 3000, speed: 250, pathDeg: 0, aoaDeg: 3, wind });
    const rocket = fly({ id: 'b8m1', agl: 1300, speed: 220, pathDeg: -30, aoaDeg: 3, wind });
    expect(bomb.impact.x).toBeGreaterThan(10);
    expect(rocket.impact.x).toBeLessThan(-10);
  });

  it('is reproducible', () => {
    const c: Release = { id: 'mk-82-se', agl: 80, speed: 250, pathDeg: 0, aoaDeg: 3, wind: { x: 5, y: 0, z: 3 } };
    expect(fly(c)).toEqual(fly(c));
  });
});
