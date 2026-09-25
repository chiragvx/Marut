import { describe, expect, it } from 'vitest';
import { tejasDefinition } from '../../src/aircraft';
import { stepAircraft } from '../../src/physics';
import { aircraftMassKg } from '../../src/physics/integrator';
import { computeStoresLoad, STORE_MASS_KG } from '../../src/combat';
import { makeTrimSeedState, makeFullHealthDamageState, buildTrimEnvironment } from '../../tools/lib/trimSolver';
import { SIM_DT_SEC, type PilotInputs, type EntityState } from '../../src/contracts/core';

function inputs(overrides: Partial<PilotInputs> = {}): PilotInputs {
  return {
    pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 0, gearDown: false,
    airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, ...overrides,
  };
}

/** Airspeed lost over `seconds` of idle-power flight from 150 m/s at 3000 m. */
function speedLossMps(configure: (s: EntityState) => void, inp: PilotInputs, seconds = 3): number {
  const s = makeTrimSeedState({ altitudeM: 3000, speedMps: 150, bankRad: 0, massKg: 9000 });
  configure(s);
  const dmg = makeFullHealthDamageState();
  const env = buildTrimEnvironment(3000);
  for (let i = 0; i < seconds / SIM_DT_SEC; i++) stepAircraft(s, dmg, inp, env as never, tejasDefinition, SIM_DT_SEC, s);
  return 150 - Math.hypot(s.vel.x, s.vel.y, s.vel.z);
}

describe('variable mass', () => {
  it('is empty mass + fuel + stores', () => {
    expect(aircraftMassKg({ fuelKg: 2000, storesMassKg: 500 }, tejasDefinition)).toBe(tejasDefinition.emptyMassKg + 2500);
    expect(aircraftMassKg({ fuelKg: 0 }, tejasDefinition)).toBe(tejasDefinition.emptyMassKg);
  });
});

describe('configuration drag', () => {
  const clean = speedLossMps(() => {}, inputs());
  it('extended gear slows the aircraft faster than clean', () => {
    const gear = speedLossMps((s) => { s.gearPos = 1; }, inputs({ gearDown: true }));
    expect(gear).toBeGreaterThan(clean * 1.1);
  });
  it('the airbrake slows the aircraft markedly faster than clean', () => {
    const brake = speedLossMps(() => {}, inputs({ airbrake: true }));
    expect(brake).toBeGreaterThan(clean * 1.4);
  });
  it('carried stores add drag', () => {
    const stores = speedLossMps((s) => { s.storesDragAreaM2 = 0.3; }, inputs());
    expect(stores).toBeGreaterThan(clean);
  });
});

describe('computeStoresLoad', () => {
  it('sums mass and drag of what is still loaded, and drops as weapons are used', () => {
    const state = {
      stations: [
        { hardpointId: 'gun', posBodyM: { x: 0, y: 0, z: 0 }, weapon: 'gun' as const, count: 100 },
        { hardpointId: 'l', posBodyM: { x: 0, y: 0, z: 0 }, weapon: 'ir_missile' as const, count: 2 },
        { hardpointId: 'r', posBodyM: { x: 0, y: 0, z: 0 }, weapon: 'radar_missile' as const, count: 1 },
      ],
    };
    const out = { massKg: 0, dragAreaM2: 0 };
    computeStoresLoad(state, out);
    expect(out.massKg).toBeCloseTo(100 * STORE_MASS_KG.gun + 2 * STORE_MASS_KG.ir_missile + STORE_MASS_KG.radar_missile, 6);
    const full = { ...out };
    state.stations[1]!.count = 1; // one IR missile launched
    computeStoresLoad(state, out);
    expect(out.massKg).toBeCloseTo(full.massKg - STORE_MASS_KG.ir_missile, 6);
    expect(out.dragAreaM2).toBeLessThan(full.dragAreaM2);
  });
});

describe('drop tanks', () => {
  const tank = tejasDefinition.dropTank!;
  const withTanks = (s: EntityState): void => {
    s.dropTankCount = 2;
    s.dropTankFuelKg = 2 * tank.capacityKg;
  };

  it('add shell + fuel mass', () => {
    const clean = aircraftMassKg({ fuelKg: 1000 }, tejasDefinition);
    const loaded = aircraftMassKg({ fuelKg: 1000, dropTankCount: 2, dropTankFuelKg: 2 * tank.capacityKg }, tejasDefinition);
    expect(loaded - clean).toBeCloseTo(2 * (tank.capacityKg + tank.emptyMassKg), 6);
  });

  it('add drag', () => {
    expect(speedLossMps(withTanks, inputs())).toBeGreaterThan(speedLossMps(() => {}, inputs()));
  });

  it('are burned before internal fuel', () => {
    const s = makeTrimSeedState({ altitudeM: 3000, speedMps: 150, bankRad: 0, massKg: 9000 });
    withTanks(s);
    const internal0 = s.fuelKg;
    const dmg = makeFullHealthDamageState();
    const env = buildTrimEnvironment(3000);
    for (let i = 0; i < 10 / SIM_DT_SEC; i++) stepAircraft(s, dmg, inputs({ throttle: 1, afterburner: true }), env as never, tejasDefinition, SIM_DT_SEC, s);
    expect(s.dropTankFuelKg!).toBeLessThan(2 * tank.capacityKg);
    expect(s.fuelKg).toBe(internal0);
  });

  it('jettison drops the tanks and their fuel', () => {
    const s = makeTrimSeedState({ altitudeM: 3000, speedMps: 150, bankRad: 0, massKg: 9000 });
    withTanks(s);
    stepAircraft(s, makeFullHealthDamageState(), inputs({ jettisonTanks: true }), buildTrimEnvironment(3000) as never, tejasDefinition, SIM_DT_SEC, s);
    expect(s.dropTankCount).toBe(0);
    expect(s.dropTankFuelKg).toBe(0);
  });
});
