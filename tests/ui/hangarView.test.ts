import { describe, expect, it } from 'vitest';
import type { AirportLayout } from '../../src/contracts/airport';
import { clampOrbit, findHangarBay, orbitCameraLocal, HANGAR_ORBIT_LIMITS } from '../../src/ui/hangarView';
import { packFitStores } from '../../src/aircraft/loadout';
import { STORE_IDS } from '../../src/contracts/core';
import { tejasDefinition as TEJAS_MK1A } from '../../src/aircraft';

const hangar = (id: string, w: number, l: number, h: number) => ({ id, kind: 'hangar' as const, worldX: 0, worldZ: 0, headingRad: 0, widthM: w, lengthM: l, heightM: h });

describe('loadout hangar view', () => {
  it('picks a roomy hangar, else the smallest a Tejas fits in', () => {
    const layout = { structures: [hangar('big', 90, 86, 17), hangar('roomy', 41, 34, 11), hangar('small', 30, 28, 10.4), hangar('tiny', 18, 15, 6)] } as unknown as AirportLayout;
    expect(findHangarBay(layout)?.id).toBe('roomy');
    const tight = { structures: [hangar('big', 90, 86, 17), hangar('small', 30, 28, 10.4)] } as unknown as AirportLayout;
    expect(findHangarBay(tight)?.id).toBe('small');
    expect(findHangarBay({ structures: [hangar('tiny', 18, 15, 6)] } as unknown as AirportLayout)).toBeUndefined();
  });

  it('keeps the camera inside the shed and above the floor', () => {
    const bay = { widthM: 30, lengthM: 28, heightM: 10.4 };
    const target = { x: 0, y: 1.9, z: 1 };
    for (let yaw = 0; yaw < 6.3; yaw += 0.4) {
      for (const pitch of [HANGAR_ORBIT_LIMITS.pitchMin, 0.3, HANGAR_ORBIT_LIMITS.pitchMax]) {
        const p = orbitCameraLocal(clampOrbit({ yaw, pitch, dist: 40 }), target, bay);
        expect(Math.abs(p.x)).toBeLessThan(15);
        expect(Math.abs(p.z)).toBeLessThan(14);
        expect(p.y).toBeGreaterThan(0.4);
        expect(p.y).toBeLessThan(10.4 * 0.72);
      }
    }
  });

  it('clamps zoom and pitch', () => {
    expect(clampOrbit({ yaw: 0, pitch: 3, dist: 1 })).toEqual({ yaw: 0, pitch: HANGAR_ORBIT_LIMITS.pitchMax, dist: HANGAR_ORBIT_LIMITS.distMin });
  });

  it('packs a fit for drawing', () => {
    const outer = TEJAS_MK1A.stations!.find((s) => s.id === 'wing-outer-l')!;
    const store = outer.accepts.find((s) => STORE_IDS.indexOf(s) > 0)!;
    const p = packFitStores(TEJAS_MK1A, { 'wing-outer-l': { store, count: 1 } });
    expect(p.a + p.b).toBeGreaterThan(0);
    expect(packFitStores(TEJAS_MK1A, {})).toEqual({ a: 0, b: 0 });
  });
});
