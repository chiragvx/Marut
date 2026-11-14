// @vitest-environment jsdom
/**
 * Flaps − / + (lever stepping, the setting in words for the HUD and the buttons), the system
 * notices driven by state changes, the toast stack, and the action bar's Flaps row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stepFlapLever, keyBoundElsewhere, FLAPS_DOWN_ALT_KEYS, FLAPS_UP_ALT_KEYS } from '../../src/input/playerPilot';
import { DEFAULT_INPUT_MAP_DATA } from '../../src/input/inputMap';
import { FLAP_LEVER_MAX } from '../../src/contracts/core';
import { flapHudText, flapSetting } from '../../src/hud/flapStatus';
import { createSystemNotices, flapNotice, type SystemState } from '../../src/ui/systemNotices';
import { createToastStack, TOAST_MS } from '../../src/ui/toasts';
import { createActionBar } from '../../src/ui/actionBar';
import { c17Detents } from '../../src/aircraft/c17Data';

const NAMES = c17Detents.map((d) => d.name);

describe('flap lever − / +', () => {
  it('steps one detent at a time within UP .. FULL', () => {
    expect(stepFlapLever(0, 1)).toBe(1);
    expect(stepFlapLever(0, -1)).toBe(0);
    expect(stepFlapLever(FLAP_LEVER_MAX, 1)).toBe(FLAP_LEVER_MAX);
    expect(stepFlapLever(3, -1)).toBe(2);
    expect(NAMES.length - 1).toBe(FLAP_LEVER_MAX);
  });

  it('has − and + as fixed second keys while nothing else uses them', () => {
    expect(FLAPS_UP_ALT_KEYS).toContain('Minus');
    expect(FLAPS_DOWN_ALT_KEYS).toContain('Equal');
    for (const k of [...FLAPS_UP_ALT_KEYS, ...FLAPS_DOWN_ALT_KEYS]) expect(keyBoundElsewhere(DEFAULT_INPUT_MAP_DATA, k), k).toBe(false);
    expect(keyBoundElsewhere(DEFAULT_INPUT_MAP_DATA, 'Comma')).toBe(true);
  });
});

describe('flap setting in words', () => {
  it('names the lever detent, and travel with its direction', () => {
    expect(flapSetting(NAMES, 2, 2)).toEqual({ name: '1/2', transit: false, extending: false });
    expect(flapSetting(NAMES, 4, 2.5)).toEqual({ name: 'FULL', transit: true, extending: true });
    expect(flapSetting(NAMES, 0, 0.4)).toEqual({ name: 'UP', transit: true, extending: false });
    expect(flapSetting(NAMES, -1, -1)).toBeUndefined();
    expect(flapHudText(flapSetting(NAMES, 3, 3)!)).toBe('FLAPS 3/4');
    expect(flapHudText(flapSetting(NAMES, 1, 1)!)).toBe('SLATS');
    expect(flapHudText(flapSetting(NAMES, 4, 3.2)!)).toBe('FLAPS FULL ↓');
    expect(flapNotice(NAMES, 0)).toBe('Flaps up');
    expect(flapNotice(NAMES, 4)).toBe('Flaps FULL');
  });
});

/** Runs the notices over a sequence of states; returns what each step said. */
function run(states: Partial<SystemState>[], transport = true): string[][] {
  const n = createSystemNotices({ transport, flapNames: NAMES });
  const base: SystemState = { gearPos: 1, airbrake: false, flapLever: 0, flapPos: 0, slats: 0, spoilers: 0, ramp: 0, reverser: 0 };
  let cur = base;
  return states.map((s) => {
    cur = { ...cur, ...s };
    return n.update(cur);
  });
}

describe('system notices (state changes, not key presses)', () => {
  it('says nothing on the first state, nor while nothing changes', () => {
    expect(run([{}, {}, {}]).flat()).toEqual([]);
  });

  it('reports the ramp opening, then open only when it gets there; closing and closed', () => {
    const out = run([{ ramp: 0 }, { ramp: 0.1 }, { ramp: 0.5 }, { ramp: 1 }, { ramp: 1 }, { ramp: 0.8 }, { ramp: 0.3 }, { ramp: 0 }]);
    expect(out).toEqual([[], ['Cargo ramp opening'], [], ['Cargo ramp open'], [], ['Cargo ramp closing'], [], ['Cargo ramp closed']]);
  });

  it('reports a ramp turned round part-way', () => {
    expect(run([{}, { ramp: 0.3 }, { ramp: 0.2 }]).flat()).toEqual(['Cargo ramp opening', 'Cargo ramp closing']);
  });

  it('reports the flaps once they reach the lever, one notice for a multi-step move, and the slats', () => {
    const out = run([{}, { flapLever: 2, slats: 0.5, flapPos: 0.4 }, { slats: 1, flapPos: 1 }, { flapPos: 1.6 }, { flapPos: 2 }, { flapLever: 0, flapPos: 1.5 }, { flapPos: 0 }, { slats: 0 }]);
    expect(out.flat()).toEqual(['Slats extended', 'Flaps 1/2', 'Flaps up', 'Slats retracted']);
  });

  it('reports flaps coming up to SLATS as flaps up with the slats out', () => {
    const out = run([{ flapLever: 3, flapPos: 3, slats: 1 }, { flapLever: 1, flapPos: 2 }, { flapPos: 1 }]);
    expect(out.flat()).toEqual(['Flaps up, slats out']);
  });

  it('reports gear travel on a transport, spoilers and reversers with hysteresis', () => {
    const out = run([{}, { gearPos: 0.9 }, { gearPos: 0.4 }, { gearPos: 0 }, { spoilers: 1 }, { spoilers: 0.5 }, { spoilers: 0 }, { reverser: 0.7 }, { reverser: 1 }, { reverser: 0 }]);
    expect(out.flat()).toEqual(['Gear retracting', 'Gear up', 'Spoilers deployed', 'Spoilers retracted', 'Reverse thrust', 'Reversers stowed']);
  });

  it('keeps the fighters quiet: gear end states and the airbrake only', () => {
    const out = run([{}, { gearPos: 0.5 }, { gearPos: 0 }, { airbrake: true }, { ramp: 1, spoilers: 1, flapLever: 2, flapPos: 2 }, { airbrake: false }, { gearPos: 0.5 }, { gearPos: 1 }], false);
    expect(out.flat()).toEqual(['Gear up', 'Airbrake out', 'Airbrake in', 'Gear down']);
  });

  it('starts afresh after a reset (a new flight)', () => {
    const n = createSystemNotices({ transport: true });
    n.update({ gearPos: 1, airbrake: false, ramp: 0 });
    n.reset();
    expect(n.update({ gearPos: 1, airbrake: false, ramp: 1 })).toEqual([]);
  });
});

describe('toast stack', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stacks notices, restarts a repeated one rather than copying it, and fades them out', () => {
    const host = document.createElement('div');
    const t = createToastStack(host);
    t.show('Gear up');
    t.show('Flaps 1/2');
    t.show('Gear up');
    expect(Array.from(t.root.children).map((c) => c.textContent)).toEqual(['Flaps 1/2', 'Gear up']);
    vi.advanceTimersByTime(TOAST_MS + 400);
    expect(t.root.childElementCount).toBe(0);
  });

  it('keeps at most four', () => {
    const t = createToastStack(document.createElement('div'));
    for (let i = 0; i < 6; i++) t.show(`n${i}`);
    expect(Array.from(t.root.children).map((c) => c.textContent)).toEqual(['n2', 'n3', 'n4', 'n5']);
  });
});

describe('action bar Flaps row', () => {
  it('shows − / + with the setting only for aircraft with flaps, and does what they say', () => {
    const host = document.createElement('div');
    const pressed: string[] = [];
    const bar = createActionBar(host, (id) => pressed.push(id));
    const row = host.querySelector('[data-action-id="flapsUp"]')!.parentElement!;
    const base = { camera: 'Chase', radarMode: 'RWS', weapon: 'GUN', gear: 'DOWN', airbrake: 'IN', onGround: true };
    bar.setState(base);
    expect(row.classList.contains('tj-hidden')).toBe(true);
    bar.setState({ ...base, flaps: '1/2' });
    expect(row.classList.contains('tj-hidden')).toBe(false);
    expect(row.textContent).toContain('Flaps 1/2');
    (host.querySelector('[data-action-id="flapsDown"]') as HTMLButtonElement).click();
    (host.querySelector('[data-action-id="flapsUp"]') as HTMLButtonElement).click();
    expect(pressed).toEqual(['flapsDown', 'flapsUp']);
  });
});
