// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createMainMenu } from '../../src/ui/mainMenu';
import { createPauseMenu } from '../../src/ui/pauseMenu';
import { createDebriefScreen, outcomeTitle } from '../../src/ui/debrief';
import { createLoadingScreen } from '../../src/ui/loadingScreen';
import { createSettingsScreen } from '../../src/ui/settings';
import { createFreeFlightSetup, DEFAULT_FREE_FLIGHT } from '../../src/ui/freeFlight';
import { createBriefing, createMissionList } from '../../src/ui/missions';
import { createLoadoutEditor, describeFit, selectionFit } from '../../src/ui/loadoutEditor';
import { createControlsScreen } from '../../src/ui/controls';
import { menuKeys } from '../../src/ui/kit';
import type { DebriefStats, SettingsState } from '../../src/contracts/ui';
import { tejasDefinition } from '../../src/aircraft';
import { BASES, MISSIONS } from '../../src/core/missions/catalogue';

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

const noop = (): void => {};
const click = (root: ParentNode, sel: string): void => {
  const el = root.querySelector(sel) as HTMLElement | null;
  if (!el) throw new Error(`no element ${sel}`);
  el.dispatchEvent(new Event('click', { bubbles: true }));
};
const change = (el: HTMLInputElement | HTMLSelectElement, value: string | boolean, type = 'change'): void => {
  if (typeof value === 'boolean') (el as HTMLInputElement).checked = value;
  else el.value = value;
  el.dispatchEvent(new Event(type, { bubbles: true }));
};

const settingsInitial = (): SettingsState => ({
  qualityOverride: 'auto',
  detectedTier: 'medium',
  keyBindings: [],
  mouseSensitivityMultiplier: 1,
  invertPitch: false,
  speedUnit: 'ms',
  alphaLimiterEnabled: true,
});

const stats = (over: Partial<DebriefStats> = {}): DebriefStats => ({
  missionId: 'm1',
  outcome: 'success',
  durationSec: 125,
  kills: 2,
  deaths: 0,
  shotsFiredGun: 10,
  shotsHitGun: 4,
  missilesFired: 2,
  missilesHit: 1,
  objectivesCompleted: ['obj1'],
  objectivesTotal: 1,
  ...over,
});

const menuOptions = { missionsDone: 0, missionsTotal: 3, qualityLabel: 'High' };
const menuCallbacks = { onFreeFlight: noop, onMissions: noop, onSettings: noop, onControls: noop };

describe('screen factories: mount / destroy contract', () => {
  const cases: [string, (c: HTMLElement) => { destroy(): void }][] = [
    ['main menu', (c) => createMainMenu(c, menuOptions, menuCallbacks)],
    ['pause menu', (c) => createPauseMenu(c, { onResume: noop, onRestart: noop, onQuitToMenu: noop, onOpenSettings: noop })],
    ['debrief', (c) => createDebriefScreen(c, stats(), { onReplay: noop, onMissionSelect: noop, onMainMenu: noop })],
    ['loading', (c) => createLoadingScreen(c)],
    ['settings', (c) => createSettingsScreen(c, settingsInitial(), { onChange: noop, onRebindStart: noop, onResetDefaults: noop, onBack: noop })],
    ['free flight', (c) => createFreeFlightSetup(c, { bases: BASES, def: tejasDefinition, setup: DEFAULT_FREE_FLIGHT }, { onFly: noop, onBack: noop })],
    ['missions', (c) => createMissionList(c, { missions: MISSIONS, bases: BASES, progress: {} }, { onSelect: noop, onBack: noop })],
    ['controls', (c) => createControlsScreen(c, [{ title: 'Fly', rows: [{ keys: ['W'], label: 'Nose down' }] }], { onBack: noop })],
  ];
  for (const [name, make] of cases) {
    it(`${name} appends one root element and destroy() is idempotent`, () => {
      const container = makeContainer();
      const handle = make(container);
      expect(container.children.length).toBe(1);
      handle.destroy();
      handle.destroy();
      expect(container.children.length).toBe(0);
    });
  }
});

describe('main menu', () => {
  it('Free Flight, Missions, Settings and Controls each call their handler', () => {
    const container = makeContainer();
    const cb = { onFreeFlight: vi.fn(), onMissions: vi.fn(), onSettings: vi.fn(), onControls: vi.fn() };
    createMainMenu(container, menuOptions, cb);
    for (const [sel, fn] of [['free-flight', cb.onFreeFlight], ['missions', cb.onMissions], ['settings', cb.onSettings], ['controls', cb.onControls]] as const) {
      click(container, `[data-action="${sel}"]`);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('shows Continue only once there is a last flight', () => {
    const a = makeContainer();
    createMainMenu(a, menuOptions, menuCallbacks);
    expect(a.querySelector('[data-action="continue"]')).toBeNull();
    const b = makeContainer();
    const onContinue = vi.fn();
    createMainMenu(b, { ...menuOptions, continueLabel: 'Free Flight · INS Hansa' }, { ...menuCallbacks, onContinue });
    click(b, '[data-action="continue"]');
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('says feedback is coming soon while there is no form', () => {
    const container = makeContainer();
    createMainMenu(container, menuOptions, menuCallbacks);
    expect(container.textContent).toContain('Feedback (coming soon)');
    expect(container.querySelector('a[href]')).toBeNull();
  });
});

describe('menu keys', () => {
  it('Escape goes back and never reaches the flight controls', () => {
    document.body.replaceChildren(); // menus from earlier tests
    const container = makeContainer();
    const onBack = vi.fn();
    const flight = vi.fn();
    window.addEventListener('keydown', flight);
    const root = container.appendChild(document.createElement('div'));
    root.appendChild(document.createElement('button'));
    const release = menuKeys(root, onBack);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', cancelable: true }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(flight).not.toHaveBeenCalled();
    // Enter keeps its default (it activates the focused button) but is hidden from the flight controls.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', cancelable: true });
    window.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(flight).not.toHaveBeenCalled();
    release();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
    expect(flight).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', flight);
  });
});

describe('settings', () => {
  it('rebind click fires onRebindStart, setCapturedKey commits and fires onChange once', () => {
    const container = makeContainer();
    const onRebindStart = vi.fn();
    const onChange = vi.fn();
    const handle = createSettingsScreen(container, settingsInitial(), { onChange, onRebindStart, onResetDefaults: noop, onBack: noop });
    click(container, '[data-action="rebind"][data-binding-action="pitchUp"]');
    expect(onRebindStart).toHaveBeenCalledWith('pitchUp');
    handle.setCapturedKey('pitchUp', 'KeyT');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0]![0] as SettingsState).keyBindings).toContainEqual({ action: 'pitchUp', code: 'KeyT' });
    expect(container.querySelector('[data-binding-action="pitchUp"]')!.parentElement!.textContent).toContain('T');
  });

  it('speed unit, AoA limiter, mouse and hints report through onChange', () => {
    const container = makeContainer();
    const onChange = vi.fn();
    createSettingsScreen(container, settingsInitial(), { onChange, onRebindStart: noop, onResetDefaults: noop, onBack: noop });
    const last = (): SettingsState => onChange.mock.calls[onChange.mock.calls.length - 1]![0] as SettingsState;

    const unit = container.querySelector('[data-action="speed-unit"]') as HTMLSelectElement;
    expect(unit.value).toBe('ms');
    change(unit, 'kt');
    expect(last().speedUnit).toBe('kt');

    const aoa = container.querySelector('[data-role="alpha-limiter"]') as HTMLInputElement;
    expect(aoa.checked).toBe(true);
    change(aoa, false);
    expect(last().alphaLimiterEnabled).toBe(false);

    change(container.querySelector('[data-role="mouse-enabled"]') as HTMLInputElement, true);
    expect(last().mouseEnabled).toBe(true);
    change(container.querySelector('[data-role="mouse-sensitivity"]') as HTMLInputElement, '2');
    expect(last().mouseSensitivityMultiplier).toBe(2);
    change(container.querySelector('[data-role="invert-pitch"]') as HTMLInputElement, true);
    expect(last().invertPitch).toBe(true);
    change(container.querySelector('[data-role="hints"]') as HTMLInputElement, false);
    expect(last().hintsEnabled).toBe(false);
  });

  it('shows keys by name, not by code', () => {
    const container = makeContainer();
    createSettingsScreen(container, { ...settingsInitial(), keyBindings: [{ action: 'afterburner', code: 'ShiftLeft' }] }, { onChange: noop, onRebindStart: noop, onResetDefaults: noop, onBack: noop });
    expect(container.querySelector('[data-binding-action="afterburner"]')!.parentElement!.textContent).toContain('Shift');
    expect(container.textContent).not.toContain('ShiftLeft');
  });
});

describe('free flight setup', () => {
  it('flies with the chosen base, start, time and weather', () => {
    const container = makeContainer();
    const onFly = vi.fn();
    createFreeFlightSetup(container, { bases: BASES, def: tejasDefinition, setup: DEFAULT_FREE_FLIGHT }, { onFly, onBack: noop });
    click(container, '[data-base="bathinda"]');
    click(container, '[data-role="start"] [data-value="air"]');
    change(container.querySelector('[data-role="time"]') as HTMLInputElement, '18.25', 'input');
    expect(container.querySelector('[data-role="time-value"]')!.textContent).toBe('18:15');
    click(container, '[data-role="weather"] [data-value="rain"]');
    click(container, '[data-action="fly"]');
    expect(onFly).toHaveBeenCalledWith({ baseId: 'bathinda', start: 'air', timeOfDayH: 18.25, weather: 'rain', loadout: {} });
  });
});

describe('loadout editor', () => {
  it('mirrors a change to the other wing and turns a preset into a custom fit', () => {
    const container = makeContainer();
    const onDone = vi.fn();
    createLoadoutEditor(container, tejasDefinition, { presetId: 'cap' }, { onDone, onCancel: noop });
    const left = container.querySelector('[data-station="wing-outer-l"]') as HTMLSelectElement;
    // Only what the outboard pylon carries.
    expect(Array.from(left.options).map((o) => o.value)).toEqual(['', 'asraam:1', 'asraam:2', 'r-73:1', 'r-73:2', 'derby:1', 'derby:2']);
    change(left, 'r-73:2');
    expect((container.querySelector('[data-station="wing-outer-r"]') as HTMLSelectElement).value).toBe('r-73:2');
    click(container, '[data-action="done"]');
    const sel = onDone.mock.calls[0]![0];
    expect(sel.presetId).toBeUndefined();
    expect(sel.fit['wing-outer-l']).toEqual({ store: 'r-73', count: 2 });
    expect(sel.fit['wing-outer-r']).toEqual({ store: 'r-73', count: 2 });
  });

  it('with mirroring off, changes one side only; a matching fit returns to its preset', () => {
    const container = makeContainer();
    const onDone = vi.fn();
    createLoadoutEditor(container, tejasDefinition, { presetId: 'cap' }, { onDone, onCancel: noop });
    change(container.querySelector('[data-role="mirror"]') as HTMLInputElement, false);
    const tankL = container.querySelector('[data-station="wing-inner-l"]') as HTMLSelectElement;
    change(tankL, '');
    expect((container.querySelector('[data-station="wing-inner-r"]') as HTMLSelectElement).value).toBe('tank-1200l:1');
    change(container.querySelector('[data-station="wing-inner-l"]') as HTMLSelectElement, 'tank-1200l:1');
    click(container, '[data-action="done"]');
    expect(onDone.mock.calls[0]![0]).toEqual({ presetId: 'cap' });
  });

  it('describes a fit in words', () => {
    expect(describeFit(selectionFit(tejasDefinition, { presetId: 'cap' }))).toBe('4× ASRAAM, 2× Astra Mk1, 2× 1200 L tank');
    expect(describeFit(selectionFit(tejasDefinition, { presetId: 'clean' }))).toBe('Gun only');
  });
});

describe('missions and briefing', () => {
  it('a mission card opens its briefing; Start passes difficulty and loadout', () => {
    const container = makeContainer();
    const onSelect = vi.fn();
    createMissionList(container, { missions: MISSIONS, bases: BASES, progress: { 'konkan-dogfight': { completed: true, bestSec: 252 } } }, { onSelect, onBack: noop });
    expect(container.textContent).toContain('Done · 4:12');
    click(container, '[data-mission="border-duel"]');
    expect(onSelect).toHaveBeenCalledWith('border-duel');

    const b = makeContainer();
    const onStart = vi.fn();
    createBriefing(b, { entry: MISSIONS[1]!, base: BASES[1], index: 1, def: tejasDefinition, difficulty: 'veteran', loadout: {}, keys: { target: 'T', launch: 'Enter', weapon: 'Tab', gun: 'Space' } }, { onStart, onBack: noop });
    click(b, '[data-role="difficulty"] [data-value="ace"]');
    click(b, '[data-action="start"]');
    expect(onStart).toHaveBeenCalledWith('ace', {});
  });
});

describe('pause and debrief', () => {
  it('Exit asks first; Stay goes back, Exit to menu exits', () => {
    const container = makeContainer();
    const onQuitToMenu = vi.fn();
    createPauseMenu(container, { onResume: noop, onRestart: noop, onQuitToMenu, onOpenSettings: noop });
    click(container, '[data-action="quit"]');
    expect(onQuitToMenu).not.toHaveBeenCalled();
    click(container, '[data-action="confirm-no"]');
    expect(container.querySelector('[data-action="confirm-yes"]')).toBeNull();
    click(container, '[data-action="quit"]');
    click(container, '[data-action="confirm-yes"]');
    expect(onQuitToMenu).toHaveBeenCalledTimes(1);
  });

  it('names the outcome and offers the next mission after a win', () => {
    expect(outcomeTitle(stats(), false)).toBe('Mission complete');
    expect(outcomeTitle(stats({ outcome: 'failure', deaths: 1 }), false)).toBe('Shot down');
    expect(outcomeTitle(stats({ outcome: 'failure', deaths: 0 }), true)).toBe('Crashed');
    const container = makeContainer();
    const onNext = vi.fn();
    createDebriefScreen(container, stats(), { onReplay: noop, onMissionSelect: noop, onMainMenu: noop, onNext });
    click(container, '[data-action="next"]');
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('2:05');
  });
});

describe('loading screen', () => {
  it('clamps progress to [0,1] and swaps to a Start button when ready', () => {
    const container = makeContainer();
    const handle = createLoadingScreen(container, { title: 'Sea Duel', tips: [[['W', 'S'], 'Nose down / up']] });
    handle.setProgress(1.5, 'x');
    expect(container.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('100');
    const onStart = vi.fn();
    handle.setReady('Start  (Space)', onStart);
    click(container, '[data-action="start"]');
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});

describe('untested base tag', () => {
  it('INS Hansa is tagged in Free Flight, the mission list and its briefings; Bhisiana is not', () => {
    const ff = makeContainer();
    createFreeFlightSetup(ff, { bases: BASES, def: tejasDefinition, setup: DEFAULT_FREE_FLIGHT }, { onFly: noop, onBack: noop });
    expect(ff.querySelector('[data-base="hansa"]')!.textContent).toContain('Not fully tested');
    expect(ff.querySelector('[data-base="bathinda"]')!.textContent).not.toContain('Not fully tested');

    const list = makeContainer();
    createMissionList(list, { missions: MISSIONS, bases: BASES, progress: {} }, { onSelect: noop, onBack: noop });
    for (const m of MISSIONS) {
      const tagged = list.querySelector(`[data-mission="${m.id}"]`)!.textContent!.includes('Not fully tested');
      expect(tagged).toBe(m.baseId === 'hansa');
    }

    const hansaMission = MISSIONS.find((m) => m.baseId === 'hansa')!;
    const b = makeContainer();
    createBriefing(b, { entry: hansaMission, base: BASES.find((x) => x.id === 'hansa'), index: 0, def: tejasDefinition, difficulty: 'veteran', loadout: {}, keys: { target: 'T', launch: 'Enter', weapon: 'Tab', gun: 'Space' } }, { onStart: noop, onBack: noop });
    expect(b.querySelector('[data-role="untested"]')).not.toBeNull();
  });
});
