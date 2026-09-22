/**
 * src/combat/subsystemDamage.ts — canonical full-health DamageState factory,
 * weighted subsystem-hit roll, and the single `applyHit` entry point that
 * mutates an aircraft's hp/structurePct/subsystem health. See
 * docs/spec/07-combat.md section 4.9/4.10.
 */
import type { DamageState, EntityState } from '../contracts/core';
import {
  SubsystemHitKind,
  SUBSYSTEM_HIT_WEIGHT,
  SUBSYSTEM_DAMAGE_EXTRA_MULT,
  type ApplyHit,
  type ApplyHitResult,
  type CreateDamageState,
  type RollSubsystemHit,
  type SubsystemHitFromU01,
  type CombatRngState,
} from '../contracts/combat';
import { clamp, createPrng, nextFloat01, type PrngState } from '../math';

/** Fixed cumulative-order walk of SUBSYSTEM_HIT_WEIGHT, matching 07-combat.md section 5's table exactly. */
const HIT_ORDER: readonly (typeof SubsystemHitKind)[keyof typeof SubsystemHitKind][] = [
  SubsystemHitKind.StructureOnly,
  SubsystemHitKind.Engine,
  SubsystemHitKind.ElevonL,
  SubsystemHitKind.ElevonR,
  SubsystemHitKind.Rudder,
  SubsystemHitKind.Fuel,
  SubsystemHitKind.Radar,
  SubsystemHitKind.Gear,
  SubsystemHitKind.Hydraulics,
];

export const createDamageState: CreateDamageState = (): DamageState => ({
  structurePct: 1,
  engineHealthPct: 1,
  controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
  hydraulicsOk: true,
  fuelLeak: false,
  radarHealthPct: 1,
  gearHealthPct: 1,
});

/** Pure, RNG-free bucket walk. `u` is a uniform draw in [0,1). Exposed standalone for exact boundary tests. */
export const subsystemHitFromU01: SubsystemHitFromU01 = (u) => {
  let cumulative = 0;
  for (let i = 0; i < HIT_ORDER.length; i++) {
    const kind = HIT_ORDER[i]!;
    cumulative += SUBSYSTEM_HIT_WEIGHT[kind];
    if (u < cumulative) return kind;
  }
  // Floating-point edge case (u extremely close to 1): fall through to the last bucket.
  return SubsystemHitKind.Hydraulics;
};

// Reused scratch PrngState — bridges CombatRngState's `seedState` field name
// to src/math's mulberry32 (`PrngState.s`) without allocating per draw.
const _prngScratch: PrngState = createPrng(0);

function stepRng(rng: CombatRngState): number {
  _prngScratch.s = rng.seedState >>> 0;
  const v = nextFloat01(_prngScratch);
  rng.seedState = _prngScratch.s;
  return v;
}

export const rollSubsystemHit: RollSubsystemHit = (rng) => subsystemHitFromU01(stepRng(rng));

export const applyHit: ApplyHit = (
  weapon,
  damageFrac,
  targetState: EntityState,
  targetDamage: DamageState,
  rng: CombatRngState,
): ApplyHitResult => {
  void weapon; // weapon kind does not currently modulate the flat structural-damage formula.
  const frac = Math.max(damageFrac, 0);
  targetDamage.structurePct = clamp(targetDamage.structurePct - frac, 0, 1);
  const newHp = Math.round(targetDamage.structurePct * 100);
  targetState.hp = newHp;
  const lethal = targetDamage.structurePct <= 0;

  const subsystemHit = rollSubsystemHit(rng);
  const extra = frac * SUBSYSTEM_DAMAGE_EXTRA_MULT;
  switch (subsystemHit) {
    case SubsystemHitKind.Engine:
      targetDamage.engineHealthPct = clamp(targetDamage.engineHealthPct - extra, 0, 1);
      break;
    case SubsystemHitKind.Radar:
      targetDamage.radarHealthPct = clamp(targetDamage.radarHealthPct - extra, 0, 1);
      break;
    case SubsystemHitKind.Gear:
      targetDamage.gearHealthPct = clamp(targetDamage.gearHealthPct - extra, 0, 1);
      break;
    case SubsystemHitKind.ElevonL:
      targetDamage.controlSurfaces.elevonL = clamp(targetDamage.controlSurfaces.elevonL - extra, 0, 1);
      break;
    case SubsystemHitKind.ElevonR:
      targetDamage.controlSurfaces.elevonR = clamp(targetDamage.controlSurfaces.elevonR - extra, 0, 1);
      break;
    case SubsystemHitKind.Rudder:
      targetDamage.controlSurfaces.rudder = clamp(targetDamage.controlSurfaces.rudder - extra, 0, 1);
      break;
    case SubsystemHitKind.Fuel:
      targetDamage.fuelLeak = true;
      break;
    case SubsystemHitKind.Hydraulics:
      targetDamage.hydraulicsOk = false;
      break;
    case SubsystemHitKind.StructureOnly:
    default:
      break;
  }

  return { subsystemHit, lethal, newHp };
};
