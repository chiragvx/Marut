/**
 * src/input/gamepad.ts — GamepadReader: polls navigator.getGamepads(),
 * exposes raw axis/button values plus the digital-press threshold. See
 * docs/spec/09-input.md section 2 and 4.6. Deadzone/curve shaping of the
 * raw values this reader exposes happens in playerPilot.ts.
 */

import type { CreateGamepadReader, GamepadReader } from '../contracts/input';

/** buttonValue(index) > this => buttonDown(index) === true. */
export const GAMEPAD_BUTTON_DIGITAL_THRESHOLD = 0.5;

export const createGamepadReader: CreateGamepadReader = (target) => {
  let activePad: Gamepad | null = null;

  const reader: GamepadReader = {
    get connected(): boolean {
      return activePad !== null;
    },
    axisValue(axisIndex: number): number {
      if (activePad === null) return 0;
      const v = activePad.axes[axisIndex];
      return typeof v === 'number' ? v : 0;
    },
    buttonValue(buttonIndex: number): number {
      if (activePad === null) return 0;
      const b = activePad.buttons[buttonIndex];
      return b ? b.value : 0;
    },
    buttonDown(buttonIndex: number): boolean {
      return reader.buttonValue(buttonIndex) > GAMEPAD_BUTTON_DIGITAL_THRESHOLD;
    },
    poll(): void {
      const pads = target.navigator.getGamepads();
      let found: Gamepad | null = null;
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        if (pad !== null && pad !== undefined && pad.connected) {
          found = pad;
          break;
        }
      }
      activePad = found;
    },
    dispose(): void {
      activePad = null;
    },
  };
  return reader;
};
