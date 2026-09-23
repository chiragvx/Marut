import { describe, expect, it } from 'vitest';
import { buildKeyBindingsFromInputMap, isAxisRebindMiscapturePositive, targetForBindableAction } from '../../src/core/inputBindingsAdapter';
import { DEFAULT_INPUT_MAP_DATA } from '../../src/input';
import { BindableAction } from '../../src/contracts/ui';
import { LogicalAxis, LogicalButton, MetaAction } from '../../src/contracts/input';

// Regression coverage for the "Settings shows no key bindings and Rebind does nothing" bug found
// while investigating a user report that keyboard throttle control "wasn't working": main.ts was
// passing `keyBindings: []` to the settings screen instead of the live InputMapData, so every row
// displayed '—' regardless of what was actually bound (throttle genuinely was PageUp/PageDown and
// worked correctly — this adapter is what makes that fact visible to the player).
describe('buildKeyBindingsFromInputMap', () => {
  const bindings = buildKeyBindingsFromInputMap(DEFAULT_INPUT_MAP_DATA);

  function codeFor(action: BindableAction): string | undefined {
    return bindings.find((b) => b.action === action)?.code;
  }

  it('produces one entry per BindableAction (none silently dropped)', () => {
    expect(bindings.length).toBe(Object.values(BindableAction).length);
  });

  it('resolves throttleUp/throttleDown from the real default keyboard axis (PageUp/PageDown), matching the live app', () => {
    expect(codeFor(BindableAction.ThrottleUp)).toBe('PageUp');
    expect(codeFor(BindableAction.ThrottleDown)).toBe('PageDown');
  });

  it('resolves pitch/roll/yaw per the architecture sign convention (positive = nose up / roll right / nose right)', () => {
    expect(codeFor(BindableAction.PitchUp)).toBe('KeyS'); // stick back = +pitch = nose up
    expect(codeFor(BindableAction.PitchDown)).toBe('KeyW');
    expect(codeFor(BindableAction.RollRight)).toBe('KeyD');
    expect(codeFor(BindableAction.RollLeft)).toBe('KeyA');
    expect(codeFor(BindableAction.YawRight)).toBe('KeyE');
    expect(codeFor(BindableAction.YawLeft)).toBe('KeyQ');
  });

  it('resolves the three actions module 09 and module 11 named differently (airbrake/noseWheelSteer/pauseToggle)', () => {
    expect(codeFor(BindableAction.Airbrake)).toBe(DEFAULT_INPUT_MAP_DATA.keyboard.buttons.airbrakeToggle);
    expect(codeFor(BindableAction.NoseWheelSteer)).toBe(DEFAULT_INPUT_MAP_DATA.keyboard.buttons.nwsToggle);
    expect(codeFor(BindableAction.PauseToggle)).toBe(DEFAULT_INPUT_MAP_DATA.keyboard.meta.menuToggle);
  });

  it('resolves every plain button/meta action to its real bound key', () => {
    expect(codeFor(BindableAction.Trigger)).toBe(DEFAULT_INPUT_MAP_DATA.keyboard.buttons.trigger);
    expect(codeFor(BindableAction.Launch)).toBe(DEFAULT_INPUT_MAP_DATA.keyboard.buttons.launch);
    expect(codeFor(BindableAction.CycleWeapon)).toBe(DEFAULT_INPUT_MAP_DATA.keyboard.buttons.cycleWeapon);
    expect(codeFor(BindableAction.CycleTarget)).toBe(DEFAULT_INPUT_MAP_DATA.keyboard.buttons.cycleTarget);
    expect(codeFor(BindableAction.GearToggle)).toBe(DEFAULT_INPUT_MAP_DATA.keyboard.buttons.gearToggle);
    expect(codeFor(BindableAction.Afterburner)).toBe(DEFAULT_INPUT_MAP_DATA.keyboard.buttons.afterburner);
    expect(codeFor(BindableAction.Brakes)).toBe(DEFAULT_INPUT_MAP_DATA.keyboard.buttons.brakes);
    expect(codeFor(BindableAction.CameraCycle)).toBe(DEFAULT_INPUT_MAP_DATA.keyboard.meta.cameraCycle);
  });

  it('omits an action whose keyboard code is explicitly null rather than emitting a bogus entry', () => {
    const withUnbound = { ...DEFAULT_INPUT_MAP_DATA, keyboard: { ...DEFAULT_INPUT_MAP_DATA.keyboard, buttons: { ...DEFAULT_INPUT_MAP_DATA.keyboard.buttons, trigger: null } } };
    const result = buildKeyBindingsFromInputMap(withUnbound);
    expect(result.find((b) => b.action === BindableAction.Trigger)).toBeUndefined();
  });
});

describe('targetForBindableAction / isAxisRebindMiscapturePositive', () => {
  it('maps every axis row to the right LogicalAxis + direction', () => {
    expect(targetForBindableAction(BindableAction.ThrottleUp)).toEqual({ rebindAction: LogicalAxis.Throttle, axisDirection: 'positive' });
    expect(targetForBindableAction(BindableAction.ThrottleDown)).toEqual({ rebindAction: LogicalAxis.Throttle, axisDirection: 'negative' });
  });

  it('maps the three renamed button/meta actions to module 09\'s real identities', () => {
    expect(targetForBindableAction(BindableAction.Airbrake).rebindAction).toBe(LogicalButton.AirbrakeToggle);
    expect(targetForBindableAction(BindableAction.NoseWheelSteer).rebindAction).toBe(LogicalButton.NwsToggle);
    expect(targetForBindableAction(BindableAction.PauseToggle).rebindAction).toBe(MetaAction.MenuToggle);
  });

  it('flags exactly the four "positive" axis rows as unsafe to keyboard-rebind (module 09\'s negative-only capture limitation)', () => {
    const flagged = Object.values(BindableAction).filter(isAxisRebindMiscapturePositive);
    expect(flagged.sort()).toEqual([BindableAction.PitchUp, BindableAction.RollRight, BindableAction.ThrottleUp, BindableAction.YawRight].sort());
  });
});
