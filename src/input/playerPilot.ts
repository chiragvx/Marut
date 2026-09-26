/**
 * src/input/playerPilot.ts — createPlayerInputSystem: composes the five
 * device readers + InputMap + the shaping layer into PlayerInputSystem. See
 * docs/spec/09-input.md sections 3.4, 4.2-4.11.
 */

import type { PilotContext, PilotInputs } from '../contracts/core';
import type {
  PlayerInputConfig,
  PlayerInputSystem,
  InputMapData,
  InputControlScheme as InputControlSchemeType,
  MetaAction as MetaActionType,
  LogicalButton as LogicalButtonType,
  RebindableAction,
  RebindDeviceKind as RebindDeviceKindType,
  RebindResult,
  KeyboardCode,
  GamepadAxisBinding,
  GamepadButtonBinding,
  StorageLike,
} from '../contracts/input';
import { InputControlScheme, LogicalAxis, LogicalButton, MetaAction, RebindDeviceKind } from '../contracts/input';

import { applyLinearDeadzone, applyRadialDeadzone, shapeCurve, moveTowardZero, updateKeyAxis, createEdgeDetector } from './deadzones';
import { createKeyboardReader } from './keyboard';
import { createMouseReader } from './mouse';
import { createGamepadReader } from './gamepad';
import { createTouchReader } from './touch';
import { createDeviceOrientationReader } from './deviceOrientation';
import { DEFAULT_INPUT_MAP_DATA, loadInputMap, saveInputMapData, createInputMap } from './inputMap';

export const KEYBOARD_AXIS_RAMP_RATE_PER_SEC = 2.5;
export const KEYBOARD_AXIS_CENTER_RATE_PER_SEC = 4.0;
export const KEYBOARD_THROTTLE_RAMP_RATE_PER_SEC = 0.5;
export const INPUT_MAX_DT_SEC = 0.25;
export const REBIND_AXIS_THRESHOLD = 0.5;
export const REBIND_BUTTON_THRESHOLD = 0.5;

/** ~40 common candidate codes for keyboard rebind capture (09-input.md section 4.9): DEFAULT_INPUT_MAP_DATA's own bindings plus common alternates. */
const KEYBOARD_REBIND_CANDIDATES: readonly KeyboardCode[] = [
  'KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyI', 'KeyJ',
  'KeyK', 'KeyL', 'KeyM', 'KeyN', 'KeyO', 'KeyP', 'KeyQ', 'KeyR', 'KeyS', 'KeyT',
  'KeyU', 'KeyV', 'KeyW', 'KeyX', 'KeyY', 'KeyZ',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'Enter', 'Escape', 'Tab', 'ShiftLeft', 'ShiftRight', 'PageUp', 'PageDown',
];

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function isTouchScheme(scheme: InputControlSchemeType): boolean {
  return scheme === InputControlScheme.Touch || scheme === InputControlScheme.TouchGyro;
}

function isLogicalAxis(action: RebindableAction): action is 'pitch' | 'roll' | 'yaw' | 'throttle' {
  return action === LogicalAxis.Pitch || action === LogicalAxis.Roll || action === LogicalAxis.Yaw || action === LogicalAxis.Throttle;
}
function isMetaAction(action: RebindableAction): action is MetaActionType {
  return action === MetaAction.CameraCycle || action === MetaAction.MenuToggle;
}

interface PendingRebind {
  action: RebindableAction;
  deviceKind: RebindDeviceKindType;
}

export function createPlayerInputSystem(config: PlayerInputConfig): PlayerInputSystem {
  const win = config.window;
  const storage: StorageLike = config.storage ?? win.localStorage;
  const initialData: InputMapData = config.initialInputMapData ?? loadInputMap(storage);
  const inputMap = createInputMap(initialData);

  const keyboardReader = createKeyboardReader(win);
  const mouseReader = createMouseReader(win, config.touchOverlayContainer);
  const gamepadReader = createGamepadReader(win);
  const touchReader = createTouchReader();
  touchReader.attach(config.touchOverlayContainer);
  // The overlay used to always be visible regardless of scheme — a desktop keyboard/mouse/
  // gamepad session showed a full set of empty touch buttons with nothing to do with it. Show it
  // only for the two touch-based schemes (TouchGyro still uses the overlay's yaw bar/throttle/
  // buttons, just not the stick — see this file's own header note); setControlScheme (below)
  // keeps this in sync on any later scheme change.
  touchReader.setVisible(isTouchScheme(initialData.controlScheme));
  const deviceOrientationReader = createDeviceOrientationReader(win);

  // Persisted per-axis ramp state (one number per axis), and mouse-aim
  // recenter accumulator — all allocated once, mutated in place every call.
  let pitchAxis = 0;
  let rollAxis = 0;
  let yawAxis = 0;
  let throttleAxis = 0;
  let mouseStickX = 0;
  let mouseStickY = 0;

  // Persisted toggle levels (survive control-scheme switches — 09-input.md acceptance criterion 8).
  // gearDownState starts true (not false): a fresh PlayerInputSystem has no way to know whether
  // it's about to fly a ground-start mission (aircraft resting on a runway, gear already down —
  // see src/core/world.ts's startOnGround spawn handling) or an airborne one, and defaulting to
  // "up" meant every ground-start mission had its gear auto-retract within
  // GEAR_TRAVEL_RATE_PER_SEC's ~2s of launch (landingGear.ts), disabling the only ground-contact
  // force the physics model has (computeGearLeg short-circuits to zero force below
  // GEAR_CONTACT_GEARPOS_THRESHOLD) and leaving the aircraft to fall through the world with
  // nothing to stop it. "Down" is also the safer default in general (mirrors real
  // emergency-procedure convention and world.ts's own defaultPilotInputs().gearDown=true) — a
  // player who never touches the gear key ends up in the safe state, not the unsafe one.
  let gearDownState = true;
  let airbrakeState = false;
  let nwsState = false;
  let alphaLimiterDisabledState = false;

  const gearEdge = createEdgeDetector();
  const airbrakeEdge = createEdgeDetector();
  const nwsEdge = createEdgeDetector();
  const cameraCycleEdge = createEdgeDetector();
  const menuToggleEdge = createEdgeDetector();

  const rebindEdgeDetectors = new Map<KeyboardCode, ReturnType<typeof createEdgeDetector>>();
  for (const code of KEYBOARD_REBIND_CANDIDATES) rebindEdgeDetectors.set(code, createEdgeDetector());

  const metaHandlers = new Set<(action: MetaActionType) => void>();
  const rebindCompleteHandlers = new Set<(result: RebindResult) => void>();
  let pendingRebind: PendingRebind | null = null;

  // Scratch objects, allocated once (09-input.md section 6).
  const mouseDeltaScratch = { dxPx: 0, dyPx: 0 };
  const radialDzScratch = { x: 0, y: 0 };
  const orientationScratch = { pitchRad: 0, rollRad: 0 };

  function data(): InputMapData {
    return inputMap.data as InputMapData;
  }

  function withMutatedData(mutate: (draft: InputMapData) => void): void {
    const draft = cloneJson(data());
    mutate(draft);
    inputMap.replace(draft);
  }

  // ---- keydown preventDefault, checked against the CURRENT InputMapData ----
  // (createKeyboardReader's contract signature takes no InputMapData, so this
  // policy lives here instead — see keyboard.ts's header comment.)
  function isCodeCurrentlyBound(code: KeyboardCode): boolean {
    const d = data();
    const axes = d.keyboard.axes;
    if (axes.pitch.negative === code || axes.pitch.positive === code) return true;
    if (axes.roll.negative === code || axes.roll.positive === code) return true;
    if (axes.yaw.negative === code || axes.yaw.positive === code) return true;
    if (axes.throttle.negative === code || axes.throttle.positive === code) return true;
    const buttons = d.keyboard.buttons;
    for (const key of Object.keys(buttons) as LogicalButtonType[]) {
      if (buttons[key] === code) return true;
    }
    const meta = d.keyboard.meta;
    for (const key of Object.keys(meta) as MetaActionType[]) {
      if (meta[key] === code) return true;
    }
    return false;
  }
  const onKeyDownPreventDefault = (event: KeyboardEvent): void => {
    if (isCodeCurrentlyBound(event.code)) event.preventDefault();
  };
  win.addEventListener('keydown', onKeyDownPreventDefault);

  // ---- Pointer Lock request on click, keyboardMouse + mouse.enabled only ----
  const onContainerClick = (): void => {
    const d = data();
    if (d.mouse.enabled && d.controlScheme === InputControlScheme.KeyboardMouse && !mouseReader.isPointerLocked()) {
      mouseReader.requestPointerLock();
    }
  };
  config.touchOverlayContainer.addEventListener('click', onContainerClick);

  // ---- raw button-held lookup, per control scheme ----
  function rawKeyboardHeldFor(code: KeyboardCode | null): boolean {
    return code !== null && keyboardReader.isDown(code);
  }
  function rawButtonHeld(action: LogicalButtonType | MetaActionType, scheme: InputControlSchemeType): boolean {
    const d = data();
    if (scheme === InputControlScheme.KeyboardMouse) {
      const code = isMetaAction(action) ? d.keyboard.meta[action] : d.keyboard.buttons[action as LogicalButtonType];
      return rawKeyboardHeldFor(code);
    }
    if (scheme === InputControlScheme.Gamepad) {
      const binding: GamepadButtonBinding | null = isMetaAction(action)
        ? d.gamepad.meta[action]
        : d.gamepad.buttons[action as LogicalButtonType];
      return binding !== null && gamepadReader.buttonDown(binding.buttonIndex);
    }
    // touch / touchGyro: TouchZoneId's string values coincide exactly with
    // LogicalButton/MetaAction string values (contracts/input.ts).
    return touchReader.state.buttons[action as keyof typeof touchReader.state.buttons] === true;
  }

  // ---- rebind capture (09-input.md section 4.9) ----
  function applyCapturedKeyboardBinding(action: RebindableAction, code: KeyboardCode): void {
    withMutatedData((d) => {
      if (isLogicalAxis(action)) {
        // No direction discriminator exists on RebindableAction; a keyboard
        // axis capture always sets the NEGATIVE key of the pair (see the
        // contract-concerns note in the final report).
        d.keyboard.axes[action].negative = code;
      } else if (isMetaAction(action)) {
        d.keyboard.meta[action] = code;
      } else {
        d.keyboard.buttons[action] = code;
      }
    });
  }
  function applyCapturedGamepadAxisBinding(action: 'pitch' | 'roll' | 'yaw', binding: GamepadAxisBinding): void {
    withMutatedData((d) => {
      d.gamepad.axes[action] = binding;
    });
  }
  function applyCapturedGamepadButtonBinding(action: RebindableAction, binding: GamepadButtonBinding): void {
    withMutatedData((d) => {
      if (isMetaAction(action)) {
        d.gamepad.meta[action] = binding;
      } else if (!isLogicalAxis(action)) {
        d.gamepad.buttons[action] = binding;
      }
      // action === a LogicalAxis (only 'throttle' can reach here, since
      // pitch/roll/yaw are captured as axes above): gamepad throttle is not
      // rebindable through this API (09-input.md section 4.9) — no-op.
    });
  }

  function completeRebind(binding: RebindResult['binding']): void {
    const pending = pendingRebind;
    if (pending === null) return;
    pendingRebind = null;
    const result: RebindResult = { action: pending.action, deviceKind: pending.deviceKind, binding, cancelled: false };
    for (const handler of rebindCompleteHandlers) handler(result);
  }

  /** Runs one frame of rebind capture. Returns true if a capture (or nothing) was handled — caller must return from update() without touching `out`. */
  function runRebindCapture(pending: PendingRebind): void {
    if (pending.deviceKind === RebindDeviceKind.Keyboard) {
      let captured: KeyboardCode | null = null;
      for (const code of KEYBOARD_REBIND_CANDIDATES) {
        const down = keyboardReader.isDown(code);
        const detector = rebindEdgeDetectors.get(code);
        const rising = detector !== undefined && detector.risingEdge(down);
        if (rising && captured === null) captured = code;
      }
      if (captured !== null) {
        applyCapturedKeyboardBinding(pending.action, captured);
        completeRebind(captured);
      }
      return;
    }
    // gamepad — always poll: this frame explicitly wants a fresh gamepad
    // snapshot to test capture thresholds against.
    gamepadReader.poll();
    if (isLogicalAxis(pending.action) && pending.action !== LogicalAxis.Throttle) {
      const axisAction = pending.action;
      for (let axisIndex = 0; axisIndex <= 7; axisIndex++) {
        const v = gamepadReader.axisValue(axisIndex);
        if (Math.abs(v) > REBIND_AXIS_THRESHOLD) {
          const binding: GamepadAxisBinding = { axisIndex, invert: v < 0 };
          applyCapturedGamepadAxisBinding(axisAction, binding);
          completeRebind(binding);
          return;
        }
      }
      return;
    }
    for (let buttonIndex = 0; buttonIndex <= 16; buttonIndex++) {
      const v = gamepadReader.buttonValue(buttonIndex);
      if (v > REBIND_BUTTON_THRESHOLD) {
        const binding: GamepadButtonBinding = { buttonIndex };
        applyCapturedGamepadButtonBinding(pending.action, binding);
        completeRebind(binding);
        return;
      }
    }
  }

  const system: PlayerInputSystem = {
    inputMap,

    update(_ctx: PilotContext, dtSecRaw: number, out: PilotInputs): void {
      const dtSec = clamp(dtSecRaw, 0, INPUT_MAX_DT_SEC);

      if (pendingRebind !== null) {
        runRebindCapture(pendingRebind);
        return;
      }

      const d = data();
      const scheme = d.controlScheme;

      // GamepadReader.poll() re-reads navigator.getGamepads(), which is only
      // guaranteed to exist in a real browser; only poll when this update()
      // will actually read gamepad values, so non-gamepad control schemes
      // never depend on the Gamepad API being present (09-input.md's own
      // implementation note: "module 12's test setup stubs
      // window.navigator.getGamepads ... for the gamepad-specific cases").
      if (scheme === InputControlScheme.Gamepad) gamepadReader.poll();

      let pitch = 0;
      let roll = 0;
      let yaw = 0;

      if (scheme === InputControlScheme.KeyboardMouse) {
        const axes = d.keyboard.axes;
        pitchAxis = updateKeyAxis(
          pitchAxis,
          rawKeyboardHeldFor(axes.pitch.negative),
          rawKeyboardHeldFor(axes.pitch.positive),
          KEYBOARD_AXIS_RAMP_RATE_PER_SEC,
          KEYBOARD_AXIS_CENTER_RATE_PER_SEC,
          -1,
          1,
          0,
          dtSec
        );
        rollAxis = updateKeyAxis(
          rollAxis,
          rawKeyboardHeldFor(axes.roll.negative),
          rawKeyboardHeldFor(axes.roll.positive),
          KEYBOARD_AXIS_RAMP_RATE_PER_SEC,
          KEYBOARD_AXIS_CENTER_RATE_PER_SEC,
          -1,
          1,
          0,
          dtSec
        );
        yawAxis = updateKeyAxis(
          yawAxis,
          rawKeyboardHeldFor(axes.yaw.negative),
          rawKeyboardHeldFor(axes.yaw.positive),
          KEYBOARD_AXIS_RAMP_RATE_PER_SEC,
          KEYBOARD_AXIS_CENTER_RATE_PER_SEC,
          -1,
          1,
          0,
          dtSec
        );
        throttleAxis = updateKeyAxis(
          throttleAxis,
          rawKeyboardHeldFor(axes.throttle.negative),
          rawKeyboardHeldFor(axes.throttle.positive),
          KEYBOARD_THROTTLE_RAMP_RATE_PER_SEC,
          0,
          0,
          1,
          0,
          dtSec
        );
        pitch = pitchAxis;
        roll = rollAxis;
        yaw = yawAxis;

        if (d.mouse.enabled && mouseReader.isPointerLocked()) {
          mouseStickX = moveTowardZero(mouseStickX, d.mouse.recenterRatePerSec * dtSec);
          mouseStickY = moveTowardZero(mouseStickY, d.mouse.recenterRatePerSec * dtSec);
          mouseReader.consumeDelta(mouseDeltaScratch);
          mouseStickX = clamp(mouseStickX + mouseDeltaScratch.dxPx * d.mouse.sensitivityPerPx, -1, 1);
          mouseStickY = clamp(mouseStickY + mouseDeltaScratch.dyPx * d.mouse.sensitivityPerPx, -1, 1);
          roll = shapeCurve(mouseStickX, d.mouse.curveExponent);
          pitch = shapeCurve(-mouseStickY, d.mouse.curveExponent);
        }
      } else if (scheme === InputControlScheme.Gamepad) {
        const g = d.gamepad;
        const rawRoll = gamepadReader.axisValue(g.axes.roll.axisIndex) * (g.axes.roll.invert ? -1 : 1);
        const rawPitch = gamepadReader.axisValue(g.axes.pitch.axisIndex) * (g.axes.pitch.invert ? -1 : 1);
        applyRadialDeadzone(rawRoll, rawPitch, g.deadzone, radialDzScratch);
        roll = shapeCurve(radialDzScratch.x, g.stickCurveExponent);
        pitch = shapeCurve(radialDzScratch.y, g.stickCurveExponent);

        const rawYaw = gamepadReader.axisValue(g.axes.yaw.axisIndex) * (g.axes.yaw.invert ? -1 : 1);
        yaw = shapeCurve(applyLinearDeadzone(rawYaw, g.deadzone), g.yawCurveExponent);

        const throttleUp = gamepadReader.buttonValue(g.throttleUpButtonIndex);
        const throttleDown = gamepadReader.buttonValue(g.throttleDownButtonIndex);
        throttleAxis = clamp(throttleAxis + (throttleUp - throttleDown) * KEYBOARD_THROTTLE_RAMP_RATE_PER_SEC * dtSec, 0, 1);
      } else if (scheme === InputControlScheme.Touch) {
        roll = touchReader.state.stickX;
        pitch = touchReader.state.stickY;
        yaw = touchReader.state.yawBar;
        throttleAxis = touchReader.state.throttle;
      } else {
        // touchGyro
        deviceOrientationReader.sample(orientationScratch);
        pitch = orientationScratch.pitchRad;
        roll = orientationScratch.rollRad;
        yaw = touchReader.state.yawBar;
        throttleAxis = touchReader.state.throttle;
      }

      // Passthrough booleans (raw held, unfiltered every update).
      const rawTrigger = rawButtonHeld(LogicalButton.Trigger, scheme);
      const rawLaunch = rawButtonHeld(LogicalButton.Launch, scheme);
      const rawCycleWeapon = rawButtonHeld(LogicalButton.CycleWeapon, scheme);
      const rawCycleTarget = rawButtonHeld(LogicalButton.CycleTarget, scheme);
      const rawAfterburner = rawButtonHeld(LogicalButton.Afterburner, scheme);
      const rawBrakes = rawButtonHeld(LogicalButton.Brakes, scheme);
      const rawJettison = rawButtonHeld(LogicalButton.JettisonTanks, scheme);
      const rawService = rawButtonHeld(LogicalButton.Service, scheme);

      // Internal toggles (persisted level, edge-triggered).
      const rawGear = rawButtonHeld(LogicalButton.GearToggle, scheme);
      if (gearEdge.risingEdge(rawGear)) gearDownState = !gearDownState;
      const rawAirbrake = rawButtonHeld(LogicalButton.AirbrakeToggle, scheme);
      if (airbrakeEdge.risingEdge(rawAirbrake)) airbrakeState = !airbrakeState;
      const rawNws = rawButtonHeld(LogicalButton.NwsToggle, scheme);
      if (nwsEdge.risingEdge(rawNws)) nwsState = !nwsState;

      // Meta actions (not in PilotInputs).
      const rawCameraCycle = rawButtonHeld(MetaAction.CameraCycle, scheme);
      if (cameraCycleEdge.risingEdge(rawCameraCycle)) {
        for (const handler of metaHandlers) handler(MetaAction.CameraCycle);
      }
      const rawMenuToggle = rawButtonHeld(MetaAction.MenuToggle, scheme);
      if (menuToggleEdge.risingEdge(rawMenuToggle)) {
        for (const handler of metaHandlers) handler(MetaAction.MenuToggle);
      }

      out.pitch = pitch;
      out.roll = roll;
      out.yaw = yaw;
      out.throttle = throttleAxis;
      out.afterburner = rawAfterburner;
      // Wheel brakes follow the airbrake toggle (one button, B, for both), plus any held brake button.
      out.brakes = rawBrakes || airbrakeState ? 1 : 0;
      out.gearDown = gearDownState;
      out.airbrake = airbrakeState;
      out.jettisonTanks = rawJettison;
      out.requestService = rawService;
      out.trigger = rawTrigger;
      out.launch = rawLaunch;
      out.cycleWeapon = rawCycleWeapon;
      out.cycleTarget = rawCycleTarget;
      out.nwsEnabled = nwsState;
      out.alphaLimiterDisabled = alphaLimiterDisabledState;
    },

    getControlScheme(): InputControlSchemeType {
      return data().controlScheme;
    },
    setControlScheme(scheme: InputControlSchemeType): void {
      withMutatedData((d) => {
        d.controlScheme = scheme;
      });
      touchReader.setVisible(isTouchScheme(scheme));
    },

    isAlphaLimiterDisabled(): boolean {
      return alphaLimiterDisabledState;
    },
    setAlphaLimiterDisabled(disabled: boolean): void {
      alphaLimiterDisabledState = disabled;
    },

    onMetaAction(handler: (action: MetaActionType) => void): () => void {
      metaHandlers.add(handler);
      return () => {
        metaHandlers.delete(handler);
      };
    },

    startRebind(action: RebindableAction, deviceKind: RebindDeviceKindType): void {
      pendingRebind = { action, deviceKind };
    },
    cancelRebind(): void {
      const pending = pendingRebind;
      if (pending === null) return;
      pendingRebind = null;
      const result: RebindResult = { action: pending.action, deviceKind: pending.deviceKind, cancelled: true };
      for (const handler of rebindCompleteHandlers) handler(result);
    },
    isRebinding(): boolean {
      return pendingRebind !== null;
    },
    onRebindComplete(handler: (result: RebindResult) => void): () => void {
      rebindCompleteHandlers.add(handler);
      return () => {
        rebindCompleteHandlers.delete(handler);
      };
    },

    saveInputMap(): void {
      saveInputMapData(storage, data());
    },
    resetInputMapToDefaults(): void {
      inputMap.replace(cloneJson(DEFAULT_INPUT_MAP_DATA));
    },

    isGyroAvailable(): boolean {
      return deviceOrientationReader.available;
    },
    isGyroCalibrated(): boolean {
      return deviceOrientationReader.calibrated;
    },
    requestGyroPermission(): Promise<boolean> {
      return deviceOrientationReader.requestPermission();
    },
    calibrateGyro(): void {
      deviceOrientationReader.calibrate();
    },

    touchState: touchReader.state,

    dispose(): void {
      win.removeEventListener('keydown', onKeyDownPreventDefault);
      config.touchOverlayContainer.removeEventListener('click', onContainerClick);
      keyboardReader.dispose();
      mouseReader.dispose();
      gamepadReader.dispose();
      touchReader.dispose();
      deviceOrientationReader.dispose();
      metaHandlers.clear();
      rebindCompleteHandlers.clear();
    },
  };

  return system;
}
