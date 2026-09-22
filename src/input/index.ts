/**
 * src/input/index.ts — barrel re-export for the whole input module. See
 * docs/spec/09-input.md section 2.
 */

export {
  applyLinearDeadzone,
  applyRadialDeadzone,
  shapeCurve,
  moveTowardZero,
  updateKeyAxis,
  createEdgeDetector,
} from './deadzones';

export { createKeyboardReader } from './keyboard';
export { createMouseReader } from './mouse';
export { createGamepadReader, GAMEPAD_BUTTON_DIGITAL_THRESHOLD } from './gamepad';
export {
  createTouchReader,
  TOUCH_STICK_RADIUS_PX,
  TOUCH_STICK_DEADZONE_FRAC,
  TOUCH_STICK_CURVE_EXPONENT,
  TOUCH_YAW_BAR_HALF_WIDTH_PX,
  TOUCH_YAW_BAR_DEADZONE_FRAC,
  TOUCH_THROTTLE_SLIDER_HEIGHT_PX,
  TOUCH_THROTTLE_SLIDER_WIDTH_PX,
  TOUCH_BUTTON_SIZE_PX,
  TOUCH_BUTTON_SIZE_SMALL_PX,
  MAX_CONCURRENT_TOUCHES,
} from './touch';
export { createDeviceOrientationReader } from './deviceOrientation';

export {
  DEFAULT_INPUT_MAP_DATA,
  parseInputMapData,
  serializeInputMapData,
  loadInputMap,
  saveInputMapData,
  detectDefaultControlScheme,
  createInputMap,
  INPUT_MAP_STORAGE_KEY,
  INPUT_MAP_VERSION,
} from './inputMap';

export {
  createPlayerInputSystem,
  KEYBOARD_AXIS_RAMP_RATE_PER_SEC,
  KEYBOARD_AXIS_CENTER_RATE_PER_SEC,
  KEYBOARD_THROTTLE_RAMP_RATE_PER_SEC,
  INPUT_MAX_DT_SEC,
  REBIND_AXIS_THRESHOLD,
  REBIND_BUTTON_THRESHOLD,
} from './playerPilot';

// Runtime enum-like values from the contract (real `as const` objects, not
// ambient declarations — legitimate to import directly, see 01-math.md's
// barrel for the analogous pattern with contracts/math.ts).
export { LogicalAxis, LogicalButton, MetaAction, InputControlScheme, TouchZoneId, MouseButtonId, RebindDeviceKind } from '../contracts/input';

export type {
  ApplyLinearDeadzone,
  ApplyRadialDeadzone,
  ShapeCurve,
  MoveTowardZero,
  UpdateKeyAxis,
  EdgeDetector,
  CreateEdgeDetector,
  KeyboardCode,
  KeyboardReader,
  CreateKeyboardReader,
  MouseReader,
  CreateMouseReader,
  GamepadReader,
  CreateGamepadReader,
  TouchZoneId as TouchZoneIdType,
  TouchControlsState,
  TouchLayoutRectPx,
  TouchReader,
  CreateTouchReader,
  DeviceOrientationSample,
  DeviceOrientationReader,
  CreateDeviceOrientationReader,
  GamepadAxisBinding,
  GamepadButtonBinding,
  KeyboardAxisBindingPair,
  InputMapData,
  InputMap,
  StorageLike,
  ParseInputMapData,
  SerializeInputMapData,
  LoadInputMap,
  SaveInputMapData,
  DetectDefaultControlScheme,
  RebindableAction,
  RebindResult,
  PlayerInputConfig,
  PlayerInputSystem,
  CreatePlayerInputSystem,
} from '../contracts/input';
