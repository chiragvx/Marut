import { describe, it, expect } from 'vitest';
import { createWeaponsState, fireWeapons } from '../../src/combat';
import { WEAPONS } from '../../src/catalog';
import type { ProjectileSpawnRequest, WeaponsLoadout } from '../../src/contracts/combat';
import type { DamageState, EntityState, PilotInputs, SimEvent } from '../../src/contracts/core';

function makeShooterState(): EntityState {
  return {
    id: 1,
    kind: 'aircraft',
    team: 0,
    pos: { x: 0, y: 1000, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 200, y: 0, z: 0 },
    omega: { x: 0, y: 0, z: 0 },
    alive: true,
    hp: 100,
    fuelKg: 1000,
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    gearPos: 0,
    throttle: 1,
    afterburnerOn: false,
    flags: 0,
  };
}

const FULL_DAMAGE: DamageState = {
  structurePct: 1,
  engineHealthPct: 1,
  controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
  hydraulicsOk: true,
  fuelLeak: false,
  radarHealthPct: 1,
  gearHealthPct: 1,
};

describe('createWeaponsState', () => {
  it('initializes station counts from the loadout', () => {
    const loadout: WeaponsLoadout = { stations: [{ hardpointId: 'gun', posBodyM: { x: 3, y: 0, z: 0 }, weapon: 'gun', maxCount: 220 }] };
    const state = createWeaponsState(loadout, 1);
    expect(state.stations[0]!.count).toBe(220);
  });
});

describe('fireWeapons (gun)', () => {
  it('produces ~56.67 gunFire events over 1.0s of trigger-held ticks at 120 Hz', () => {
    const loadout: WeaponsLoadout = { stations: [{ hardpointId: 'gun', posBodyM: { x: 3, y: 0, z: 0 }, weapon: 'gun', maxCount: 220 }] };
    const state = createWeaponsState(loadout, 1);
    const shooter = makeShooterState();
    const dt = 1 / 120;
    const inputs: PilotInputs = {
      pitch: 0, roll: 0, yaw: 0, throttle: 1, afterburner: false, brakes: 0, gearDown: false, airbrake: false,
      trigger: true, launch: false, cycleWeapon: false, cycleTarget: false,
    };

    let totalGunFire = 0;
    for (let i = 0; i < 120; i++) {
      const outRequests: ProjectileSpawnRequest[] = [];
      const outEvents: SimEvent[] = [];
      fireWeapons(1, shooter, FULL_DAMAGE, undefined, inputs, state, i * dt, dt, outRequests, outEvents);
      totalGunFire += outEvents.filter((e) => e.type === 'gunFire').length;
    }

    expect(totalGunFire).toBeGreaterThanOrEqual(55);
    expect(totalGunFire).toBeLessThanOrEqual(57);
    expect(state.stations[0]!.count).toBe(220 - totalGunFire);
  });
});

describe('fireWeapons (CCRP release window)', () => {
  const bombLoadout = (): WeaponsLoadout => ({ stations: [{ hardpointId: 'wing', posBodyM: { x: 0, y: -0.3, z: 2 }, weapon: 'bomb', maxCount: 1, profile: WEAPONS['hsld-250']! }] });
  const held: PilotInputs = {
    pitch: 0, roll: 0, yaw: 0, throttle: 1, afterburner: false, brakes: 0, gearDown: false, airbrake: false,
    trigger: false, launch: true, cycleWeapon: false, cycleTarget: false,
  };
  const releaseAt = (ttr: number): number => {
    const state = createWeaponsState(bombLoadout(), 1);
    state.selectedStoreId = 'hsld-250';
    state.selectedWeapon = 'bomb';
    state.spiValid = true;
    state.ccrpTimeToReleaseSec = ttr;
    state.ccrpCrossTrackM = 0;
    const out: ProjectileSpawnRequest[] = [];
    fireWeapons(1, makeShooterState(), FULL_DAMAGE, undefined, held, state, 0, 1 / 120, out, []);
    return out.length;
  };

  it('releases at the release point', () => {
    expect(releaseAt(0)).toBe(1);
    expect(releaseAt(-0.1)).toBe(1);
  });
  it('holds before it', () => {
    expect(releaseAt(0.5)).toBe(0);
  });
  it('never drops late (pressed or held well past the release point)', () => {
    expect(releaseAt(-0.5)).toBe(0);
    expect(releaseAt(-3)).toBe(0);
  });
});
