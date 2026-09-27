/**
 * =============================================================================
 * TEJAS SIM — INPUT CONTRACT (docs/spec/contracts/input.ts)
 * =============================================================================
 * Owner: module 09 (docs/spec/09-input.md). Implements src/input/*.
 *
 * Imports ONLY from './core'. src/input imports src/contracts/* only (see
 * 00-architecture.md section 10) — it never imports src/math, even though
 * other leaf modules may. All numeric shaping used by this module (dead
 * zones, response curves, ramping, radial normalisation) is therefore
 * declared HERE as pure function-signature aliases, not borrowed from
 * contracts/math.ts.
 *
 * Contains ONLY interfaces, type aliases, `as const` objects + derived
 * unions, and bare function-signature aliases. NO implementation. Must
 * compile standalone with `tsc --noEmit --strict`.
 *
 * -----------------------------------------------------------------------------
 * WHERE THIS RUNS — READ BEFORE IMPLEMENTING.
 * PlayerInputSystem (below) implements core.ts's `Pilot` interface for
 * structural conformance only. Its `update(ctx, dtSec, out)` NEVER reads
 * `ctx` — every output field is derived purely from live device state,
 * `dtSec` and the InputMap. This is deliberate: keyboard/mouse/Gamepad
 * API/Touch/DeviceOrientation exist only on the main thread (00-architecture
 * .md section 2, "concurrency model"), never inside sim.worker.ts, so this
 * module's `Pilot` cannot be the object the sim worker calls in-worker the
 * way it calls an in-worker `AiPilot`. See 09-input.md section 9 for the
 * assumption this rests on (main.ts calls this on the main thread once per
 * animation frame and forwards the result to the sim worker via core.ts's
 * existing `SimInputMessage`).
 * =============================================================================
 */

import type { PilotInputs, Pilot, PilotContext, Result } from './core';

// -----------------------------------------------------------------------------
// 0. Pure numeric shaping primitives. Every device reader and the assembly
//    step in PlayerInputSystem is built exclusively from these five
//    functions — no other numeric shaping is permitted, so behaviour is
//    identical (and independently testable) regardless of which device
//    produced the raw sample.
// -----------------------------------------------------------------------------

/**
 * Linear (single-axis) dead zone with rescale so the output still reaches
 * exactly +-1 at |raw|=1. `deadzone` in [0,1). `raw` in [-1,1].
 * |raw| <= deadzone -> 0. Otherwise sign(raw) * (|raw|-deadzone)/(1-deadzone).
 */
export type ApplyLinearDeadzone = (raw: number, deadzone: number) => number;

/**
 * Radial (paired-axis) dead zone with rescale, for a 2D stick. Writes the
 * shaped (x,y) into `out` (no allocation) and returns `out`. Let
 * mag = hypot(x,y). mag <= deadzone -> (0,0). Otherwise both components are
 * scaled by (mag-deadzone)/(1-deadzone)/mag, which rescales the vector's
 * magnitude into [0,1] while preserving its direction exactly.
 */
export type ApplyRadialDeadzone = (
  x: number,
  y: number,
  deadzone: number,
  out: { x: number; y: number }
) => { x: number; y: number };

/**
 * Per-axis response curve applied AFTER dead zone shaping, applied
 * independently to each component of a stick (never to the pair jointly).
 * normalized in [-1,1]. Returns sign(normalized) * |normalized|^exponent.
 * exponent === 1 is the identity (linear) curve. Preserves sign and the
 * exact endpoints -1, 0, 1 for any exponent > 0.
 */
export type ShapeCurve = (normalized: number, exponent: number) => number;

/** Moves `value` toward 0 by at most `maxDelta` (maxDelta >= 0), never overshooting past 0. */
export type MoveTowardZero = (value: number, maxDelta: number) => number;

/**
 * Digital-hold axis integrator shared by every keyboard- and gamepad-button-
 * driven axis (pitch/roll/yaw/throttle). Exactly one of `negativeHeld`/
 * `positiveHeld` may be true, or neither (both true is treated as neither:
 * target = centerValue).
 *
 * target = positiveHeld ? maxValue : negativeHeld ? minValue : centerValue
 * rate   = (positiveHeld || negativeHeld) ? rampPerSec : centerPerSec
 * maxDelta = rate * dtSec
 * result = current moved toward target by at most maxDelta, clamped so it
 *          never overshoots target.
 *
 * Setting `centerPerSec = 0` makes the axis HOLD its last value when
 * released instead of returning to `centerValue` (this is how the throttle
 * axis is configured — see 09-input.md section 4.2).
 */
export type UpdateKeyAxis = (
  current: number,
  negativeHeld: boolean,
  positiveHeld: boolean,
  rampPerSec: number,
  centerPerSec: number,
  minValue: number,
  maxValue: number,
  centerValue: number,
  dtSec: number
) => number;

/**
 * Stateful rising-edge detector (false -> true transition) used ONLY for
 * this module's own internal toggle bookkeeping (gear/airbrake/NWS persist-
 * ent state, and meta actions). NEVER used to edge-trigger `launch`,
 * `cycleWeapon` or `cycleTarget` on the PilotInputs the module outputs —
 * core.ts documents those three as "edge-triggered by the consumer", so
 * this module passes their raw held state straight through unfiltered (see
 * 09-input.md section 4.4).
 */
export interface EdgeDetector {
  /** Call once per update with the button's current raw held state. Returns true only on the tick it transitions from not-held to held. */
  risingEdge(currentlyDown: boolean): boolean;
  reset(): void;
}
export type CreateEdgeDetector = () => EdgeDetector;

// -----------------------------------------------------------------------------
// 1. Logical action vocabulary. These names are used uniformly across
//    keyboard, gamepad, and touch bindings so one InputMapData shape covers
//    all three device families.
// -----------------------------------------------------------------------------

export const LogicalAxis = {
  Pitch: 'pitch',
  Roll: 'roll',
  Yaw: 'yaw',
  Throttle: 'throttle',
} as const;
export type LogicalAxis = (typeof LogicalAxis)[keyof typeof LogicalAxis];

/**
 * Digital button-style actions. `brakes` is included even though
 * PilotInputs.brakes is a number [0,1]: every binding in this module's
 * default map is a digital (on/off) source for it, which yields exactly 0.0
 * or 1.0 — a valid subset of [0,1]. `trigger`, `launch`, `cycleWeapon`,
 * `cycleTarget`, `afterburner`, `brakes` are PASSED THROUGH as raw held
 * state each update (no edge-triggering, no toggle). `gearToggle`,
 * `airbrakeToggle`, `nwsToggle` are converted from a momentary press into a
 * persisted level (see UpdateKeyAxis's sibling concept, EdgeDetector, in
 * section 4.4 of 09-input.md) because PilotInputs.gearDown/airbrake/
 * nwsEnabled are themselves level state, not edge-triggered per core.ts.
 */
export const LogicalButton = {
  Trigger: 'trigger',
  Launch: 'launch',
  CycleWeapon: 'cycleWeapon',
  CycleTarget: 'cycleTarget',
  GearToggle: 'gearToggle',
  AirbrakeToggle: 'airbrakeToggle',
  Afterburner: 'afterburner',
  Brakes: 'brakes',
  NwsToggle: 'nwsToggle',
  /** Jettison drop tanks (PilotInputs.jettisonTanks), passed through as raw held state. */
  JettisonTanks: 'jettisonTanks',
  /** Refuel + re-arm on the ground (PilotInputs.requestService), passed through as raw held state. */
  Service: 'service',
  /** Radar mode (PilotInputs.radarModeCycle: RWS <-> ACM), passed through as raw held state. */
  RadarMode: 'radarMode',
} as const;
export type LogicalButton = (typeof LogicalButton)[keyof typeof LogicalButton];

/**
 * Actions that do NOT map to any PilotInputs field. Reported to the host
 * application (src/main.ts, module 10) via PlayerInputSystem.onMetaAction;
 * this module does not know or care what they do.
 */
export const MetaAction = {
  CameraCycle: 'cameraCycle',
  MenuToggle: 'menuToggle',
  /** Taxi guidance on/off (HUD follow-me route to the runway or back to a stand). */
  TaxiGuide: 'taxiGuide',
  /** Radar display range scale up / down. */
  RadarRangeUp: 'radarRangeUp',
  RadarRangeDown: 'radarRangeDown',
  /** Autopilot master and autothrottle on/off. */
  ApToggle: 'apToggle',
  AtToggle: 'atToggle',
  /** Autopilot bugs down/up: heading, altitude, vertical speed, speed (held = repeat). */
  ApHdgDown: 'apHdgDown',
  ApHdgUp: 'apHdgUp',
  ApAltDown: 'apAltDown',
  ApAltUp: 'apAltUp',
  ApVsDown: 'apVsDown',
  ApVsUp: 'apVsUp',
  ApSpdDown: 'apSpdDown',
  ApSpdUp: 'apSpdUp',
} as const;
export type MetaAction = (typeof MetaAction)[keyof typeof MetaAction];

/** Union of everything a binding can target, for the rebind API. */
export type RebindableAction = LogicalAxis | LogicalButton | MetaAction;

export const InputControlScheme = {
  KeyboardMouse: 'keyboardMouse',
  Gamepad: 'gamepad',
  Touch: 'touch',
  /** Same as Touch but pitch/roll are sourced from DeviceOrientation instead of the left stick; the left-stick zone is hidden. */
  TouchGyro: 'touchGyro',
} as const;
export type InputControlScheme = (typeof InputControlScheme)[keyof typeof InputControlScheme];

// -----------------------------------------------------------------------------
// 2. Raw device reader interfaces. One per owned file
//    (keyboard.ts/mouse.ts/gamepad.ts/touch.ts/deviceOrientation.ts). Each
//    is DOM-backed (this module is exempt from the DOM-free rule) but
//    exposes a plain-data polling surface so PlayerInputSystem's assembly
//    step never touches `window`/`document`/`navigator` directly.
// -----------------------------------------------------------------------------

/** KeyboardEvent.code values, e.g. 'KeyW', 'ArrowUp', 'ShiftLeft', 'Space', 'PageUp'. Physical-key-position based (layout-independent), never KeyboardEvent.key. */
export type KeyboardCode = string;

export interface KeyboardReader {
  /** True while the physical key identified by `code` is currently held. */
  isDown(code: KeyboardCode): boolean;
  /** Removes all listeners from the target window. */
  dispose(): void;
}
export type CreateKeyboardReader = (target: Window) => KeyboardReader;

export const MouseButtonId = {
  Left: 0,
  Middle: 1,
  Right: 2,
} as const;
export type MouseButtonId = (typeof MouseButtonId)[keyof typeof MouseButtonId];

export interface MouseReader {
  /** True if the browser currently holds Pointer Lock on `pointerLockTarget`. */
  isPointerLocked(): boolean;
  /** Requests Pointer Lock on the configured target. Must be called from within a user-gesture event handler; this module calls it internally from its own click listener (see 09-input.md section 4.3) — nothing outside this module needs to call it directly. */
  requestPointerLock(): void;
  exitPointerLock(): void;
  isButtonDown(button: MouseButtonId): boolean;
  /**
   * Writes this frame's accumulated relative movement (movementX/movementY
   * summed since the previous call) into `out` and resets the internal
   * accumulator to zero. No-op writing (0,0) when not pointer-locked.
   */
  consumeDelta(out: { dxPx: number; dyPx: number }): { dxPx: number; dyPx: number };
  dispose(): void;
}
export type CreateMouseReader = (target: Window, pointerLockTarget: HTMLElement) => MouseReader;

/** Standard Gamepad API mapping ('standard'). Non-standard-mapping pads are read the same way but binding indices may not match a real controller; out of scope for correction here. */
export interface GamepadReader {
  readonly connected: boolean;
  /** [-1,1]. 0 if `connected` is false or `axisIndex` is out of range. */
  axisValue(axisIndex: number): number;
  /** [0,1] analog value (triggers report analog here even though they are `buttons[6]`/`buttons[7]`). 0 if not connected / out of range. */
  buttonValue(buttonIndex: number): number;
  /** buttonValue(buttonIndex) > GAMEPAD_BUTTON_DIGITAL_THRESHOLD. */
  buttonDown(buttonIndex: number): boolean;
  /** Re-reads navigator.getGamepads(); must be called once per PlayerInputSystem.update before any axisValue/buttonValue/buttonDown call that update. */
  poll(): void;
  dispose(): void;
}
export type CreateGamepadReader = (target: Window) => GamepadReader;

export const TouchZoneId = {
  Stick: 'stick',
  YawBar: 'yawBar',
  Throttle: 'throttle',
  Trigger: 'trigger',
  Launch: 'launch',
  CycleWeapon: 'cycleWeapon',
  CycleTarget: 'cycleTarget',
  GearToggle: 'gearToggle',
  AirbrakeToggle: 'airbrakeToggle',
  Afterburner: 'afterburner',
  Brakes: 'brakes',
  CameraCycle: 'cameraCycle',
  MenuToggle: 'menuToggle',
} as const;
export type TouchZoneId = (typeof TouchZoneId)[keyof typeof TouchZoneId];

export interface TouchControlsState {
  /** [-1,1] shaped stick X (roll sign convention), 0 if the stick zone is not currently touched. */
  stickX: number;
  /** [-1,1] shaped stick Y-derived pitch value (see 09-input.md 4.5 for the sign flip), 0 if not touched. */
  stickY: number;
  /** [-1,1] shaped yaw-bar value, 0 if not touched (bar has no memory — see 09-input.md 4.5). */
  yawBar: number;
  /** [0,1] absolute throttle slider position. RETAINS its last value after the finger lifts. */
  throttle: number;
  /** Current held state of each touch button zone (subset of TouchZoneId excluding stick/yawBar/throttle). */
  buttons: Readonly<Record<Exclude<TouchZoneId, 'stick' | 'yawBar' | 'throttle'>, boolean>>;
}

export interface TouchLayoutRectPx {
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
}

export interface TouchReader {
  readonly state: TouchControlsState;
  /** Creates and appends this module's own DOM overlay elements (stick, yaw bar, throttle slider, buttons) as children of `container`, and attaches touch listeners. See 09-input.md section 5.2 for the fixed layout. */
  attach(container: HTMLElement): void;
  /** Recomputes fixed-zone pixel rects from `container`'s current bounding box; call on resize/orientation change. */
  relayout(): void;
  /**
   * Shows/hides the overlay DOM (touch listeners and hit-testing keep working regardless — this
   * is a pure visibility toggle, not a functional enable/disable). No-op before `attach()`.
   * Callers should hide it for any non-Touch InputControlScheme, since the overlay was previously
   * always visible even on a desktop keyboard/mouse/gamepad session.
   */
  setVisible(visible: boolean): void;
  dispose(): void;
}
export type CreateTouchReader = () => TouchReader;

export interface DeviceOrientationSample {
  pitchRad: number;
  rollRad: number;
}

export interface DeviceOrientationReader {
  /** True once the DeviceOrientationEvent API has produced at least one real event on this device. */
  readonly available: boolean;
  /** True after calibrate() has captured a baseline. Readings are (0,0) before calibration. */
  readonly calibrated: boolean;
  /** iOS 13+ requires this to be called from inside a user-gesture handler before events fire. Resolves true if permission was granted (or was not required on this platform). */
  requestPermission(): Promise<boolean>;
  /** Captures the current raw beta/gamma as the zero baseline. Call from a "Calibrate" UI action while the device is held level. */
  calibrate(): void;
  /** Writes the shaped, calibrated (pitchRad, rollRad) into `out` and returns it (no allocation). (0,0) if not calibrated. */
  sample(out: DeviceOrientationSample): DeviceOrientationSample;
  dispose(): void;
}
export type CreateDeviceOrientationReader = (target: Window) => DeviceOrientationReader;

// -----------------------------------------------------------------------------
// 3. Binding data (persisted) and the live InputMap wrapper.
// -----------------------------------------------------------------------------

export interface GamepadAxisBinding {
  axisIndex: number;
  invert: boolean;
}
export interface GamepadButtonBinding {
  buttonIndex: number;
}

export interface KeyboardAxisBindingPair {
  /** Key that drives this axis toward its minimum (pitch: nose down, roll: left, yaw: left, throttle: decrease). */
  negative: KeyboardCode | null;
  /** Key that drives this axis toward its maximum (pitch: nose up, roll: right, yaw: right, throttle: increase). */
  positive: KeyboardCode | null;
}

export interface InputMapData {
  /** Bump when this shape changes; loadInputMap() discards and re-defaults on a version mismatch. */
  version: number;
  controlScheme: InputControlScheme;

  keyboard: {
    axes: Record<LogicalAxis, KeyboardAxisBindingPair>;
    buttons: Record<LogicalButton, KeyboardCode | null>;
    meta: Record<MetaAction, KeyboardCode | null>;
  };

  gamepad: {
    axes: Record<'pitch' | 'roll' | 'yaw', GamepadAxisBinding>;
    throttleUpButtonIndex: number;
    throttleDownButtonIndex: number;
    buttons: Record<LogicalButton, GamepadButtonBinding | null>;
    meta: Record<MetaAction, GamepadButtonBinding | null>;
    deadzone: number;
    stickCurveExponent: number;
    yawCurveExponent: number;
  };

  mouse: {
    enabled: boolean;
    sensitivityPerPx: number;
    curveExponent: number;
    recenterRatePerSec: number;
    /** Mouse forward = nose up. Optional so older saved maps still load; absent = off. */
    invertPitch?: boolean;
  };

  touch: {
    stickRadiusPx: number;
    stickDeadzoneFrac: number;
    stickCurveExponent: number;
    yawBarHalfWidthPx: number;
    yawBarDeadzoneFrac: number;
    throttleSliderHeightPx: number;
  };

  gyro: {
    maxTiltDeg: number;
    deadzoneFrac: number;
    curveExponent: number;
    invertPitch: boolean;
    invertRoll: boolean;
  };
}

/** Live, mutable binding configuration handed to callers who want to inspect or rebind without going through PlayerInputSystem's rebind flow (e.g. a settings screen listing current bindings). Backed by the same data PlayerInputSystem reads each update. */
export interface InputMap {
  readonly data: Readonly<InputMapData>;
  /** Replaces the whole binding data (e.g. after loading from storage or resetting to defaults). Does not persist by itself — call saveInputMap(). */
  replace(data: InputMapData): void;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ParseInputMapData = (json: string) => Result<InputMapData, string>;
export type SerializeInputMapData = (data: InputMapData) => string;
/** Never throws. Falls back to DEFAULT_INPUT_MAP_DATA on a missing key, parse failure, or version mismatch. */
export type LoadInputMap = (storage: StorageLike) => InputMapData;
export type SaveInputMapData = (storage: StorageLike, data: InputMapData) => void;

/** Reads navigator.maxTouchPoints and the presence of a physical-keyboard hint to pick a sensible first-run default. Called once by CreatePlayerInputSystem when no persisted InputMapData exists. */
export type DetectDefaultControlScheme = (nav: { maxTouchPoints: number }, hasPhysicalKeyboardHint: boolean) => InputControlScheme;

// -----------------------------------------------------------------------------
// 4. Rebinding.
// -----------------------------------------------------------------------------

export const RebindDeviceKind = {
  Keyboard: 'keyboard',
  Gamepad: 'gamepad',
} as const;
export type RebindDeviceKind = (typeof RebindDeviceKind)[keyof typeof RebindDeviceKind];

export interface RebindResult {
  action: RebindableAction;
  deviceKind: RebindDeviceKind;
  /** Undefined when cancelled (see `cancelled`). */
  binding?: KeyboardCode | GamepadButtonBinding | GamepadAxisBinding;
  cancelled: boolean;
}

// -----------------------------------------------------------------------------
// 5. Top-level module surface.
// -----------------------------------------------------------------------------

export interface PlayerInputConfig {
  window: Window;
  /** Receives this module's own touch-control DOM overlay (stick/yaw bar/throttle/buttons) and is used as the default Pointer Lock target. Required even on desktop-only builds (unused there beyond pointer lock). */
  touchOverlayContainer: HTMLElement;
  /** Defaults to `window.localStorage`. */
  storage?: StorageLike;
  /** Overrides loading from storage entirely (mainly for tests). When omitted, PlayerInputSystem calls loadInputMap(storage) at construction. */
  initialInputMapData?: InputMapData;
}

export interface PlayerInputSystem extends Pilot {
  readonly inputMap: InputMap;

  /**
   * The sole per-frame entry point. Conforms to Pilot.update exactly; `ctx`
   * is accepted for interface conformance and is NEVER read (see the file
   * header). Polls all device readers, advances keyboard/throttle ramp
   * state and gear/airbrake/NWS toggle state, and writes the assembled
   * result into `out` in place (no allocation, no replacing `out`).
   * `dtSec` is clamped internally to [0, INPUT_MAX_DT_SEC] before use.
   */
  update(ctx: PilotContext, dtSec: number, out: PilotInputs): void;

  getControlScheme(): InputControlScheme;
  setControlScheme(scheme: InputControlScheme): void;

  /** Whether update() writes PilotInputs.alphaLimiterDisabled=true (a player-facing Settings option; see that field's own doc comment). Defaults to false (limiter active). */
  isAlphaLimiterDisabled(): boolean;
  /** Moves the throttle lever (keyboard/gamepad schemes): the autothrottle drives it while engaged. */
  setThrottle(frac: number): void;
  /** Sets the landing-gear lever (the G key toggles it): down for ground starts, up for air starts. */
  setGearDown(down: boolean): void;
  setAlphaLimiterDisabled(disabled: boolean): void;

  /** Subscribes to meta actions (camera cycle, menu toggle). Returns an unsubscribe function. Fires at most once per rising edge, regardless of source device. */
  /** `repeat` is true for the auto-repeat of a held autopilot adjust key (not the first press). */
  onMetaAction(handler: (action: MetaAction, repeat?: boolean) => void): () => void;

  /** Enters rebind-listening mode for one action on one device kind. The next matching input event is captured as of the next update() call; see 09-input.md section 4.6 for capture thresholds. */
  startRebind(action: RebindableAction, deviceKind: RebindDeviceKind): void;
  cancelRebind(): void;
  isRebinding(): boolean;
  /** Fires exactly once per startRebind() call, whether it completed or was cancelled. */
  onRebindComplete(handler: (result: RebindResult) => void): () => void;

  /** Persists inputMap.data to the configured storage. */
  saveInputMap(): void;
  /** Replaces inputMap.data with DEFAULT_INPUT_MAP_DATA (does not auto-save; caller decides). */
  resetInputMapToDefaults(): void;

  /** True once at least one real DeviceOrientationEvent has been observed. Mirrors the underlying DeviceOrientationReader. */
  isGyroAvailable(): boolean;
  isGyroCalibrated(): boolean;
  requestGyroPermission(): Promise<boolean>;
  calibrateGyro(): void;

  /** Current touch overlay state, exposed read-only for a settings screen or debug overlay that wants to visualise it. Not used by core.ts's Pilot path. */
  readonly touchState: TouchControlsState;

  /** Removes every DOM listener and the touch overlay. */
  dispose(): void;
}

export type CreatePlayerInputSystem = (config: PlayerInputConfig) => PlayerInputSystem;
