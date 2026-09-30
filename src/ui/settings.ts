/**
 * src/ui/settings.ts — implements CreateSettingsScreen (docs/spec/11-ui.md section 4.3), in three
 * tabs: Graphics (quality), Controls (keys, mouse), Gameplay (units, AoA limiter, flight hints).
 * Time of day and weather are per flight now (Free Flight setup), not settings.
 *
 * Purely presentational: no storage I/O. Every change applies at once through `onChange`, which is
 * handed a full new SettingsState. Rebinding: "Rebind" asks the caller to capture a key
 * (`onRebindStart`); the caller reports it with `setCapturedKey`; after 5 s without a key the row
 * reverts.
 */
import type { QualityTier, SpeedUnit } from '../contracts/core';
import type { BindableAction, CreateSettingsScreen, KeyBinding, SettingsScreenHandle, SettingsState } from '../contracts/ui';
import { BindableAction as BindableActionEnum } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { button, checkbox, h, keyLabel, menuKeys, row, select, shell } from './kit';

const QUALITY_OPTIONS: readonly { value: QualityTier | 'auto'; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'ultra', label: 'Ultra' },
];
const SPEED_UNIT_OPTIONS: readonly { value: SpeedUnit; label: string }[] = [
  { value: 'ms', label: 'm/s' },
  { value: 'kt', label: 'knots' },
];

/** What each rebindable action does, in the player's words. */
export const ACTION_LABELS: Readonly<Record<BindableAction, string>> = {
  pitchUp: 'Pitch up (nose up)',
  pitchDown: 'Pitch down',
  rollLeft: 'Roll left',
  rollRight: 'Roll right',
  yawLeft: 'Rudder left',
  yawRight: 'Rudder right',
  throttleUp: 'Throttle up',
  throttleDown: 'Throttle down',
  afterburner: 'Afterburner',
  brakes: 'Wheel brakes',
  gearToggle: 'Landing gear',
  airbrake: 'Airbrake and brakes',
  trigger: 'Gun',
  launch: 'Fire missile',
  cycleWeapon: 'Next weapon',
  cycleTarget: 'Next target',
  jettisonTanks: 'Drop tanks',
  flare: 'Flares',
  chaff: 'Chaff',
  service: 'Refuel and rearm',
  noseWheelSteer: 'Nosewheel steering',
  pauseToggle: 'Pause',
  cameraCycle: 'Change camera',
  taxiGuide: 'Taxi guidance',
  radarMode: 'Radar mode',
  radarRangeUp: 'Radar range up',
  radarRangeDown: 'Radar range down',
  apToggle: 'Autopilot',
  atToggle: 'Autothrottle',
  apHdgDown: 'Autopilot heading left',
  apHdgUp: 'Autopilot heading right',
  apAltDown: 'Autopilot altitude down',
  apAltUp: 'Autopilot altitude up',
  apVsDown: 'Autopilot climb rate down',
  apVsUp: 'Autopilot climb rate up',
  apSpdDown: 'Autopilot speed down',
  apSpdUp: 'Autopilot speed up',
  lightsCycle: 'Exterior lights (next mode)',
};

/** "HH:MM" for a time of day in hours. */
export function formatTimeOfDay(hours: number): string {
  const m = Math.round((((hours % 24) + 24) % 24) * 60) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

const REBIND_TIMEOUT_MS = 5000;

function findBinding(bindings: readonly KeyBinding[], action: BindableAction): KeyBinding | undefined {
  return bindings.find((b) => b.action === action);
}

type Tab = 'graphics' | 'controls' | 'gameplay';

export const createSettingsScreen: CreateSettingsScreen = (container, initial, callbacks): SettingsScreenHandle => {
  let current: SettingsState = { ...initial, keyBindings: initial.keyBindings.map((b) => ({ ...b })) };
  let capturingAction: BindableAction | null = null;
  let captureTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const s = shell({ title: 'Settings', sub: 'Changes apply straight away and are saved on this device.', back: { onClick: () => callbacks.onBack() } });
  s.root.classList.add('tj-settings');

  function fireChange(): void {
    current = { ...current, keyBindings: current.keyBindings.map((b) => ({ ...b })) };
    callbacks.onChange(current);
  }

  // --- Graphics ---
  const qualitySelect = select(QUALITY_OPTIONS, current.qualityOverride, (v) => {
    current.qualityOverride = v;
    fireChange();
  }, { 'data-action': 'quality-override' });
  const graphics = h('div', { className: 'tj-stack', attrs: { 'data-tab': 'graphics' } }, row('Graphics quality', qualitySelect), row('Detected for this device', h('span', { text: current.detectedTier[0]!.toUpperCase() + current.detectedTier.slice(1) })), h('p', { className: 'tj-note', text: 'Auto uses the level measured the first time the game ran on this device.' }));

  // --- Controls ---
  const sensitivityValue = h('span', { className: 'tj-value', text: `${current.mouseSensitivityMultiplier.toFixed(1)}×` });
  const sensitivityInput = h('input', { className: 'tj-range', attrs: { 'data-role': 'mouse-sensitivity', type: 'range', min: '0.1', max: '3.0', step: '0.1', 'aria-label': 'Mouse sensitivity' } });
  sensitivityInput.value = String(current.mouseSensitivityMultiplier);
  sensitivityInput.addEventListener('input', () => (sensitivityValue.textContent = `${Number(sensitivityInput.value).toFixed(1)}×`));
  sensitivityInput.addEventListener('change', () => {
    current.mouseSensitivityMultiplier = Number(sensitivityInput.value);
    fireChange();
  });
  // Control rates: how lively the jet is on each axis, 50-150% of its standard response.
  const rates = { pitch: 1, roll: 1, yaw: 1, ...current.controlRates };
  const rateSlider = (axis: 'pitch' | 'roll' | 'yaw', label: string): HTMLElement => {
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    const value = h('span', { className: 'tj-value', text: pct(rates[axis]) });
    const input = h('input', { className: 'tj-range', attrs: { 'data-role': `rate-${axis}`, type: 'range', min: '0.5', max: '1.5', step: '0.05', 'aria-label': label } });
    input.value = String(rates[axis]);
    input.addEventListener('input', () => (value.textContent = pct(Number(input.value))));
    input.addEventListener('change', () => {
      rates[axis] = Number(input.value);
      current.controlRates = { ...rates };
      fireChange();
    });
    return row(label, h('span', { className: 'tj-row' }, input, value));
  };
  const bindingRows = new Map<BindableAction, { row: HTMLElement; codeLabel: HTMLElement; button: HTMLButtonElement }>();
  const bindingsList = h('div', { className: 'tj-settings-bindings' });
  for (const action of Object.values(BindableActionEnum)) {
    if (action === 'pauseToggle') continue; // Esc always pauses
    if (action === 'noseWheelSteer') continue; // steering is always on
    const binding = findBinding(current.keyBindings, action);
    const codeLabel = h('span', { className: 'tj-settings-binding-code tj-key', text: keyLabel(binding?.code) });
    const rebindBtn = button('Rebind', () => startRebind(action), 'default', { 'data-action': 'rebind', 'data-binding-action': action });
    const r = h('div', { className: 'tj-settings-binding-row' }, h('span', { className: 'tj-settings-binding-name', text: ACTION_LABELS[action] ?? action }), codeLabel, rebindBtn);
    bindingsList.append(r);
    bindingRows.set(action, { row: r, codeLabel, button: rebindBtn });
  }
  const controls = h(
    'div',
    { className: 'tj-stack tj-hidden', attrs: { 'data-tab': 'controls' } },
    row('Fly with the mouse', checkbox('On', current.mouseEnabled ?? false, (v) => { current.mouseEnabled = v; fireChange(); }, { 'data-role': 'mouse-enabled' })),
    row('Mouse sensitivity', h('span', { className: 'tj-row' }, sensitivityInput, sensitivityValue)),
    row('Invert mouse pitch', checkbox('On', current.invertPitch, (v) => { current.invertPitch = v; fireChange(); }, { 'data-role': 'invert-pitch' })),
    h('p', { className: 'tj-note', text: 'With the mouse on, click the view in flight to capture the pointer; Esc releases it.' }),
    rateSlider('roll', 'Roll rate'),
    rateSlider('pitch', 'Pitch rate'),
    rateSlider('yaw', 'Yaw rate'),
    h('p', { className: 'tj-note', text: 'How lively the jet is on each axis, for every control (keys, mouse, gamepad, touch). 100% is the Tejas as standard. Pitch changes how much g a partial pull asks for; a full pull is the same at every setting.' }),
    h('div', { className: 'tj-row', attrs: { style: 'justify-content: space-between' } }, h('span', { className: 'tj-label', text: 'Keys' }), button('Reset keys to defaults', () => callbacks.onResetDefaults(), 'default', { 'data-action': 'reset-defaults' })),
    bindingsList
  );

  // --- Gameplay ---
  const speedUnitSelect = select(SPEED_UNIT_OPTIONS, current.speedUnit, (v) => {
    current.speedUnit = v;
    fireChange();
  }, { 'data-action': 'speed-unit' });
  const gameplay = h(
    'div',
    { className: 'tj-stack tj-hidden', attrs: { 'data-tab': 'gameplay' } },
    row('Speed shown in', speedUnitSelect),
    row('AoA limiter (stops you pulling into a stall)', checkbox('On', current.alphaLimiterEnabled, (v) => { current.alphaLimiterEnabled = v; fireChange(); }, { 'data-role': 'alpha-limiter' })),
    row('First-flight hints', checkbox('On', current.hintsEnabled ?? true, (v) => { current.hintsEnabled = v; fireChange(); }, { 'data-role': 'hints' }))
  );

  const panes: Record<Tab, HTMLElement> = { graphics, controls, gameplay };
  const tabs = h('div', { className: 'tj-tabs', attrs: { role: 'tablist' } });
  const tabButtons = (['graphics', 'controls', 'gameplay'] as const).map((t) => {
    const b = h('button', { className: 'tj-tab', text: t[0]!.toUpperCase() + t.slice(1), attrs: { type: 'button', role: 'tab', 'aria-selected': String(t === 'graphics'), 'data-tab-button': t } });
    b.addEventListener('click', () => {
      for (const x of tabButtons) x.setAttribute('aria-selected', String(x === b));
      for (const [k, p] of Object.entries(panes)) p.classList.toggle('tj-hidden', k !== t);
    });
    return b;
  });
  tabs.append(...tabButtons);
  s.body.append(tabs, graphics, controls, gameplay);

  function cancelCaptureTimeout(): void {
    if (captureTimeoutHandle !== undefined) {
      clearTimeout(captureTimeoutHandle);
      captureTimeoutHandle = undefined;
    }
  }

  function startRebind(action: BindableAction): void {
    capturingAction = action;
    const entry = bindingRows.get(action);
    if (entry !== undefined) {
      entry.row.classList.add('tj-settings-binding-capturing');
      entry.codeLabel.textContent = 'press any key…';
      entry.button.disabled = true;
    }
    cancelCaptureTimeout();
    captureTimeoutHandle = setTimeout(() => {
      if (capturingAction !== action) return;
      revertRebindVisual(action);
      capturingAction = null;
    }, REBIND_TIMEOUT_MS);
    callbacks.onRebindStart(action);
  }

  function revertRebindVisual(action: BindableAction): void {
    const entry = bindingRows.get(action);
    if (entry === undefined) return;
    entry.row.classList.remove('tj-settings-binding-capturing');
    entry.codeLabel.textContent = keyLabel(findBinding(current.keyBindings, action)?.code);
    entry.button.disabled = false;
    entry.button.focus();
  }

  const baseHandle = mountScreen(container, s.root);
  const release = menuKeys(s.root, () => callbacks.onBack(), { isCapturing: () => capturingAction !== null, initialFocus: tabButtons[0] });

  return {
    ...baseHandle,
    destroy(): void {
      cancelCaptureTimeout();
      release();
      baseHandle.destroy();
    },
    setCapturedKey(action: BindableAction, code: string): void {
      if (capturingAction !== action) return;
      cancelCaptureTimeout();
      capturingAction = null;
      const next = current.keyBindings.filter((b) => b.action !== action);
      next.push({ action, code });
      current = { ...current, keyBindings: next };
      const entry = bindingRows.get(action);
      if (entry !== undefined) {
        entry.row.classList.remove('tj-settings-binding-capturing');
        entry.codeLabel.textContent = keyLabel(code);
        entry.button.disabled = false;
        entry.button.focus();
      }
      callbacks.onChange({ ...current, keyBindings: next.map((b) => ({ ...b })) });
    },
  };
};
