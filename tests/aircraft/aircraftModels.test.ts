/**
 * Each aircraft type is drawn with its own 3D model where it has one: the model code rides in the
 * entity's flags (set at spawn), the renderer picks the model by it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AircraftModel, aircraftModelOf } from '../../src/contracts/core';
import { flightModelAdapter } from '../../src/core/flightModelAdapter';
import { buildWorldDependencies, createWorld, resolveBuiltinMission } from '../../src/core';
import { jf17Definition } from '../../src/aircraft/aggressors';
import { tejasDefinition } from '../../src/aircraft/tejasDefinition';

describe('aircraft models', () => {
  it('names the JF-17 model for the JF-17 and the Tejas for the rest', () => {
    expect(flightModelAdapter.renderModel!('jf-17')).toBe(AircraftModel.Jf17);
    expect(flightModelAdapter.renderModel!('tejas-mk1a')).toBe(AircraftModel.Tejas);
    expect(flightModelAdapter.renderModel!('f-16')).toBe(AircraftModel.Tejas);
  });

  it('carries the model in the spawned aircraft flags, beside the others', () => {
    const mission = resolveBuiltinMission('border-duel');
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const player = world.getEntityState(world.getPlayerEntityId())!;
    expect(aircraftModelOf(player.flags)).toBe(AircraftModel.Tejas);
    let bandits = 0;
    for (let id = 0; id < 4096; id++) {
      const s = world.getEntityState(id);
      if (s && s.kind === 'aircraft' && s.team === 1) {
        expect(aircraftModelOf(s.flags)).toBe(AircraftModel.Jf17);
        bandits++;
      }
    }
    expect(bandits).toBeGreaterThan(0);
  });

  it('puts the JF-17 nose leg under its own nose wheel, the main legs on the Tejas', () => {
    const nose = jf17Definition.gear.find((g) => g.id === 'nose')!;
    const main = jf17Definition.gear.find((g) => g.id === 'mainLeft')!;
    expect(nose.posBodyM.x).toBeCloseTo(4.0, 1);
    expect(nose.steeringWheelbaseM).toBeCloseTo(nose.posBodyM.x - main.posBodyM.x, 6);
    expect(main).toEqual(tejasDefinition.gear.find((g) => g.id === 'mainLeft'));
  });

  it('the JF-17 GLB has its rig: hinged parts, pylons for every store station in slot order', () => {
    // GLB: 12-byte header, then the JSON chunk (length, type, data).
    const buf = readFileSync('public/models/jf17.glb');
    const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(12, true);
    const gltf = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + len))) as {
      scenes: { extras?: { marut?: { pylons: { stationId: string; rail?: boolean }[] } } }[];
      nodes: { name?: string; extras?: { driver?: string } }[];
    };
    const drivers = new Map(gltf.nodes.filter((n) => n.extras?.driver).map((n) => [n.name!, n.extras!.driver!]));
    for (const [name, driver] of [
      ['tailplaneL', 'elevonL'],
      ['tailplaneR', 'elevonR'],
      ['flaperonL0', 'aileronL'],
      ['flaperonR1', 'aileronR'],
      ['slatL1', 'slat'],
      ['rudder', 'rudder'],
      ['noseGear', 'gear'],
      ['mainGearL', 'gear'],
      ['mainGearR', 'gear'],
      ['noseDoorR', 'gear'],
      ['mainWheelL', 'wheel'],
    ]) {
      expect(drivers.get(name!), name).toBe(driver);
    }
    const stations = (jf17Definition.stations ?? []).filter((s) => s.id !== 'gun').map((s) => s.id);
    const pylons = gltf.scenes[0]!.extras!.marut!.pylons;
    expect(pylons.map((p) => p.stationId)).toEqual(stations);
    expect(pylons.find((p) => p.stationId === 'wing-outer-l')!.rail).toBe(false);
  });
});
