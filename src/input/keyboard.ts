/**
 * src/input/keyboard.ts — KeyboardReader: tracks held KeyboardEvent.codes via
 * keydown/keyup listeners. See docs/spec/09-input.md section 2.
 *
 * This reader is deliberately policy-free (no preventDefault/binding
 * knowledge) because `CreateKeyboardReader`'s contract signature is
 * `(target: Window) => KeyboardReader` — it has no way to receive the live
 * InputMapData the spec's section 5.2 preventDefault note refers to. That
 * behaviour is instead implemented in playerPilot.ts, which owns both the
 * window and the live InputMap. See this module's return value in the final
 * report for the full note.
 */

import type { CreateKeyboardReader, KeyboardReader, KeyboardCode } from '../contracts/input';

export const createKeyboardReader: CreateKeyboardReader = (target) => {
  const held = new Set<KeyboardCode>();

  const onKeyDown = (event: KeyboardEvent): void => {
    held.add(event.code);
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    held.delete(event.code);
  };
  // A key can get "stuck" held if the window loses focus while it is down
  // (e.g. Alt-Tab, or a browser dialog) — no keyup ever fires. Clearing on
  // blur prevents a stuck key from silently driving an axis forever.
  const onBlur = (): void => {
    held.clear();
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  const reader: KeyboardReader = {
    isDown(code: KeyboardCode): boolean {
      return held.has(code);
    },
    dispose(): void {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
      held.clear();
    },
  };
  return reader;
};
