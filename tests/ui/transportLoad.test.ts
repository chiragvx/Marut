/**
 * tests/ui/transportLoad.test.ts — the C-17 load planner's arithmetic (src/ui/transportLoad.ts):
 * presets inside MTOW and the CG envelope, saved loads made safe, the load reaching the mission.
 */
import { describe, expect, it } from 'vitest';
import { c17Definition as def } from '../../src/aircraft/c17Definition';
import { cgMacFraction } from '../../src/aircraft/massModel';
import { cgOffsetBodyX } from '../../src/physics/integrator';
import { DEFAULT_TRANSPORT_LOAD, MIN_TRANSPORT_FUEL_FRAC, TRANSPORT_PRESETS, describeTransportLoad, normalizeTransportLoad, transportWeight, withTransportLoad } from '../../src/ui/transportLoad';
import { freeFlightMission } from '../../src/core/missions/catalogue';

describe('C-17 load planner', () => {
  it('every preset is within MTOW and the CG envelope', () => {
    for (const p of TRANSPORT_PRESETS) {
      const w = transportWeight(def, p);
      expect(w.overKg, p.id).toBe(0);
      expect(w.cgMac!, p.id).toBeGreaterThanOrEqual(def.massModel!.cgRangeMac![0]);
      expect(w.cgMac!, p.id).toBeLessThanOrEqual(def.massModel!.cgRangeMac![1]);
    }
    expect(TRANSPORT_PRESETS.find((p) => p.id === DEFAULT_TRANSPORT_LOAD.presetId)).toMatchObject({ fuelFrac: DEFAULT_TRANSPORT_LOAD.fuelFrac, cargoKg: DEFAULT_TRANSPORT_LOAD.cargoKg });
  });

  it('the CG it shows is the flight model\'s', () => {
    for (const [fuel, cargo] of [[0, 0], [110949, 0], [60000, 77519], [20000, 30000]] as const) {
      const mass = def.emptyMassKg + fuel + cargo;
      const dx = cgOffsetBodyX({ fuelKg: fuel, cargoMassKg: cargo }, def, mass);
      expect(cgMacFraction(def, fuel, cargo)).toBeCloseTo(def.massModel!.referenceCgMac! - dx / def.meanChordM, 9);
    }
    // Empty at the reference CG; full wing fuel moves it a little aft.
    expect(cgMacFraction(def, 0, 0)).toBeCloseTo(0.3, 9);
    expect(cgMacFraction(def, def.maxFuelKg, 0)!).toBeGreaterThan(0.3);
  });

  it('shows the turning speeds: heavier needs more speed for the full g', () => {
    const light = transportWeight(def, { fuelFrac: 0.15, cargoKg: 0 });
    const heavy = transportWeight(def, { fuelFrac: 0.53, cargoKg: 77519 });
    expect(light.stallMps).toBeLessThan(heavy.stallMps);
    expect(light.fullGMps).toBeGreaterThan(light.stallMps * Math.sqrt(def.fcsLimits.maxGLoadPos));
    // ~200 t: the clean stall near the pack's 80.5 m/s (C17_PERFORMANCE_TARGETS stall_clean_200t).
    const mid = transportWeight(def, { fuelFrac: (200000 - def.emptyMassKg) / def.maxFuelKg, cargoKg: 0 });
    expect(mid.stallMps).toBeGreaterThan(75);
    expect(mid.stallMps).toBeLessThan(86);
  });

  it('makes a saved load safe', () => {
    expect(normalizeTransportLoad(def, undefined)).toEqual(DEFAULT_TRANSPORT_LOAD);
    expect(normalizeTransportLoad(def, { fuelFrac: 'x' })).toEqual(DEFAULT_TRANSPORT_LOAD);
    expect(normalizeTransportLoad(def, { fuelFrac: 5, cargoKg: 1e9 })).toEqual({ fuelFrac: 1, cargoKg: def.massModel!.maxCargoKg });
    expect(normalizeTransportLoad(def, { fuelFrac: 0, cargoKg: -3 })).toEqual({ fuelFrac: MIN_TRANSPORT_FUEL_FRAC, cargoKg: 0 });
    expect(normalizeTransportLoad(def, { presetId: 'troops', fuelFrac: 0.6, cargoKg: 12240 }).presetId).toBe('troops');
    expect(normalizeTransportLoad(def, { presetId: 'troops', fuelFrac: 0.7, cargoKg: 12240 }).presetId).toBeUndefined();
  });

  it('puts the load on the mission', () => {
    const m = withTransportLoad(freeFlightMission('bathinda', 'runway', 'c-17'), { fuelFrac: 0.6, cargoKg: 12240 });
    expect(m.playerStart.fuelFrac).toBe(0.6);
    expect(m.playerStart.cargoKg).toBe(12240);
    expect(m.playerStart.aircraftId).toBe('c-17');
    expect(describeTransportLoad(def, { presetId: 'troops', fuelFrac: 0.6, cargoKg: 12240 })).toMatch(/^Troops · 60% fuel · 12 t cargo · 207 t$/);
  });
});
