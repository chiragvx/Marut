/**
 * src/core/inputBindingsAdapter.ts — bridges module 09's `InputMapData` (contracts/input.ts) onto
 * module 11's `KeyBinding[]`/`BindableAction` (contracts/ui.ts) for the settings screen.
 *
 * Neither module could see the other while being built in parallel (00-architecture.md's
 * dependency rules only let src/ui import src/contracts, and src/input the same), so their two
 * action-naming schemes drifted:
 *   - `BindableAction` (module 11) splits each axis into two directional rows (e.g. `throttleUp`
 *     / `throttleDown`); `RebindableAction` (module 09) has one identity per axis (`throttle`) and
 *     expects the caller to already know which half of the pair ("positive"/"negative") a given
 *     row means, via 00-architecture.md's PilotInputs sign convention (+1 = the intuitive
 *     "more"/"right"/"up" direction — confirmed against inputMap.ts's DEFAULT_INPUT_MAP_DATA:
 *     pitch positive='KeyS' (stick back = nose up), roll positive='KeyD' (roll right), yaw
 *     positive='KeyE' (nose right), throttle positive='KeyZ').
 *   - Three button/meta actions were simply named differently by the two modules: module 11's
 *     `airbrake`/`noseWheelSteer`/`pauseToggle` are module 09's `airbrakeToggle`/`nwsToggle`/
 *     `menuToggle`.
 * This was previously never reconciled at all: main.ts's showSettingsOverlay() passed
 * `keyBindings: []` and no-op rebind callbacks, so the settings screen displayed nothing and
 * "Rebind" did nothing — see this file's own tests and main.ts's wiring for the fix.
 *
 * KNOWN REMAINING LIMITATION (inherited from module 09, not introduced here — see
 * playerPilot.ts's `applyCapturedKeyboardBinding`): a keyboard axis rebind capture always writes
 * the NEGATIVE key of the pair, because `RebindableAction`/`startRebind` carry no direction
 * discriminator. Rebinding e.g. `pitchDown`/`rollLeft`/`yawLeft`/`throttleDown` is therefore fully
 * correct; rebinding the "Up"/"Right" row of a pair will incorrectly overwrite the *negative* key
 * instead. `isAxisPositiveDirection` below is exported so callers (main.ts) can detect this case
 * and disable/flag those specific rows rather than silently mis-rebind them.
 */
import type { InputMapData, RebindableAction, KeyboardCode } from '../contracts/input';
import { LogicalAxis, LogicalButton, MetaAction } from '../contracts/input';
import type { KeyBinding, BindableAction } from '../contracts/ui';
import { BindableAction as BA } from '../contracts/ui';

type AxisDirection = 'positive' | 'negative';

interface BindableActionTarget {
  readonly rebindAction: RebindableAction;
  /** Present only for the six axis-backed rows (pitch/roll/yaw/throttle x2). */
  readonly axisDirection?: AxisDirection;
}

const BINDABLE_ACTION_TARGETS: Readonly<Record<BindableAction, BindableActionTarget>> = {
  [BA.PitchUp]: { rebindAction: LogicalAxis.Pitch, axisDirection: 'positive' },
  [BA.PitchDown]: { rebindAction: LogicalAxis.Pitch, axisDirection: 'negative' },
  [BA.RollLeft]: { rebindAction: LogicalAxis.Roll, axisDirection: 'negative' },
  [BA.RollRight]: { rebindAction: LogicalAxis.Roll, axisDirection: 'positive' },
  [BA.YawLeft]: { rebindAction: LogicalAxis.Yaw, axisDirection: 'negative' },
  [BA.YawRight]: { rebindAction: LogicalAxis.Yaw, axisDirection: 'positive' },
  [BA.ThrottleUp]: { rebindAction: LogicalAxis.Throttle, axisDirection: 'positive' },
  [BA.ThrottleDown]: { rebindAction: LogicalAxis.Throttle, axisDirection: 'negative' },
  [BA.Afterburner]: { rebindAction: LogicalButton.Afterburner },
  [BA.Brakes]: { rebindAction: LogicalButton.Brakes },
  [BA.GearToggle]: { rebindAction: LogicalButton.GearToggle },
  [BA.Airbrake]: { rebindAction: LogicalButton.AirbrakeToggle },
  [BA.Trigger]: { rebindAction: LogicalButton.Trigger },
  [BA.Launch]: { rebindAction: LogicalButton.Launch },
  [BA.CycleWeapon]: { rebindAction: LogicalButton.CycleWeapon },
  [BA.CycleTarget]: { rebindAction: LogicalButton.CycleTarget },
  [BA.JettisonTanks]: { rebindAction: LogicalButton.JettisonTanks },
  [BA.Service]: { rebindAction: LogicalButton.Service },
  [BA.NoseWheelSteer]: { rebindAction: LogicalButton.NwsToggle },
  [BA.PauseToggle]: { rebindAction: MetaAction.MenuToggle },
  [BA.CameraCycle]: { rebindAction: MetaAction.CameraCycle },
  [BA.TaxiGuide]: { rebindAction: MetaAction.TaxiGuide },
  [BA.RadarMode]: { rebindAction: LogicalButton.RadarMode },
  [BA.RadarRangeUp]: { rebindAction: MetaAction.RadarRangeUp },
  [BA.RadarRangeDown]: { rebindAction: MetaAction.RadarRangeDown },
  [BA.ApToggle]: { rebindAction: MetaAction.ApToggle },
  [BA.AtToggle]: { rebindAction: MetaAction.AtToggle },
  [BA.ApHdgDown]: { rebindAction: MetaAction.ApHdgDown },
  [BA.ApHdgUp]: { rebindAction: MetaAction.ApHdgUp },
  [BA.ApAltDown]: { rebindAction: MetaAction.ApAltDown },
  [BA.ApAltUp]: { rebindAction: MetaAction.ApAltUp },
  [BA.ApVsDown]: { rebindAction: MetaAction.ApVsDown },
  [BA.ApVsUp]: { rebindAction: MetaAction.ApVsUp },
  [BA.ApSpdDown]: { rebindAction: MetaAction.ApSpdDown },
  [BA.ApSpdUp]: { rebindAction: MetaAction.ApSpdUp },
};

/** The `RebindableAction` + axis direction (if any) a given settings-screen row corresponds to. */
export function targetForBindableAction(action: BindableAction): BindableActionTarget {
  return BINDABLE_ACTION_TARGETS[action];
}

/**
 * True for the two rows per axis (`pitchDown`/`rollLeft`/`yawLeft`/`throttleDown`, i.e. the
 * NEGATIVE half of each pair) whose keyboard rebind is fully correct today. False for every
 * button/meta action (also fully correct — no direction to worry about) AND for the four
 * "positive" axis rows (`pitchUp`/`rollRight`/`yawRight`/`throttleUp`), where a keyboard rebind
 * capture would silently overwrite the wrong (negative) key — see this file's header note.
 */
export function isAxisRebindMiscapturePositive(action: BindableAction): boolean {
  return BINDABLE_ACTION_TARGETS[action].axisDirection === 'positive';
}

function keyboardCodeFor(data: Readonly<InputMapData>, target: BindableActionTarget): KeyboardCode | null {
  const { rebindAction, axisDirection } = target;
  if (axisDirection !== undefined) {
    // rebindAction is guaranteed to be a LogicalAxis whenever axisDirection is set.
    return data.keyboard.axes[rebindAction as LogicalAxis][axisDirection];
  }
  if ((Object.values(MetaAction) as string[]).includes(rebindAction)) {
    return data.keyboard.meta[rebindAction as MetaAction];
  }
  return data.keyboard.buttons[rebindAction as LogicalButton];
}

/** Every `BindableAction` in `BindableAction`'s own declared order, each resolved to its current keyboard code (or omitted if unbound). Pure; matches the shape `SettingsState.keyBindings` expects. */
export function buildKeyBindingsFromInputMap(data: Readonly<InputMapData>): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const action of Object.values(BA)) {
    const code = keyboardCodeFor(data, BINDABLE_ACTION_TARGETS[action]);
    if (code !== null) out.push({ action, code });
  }
  return out;
}
