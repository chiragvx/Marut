/**
 * src/ui/settings.ts — implements CreateSettingsScreen (docs/spec/11-ui.md
 * section 4.3). Purely presentational: performs zero localStorage/IndexedDB
 * I/O. `initial` is supplied by the caller (module 10) on every call;
 * `onChange` hands the caller a full new SettingsState to persist however
 * it chooses.
 */
import type { QualityTier, SpeedUnit } from '../contracts/core';
import type {
  BindableAction,
  CreateSettingsScreen,
  KeyBinding,
  SettingsScreenHandle,
  SettingsState,
} from '../contracts/ui';
import { BindableAction as BindableActionEnum } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { el, actionButton } from './domHelpers';

const QUALITY_OPTIONS: readonly (QualityTier | 'auto')[] = ['auto', 'low', 'medium', 'high', 'ultra'];
const SPEED_UNIT_OPTIONS: readonly SpeedUnit[] = ['ms', 'kt'];
const SPEED_UNIT_LABELS: Readonly<Record<SpeedUnit, string>> = { ms: 'm/s', kt: 'knots' };

const REBIND_TIMEOUT_MS = 5000;

function findBinding(bindings: readonly KeyBinding[], action: BindableAction): KeyBinding | undefined {
  for (const b of bindings) {
    if (b.action === action) return b;
  }
  return undefined;
}

export const createSettingsScreen: CreateSettingsScreen = (container, initial, callbacks): SettingsScreenHandle => {
  // Local mutable snapshot this module owns between commits; a fresh object
  // literal (never the caller's `initial` reference) is handed to onChange.
  let current: SettingsState = {
    qualityOverride: initial.qualityOverride,
    detectedTier: initial.detectedTier,
    keyBindings: initial.keyBindings.map((b) => ({ action: b.action, code: b.code })),
    mouseSensitivityMultiplier: initial.mouseSensitivityMultiplier,
    invertPitch: initial.invertPitch,
    speedUnit: initial.speedUnit,
    alphaLimiterEnabled: initial.alphaLimiterEnabled,
  };

  let capturingAction: BindableAction | null = null;
  let captureTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const root = el('div', { className: 'tj-settings' });
  const title = el('h2', { text: 'Settings' });

  // --- Quality override ---
  const qualitySection = el('div', { className: 'tj-settings-section' });
  const qualityLabel = el('label', { text: 'Graphics quality' });
  const qualitySelect = el('select', { attrs: { 'data-action': 'quality-override' } });
  for (const q of QUALITY_OPTIONS) {
    qualitySelect.appendChild(el('option', { text: q, attrs: { value: q } }));
  }
  qualitySelect.value = current.qualityOverride;
  qualityLabel.appendChild(qualitySelect);
  qualitySection.appendChild(qualityLabel);

  // --- Speed unit ---
  const speedUnitSection = el('div', { className: 'tj-settings-section' });
  const speedUnitLabel = el('label', { text: 'Speed unit' });
  const speedUnitSelect = el('select', { attrs: { 'data-action': 'speed-unit' } });
  for (const u of SPEED_UNIT_OPTIONS) {
    speedUnitSelect.appendChild(el('option', { text: SPEED_UNIT_LABELS[u], attrs: { value: u } }));
  }
  speedUnitSelect.value = current.speedUnit;
  speedUnitLabel.appendChild(speedUnitSelect);
  speedUnitSection.appendChild(speedUnitLabel);

  // --- Mouse sensitivity ---
  const sensitivitySection = el('div', { className: 'tj-settings-section' });
  const sensitivityLabel = el('label', { text: 'Mouse sensitivity' });
  const sensitivityInput = el('input', { attrs: { 'data-role': 'mouse-sensitivity', type: 'range', min: '0.1', max: '3.0', step: '0.1' } }) as HTMLInputElement;
  sensitivityInput.value = String(current.mouseSensitivityMultiplier);
  sensitivityLabel.appendChild(sensitivityInput);
  sensitivitySection.appendChild(sensitivityLabel);

  // --- Invert pitch ---
  const invertSection = el('div', { className: 'tj-settings-section' });
  const invertLabel = el('label', { text: 'Invert pitch' });
  const invertInput = el('input', { attrs: { 'data-role': 'invert-pitch', type: 'checkbox' } }) as HTMLInputElement;
  invertInput.checked = current.invertPitch;
  invertLabel.appendChild(invertInput);
  invertSection.appendChild(invertLabel);

  // --- AoA limiter ---
  const alphaLimiterSection = el('div', { className: 'tj-settings-section' });
  const alphaLimiterLabel = el('label', { text: 'AoA limiter' });
  const alphaLimiterInput = el('input', { attrs: { 'data-role': 'alpha-limiter', type: 'checkbox' } }) as HTMLInputElement;
  alphaLimiterInput.checked = current.alphaLimiterEnabled;
  alphaLimiterLabel.appendChild(alphaLimiterInput);
  alphaLimiterSection.appendChild(alphaLimiterLabel);

  // --- Key bindings ---
  const bindingsSection = el('div', { className: 'tj-settings-bindings' });
  const bindingRows = new Map<BindableAction, { row: HTMLDivElement; codeLabel: HTMLSpanElement; button: HTMLButtonElement }>();
  for (const action of Object.values(BindableActionEnum)) {
    const row = el('div', { className: 'tj-settings-binding-row' });
    const nameLabel = el('span', { className: 'tj-settings-binding-name', text: action });
    const binding = findBinding(current.keyBindings, action);
    const codeLabel = el('span', { className: 'tj-settings-binding-code', text: binding !== undefined ? binding.code : '—' });
    const rebindBtn = actionButton('rebind', 'Rebind', { 'data-binding-action': action });
    row.append(nameLabel, codeLabel, rebindBtn);
    bindingsSection.appendChild(row);
    bindingRows.set(action, { row, codeLabel, button: rebindBtn });

    rebindBtn.addEventListener('click', () => {
      startRebind(action);
    });
  }

  // --- Footer nav ---
  const nav = el('div', { className: 'tj-settings-nav' });
  const resetBtn = actionButton('reset-defaults', 'Reset Defaults');
  const backBtn = actionButton('back', 'Back');
  nav.append(resetBtn, backBtn);

  root.append(title, qualitySection, speedUnitSection, sensitivitySection, invertSection, alphaLimiterSection, bindingsSection, nav);

  function fireChange(): void {
    // Hand out a fresh snapshot; keyBindings is always a new array too.
    current = {
      qualityOverride: current.qualityOverride,
      detectedTier: current.detectedTier,
      keyBindings: current.keyBindings.map((b) => ({ action: b.action, code: b.code })),
      mouseSensitivityMultiplier: current.mouseSensitivityMultiplier,
      invertPitch: current.invertPitch,
      speedUnit: current.speedUnit,
      alphaLimiterEnabled: current.alphaLimiterEnabled,
    };
    callbacks.onChange(current);
  }

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
    const binding = findBinding(current.keyBindings, action);
    entry.codeLabel.textContent = binding !== undefined ? binding.code : '—';
    entry.button.disabled = false;
  }

  qualitySelect.addEventListener('change', () => {
    current.qualityOverride = qualitySelect.value as QualityTier | 'auto';
    fireChange();
  });
  speedUnitSelect.addEventListener('change', () => {
    current.speedUnit = speedUnitSelect.value as SpeedUnit;
    fireChange();
  });
  sensitivityInput.addEventListener('change', () => {
    current.mouseSensitivityMultiplier = Number(sensitivityInput.value);
    fireChange();
  });
  invertInput.addEventListener('change', () => {
    current.invertPitch = invertInput.checked;
    fireChange();
  });
  alphaLimiterInput.addEventListener('change', () => {
    current.alphaLimiterEnabled = alphaLimiterInput.checked;
    fireChange();
  });
  resetBtn.addEventListener('click', () => callbacks.onResetDefaults());
  backBtn.addEventListener('click', () => callbacks.onBack());

  const baseHandle = mountScreen(container, root);

  return {
    ...baseHandle,
    setCapturedKey(action: BindableAction, code: string): void {
      if (capturingAction !== action) return;
      cancelCaptureTimeout();
      capturingAction = null;
      const next = current.keyBindings.filter((b) => b.action !== action);
      next.push({ action, code });
      current = {
        qualityOverride: current.qualityOverride,
        detectedTier: current.detectedTier,
        keyBindings: next,
        mouseSensitivityMultiplier: current.mouseSensitivityMultiplier,
        invertPitch: current.invertPitch,
        speedUnit: current.speedUnit,
        alphaLimiterEnabled: current.alphaLimiterEnabled,
      };
      const entry = bindingRows.get(action);
      if (entry !== undefined) {
        entry.row.classList.remove('tj-settings-binding-capturing');
        entry.codeLabel.textContent = code;
        entry.button.disabled = false;
      }
      callbacks.onChange(current);
    },
  };
};
