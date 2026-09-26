// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createMainMenu } from '../../src/ui/mainMenu';
import { createMissionSelect } from '../../src/ui/missionSelect';
import { createPauseMenu } from '../../src/ui/pauseMenu';
import { createDebriefScreen } from '../../src/ui/debrief';
import { createLoadingScreen } from '../../src/ui/loadingScreen';
import { createSettingsScreen } from '../../src/ui/settings';
import type { SettingsState } from '../../src/contracts/ui';

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

const noop = (): void => {};

describe('screen factories: mount / destroy contract', () => {
  it('createMainMenu appends one root element and destroy() is idempotent', () => {
    const container = makeContainer();
    const handle = createMainMenu(container, { onPlay: noop, onAirportEditor: noop, onSettings: noop });
    expect(container.children.length).toBe(1);
    handle.destroy();
    handle.destroy();
    expect(container.children.length).toBe(0);
  });

  it('createMissionSelect appends one root element and destroy() is idempotent', () => {
    const container = makeContainer();
    const handle = createMissionSelect(
      container,
      { missions: [{ id: 'm1', name: 'Mission 1', description: 'desc', aircraftLabel: 'HAL Tejas Mk1' }], defaultDifficulty: 'veteran' },
      { onLaunch: noop, onBack: noop }
    );
    expect(container.children.length).toBe(1);
    handle.destroy();
    handle.destroy();
    expect(container.children.length).toBe(0);
  });

  it('createPauseMenu appends one root element and destroy() is idempotent', () => {
    const container = makeContainer();
    const handle = createPauseMenu(container, { onResume: noop, onRestart: noop, onQuitToMenu: noop, onOpenSettings: noop });
    expect(container.children.length).toBe(1);
    handle.destroy();
    handle.destroy();
    expect(container.children.length).toBe(0);
  });

  it('createDebriefScreen appends one root element and destroy() is idempotent', () => {
    const container = makeContainer();
    const handle = createDebriefScreen(
      container,
      {
        missionId: 'm1',
        outcome: 'success',
        durationSec: 120,
        kills: 2,
        deaths: 0,
        shotsFiredGun: 10,
        shotsHitGun: 4,
        missilesFired: 2,
        missilesHit: 1,
        objectivesCompleted: ['obj1'],
        objectivesTotal: 2,
      },
      { onReplay: noop, onMissionSelect: noop, onMainMenu: noop }
    );
    expect(container.children.length).toBe(1);
    handle.destroy();
    handle.destroy();
    expect(container.children.length).toBe(0);
  });

  it('createLoadingScreen appends one root element and destroy() is idempotent', () => {
    const container = makeContainer();
    const handle = createLoadingScreen(container);
    expect(container.children.length).toBe(1);
    handle.destroy();
    handle.destroy();
    expect(container.children.length).toBe(0);
  });

  it('createSettingsScreen appends one root element and destroy() is idempotent', () => {
    const container = makeContainer();
    const initial: SettingsState = {
      qualityOverride: 'auto',
      detectedTier: 'medium',
      keyBindings: [],
      mouseSensitivityMultiplier: 1,
      invertPitch: false,
      speedUnit: 'ms',
      alphaLimiterEnabled: true,
    };
    const handle = createSettingsScreen(container, initial, { onChange: noop, onRebindStart: noop, onResetDefaults: noop, onBack: noop });
    expect(container.children.length).toBe(1);
    handle.destroy();
    handle.destroy();
    expect(container.children.length).toBe(0);
  });
});

describe('createMainMenu interaction', () => {
  it('clicking [data-action="play"] calls onPlay exactly once', () => {
    const container = makeContainer();
    const onPlay = vi.fn();
    createMainMenu(container, { onPlay, onAirportEditor: noop, onSettings: noop });
    const btn = container.querySelector('[data-action="play"]') as HTMLElement;
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
});

describe('createSettingsScreen rebind flow', () => {
  it('rebind click fires onRebindStart, setCapturedKey commits and fires onChange once', () => {
    const container = makeContainer();
    const onRebindStart = vi.fn();
    const onChange = vi.fn();
    const initial: SettingsState = {
      qualityOverride: 'auto',
      detectedTier: 'medium',
      keyBindings: [],
      mouseSensitivityMultiplier: 1,
      invertPitch: false,
      speedUnit: 'ms',
      alphaLimiterEnabled: true,
    };
    const handle = createSettingsScreen(container, initial, { onChange, onRebindStart, onResetDefaults: noop, onBack: noop });

    const btn = container.querySelector('[data-action="rebind"][data-binding-action="pitchUp"]') as HTMLElement;
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onRebindStart).toHaveBeenCalledWith('pitchUp');

    handle.setCapturedKey('pitchUp', 'KeyT');
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as SettingsState;
    expect(next.keyBindings).toContainEqual({ action: 'pitchUp', code: 'KeyT' });
  });
});

// Regression coverage for the "convert HUD airspeed tape to knots" feature: the Settings screen's
// new speed-unit control must default to `initial.speedUnit` and hand the selected unit back
// through onChange exactly like the pre-existing quality-override select does.
describe('createSettingsScreen speed unit', () => {
  it('defaults the select to initial.speedUnit and reports the new value through onChange on selection', () => {
    const container = makeContainer();
    const onChange = vi.fn();
    const initial: SettingsState = {
      qualityOverride: 'auto',
      detectedTier: 'medium',
      keyBindings: [],
      mouseSensitivityMultiplier: 1,
      invertPitch: false,
      speedUnit: 'ms',
      alphaLimiterEnabled: true,
    };
    createSettingsScreen(container, initial, { onChange, onRebindStart: noop, onResetDefaults: noop, onBack: noop });

    const select = container.querySelector('[data-action="speed-unit"]') as HTMLSelectElement;
    expect(select.value).toBe('ms');

    select.value = 'kt';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as SettingsState;
    expect(next.speedUnit).toBe('kt');
  });
});

// Regression coverage for the "disable AoA limiter" setting (user report: the FBW alpha limiter
// fights the pilot and oscillates near the boundary; this control lets a pilot fly past the
// protected envelope instead). Mirrors the speed-unit select test above.
describe('createSettingsScreen AoA limiter', () => {
  it('defaults the checkbox to initial.alphaLimiterEnabled and reports the new value through onChange on toggle', () => {
    const container = makeContainer();
    const onChange = vi.fn();
    const initial: SettingsState = {
      qualityOverride: 'auto',
      detectedTier: 'medium',
      keyBindings: [],
      mouseSensitivityMultiplier: 1,
      invertPitch: false,
      speedUnit: 'ms',
      alphaLimiterEnabled: true,
    };
    createSettingsScreen(container, initial, { onChange, onRebindStart: noop, onResetDefaults: noop, onBack: noop });

    const checkbox = container.querySelector('[data-role="alpha-limiter"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as SettingsState;
    expect(next.alphaLimiterEnabled).toBe(false);
  });
});

describe('createSettingsScreen weather', () => {
  it('defaults to on when not given, and reports the toggle through onChange', () => {
    const container = makeContainer();
    const onChange = vi.fn();
    const initial: SettingsState = {
      qualityOverride: 'auto',
      detectedTier: 'medium',
      keyBindings: [],
      mouseSensitivityMultiplier: 1,
      invertPitch: false,
      speedUnit: 'ms',
      alphaLimiterEnabled: true,
    };
    createSettingsScreen(container, initial, { onChange, onRebindStart: noop, onResetDefaults: noop, onBack: noop });

    const select = container.querySelector('[data-role="weather"]') as HTMLSelectElement;
    expect(select.value).toBe('clear');

    select.value = 'off';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as SettingsState;
    expect(next.weatherEnabled).toBe(false);
    expect(next.weatherMode).toBe('off');

    select.value = 'rain';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect((onChange.mock.calls[1]![0] as SettingsState).weatherMode).toBe('rain');
    expect((onChange.mock.calls[1]![0] as SettingsState).weatherEnabled).toBe(true);
  });

  it('time of day slider reports hours live and shows HH:MM', () => {
    const container = makeContainer();
    const onChange = vi.fn();
    const initial: SettingsState = {
      qualityOverride: 'auto',
      detectedTier: 'medium',
      keyBindings: [],
      mouseSensitivityMultiplier: 1,
      invertPitch: false,
      speedUnit: 'ms',
      alphaLimiterEnabled: true,
      timeOfDayH: 22,
    };
    createSettingsScreen(container, initial, { onChange, onRebindStart: noop, onResetDefaults: noop, onBack: noop });
    const slider = container.querySelector('[data-role="time-of-day"]') as HTMLInputElement;
    const label = container.querySelector('[data-role="time-of-day-value"]') as HTMLElement;
    expect(Number(slider.value)).toBe(22);
    expect(label.textContent).toBe('22:00');
    slider.value = '6.25';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect((onChange.mock.calls[0]![0] as SettingsState).timeOfDayH).toBe(6.25);
    expect(label.textContent).toBe('06:15');
  });
});

describe('createLoadingScreen.setProgress', () => {
  it('clamps fraction to [0,1]', () => {
    const container = makeContainer();
    const handle = createLoadingScreen(container);
    handle.setProgress(1.5, 'x');
    const progress = container.querySelector('progress') as HTMLProgressElement;
    expect(progress.value).toBe(1);
  });
});
