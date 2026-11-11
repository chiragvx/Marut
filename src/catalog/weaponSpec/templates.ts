/**
 * src/catalog/weaponSpec/templates.ts — weapon families. A weapon spec `extends` one of these (or
 * another weapon) and fills in its own numbers. A template only holds what the whole family has in
 * common; anything a weapon must decide for itself is left out, so validation asks for it.
 */
import type { WeaponSpecFull } from './types';

type DeepPartial<T> = T extends (infer U)[] ? U[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type WeaponTemplate = DeepPartial<WeaponSpecFull> & { extends?: string };

export const TEMPLATES: Readonly<Record<string, WeaponTemplate>> = {
  /** Aircraft or ground gun: unguided rounds, damage per round. */
  gun: {
    kind: 'gun',
    carriage: { dragAreaM2: 0 },
    release: { minRangeM: 0 },
    guidance: { law: 'none' },
    seeker: { type: 'none' },
    fuze: { proximityM: 0 },
  },

  /** Air-to-air missile with an infrared seeker. */
  'ir-missile': {
    kind: 'ir_missile',
    release: { roundIntervalSec: 0, dispersionMrad: 0 },
    guidance: { law: 'pn' },
    seeker: { type: 'ir' },
    warhead: { damageFrac: 0.6 },
  },

  /** Air-to-air missile with a radar seeker (datalink mid-course, own seeker at the end). */
  'radar-missile': {
    kind: 'radar_missile',
    release: { roundIntervalSec: 0, dispersionMrad: 0 },
    guidance: { law: 'pn' },
    seeker: { type: 'radar' },
    warhead: { damageFrac: 0.65 },
  },

  /** Surface-to-air radar missile: fired from a launcher, guided by its site's radar. */
  'sam-radar': {
    extends: 'radar-missile',
    carriage: { dragAreaM2: 0 },
    release: { minRangeM: 0 },
    seeker: { type: 'radar', siteGuided: true },
  },

  /** Shoulder-launched / short-range infrared surface-to-air missile. */
  'sam-ir': {
    extends: 'ir-missile',
    carriage: { dragAreaM2: 0 },
  },

  /** Free-fall bomb: no motor, no guidance; impact fuze. */
  bomb: {
    kind: 'bomb',
    release: { minRangeM: 0, roundIntervalSec: 0, dispersionMrad: 0 },
    airframe: { maxG: 0 },
    guidance: { law: 'none' },
    seeker: { type: 'none' },
    fuze: { proximityM: 0 },
    warhead: { damageFrac: 1 },
  },

  /** Bomb with a retarding tail for low-level release. */
  'retarded-bomb': {
    extends: 'bomb',
  },

  /** Unguided rocket (usually several to a pod), fired in a ripple. */
  rocket: {
    kind: 'rocket',
    release: { minRangeM: 0 },
    airframe: { maxG: 0 },
    guidance: { law: 'none' },
    seeker: { type: 'none' },
    fuze: { proximityM: 0 },
    warhead: { damageFrac: 1 },
  },

  /** Guided bomb / stand-off weapon (laser or GPS seeker), with a launch-zone cue. */
  'guided-bomb': {
    kind: 'guided_bomb',
    release: { minRangeM: 0, roundIntervalSec: 0, dispersionMrad: 0 },
    guidance: { law: 'pn' },
    fuze: { proximityM: 0 },
    warhead: { damageFrac: 1 },
  },

  /** Anti-radiation missile: homes on a transmitting radar. */
  arm: {
    kind: 'arm',
    release: { minRangeM: 0, roundIntervalSec: 0, dispersionMrad: 0 },
    guidance: { law: 'pn' },
    seeker: { type: 'arm' },
    fuze: { proximityM: 0 },
    warhead: { damageFrac: 1 },
  },
};
