/**
 * tests/combat/jammer.test.ts — the self-protection jammer pod (EL/L-8222): a fighter's radar and an
 * air-defence battery see and track a jamming jet only inside burn-through range (and normally
 * otherwise); chaff is likelier to decoy a radar missile homing on it; its mass and drag count.
 */
import { describe, expect, it, test } from 'vitest';
import {
  AirDefenceNetwork,
  burnThroughRangeM,
  chaffSeductionChance,
  computeGeometry,
  computeStoresLoad,
  createWeaponsState,
  radarDetectionRangeM,
  updateSensors,
  writeCombatStatus,
  type AdSiteSpec,
  type AdUnitSpec,
} from '../../src/combat';
import { JAMMER_PODS, SITE_TEMPLATES } from '../../src/catalog';
import {
  JAMMER_BURN_THROUGH_FACTOR,
  JAMMER_CHAFF_FACTOR,
  JAMMER_SAM_BURN_THROUGH_FACTOR,
  type DetectableEntity,
  type ProjectileSpawnRequest,
  type WeaponsLoadout,
} from '../../src/contracts/combat';
import { PodFlag, type CombatStatus, type Contact, type HeightSampler, type PilotInputs, type SimEvent } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const NO_TERRAIN: HeightSampler = { seed: 0, heightAt: () => -1_000_000, normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o) };
const NO_INPUTS: PilotInputs = {
  pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 0, gearDown: false, airbrake: false,
  trigger: false, launch: false, cycleWeapon: false, cycleTarget: false,
};
const DAMAGE = { structurePct: 1, engineHealthPct: 1, controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 }, hydraulicsOk: true, fuelLeak: false, radarHealthPct: 1, gearHealthPct: 1 };
const POD = JAMMER_PODS['el-l-8222']!;

describe('burnThroughRangeM', () => {
  it('cuts a radar range to the burn-through factor only for a jamming target', () => {
    expect(burnThroughRangeM(80000, {})).toBe(80000);
    expect(burnThroughRangeM(80000, { jamming: false })).toBe(80000);
    expect(burnThroughRangeM(80000, { jamming: true })).toBeCloseTo(80000 * JAMMER_BURN_THROUGH_FACTOR, 6);
    expect(burnThroughRangeM(80000, { jamming: true }, JAMMER_SAM_BURN_THROUGH_FACTOR)).toBeCloseTo(80000 * JAMMER_SAM_BURN_THROUGH_FACTOR, 6);
    // Ground radars (bigger, more powerful) burn through further out than a fighter's.
    expect(JAMMER_SAM_BURN_THROUGH_FACTOR).toBeGreaterThan(JAMMER_BURN_THROUGH_FACTOR);
  });
});

describe("a fighter's radar against a jamming target", () => {
  const observer: DetectableEntity = { id: 1, team: 0, kind: 'aircraft', pos: { x: 0, y: 5000, z: 0 }, vel: { x: 250, y: 0, z: 0 }, rot: IDENTITY, alive: true };
  const target = (rangeM: number, jamming: boolean): DetectableEntity => ({
    id: 2, team: 1, kind: 'aircraft', pos: { x: rangeM, y: 5000, z: 0 }, vel: { x: -250, y: 0, z: 0 }, rot: IDENTITY, alive: true, jamming,
  });
  /** The target's contacts on a fresh radar (no track memory) after one sweep. */
  const contacts = (t: DetectableEntity): Contact[] => {
    const loadout: WeaponsLoadout = { stations: [{ hardpointId: 'gun', posBodyM: { x: 3, y: 0, z: 0 }, weapon: 'gun', maxCount: 220 }] };
    const state = createWeaponsState(loadout, 42);
    const out: Contact[] = [];
    updateSensors(1, observer, DAMAGE, 5000, NO_INPUTS, [observer, t], NO_TERRAIN, state, 0, 1 / 120, out, [] as SimEvent[]);
    return out;
  };
  // The radar's normal range against this target at this aspect.
  const r0 = radarDetectionRangeM(computeGeometry(observer, target(50000, false), NO_TERRAIN).rcsM2);

  it('detects a non-jamming target at 80% of its normal range, but not a jamming one', () => {
    expect(contacts(target(0.8 * r0, false))).toHaveLength(1);
    expect(contacts(target(0.8 * r0, true))).toHaveLength(0);
  });

  it('burns through: the jamming target is detected inside the burn-through range', () => {
    expect(contacts(target(0.9 * JAMMER_BURN_THROUGH_FACTOR * r0, true))).toHaveLength(1);
  });
});

describe('an air-defence battery against a jamming target', () => {
  const LY80 = SITE_TEMPLATES['sam-mr-battery']!.airDefence!;
  const flat: HeightSampler = { seed: 0, heightAt: () => 200, normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o) };
  /** Whether a LY-80 battery's engagement radar is tracking a jet held at `x` m (6 km up) after 2 s. */
  function tracks(x: number, jamming: boolean): boolean {
    const sites: AdSiteSpec[] = [{ id: 'sam', team: 1, system: LY80, emcon: 'active' }];
    const units: AdUnitSpec[] = [
      { entityId: 1, siteId: 'sam', typeId: 'radar-search' },
      { entityId: 2, siteId: 'sam', typeId: 'radar-track' },
      { entityId: 3, siteId: 'sam', typeId: 'sam-tel' },
    ];
    const ents: DetectableEntity[] = [1, 2, 3].map((id) => ({ id, team: 1, kind: 'ground', pos: { x: 0, y: 200, z: id * 50 }, vel: { x: 0, y: 0, z: 0 }, rot: IDENTITY, alive: true }));
    const jet: DetectableEntity = { id: 100, team: 0, kind: 'aircraft', pos: { x, y: 6000, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: IDENTITY, alive: true, radarSignature: { noseOnRcsM2: 2, broadsideRcsM2: 6 }, jamming };
    const net = new AirDefenceNetwork(sites, units, 7);
    for (let t = 0; t < 2; t += 1 / 120) net.step(t, 1 / 120, [...ents, jet], () => false, flat, [] as ProjectileSpawnRequest[], []);
    return net.emissions().some((e) => e.state >= 1 && e.targetId === 100);
  }

  it('tracks a non-jamming jet at 45 km but not a jamming one (outside burn-through)', () => {
    // Track range against this jet: 60 km x (4/5)^0.25 = 56.7 km; jamming: x 0.7 = 39.7 km.
    expect(tracks(45000, false)).toBe(true);
    expect(tracks(45000, true)).toBe(false);
  });

  it('burns through and tracks the jamming jet at 30 km', () => {
    expect(tracks(30000, true)).toBe(true);
  });
});

describe('chaff against a radar missile homing on a jamming target', () => {
  const tgt = { x: 0, y: 5000, z: 0 };
  const vel = { x: 250, y: 0, z: 0 };
  const beam = { x: 0, y: 5000, z: 8000 };
  const ahead = { x: 8000, y: 5000, z: 0 };

  it('is JAMMER_CHAFF_FACTOR times likelier, capped at 1', () => {
    const plain = chaffSeductionChance(0.5, ahead, tgt, vel);
    expect(chaffSeductionChance(0.5, ahead, tgt, vel, true)).toBeCloseTo(plain * JAMMER_CHAFF_FACTOR, 9);
    expect(chaffSeductionChance(0.5, ahead, tgt, vel, false)).toBe(plain);
    // Beaming a seeker with no chaff resistance: already 1, stays 1.
    expect(chaffSeductionChance(0, beam, tgt, vel, true)).toBe(1);
  });
});

describe('the jammer pod is carried', () => {
  it("adds its mass and drag to the stores load (with the targeting pod's and the weapons')", () => {
    const loadout: WeaponsLoadout = { stations: [{ hardpointId: 'gun', posBodyM: { x: 3, y: 0, z: 0 }, weapon: 'gun', maxCount: 220 }] };
    const out = { massKg: 0, dragAreaM2: 0 };
    computeStoresLoad(createWeaponsState(loadout, 1), out);
    const clean = { ...out };
    const s = createWeaponsState({ ...loadout, jammer: POD }, 1);
    expect(s.jammer).toBe(POD);
    computeStoresLoad(s, out);
    expect(out.massKg - clean.massKg).toBeCloseTo(POD.massKg, 9);
    expect(out.dragAreaM2 - clean.dragAreaM2).toBeCloseTo(POD.dragAreaM2, 9);
  });

  it('raises the JAM cue (POD_FLAGS Jammer bit) in the combat status, and only with the pod', () => {
    const loadout: WeaponsLoadout = { stations: [{ hardpointId: 'gun', posBodyM: { x: 3, y: 0, z: 0 }, weapon: 'gun', maxCount: 220 }] };
    const status = (s: ReturnType<typeof createWeaponsState>): CombatStatus => {
      const out = { aimPointWorld: { x: 0, y: 0, z: 0 } } as CombatStatus;
      writeCombatStatus(s, out);
      return out;
    };
    expect((status(createWeaponsState({ ...loadout, jammer: POD }, 1)).podFlags ?? 0) & PodFlag.Jammer).toBe(PodFlag.Jammer);
    expect((status(createWeaponsState(loadout, 1)).podFlags ?? 0) & PodFlag.Jammer).toBe(0);
  });

  test('in the running sim, a fit with the pod on the outer wing station weighs the pod more', () => {
    const storesKg = (withPod: boolean): number => {
      const base = resolveBuiltinMission('konkan-free');
      const mission = {
        ...base,
        playerStart: {
          ...base.playerStart,
          loadout: {
            'wing-outer-r': { store: 'r-73', count: 1 },
            ...(withPod ? { 'wing-outer-l': { store: 'el-l-8222', count: 1 } } : {}),
          },
        },
      };
      const world = createWorld(buildWorldDependencies(mission));
      world.loadMission(mission);
      const id = world.getPlayerEntityId();
      world.stepOnce();
      return world.getEntityState(id)!.storesMassKg ?? 0;
    };
    expect(storesKg(true) - storesKg(false)).toBeCloseTo(POD.massKg, 6);
  });
});
