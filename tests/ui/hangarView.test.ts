import { describe, expect, it } from 'vitest';
import type { AirportLayout } from '../../src/contracts/airport';
import { C17_HANGAR_FIT, C17_HANGAR_SUBJECT, clampOrbit, findHangarBay, orbitCameraLocal, HANGAR_ORBIT_LIMITS } from '../../src/ui/hangarView';
import { c17Definition } from '../../src/aircraft/c17Definition';
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

  it('puts the C-17 in a hangar it fits, drawn tall enough for its fin', () => {
    const layout = { structures: [hangar('big', 88.7, 86.4, 17.4), hangar('wide', 95, 28, 10.4), hangar('roomy', 41, 34, 11)] } as unknown as AirportLayout;
    const bay = findHangarBay(layout, C17_HANGAR_FIT)!;
    expect(bay.id).toBe('big');
    expect(bay.widthM).toBeGreaterThan(c17Definition.wingSpanM + 15);
    // The fin (16.8 m) under the tie beams and lamps (wall height 0.72 x the interior height, lamps 1 m below).
    expect(bay.heightM * 0.72 - 1).toBeGreaterThan(16.8 + 0.5);
    expect(findHangarBay({ structures: [hangar('roomy', 41, 34, 11)] } as unknown as AirportLayout, C17_HANGAR_FIT)).toBeUndefined();
    // Stand-off: the closest the camera comes is outside the wing tips' half-span from the middle.
    expect(C17_HANGAR_SUBJECT.limits.distMin).toBeGreaterThan(15);
    expect(C17_HANGAR_SUBJECT.limits.distMax).toBeLessThan(bay.lengthM);
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
