/**
 * tests/combat/radarTracks.test.ts — the radar's track file: memory after a lost contact, IFF
 * (friend) and non-cooperative identification (hostile), stable T cycling that skips friends, and
 * the dogfight (ACM) auto-acquisition.
 */
import { describe, expect, it } from 'vitest';
import { createWeaponsState, updateSensors } from '../../src/combat';
import { RADARS } from '../../src/catalog';
import type { DetectableEntity, WeaponsLoadout } from '../../src/contracts/combat';
import type { Contact, DamageState, HeightSampler, PilotInputs, SimEvent, Vec3Like } from '../../src/contracts/core';

// Observer at the origin, 5 km up, heading east (identity rotation = nose along +x).
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const FLAT: HeightSampler = { seed: 0, heightAt: () => 0, normalAt: (_x, _z, out) => { out.x = 0; out.y = 1; out.z = 0; return out; } };
const DAMAGE: DamageState = { structurePct: 1, engineHealthPct: 1, controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 }, hydraulicsOk: true, fuelLeak: false, radarHealthPct: 1, gearHealthPct: 1 };
const DT = 1 / 120;
const inputs = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.8, afterburner: false, brakes: 0, gearDown: false, airbrake: false,
  trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...over,
});
const ac = (id: number, team: 0 | 1, pos: Vec3Like, vel: Vec3Like = { x: 250, y: 0, z: 0 }): DetectableEntity => ({ id, team, kind: 'aircraft', pos, vel, rot: IDENTITY, alive: true });

function setup(targets: DetectableEntity[]) {
  const loadout: WeaponsLoadout = { stations: [{ hardpointId: 'gun', posBodyM: { x: 3, y: 0, z: 0 }, weapon: 'gun', maxCount: 220 }], radar: RADARS['elm-2052'] };
  const state = createWeaponsState(loadout, 1);
  const observer = ac(1, 0, { x: 0, y: 5000, z: 0 });
  let t = 0;
  let contacts: Contact[] = [];
  const step = (sec: number, inp: PilotInputs = inputs(), all: DetectableEntity[] = targets): Contact[] => {
    for (let k = 0; k < Math.round(sec / DT); k++) {
      contacts = [];
      const events: SimEvent[] = [];
      updateSensors(1, observer, DAMAGE, 5000, inp, [observer, ...all], FLAT, state, t, DT, contacts, events);
      t += DT;
    }
    return contacts;
  };
  return { state, step };
}

describe('radar track file', () => {
  it('detects a fighter out to ~100 km with the EL/M-2052, not at 150 km', () => {
    expect(setup([ac(2, 1, { x: 95000, y: 5000, z: 0 }, { x: -250, y: 0, z: 0 })]).step(0.1).length).toBe(1);
    expect(setup([ac(2, 1, { x: 150000, y: 5000, z: 0 }, { x: -250, y: 0, z: 0 })]).step(0.1).length).toBe(0);
  });

  it('keeps a lost track on memory for a few seconds (extrapolated), then drops it', () => {
    const target = ac(2, 1, { x: 30000, y: 5000, z: 0 }, { x: -250, y: 0, z: 0 });
    const { step } = setup([target]);
    step(0.5);
    const lost = step(1, inputs(), []);
    expect(lost.length).toBe(1);
    expect(lost[0]!.memory).toBe(true);
    expect(lost[0]!.pos.x).toBeCloseTo(30000 - 250 * 1, -1); // coasted on at its last velocity
    expect(step(5, inputs(), []).length).toBe(0);
  });

  it('identifies a friend by IFF and a hostile by NCTR inside 60 km; unknown beyond', () => {
    const { step } = setup([ac(2, 0, { x: 40000, y: 5000, z: 3000 }), ac(3, 1, { x: 45000, y: 5000, z: -3000 }), ac(4, 1, { x: 90000, y: 5000, z: 0 })]);
    const c = step(2.5);
    const byId = (id: number) => c.find((x) => x.id === id)!;
    expect(byId(2).identity).toBe('friend');
    expect(byId(3).identity).toBe('hostile');
    expect(byId(4).identity).toBe('unknown');
    expect(byId(4).identified).toBe(false);
  });

  it('T steps outward through non-friendly tracks, skipping friends, and wraps', () => {
    const { state, step } = setup([ac(2, 1, { x: 20000, y: 5000, z: 0 }), ac(3, 0, { x: 25000, y: 5000, z: 1000 }), ac(4, 1, { x: 30000, y: 5000, z: 0 })]);
    step(2);
    const press = (): void => {
      step(DT, inputs({ cycleTarget: true }));
      step(DT);
    };
    press();
    expect(state.lockedTargetId).toBe(2);
    press();
    expect(state.lockedTargetId).toBe(4);
    press();
    expect(state.lockedTargetId).toBe(2);
  });

  it('ACM auto-acquires the nearest non-friend in the HUD field, not one off to the side', () => {
    const { state, step } = setup([ac(2, 1, { x: 8000, y: 5400, z: 400 }), ac(3, 1, { x: 3000, y: 5000, z: 6000 })]);
    step(0.1);
    step(DT, inputs({ radarModeCycle: true }));
    step(0.2);
    expect(state.radarMode).toBe('acm');
    expect(state.lockedTargetId).toBe(2);
  });
});
