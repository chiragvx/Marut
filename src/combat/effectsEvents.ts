/**
 * src/combat/effectsEvents.ts — explosion SimEvent builder and the single
 * `resolveProjectileHit` entry point src/core calls for every 'direct_hit'/
 * 'proximity_detonation' stepProjectile result. See docs/spec/07-combat.md
 * section 4.9.
 */
import { WeaponKind, type Vec3Like } from '../contracts/core';
import {
  PROXIMITY_DAMAGE_FALLOFF_MIN_FRAC,
  EXPLOSION_RADIUS_MISSILE_M,
  ProjectileKind,
  ProjectileOutcome,
  type PushExplosionEvent,
  type ResolveProjectileHit,
} from '../contracts/combat';
import { projectileProfile } from './weaponProfiles';
import { clamp, lerp, nextFloat01, type PrngState } from '../math';
import { applyHit } from './subsystemDamage';
import type { MissileLethality } from '../contracts/combat';

const _prngBridge: PrngState = { s: 0 };

/** A warhead's kill probability at a miss distance: pkDirect at 0 m, pkAtLethalRadius at the lethal radius, 0 beyond. */
export function missileKillProbability(L: MissileLethality, missM: number): number {
  return missM > L.lethalRadiusM ? 0 : lerp(L.pkDirect, L.pkAtLethalRadius, clamp(missM / L.lethalRadiusM, 0, 1));
}

export const pushExplosionEvent: PushExplosionEvent = (kind, pos: Vec3Like, causedBy, outEvents) => {
  void kind; // radius is fixed regardless of missile kind (EXPLOSION_RADIUS_MISSILE_M); kept for signature symmetry.
  outEvents.push({
    type: 'explosion',
    pos: { x: pos.x, y: pos.y, z: pos.z },
    radiusM: EXPLOSION_RADIUS_MISSILE_M,
    causedBy,
  });
};

export const resolveProjectileHit: ResolveProjectileHit = (
  result,
  ownerId,
  kind,
  targetState,
  targetDamage,
  rng,
  outEvents,
  profile,
) => {
  const prof = projectileProfile({ kind, profile });
  let damageFrac: number;
  if (kind === ProjectileKind.Bullet) {
    damageFrac = prof.damageFrac;
  } else if (result.outcome === ProjectileOutcome.DirectHit) {
    damageFrac = prof.damageFrac;
  } else {
    // proximity_detonation
    const falloff = lerp(1.0, PROXIMITY_DAMAGE_FALLOFF_MIN_FRAC, clamp(result.missDistanceM / prof.proximityFuseRadiusM, 0, 1));
    damageFrac = prof.damageFrac * falloff;
  }

  // Realism profiles: roll the warhead's kill probability for this miss distance; a kill destroys
  // the aircraft outright, otherwise it takes the (falloff-reduced) damage.
  if (kind !== ProjectileKind.Bullet && prof.lethality) {
    const d = result.outcome === ProjectileOutcome.DirectHit ? 0 : result.missDistanceM;
    const pk = missileKillProbability(prof.lethality, d);
    _prngBridge.s = rng.seedState >>> 0;
    const u = nextFloat01(_prngBridge);
    rng.seedState = _prngBridge.s;
    if (u < pk) damageFrac = 1;
  }

  const weapon: WeaponKind = kind === ProjectileKind.Bullet ? WeaponKind.Gun : kind;
  const applyResult = applyHit(weapon, damageFrac, targetState, targetDamage, rng);

  const impact = result.impactPos ?? targetState.pos;
  outEvents.push({
    type: 'hit',
    targetId: targetState.id,
    sourceId: ownerId,
    damage: damageFrac,
    weapon,
    pos: { x: impact.x, y: impact.y, z: impact.z },
  });

  if (kind !== ProjectileKind.Bullet) {
    pushExplosionEvent(kind, impact, ownerId, outEvents);
  }

  return { targetLethal: applyResult.lethal, targetNewHp: applyResult.newHp, subsystemHit: applyResult.subsystemHit };
};
