/**
 * src/combat/effectsEvents.ts — explosion SimEvent builder and the single
 * `resolveProjectileHit` entry point src/core calls for every 'direct_hit'/
 * 'proximity_detonation' stepProjectile result. See docs/spec/07-combat.md
 * section 4.9.
 */
import { WeaponKind, type Vec3Like } from '../contracts/core';
import {
  GUN_HIT_DAMAGE_FRAC,
  IR_WARHEAD_DAMAGE_FRAC,
  RADAR_MISSILE_WARHEAD_DAMAGE_FRAC,
  IR_PROXIMITY_FUSE_RADIUS_M,
  RADAR_MISSILE_PROXIMITY_FUSE_RADIUS_M,
  PROXIMITY_DAMAGE_FALLOFF_MIN_FRAC,
  EXPLOSION_RADIUS_MISSILE_M,
  ProjectileKind,
  ProjectileOutcome,
  type PushExplosionEvent,
  type ResolveProjectileHit,
} from '../contracts/combat';
import { clamp, lerp } from '../math';
import { applyHit } from './subsystemDamage';

export const pushExplosionEvent: PushExplosionEvent = (kind, pos: Vec3Like, causedBy, outEvents) => {
  void kind; // radius is fixed regardless of missile kind (EXPLOSION_RADIUS_MISSILE_M); kept for signature symmetry.
  outEvents.push({
    type: 'explosion',
    pos: { x: pos.x, y: pos.y, z: pos.z },
    radiusM: EXPLOSION_RADIUS_MISSILE_M,
    causedBy,
  });
};

function warheadFrac(kind: (typeof ProjectileKind)[keyof typeof ProjectileKind]): number {
  return kind === ProjectileKind.IrMissile ? IR_WARHEAD_DAMAGE_FRAC : RADAR_MISSILE_WARHEAD_DAMAGE_FRAC;
}

function fuseRadius(kind: (typeof ProjectileKind)[keyof typeof ProjectileKind]): number {
  return kind === ProjectileKind.IrMissile ? IR_PROXIMITY_FUSE_RADIUS_M : RADAR_MISSILE_PROXIMITY_FUSE_RADIUS_M;
}

export const resolveProjectileHit: ResolveProjectileHit = (
  result,
  ownerId,
  kind,
  targetState,
  targetDamage,
  rng,
  outEvents,
) => {
  let damageFrac: number;
  if (kind === ProjectileKind.Bullet) {
    damageFrac = GUN_HIT_DAMAGE_FRAC;
  } else if (result.outcome === ProjectileOutcome.DirectHit) {
    damageFrac = warheadFrac(kind);
  } else {
    // proximity_detonation
    const falloff = lerp(1.0, PROXIMITY_DAMAGE_FALLOFF_MIN_FRAC, clamp(result.missDistanceM / fuseRadius(kind), 0, 1));
    damageFrac = warheadFrac(kind) * falloff;
  }

  const weapon = kind === ProjectileKind.Bullet ? WeaponKind.Gun : kind === ProjectileKind.IrMissile ? WeaponKind.IrMissile : WeaponKind.RadarMissile;
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
