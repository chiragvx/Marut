/**
 * src/combat/weaponProfiles.ts — the generic weapon and radar profiles (from src/catalog, built on
 * the contracts/combat.ts constants) used wherever a station, projectile or weapons state carries
 * no profile of its own.
 */
import { WeaponKind } from '../contracts/core';
import { ProjectileKind, type WeaponProfile } from '../contracts/combat';
import { GENERIC_GUN_PROFILE, GENERIC_IR_MISSILE_PROFILE, GENERIC_RADAR_MISSILE_PROFILE, GENERIC_RADAR_PROFILE } from '../catalog/weapons';

export { GENERIC_GUN_PROFILE, GENERIC_IR_MISSILE_PROFILE, GENERIC_RADAR_MISSILE_PROFILE, GENERIC_RADAR_PROFILE };

export function defaultWeaponProfile(kind: WeaponKind): WeaponProfile {
  return kind === WeaponKind.Gun ? GENERIC_GUN_PROFILE : kind === WeaponKind.IrMissile ? GENERIC_IR_MISSILE_PROFILE : GENERIC_RADAR_MISSILE_PROFILE;
}

/** A projectile's profile: its own, else the generic one for its kind. */
export function projectileProfile(p: { kind: ProjectileKind; profile?: WeaponProfile }): WeaponProfile {
  if (p.profile) return p.profile;
  return p.kind === ProjectileKind.Bullet ? GENERIC_GUN_PROFILE : p.kind === ProjectileKind.IrMissile ? GENERIC_IR_MISSILE_PROFILE : GENERIC_RADAR_MISSILE_PROFILE;
}
