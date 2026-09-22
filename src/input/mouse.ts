/**
 * src/input/mouse.ts — MouseReader: Pointer Lock lifecycle, button state,
 * per-frame relative movement accumulator. See docs/spec/09-input.md
 * section 2 and 4.3. Deadzone/curve/sensitivity shaping of the raw pixel
 * deltas this reader exposes happens in playerPilot.ts (which alone has
 * access to the live InputMapData.mouse tuning) — this reader only ever
 * reports raw button state and raw accumulated movementX/movementY.
 */

import type { CreateMouseReader, MouseReader, MouseButtonId } from '../contracts/input';

const MOUSE_BUTTON_COUNT = 3;

export const createMouseReader: CreateMouseReader = (target, pointerLockTarget) => {
  const buttonDown: boolean[] = [false, false, false];
  let accumDxPx = 0;
  let accumDyPx = 0;

  const isLocked = (): boolean => target.document.pointerLockElement === pointerLockTarget;

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button >= 0 && event.button < MOUSE_BUTTON_COUNT) {
      buttonDown[event.button] = true;
    }
  };
  const onMouseUp = (event: MouseEvent): void => {
    if (event.button >= 0 && event.button < MOUSE_BUTTON_COUNT) {
      buttonDown[event.button] = false;
    }
  };
  const onMouseMove = (event: MouseEvent): void => {
    if (!isLocked()) return;
    accumDxPx += event.movementX;
    accumDyPx += event.movementY;
  };
  const onBlur = (): void => {
    buttonDown[0] = false;
    buttonDown[1] = false;
    buttonDown[2] = false;
  };

  target.addEventListener('mousedown', onMouseDown);
  target.addEventListener('mouseup', onMouseUp);
  target.addEventListener('mousemove', onMouseMove);
  target.addEventListener('blur', onBlur);

  const reader: MouseReader = {
    isPointerLocked(): boolean {
      return isLocked();
    },
    requestPointerLock(): void {
      pointerLockTarget.requestPointerLock();
    },
    exitPointerLock(): void {
      target.document.exitPointerLock();
    },
    isButtonDown(button: MouseButtonId): boolean {
      return buttonDown[button] === true;
    },
    consumeDelta(out) {
      // Always drain the accumulator (even unlocked) so a burst of movement
      // recorded just before lock was lost can never leak into a later,
      // unrelated locked period.
      const dx = accumDxPx;
      const dy = accumDyPx;
      accumDxPx = 0;
      accumDyPx = 0;
      if (!isLocked()) {
        out.dxPx = 0;
        out.dyPx = 0;
        return out;
      }
      out.dxPx = dx;
      out.dyPx = dy;
      return out;
    },
    dispose(): void {
      target.removeEventListener('mousedown', onMouseDown);
      target.removeEventListener('mouseup', onMouseUp);
      target.removeEventListener('mousemove', onMouseMove);
      target.removeEventListener('blur', onBlur);
      buttonDown[0] = false;
      buttonDown[1] = false;
      buttonDown[2] = false;
      accumDxPx = 0;
      accumDyPx = 0;
    },
  };
  return reader;
};
