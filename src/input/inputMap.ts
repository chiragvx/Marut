/**
 * src/input/inputMap.ts — InputMapData shape defaults, JSON parse/serialize/
 * load/save (never-throwing, Result-returning where the contract says so),
 * the live InputMap wrapper, and first-run control-scheme detection. See
 * docs/spec/09-input.md sections 3.3, 4.10, 5.1, 5.2, 5.5, 5.6.
 */

import type { Result } from '../contracts/core';
import type {
  InputMapData,
  InputMap,
  StorageLike,
  ParseInputMapData,
  SerializeInputMapData,
  LoadInputMap,
  SaveInputMapData,
  DetectDefaultControlScheme,
} from '../contracts/input';
import { InputControlScheme } from '../contracts/input';

export const INPUT_MAP_STORAGE_KEY = 'tejas.inputMap.v1';
// Bumped 1 -> 2 for the PageUp/PageDown -> Z/X throttle rebind below: loadInputMap() discards
// and re-defaults on any version mismatch, so this makes the new default take effect even for a
// browser that already has an old InputMapData saved in localStorage, without needing the player
// to manually hit "Reset Defaults".
// Bumped 2 -> 3 when the jettisonTanks button (J) was added, for the same reason.
// Bumped 4 -> 5 when the service button (R: refuel + re-arm) was added.
export const INPUT_MAP_VERSION = 5;

/**
 * The literal default binding/tuning data, matching 09-input.md section 5.1 (throttle keys
 * since customized off that baseline — negative='KeyX'/positive='KeyZ', not PageDown/PageUp).
 * `loadInputMap`/`resetInputMapToDefaults` always hand out a fresh clone of this object (via
 * `cloneInputMapData`), never this shared const, so callers can freely mutate what they receive.
 */
export const DEFAULT_INPUT_MAP_DATA: InputMapData = {
  version: INPUT_MAP_VERSION,
  controlScheme: InputControlScheme.KeyboardMouse,
  keyboard: {
    axes: {
      pitch: { negative: 'KeyW', positive: 'KeyS' },
      roll: { negative: 'KeyA', positive: 'KeyD' },
      yaw: { negative: 'KeyQ', positive: 'KeyE' },
      // Z = more thrust, X = less thrust (X no longer also brakes: see `brakes` below).
      throttle: { negative: 'KeyX', positive: 'KeyZ' },
    },
    buttons: {
      trigger: 'Space',
      launch: 'Enter',
      cycleWeapon: 'Tab',
      cycleTarget: 'KeyT',
      gearToggle: 'KeyG',
      airbrakeToggle: 'KeyB',
      afterburner: 'ShiftLeft',
      // B is one button for airbrake + wheel brakes (user request): pressing B toggles the airbrake,
      // and the wheel brakes follow the airbrake state (playerPilot.ts), so B on landing rollout
      // extends the airbrake and brakes; B again releases both. Holding B also brakes directly.
      brakes: 'KeyB',
      nwsToggle: 'KeyN',
      jettisonTanks: 'KeyJ',
      service: 'KeyR',
    },
    meta: { cameraCycle: 'KeyV', menuToggle: 'Escape' },
  },
  gamepad: {
    axes: {
      pitch: { axisIndex: 1, invert: false },
      roll: { axisIndex: 0, invert: false },
      yaw: { axisIndex: 2, invert: false },
    },
    throttleUpButtonIndex: 7,
    throttleDownButtonIndex: 6,
    buttons: {
      trigger: { buttonIndex: 0 },
      launch: { buttonIndex: 1 },
      gearToggle: { buttonIndex: 2 },
      airbrakeToggle: { buttonIndex: 3 },
      brakes: { buttonIndex: 4 },
      afterburner: { buttonIndex: 5 },
      cycleWeapon: { buttonIndex: 8 },
      cycleTarget: { buttonIndex: 12 },
      nwsToggle: { buttonIndex: 10 },
      jettisonTanks: { buttonIndex: 13 },
      service: { buttonIndex: 14 },
    },
    meta: {
      cameraCycle: { buttonIndex: 11 },
      menuToggle: { buttonIndex: 9 },
    },
    deadzone: 0.12,
    stickCurveExponent: 1.6,
    yawCurveExponent: 1.3,
  },
  mouse: {
    enabled: false,
    sensitivityPerPx: 0.0022,
    curveExponent: 1.4,
    recenterRatePerSec: 3.0,
  },
  touch: {
    stickRadiusPx: 70,
    stickDeadzoneFrac: 0.08,
    stickCurveExponent: 1.6,
    yawBarHalfWidthPx: 90,
    yawBarDeadzoneFrac: 0.05,
    throttleSliderHeightPx: 220,
  },
  gyro: {
    maxTiltDeg: 35,
    deadzoneFrac: 0.05,
    curveExponent: 1.0,
    invertPitch: false,
    invertRoll: false,
  },
};

/** Deep clone via JSON round-trip — safe because InputMapData is plain, JSON-serializable data (no functions/dates/cycles). */
function cloneInputMapData(data: InputMapData): InputMapData {
  return JSON.parse(JSON.stringify(data)) as InputMapData;
}

/** Minimal structural shape check — enough to distinguish "this looks like our InputMapData at the current version" from garbage, without hand-validating every leaf field. */
function isInputMapDataShape(value: unknown): value is InputMapData {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== INPUT_MAP_VERSION) return false;
  if (typeof v.controlScheme !== 'string') return false;
  if (typeof v.keyboard !== 'object' || v.keyboard === null) return false;
  if (typeof v.gamepad !== 'object' || v.gamepad === null) return false;
  if (typeof v.mouse !== 'object' || v.mouse === null) return false;
  if (typeof v.touch !== 'object' || v.touch === null) return false;
  if (typeof v.gyro !== 'object' || v.gyro === null) return false;
  return true;
}

export const parseInputMapData: ParseInputMapData = (json) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'malformed JSON' } as Result<InputMapData, string>;
  }
  if (!isInputMapDataShape(parsed)) {
    return { ok: false, error: 'invalid InputMapData shape or version' } as Result<InputMapData, string>;
  }
  return { ok: true, value: parsed };
};

export const serializeInputMapData: SerializeInputMapData = (data) => {
  return JSON.stringify(data);
};

export const loadInputMap: LoadInputMap = (storage) => {
  let raw: string | null;
  try {
    raw = storage.getItem(INPUT_MAP_STORAGE_KEY);
  } catch {
    return cloneInputMapData(DEFAULT_INPUT_MAP_DATA);
  }
  if (raw === null) return cloneInputMapData(DEFAULT_INPUT_MAP_DATA);
  const result = parseInputMapData(raw);
  if (!result.ok) return cloneInputMapData(DEFAULT_INPUT_MAP_DATA);
  return result.value;
};

export const saveInputMapData: SaveInputMapData = (storage, data) => {
  try {
    storage.setItem(INPUT_MAP_STORAGE_KEY, serializeInputMapData(data));
  } catch {
    // Quota exceeded / private-browsing restriction: losing a binding
    // customization is not fatal, per 09-input.md section 4.10.
  }
};

export const detectDefaultControlScheme: DetectDefaultControlScheme = (nav, hasPhysicalKeyboardHint) => {
  if (nav.maxTouchPoints > 0 && !hasPhysicalKeyboardHint) {
    return InputControlScheme.Touch;
  }
  return InputControlScheme.KeyboardMouse;
};

/** Live, mutable binding-config wrapper. Backed by a single reassignable reference so `replace()` is O(1) and `data` always reflects the latest value. */
export function createInputMap(initial: InputMapData): InputMap {
  let current: InputMapData = initial;
  return {
    get data(): Readonly<InputMapData> {
      return current;
    },
    replace(data: InputMapData): void {
      current = data;
    },
  };
}
