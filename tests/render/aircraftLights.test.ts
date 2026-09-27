import { describe, expect, it } from 'vitest';
import { strobeFlash } from '../../src/render/aircraftLights';
import { EntityFlag, LIGHT_FLAGS_MASK, LIGHT_MODES, SIM_DT_SEC } from '../../src/contracts/core';
import { buildWorldDependencies, createWorld } from '../../src/core';
import { freeFlightMission } from '../../src/core/missions/catalogue';
import { parseInputMapData, DEFAULT_INPUT_MAP_DATA, INPUT_MAP_VERSION } from '../../src/input/inputMap';

describe('aircraft lights', () => {
  it('strobes flash a double pulse, about 100 ms in every 1.2 s', () => {
    let on = 0;
    for (let t = 0; t < 12; t += 0.001) on += strobeFlash(t, 0.37);
    expect(on / 12000).toBeCloseTo(0.1 / 1.2, 2);
    expect(strobeFlash(0.02, 0)).toBe(1);
    expect(strobeFlash(0.1, 0)).toBe(0);
    expect(strobeFlash(0.18, 0)).toBe(1);
  });

  it('the modes go off, nav, strobes, landing, formation', () => {
    expect(LIGHT_MODES.map((m) => m.name)).toEqual(['Off', 'Nav', 'Nav + strobes', 'Nav + strobes + landing', 'Formation (covert)']);
    for (const m of LIGHT_MODES) expect(m.flags & ~LIGHT_FLAGS_MASK).toBe(0);
  });

  it('the chosen lights reach the aircraft entity (so the renderer can draw them)', () => {
    const mission = freeFlightMission('hansa', 'runway');
    const world = createWorld(buildWorldDependencies(mission));
    world.loadMission(mission);
    const id = world.getPlayerEntityId();
    const lights = LIGHT_MODES[3]!.flags;
    for (let k = 0; k < 0.2 / SIM_DT_SEC; k++) {
      world.setPlayerInput(id, { pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 1, gearDown: true, airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false, lights });
      world.stepOnce();
    }
    const flags = world.getEntityState(id)!.flags;
    expect(flags & LIGHT_FLAGS_MASK).toBe(EntityFlag.Lights | EntityFlag.LightsStrobe | EntityFlag.LightsLanding);
    expect(flags & EntityFlag.OnGround).not.toBe(0); // other flags untouched
  });

  it('a saved v8 key map gains the lights key without losing the player’s own keys', () => {
    const old = JSON.parse(JSON.stringify(DEFAULT_INPUT_MAP_DATA));
    old.version = 8;
    delete old.keyboard.meta.lightsCycle;
    delete old.gamepad.meta.lightsCycle;
    old.keyboard.buttons.trigger = 'KeyK'; // a custom key
    const r = parseInputMapData(JSON.stringify(old));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.version).toBe(INPUT_MAP_VERSION);
    expect(r.value.keyboard.meta.lightsCycle).toBe('KeyL');
    expect(r.value.keyboard.buttons.trigger).toBe('KeyK');
    // L already taken: left unbound rather than clashing.
    old.keyboard.buttons.trigger = 'KeyL';
    const r2 = parseInputMapData(JSON.stringify(old));
    expect(r2.ok && r2.value.keyboard.meta.lightsCycle).toBe(null);
  });
});
