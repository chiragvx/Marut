/**
 * Missile envelopes: each catalogue missile, fired from Mach 0.9 at a Mach 0.9 target, reaches its
 * published head-on range at 10 km (and not far beyond), is much shorter tail-on and low down, and
 * its warhead's kill probability falls off with miss distance.
 */
import { describe, expect, test } from 'vitest';
import { createProjectilePool, initProjectile, isaDensityKgM3, missileKillProbability, stepProjectile } from '../../src/combat';
import { WEAPONS } from '../../src/catalog';
import type { CombatEnvironment, DetectableEntity, WeaponProfile } from '../../src/contracts/combat';
import type { EntityState, HeightSampler } from '../../src/contracts/core';

const FLAT: HeightSampler = { seed: 0, heightAt: () => -1e6, normalAt: (_x, _z, o) => { o.x = 0; o.y = 1; o.z = 0; return o; } };
const ENV: CombatEnvironment = { airDensityKgM3: 1.225, windWorldMps: { x: 0, y: 0, z: 0 }, gravityMps2: 9.81, densityAtAltitude: isaDensityKgM3 };

/** One shot; aspect 180 = head-on, 0 = tail. True if the missile fuzes on the target. */
function shot(p: WeaponProfile, rangeM: number, aspectDeg: number, seed: number, alt = 10000): boolean {
  const speed = 0.9 * 299;
  let s = seed >>> 0;
  const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const hdg = (aspectDeg * Math.PI) / 180;
  const tgt: DetectableEntity = {
    id: 2, team: 1, kind: 'aircraft', alive: true,
    pos: { x: rangeM, y: alt, z: (rnd() - 0.5) * 200 },
    vel: { x: Math.cos(hdg) * speed, y: 0, z: Math.sin(hdg) * speed },
    rot: { x: 0, y: 0, z: 0, w: 1 },
  };
  const m: EntityState = {
    id: 100, kind: 'missile', team: 0, pos: { x: 0, y: alt, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: speed + p.launchSpeedMps, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 }, alive: true, hp: 100, fuelKg: 0,
    elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0, afterburnerOn: false, flags: 0,
  };
  const slot = createProjectilePool(1)[0]!;
  initProjectile(slot, { kind: p.kind === 'ir_missile' ? 'ir_missile' : 'radar_missile', ownerId: 1, team: 0, posWorld: m.pos, rotWorld: m.rot, velWorld: m.vel, targetId: 2, profile: p, rngSeed: Math.floor(rnd() * 4e9) }, 0);
  const dt = 1 / 60;
  for (let t = 0; t < p.maxLifetimeSec + 1; t += dt) {
    tgt.pos.x += tgt.vel.x * dt;
    tgt.pos.z += tgt.vel.z * dt;
    slot.datalinkOk = true;
    const r = stepProjectile(m, slot, [tgt], FLAT, ENV, dt, m);
    if (r.outcome === 'direct_hit' || r.outcome === 'proximity_detonation') return true;
    if (r.outcome !== 'flying') return false;
  }
  return false;
}

function hitRate(p: WeaponProfile, rangeM: number, aspectDeg: number, alt = 10000, n = 8): number {
  let hits = 0;
  for (let k = 0; k < n; k++) if (shot(p, rangeM, aspectDeg, 1234 + k * 7919, alt)) hits++;
  return hits / n;
}

describe.each([
  ['asraam', 35000],
  ['r-73', 30000],
  ['astra-mk1', 160000],
  ['derby', 50000],
])('%s envelope', (id, rMaxHeadOnM) => {
  const p = WEAPONS[id]!;

  test('matches its catalogue envelope', () => {
    expect(p.envelope?.rMaxHeadOnM).toBe(rMaxHeadOnM);
  });

  test('head-on at 10 km: hits inside the published range, falls short well beyond it', () => {
    expect(hitRate(p, rMaxHeadOnM * 0.85, 180)).toBeGreaterThanOrEqual(0.75);
    expect(hitRate(p, rMaxHeadOnM * 1.25, 180)).toBeLessThanOrEqual(0.25);
  });

  test('tail-on and low-level shots are much shorter', () => {
    expect(hitRate(p, rMaxHeadOnM * 0.75, 0)).toBeLessThanOrEqual(0.25);
    expect(hitRate(p, rMaxHeadOnM * 0.75, 180, 1000)).toBeLessThanOrEqual(0.25);
  });
});

test('Astra Mk1 reaches the extended ~160 km class (well past the original 110 km)', () => {
  expect(hitRate(WEAPONS['astra-mk1']!, 130000, 180)).toBeGreaterThanOrEqual(0.75);
});

test('kill probability falls with miss distance and is zero beyond the lethal radius', () => {
  const L = WEAPONS['asraam']!.lethality!;
  expect(missileKillProbability(L, 0)).toBeCloseTo(L.pkDirect);
  expect(missileKillProbability(L, L.lethalRadiusM)).toBeCloseTo(L.pkAtLethalRadius);
  expect(missileKillProbability(L, L.lethalRadiusM / 2)).toBeLessThan(L.pkDirect);
  expect(missileKillProbability(L, L.lethalRadiusM / 2)).toBeGreaterThan(L.pkAtLethalRadius);
  expect(missileKillProbability(L, L.lethalRadiusM + 1)).toBe(0);
});
