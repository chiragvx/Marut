// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createPlayerInputSystem } from '../../src/input/playerPilot';
import { DEFAULT_INPUT_MAP_DATA } from '../../src/input/inputMap';
import { RebindDeviceKind } from '../../src/contracts/input';
import type { InputMapData, PlayerInputSystem, RebindResult, MetaAction } from '../../src/contracts/input';
import type { PilotContext, PilotInputs } from '../../src/contracts/core';

function cloneDefaultMap(): InputMapData {
  return JSON.parse(JSON.stringify(DEFAULT_INPUT_MAP_DATA)) as InputMapData;
}

function makeOut(): PilotInputs {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0,
    afterburner: false,
    brakes: 0,
    gearDown: false,
    airbrake: false,
    trigger: false,
    launch: false,
    cycleWeapon: false,
    cycleTarget: false,
    nwsEnabled: false,
  };
}

/** A PilotContext-shaped object whose every property access throws — see 09-input.md acceptance criterion 6. */
function makeThrowingCtx(): PilotContext {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`ctx.${String(prop)} was read`);
      },
    }
  ) as unknown as PilotContext;
}

function dispatchKey(type: 'keydown' | 'keyup', code: string): void {
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
}

const systems: PlayerInputSystem[] = [];
function makeSystem(mapData?: InputMapData): PlayerInputSystem {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const system = createPlayerInputSystem({
    window,
    touchOverlayContainer: container,
    initialInputMapData: mapData ?? cloneDefaultMap(),
  });
  systems.push(system);
  return system;
}

afterEach(() => {
  while (systems.length > 0) {
    const s = systems.pop();
    s?.dispose();
  }
  document.body.innerHTML = '';
});

describe('PlayerInputSystem — keyboard pitch axis (keyboardMouse scheme)', () => {
  it('ramps pitch toward +1 over three 0.1s updates while KeyS (positive) is held', () => {
    const system = makeSystem();
    const ctx = makeThrowingCtx();
    const out = makeOut();

    dispatchKey('keydown', 'KeyS');
    const expected = [0.25, 0.5, 0.75];
    for (const e of expected) {
      system.update(ctx, 0.1, out);
      expect(out.pitch).toBeCloseTo(e, 6);
    }
  });
});

describe('PlayerInputSystem — raw passthrough booleans', () => {
  it('trigger/launch/cycleWeapon/cycleTarget report raw held state on every update, not just the first', () => {
    const system = makeSystem();
    const ctx = makeThrowingCtx();
    const out = makeOut();

    dispatchKey('keydown', 'Space'); // trigger
    dispatchKey('keydown', 'Enter'); // launch
    dispatchKey('keydown', 'Tab'); // cycleWeapon
    dispatchKey('keydown', 'KeyT'); // cycleTarget

    for (let i = 0; i < 3; i++) {
      system.update(ctx, 0.1, out);
      expect(out.trigger).toBe(true);
      expect(out.launch).toBe(true);
      expect(out.cycleWeapon).toBe(true);
      expect(out.cycleTarget).toBe(true);
    }
  });
});

describe('PlayerInputSystem — gearDown toggle', () => {
  it('starts down (true) — see playerPilot.ts\'s gearDownState comment for why', () => {
    const system = makeSystem();
    const ctx = makeThrowingCtx();
    const out = makeOut();

    system.update(ctx, 0.1, out);
    expect(out.gearDown).toBe(true);
  });

  it('flips on a rising edge and holds its value after release', () => {
    const system = makeSystem();
    const ctx = makeThrowingCtx();
    const out = makeOut();

    // Starts true (down); first press toggles it up.
    dispatchKey('keydown', 'KeyG');
    system.update(ctx, 0.1, out);
    expect(out.gearDown).toBe(false);

    dispatchKey('keyup', 'KeyG');
    system.update(ctx, 0.1, out);
    expect(out.gearDown).toBe(false);
    system.update(ctx, 0.1, out);
    expect(out.gearDown).toBe(false);

    dispatchKey('keydown', 'KeyG');
    system.update(ctx, 0.1, out);
    expect(out.gearDown).toBe(true);
    dispatchKey('keyup', 'KeyG');
    system.update(ctx, 0.1, out);
    expect(out.gearDown).toBe(true);
  });
});

describe('PlayerInputSystem — meta actions', () => {
  it('fires onMetaAction exactly once while the bound key is held across 5 updates', () => {
    const system = makeSystem();
    const ctx = makeThrowingCtx();
    const out = makeOut();

    let fireCount = 0;
    system.onMetaAction((action: MetaAction) => {
      if (action === 'cameraCycle') fireCount += 1;
    });

    dispatchKey('keydown', 'KeyV');
    for (let i = 0; i < 5; i++) {
      system.update(ctx, 0.1, out);
    }
    expect(fireCount).toBe(1);
  });
});

describe('PlayerInputSystem — rebinding', () => {
  it('captures a newly-pressed key and applies it to the live binding', () => {
    const system = makeSystem();
    const ctx = makeThrowingCtx();
    const out = makeOut();

    let result: RebindResult | null = null;
    system.onRebindComplete((r) => {
      result = r;
    });

    system.startRebind('pitch', RebindDeviceKind.Keyboard);
    expect(system.isRebinding()).toBe(true);

    dispatchKey('keydown', 'KeyW');
    system.update(ctx, 0.1, out);

    expect(result).toEqual({ action: 'pitch', deviceKind: 'keyboard', binding: 'KeyW', cancelled: false });
    expect(system.isRebinding()).toBe(false);

    // KeyW held now drives pitch NEGATIVE (proves the capture actually
    // rewrote the negative-direction binding, not just that the callback
    // fired) — see 09-input.md section 7.
    system.update(ctx, 0.1, out);
    expect(out.pitch).toBeLessThan(0);
  });

  it('does not touch out while a rebind is pending', () => {
    const system = makeSystem();
    const ctx = makeThrowingCtx();
    const out = makeOut();
    out.pitch = 0.42;

    system.startRebind('roll', RebindDeviceKind.Keyboard);
    system.update(ctx, 0.1, out);
    expect(out.pitch).toBe(0.42);
  });
});

describe('PlayerInputSystem — ctx is never read', () => {
  it('does not throw when ctx is a throwing-getter proxy', () => {
    const system = makeSystem();
    const ctx = makeThrowingCtx();
    const out = makeOut();
    expect(() => system.update(ctx, 0.1, out)).not.toThrow();
  });
});
