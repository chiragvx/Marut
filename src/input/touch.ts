/**
 * src/input/touch.ts — TouchReader: creates and manages this module's own
 * DOM touch-control overlay (stick, yaw bar, throttle slider, buttons) and
 * multi-touch identifier tracking. See docs/spec/09-input.md section 2, 4.5,
 * 5.4.
 *
 * `CreateTouchReader = () => TouchReader` takes no config, so this reader
 * cannot honor live InputMapData.touch tuning (radius/deadzone/curve
 * exponent) — the shaping constants below are fixed at the same values as
 * DEFAULT_INPUT_MAP_DATA.touch (src/input/inputMap.ts). See this module's
 * contract-concerns note in the final report.
 *
 * The `touchGyro` scheme's "hide/disable the stick zone" behaviour (section
 * 4.5) has no hook in this reader's contract (no setScheme/hide method) —
 * this reader always implements the stick; playerPilot.ts simply does not
 * read `touchState.stickX/stickY` while `touchGyro` is active (it reads
 * DeviceOrientationReader instead). See the final report for this note too.
 */

import type { CreateTouchReader, TouchReader, TouchControlsState, TouchLayoutRectPx, TouchZoneId as TouchZoneIdType } from '../contracts/input';
import { TouchZoneId } from '../contracts/input';
import { applyRadialDeadzone, applyLinearDeadzone, shapeCurve } from './deadzones';
import { buttonIconSvgMarkup } from './touchIcons';

export const TOUCH_STICK_RADIUS_PX = 70;
export const TOUCH_STICK_DEADZONE_FRAC = 0.08;
export const TOUCH_STICK_CURVE_EXPONENT = 1.6;
export const TOUCH_YAW_BAR_HALF_WIDTH_PX = 90;
export const TOUCH_YAW_BAR_DEADZONE_FRAC = 0.05;
export const TOUCH_THROTTLE_SLIDER_HEIGHT_PX = 220;
export const TOUCH_THROTTLE_SLIDER_WIDTH_PX = 48;
export const TOUCH_BUTTON_SIZE_PX = 56;
export const TOUCH_BUTTON_SIZE_SMALL_PX = 44;
export const MAX_CONCURRENT_TOUCHES = 10;

type ButtonZoneId = Exclude<TouchZoneIdType, 'stick' | 'yawBar' | 'throttle'>;

/** Fixed hit-test / layout order for the combat cluster, utility row, and meta row (09-input.md section 4.5). */
const BUTTON_ZONE_ORDER: readonly ButtonZoneId[] = [
  TouchZoneId.Trigger,
  TouchZoneId.Launch,
  TouchZoneId.CycleWeapon,
  TouchZoneId.CycleTarget,
  TouchZoneId.GearToggle,
  TouchZoneId.AirbrakeToggle,
  TouchZoneId.Afterburner,
  TouchZoneId.Brakes,
  TouchZoneId.CameraCycle,
  TouchZoneId.MenuToggle,
];

interface ClaimSlot {
  identifier: number;
  zone: TouchZoneIdType;
  /** Only meaningful for the (floating) stick zone: the local (x,y) the finger landed at. */
  spawnX: number;
  spawnY: number;
}

interface SafeAreaInsetsPx {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function rectContains(rect: TouchLayoutRectPx, x: number, y: number): boolean {
  return x >= rect.leftPx && x <= rect.leftPx + rect.widthPx && y >= rect.topPx && y <= rect.topPx + rect.heightPx;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function createOverlayDiv(doc: Document): HTMLDivElement {
  const el = doc.createElement('div');
  el.style.position = 'absolute';
  el.style.touchAction = 'none';
  el.style.background = 'rgba(255,255,255,0.12)';
  el.style.border = '1px solid rgba(255,255,255,0.4)';
  el.style.boxSizing = 'border-box';
  return el;
}

function applyRect(el: HTMLElement, rect: TouchLayoutRectPx): void {
  el.style.left = `${rect.leftPx}px`;
  el.style.top = `${rect.topPx}px`;
  el.style.width = `${rect.widthPx}px`;
  el.style.height = `${rect.heightPx}px`;
}

export const createTouchReader: CreateTouchReader = () => {
  const state: TouchControlsState = {
    stickX: 0,
    stickY: 0,
    yawBar: 0,
    throttle: 0,
    buttons: {
      trigger: false,
      launch: false,
      cycleWeapon: false,
      cycleTarget: false,
      gearToggle: false,
      airbrakeToggle: false,
      afterburner: false,
      brakes: false,
      cameraCycle: false,
      menuToggle: false,
    },
  };

  const claims: (ClaimSlot | null)[] = new Array(MAX_CONCURRENT_TOUCHES).fill(null);
  const scratchDz = { x: 0, y: 0 };

  let container: HTMLElement | null = null;
  let probeEl: HTMLDivElement | null = null;
  // Wraps every VISIBLE overlay element (not probeEl, which is invisible/pointer-events:none
  // and used only to measure safe-area insets — nesting it under a display:none ancestor would
  // zero out its getBoundingClientRect() reading, breaking readSafeAreaInsets). setVisible()
  // toggles this one element's display instead of each child individually. Added because the
  // overlay was previously always mounted and always visible regardless of the active
  // InputControlScheme — a desktop keyboard/mouse/gamepad session showed a full set of empty
  // touch buttons with nothing to do with it.
  let overlayRootEl: HTMLDivElement | null = null;
  let stickBaseEl: HTMLDivElement | null = null;
  let stickKnobEl: HTMLDivElement | null = null;
  let yawBarEl: HTMLDivElement | null = null;
  let throttleEl: HTMLDivElement | null = null;
  const buttonEls = new Map<ButtonZoneId, HTMLDivElement>();

  let stickSpawnRect: TouchLayoutRectPx = { leftPx: 0, topPx: 0, widthPx: 0, heightPx: 0 };
  let yawBarRect: TouchLayoutRectPx = { leftPx: 0, topPx: 0, widthPx: 0, heightPx: 0 };
  let throttleRect: TouchLayoutRectPx = { leftPx: 0, topPx: 0, widthPx: 0, heightPx: 0 };
  const buttonRects = new Map<ButtonZoneId, TouchLayoutRectPx>();

  function readSafeAreaInsets(doc: Document, win: Window): SafeAreaInsetsPx {
    if (probeEl === null) return { top: 0, right: 0, bottom: 0, left: 0 };
    const rect = probeEl.getBoundingClientRect();
    // probeEl is `position: fixed` with all four env(safe-area-inset-*)
    // offsets set, so its box is stretched between the four insets — see
    // this file's header comment and 09-input.md section 4.5.
    const top = Math.max(0, rect.top);
    const left = Math.max(0, rect.left);
    const right = Math.max(0, win.innerWidth - rect.right);
    const bottom = Math.max(0, win.innerHeight - rect.bottom);
    if (!isFinite(top) || !isFinite(left) || !isFinite(right) || !isFinite(bottom)) {
      return { top: 0, right: 0, bottom: 0, left: 0 };
    }
    return { top, right, bottom, left };
  }

  function computeLayout(): void {
    if (container === null) return;
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    if (win === null) return;
    const containerRect = container.getBoundingClientRect();
    const w = containerRect.width;
    const h = containerRect.height;
    const insets = readSafeAreaInsets(doc, win);

    // Assumes touchOverlayContainer spans the full viewport (its documented
    // role, 09-input.md section 2), so a viewport-relative safe-area inset
    // maps directly onto a container-relative offset.
    stickSpawnRect = { leftPx: 0, topPx: 0, widthPx: w * 0.5, heightPx: h * 0.78 };

    const yawBarWidth = 2 * TOUCH_YAW_BAR_HALF_WIDTH_PX + 40;
    const yawBarHeight = 48;
    yawBarRect = {
      leftPx: (w - yawBarWidth) / 2,
      topPx: h - (12 + insets.bottom) - yawBarHeight,
      widthPx: yawBarWidth,
      heightPx: yawBarHeight,
    };

    throttleRect = {
      leftPx: w - (12 + insets.right) - TOUCH_THROTTLE_SLIDER_WIDTH_PX,
      topPx: (h - TOUCH_THROTTLE_SLIDER_HEIGHT_PX) / 2,
      widthPx: TOUCH_THROTTLE_SLIDER_WIDTH_PX,
      heightPx: TOUCH_THROTTLE_SLIDER_HEIGHT_PX,
    };

    // Combat cluster: 2x2, anchored bottom-right, directly above the
    // throttle slider's top edge.
    const clusterGap = 8;
    const clusterCellsPerSide = 2;
    const clusterSide = clusterCellsPerSide * TOUCH_BUTTON_SIZE_PX + (clusterCellsPerSide - 1) * clusterGap;
    const clusterRight = w - (12 + insets.right);
    const clusterBottom = throttleRect.topPx;
    const clusterLeft = clusterRight - clusterSide;
    const clusterTop = clusterBottom - clusterSide;
    const combatOrder: readonly ButtonZoneId[] = [
      TouchZoneId.Trigger,
      TouchZoneId.Launch,
      TouchZoneId.CycleWeapon,
      TouchZoneId.CycleTarget,
    ];
    for (let i = 0; i < combatOrder.length; i++) {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const zone = combatOrder[i];
      if (zone === undefined) continue;
      buttonRects.set(zone, {
        leftPx: clusterLeft + col * (TOUCH_BUTTON_SIZE_PX + clusterGap),
        topPx: clusterTop + row * (TOUCH_BUTTON_SIZE_PX + clusterGap),
        widthPx: TOUCH_BUTTON_SIZE_PX,
        heightPx: TOUCH_BUTTON_SIZE_PX,
      });
    }

    // Utility row: 4 buttons, anchored top-right.
    const utilGap = 6;
    const utilOrder: readonly ButtonZoneId[] = [
      TouchZoneId.GearToggle,
      TouchZoneId.AirbrakeToggle,
      TouchZoneId.Afterburner,
          TouchZoneId.Brakes,
    ];
    const utilWidth = utilOrder.length * TOUCH_BUTTON_SIZE_SMALL_PX + (utilOrder.length - 1) * utilGap;
    const utilRight = w - (12 + insets.right);
    const utilTop = 12 + insets.top;
    const utilLeft = utilRight - utilWidth;
    for (let i = 0; i < utilOrder.length; i++) {
      const zone = utilOrder[i];
      if (zone === undefined) continue;
      buttonRects.set(zone, {
        leftPx: utilLeft + i * (TOUCH_BUTTON_SIZE_SMALL_PX + utilGap),
        topPx: utilTop,
        widthPx: TOUCH_BUTTON_SIZE_SMALL_PX,
        heightPx: TOUCH_BUTTON_SIZE_SMALL_PX,
      });
    }

    // Meta row: 2 buttons, anchored top-left.
    const metaGap = 6;
    const metaOrder: readonly ButtonZoneId[] = [TouchZoneId.CameraCycle, TouchZoneId.MenuToggle];
    const metaLeft = 12 + insets.left;
    const metaTop = 12 + insets.top;
    for (let i = 0; i < metaOrder.length; i++) {
      const zone = metaOrder[i];
      if (zone === undefined) continue;
      buttonRects.set(zone, {
        leftPx: metaLeft + i * (TOUCH_BUTTON_SIZE_SMALL_PX + metaGap),
        topPx: metaTop,
        widthPx: TOUCH_BUTTON_SIZE_SMALL_PX,
        heightPx: TOUCH_BUTTON_SIZE_SMALL_PX,
      });
    }

    // Push the computed rects onto the actual DOM elements.
    if (yawBarEl !== null) applyRect(yawBarEl, yawBarRect);
    if (throttleEl !== null) applyRect(throttleEl, throttleRect);
    for (const [zone, el] of buttonEls) {
      const rect = buttonRects.get(zone);
      if (rect !== undefined) applyRect(el, rect);
    }
    // The stick base/knob are repositioned per-touch (floating); while idle
    // they are hidden (opacity 0) since there is no fixed "home" position.
    if (stickBaseEl !== null && !isStickActive()) stickBaseEl.style.opacity = '0';
    if (stickKnobEl !== null && !isStickActive()) stickKnobEl.style.opacity = '0';
  }

  function isStickActive(): boolean {
    for (const slot of claims) {
      if (slot != null && slot.zone === TouchZoneId.Stick) return true;
    }
    return false;
  }

  function findSlotIndexByIdentifier(identifier: number): number {
    for (let i = 0; i < claims.length; i++) {
      const slot = claims[i];
      if (slot != null && slot.identifier === identifier) return i;
    }
    return -1;
  }

  function findFreeSlotIndex(): number {
    for (let i = 0; i < claims.length; i++) {
      if (claims[i] == null) return i;
    }
    return -1;
  }

  function isZoneClaimed(zone: TouchZoneIdType): boolean {
    for (const slot of claims) {
      if (slot != null && slot.zone === zone) return true;
    }
    return false;
  }

  function updateStickFromLocal(slot: ClaimSlot, localX: number, localY: number): void {
    const dx = localX - slot.spawnX;
    const dy = localY - slot.spawnY;
    const r = TOUCH_STICK_RADIUS_PX;
    const nx = clamp(dx / r, -1, 1);
    const ny = clamp(dy / r, -1, 1);
    applyRadialDeadzone(nx, ny, TOUCH_STICK_DEADZONE_FRAC, scratchDz);
    state.stickX = shapeCurve(scratchDz.x, TOUCH_STICK_CURVE_EXPONENT);
    state.stickY = shapeCurve(-scratchDz.y, TOUCH_STICK_CURVE_EXPONENT);
    if (stickBaseEl !== null && stickKnobEl !== null) {
      const baseSize = TOUCH_STICK_RADIUS_PX * 2;
      stickBaseEl.style.left = `${slot.spawnX - TOUCH_STICK_RADIUS_PX}px`;
      stickBaseEl.style.top = `${slot.spawnY - TOUCH_STICK_RADIUS_PX}px`;
      stickBaseEl.style.width = `${baseSize}px`;
      stickBaseEl.style.height = `${baseSize}px`;
      stickBaseEl.style.borderRadius = '50%';
      stickBaseEl.style.opacity = '1';
      const knobSize = TOUCH_STICK_RADIUS_PX * 0.6;
      stickKnobEl.style.left = `${localX - knobSize / 2}px`;
      stickKnobEl.style.top = `${localY - knobSize / 2}px`;
      stickKnobEl.style.width = `${knobSize}px`;
      stickKnobEl.style.height = `${knobSize}px`;
      stickKnobEl.style.borderRadius = '50%';
      stickKnobEl.style.opacity = '1';
    }
  }

  function updateYawBarFromLocal(localX: number): void {
    const bx = yawBarRect.leftPx + yawBarRect.widthPx / 2;
    const w = TOUCH_YAW_BAR_HALF_WIDTH_PX;
    const dx = clamp((localX - bx) / w, -1, 1);
    state.yawBar = shapeCurve(applyLinearDeadzone(dx, TOUCH_YAW_BAR_DEADZONE_FRAC), TOUCH_STICK_CURVE_EXPONENT);
  }

  function updateThrottleFromLocal(localY: number): void {
    const topY = throttleRect.topPx;
    const hgt = throttleRect.heightPx;
    const frac = hgt > 0 ? clamp(1 - (localY - topY) / hgt, 0, 1) : 0;
    state.throttle = frac;
  }

  function handleTouchStartOrMoveForSlot(slotIndex: number, localX: number, localY: number): void {
    const slot = claims[slotIndex];
    if (slot == null) return;
    if (slot.zone === TouchZoneId.Stick) {
      updateStickFromLocal(slot, localX, localY);
    } else if (slot.zone === TouchZoneId.YawBar) {
      updateYawBarFromLocal(localX);
    } else if (slot.zone === TouchZoneId.Throttle) {
      updateThrottleFromLocal(localY);
    }
    // Buttons ignore movement entirely.
  }

  function localPointFor(touch: Touch): { x: number; y: number } {
    if (container === null) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  }

  function onTouchStart(event: TouchEvent): void {
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches.item(i);
      if (touch === null) continue;
      const { x, y } = localPointFor(touch);

      let matchedZone: TouchZoneIdType | null = null;
      if (!isZoneClaimed(TouchZoneId.Stick) && rectContains(stickSpawnRect, x, y)) {
        matchedZone = TouchZoneId.Stick;
      } else if (!isZoneClaimed(TouchZoneId.YawBar) && rectContains(yawBarRect, x, y)) {
        matchedZone = TouchZoneId.YawBar;
      } else if (!isZoneClaimed(TouchZoneId.Throttle) && rectContains(throttleRect, x, y)) {
        matchedZone = TouchZoneId.Throttle;
      } else {
        for (const zone of BUTTON_ZONE_ORDER) {
          if (isZoneClaimed(zone)) continue;
          const rect = buttonRects.get(zone);
          if (rect !== undefined && rectContains(rect, x, y)) {
            matchedZone = zone;
            break;
          }
        }
      }
      if (matchedZone === null) continue;

      const freeIndex = findFreeSlotIndex();
      if (freeIndex === -1) continue;
      claims[freeIndex] = { identifier: touch.identifier, zone: matchedZone, spawnX: x, spawnY: y };

      if (matchedZone === TouchZoneId.Stick || matchedZone === TouchZoneId.YawBar || matchedZone === TouchZoneId.Throttle) {
        handleTouchStartOrMoveForSlot(freeIndex, x, y);
      } else {
        (state.buttons as Record<ButtonZoneId, boolean>)[matchedZone] = true;
      }
    }
    event.preventDefault();
  }

  function onTouchMove(event: TouchEvent): void {
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches.item(i);
      if (touch === null) continue;
      const slotIndex = findSlotIndexByIdentifier(touch.identifier);
      if (slotIndex === -1) continue;
      const { x, y } = localPointFor(touch);
      handleTouchStartOrMoveForSlot(slotIndex, x, y);
    }
    event.preventDefault();
  }

  function onTouchEndOrCancel(event: TouchEvent): void {
    for (let i = 0; i < event.changedTouches.length; i++) {
      const touch = event.changedTouches.item(i);
      if (touch === null) continue;
      const slotIndex = findSlotIndexByIdentifier(touch.identifier);
      if (slotIndex === -1) continue;
      const slot = claims[slotIndex];
      claims[slotIndex] = null;
      if (slot == null) continue;
      if (slot.zone === TouchZoneId.Stick) {
        state.stickX = 0;
        state.stickY = 0;
        if (stickBaseEl !== null) stickBaseEl.style.opacity = '0';
        if (stickKnobEl !== null) stickKnobEl.style.opacity = '0';
      } else if (slot.zone === TouchZoneId.YawBar) {
        state.yawBar = 0;
      } else if (slot.zone === TouchZoneId.Throttle) {
        // Retains its last absolute value.
      } else {
        (state.buttons as Record<ButtonZoneId, boolean>)[slot.zone as ButtonZoneId] = false;
      }
    }
    event.preventDefault();
  }

  const reader: TouchReader = {
    state,
    attach(el: HTMLElement): void {
      container = el;
      const doc = el.ownerDocument;

      probeEl = doc.createElement('div');
      probeEl.style.position = 'fixed';
      probeEl.style.top = 'env(safe-area-inset-top)';
      probeEl.style.right = 'env(safe-area-inset-right)';
      probeEl.style.bottom = 'env(safe-area-inset-bottom)';
      probeEl.style.left = 'env(safe-area-inset-left)';
      probeEl.style.visibility = 'hidden';
      probeEl.style.pointerEvents = 'none';
      el.appendChild(probeEl);

      // Touch hit-testing is entirely coordinate-based (rectContains against buttonRects, from
      // touch events listened for on `el`/container itself, not on these child elements) — so
      // CSS pointer-events on this wrapper or its children has no effect on functionality either
      // way; it exists purely so setVisible() has one element to toggle display on.
      overlayRootEl = doc.createElement('div');
      overlayRootEl.style.position = 'absolute';
      overlayRootEl.style.inset = '0';
      el.appendChild(overlayRootEl);

      stickBaseEl = createOverlayDiv(doc);
      stickBaseEl.style.opacity = '0';
      stickKnobEl = createOverlayDiv(doc);
      stickKnobEl.style.opacity = '0';
      stickKnobEl.style.background = 'rgba(255,255,255,0.28)';
      overlayRootEl.appendChild(stickBaseEl);
      overlayRootEl.appendChild(stickKnobEl);

      yawBarEl = createOverlayDiv(doc);
      yawBarEl.setAttribute('aria-label', TouchZoneId.YawBar);
      overlayRootEl.appendChild(yawBarEl);

      throttleEl = createOverlayDiv(doc);
      throttleEl.setAttribute('aria-label', TouchZoneId.Throttle);
      overlayRootEl.appendChild(throttleEl);

      for (const zone of BUTTON_ZONE_ORDER) {
        const btn = createOverlayDiv(doc);
        btn.setAttribute('aria-label', zone);
        btn.innerHTML = buttonIconSvgMarkup(zone);
        buttonEls.set(zone, btn);
        overlayRootEl.appendChild(btn);
      }

      el.addEventListener('touchstart', onTouchStart, { passive: false });
      el.addEventListener('touchmove', onTouchMove, { passive: false });
      el.addEventListener('touchend', onTouchEndOrCancel, { passive: false });
      el.addEventListener('touchcancel', onTouchEndOrCancel, { passive: false });

      reader.relayout();
    },
    relayout(): void {
      computeLayout();
    },
    setVisible(visible: boolean): void {
      if (overlayRootEl !== null) overlayRootEl.style.display = visible ? '' : 'none';
    },
    dispose(): void {
      if (container !== null) {
        container.removeEventListener('touchstart', onTouchStart);
        container.removeEventListener('touchmove', onTouchMove);
        container.removeEventListener('touchend', onTouchEndOrCancel);
        container.removeEventListener('touchcancel', onTouchEndOrCancel);
        // stickBaseEl/stickKnobEl/yawBarEl/throttleEl/buttonEls all live inside overlayRootEl
        // now (not directly under container — see overlayRootEl's own comment above), so
        // removing probeEl + overlayRootEl detaches everything else with them.
        for (const child of [probeEl, overlayRootEl]) {
          if (child !== null && child.parentNode === container) {
            container.removeChild(child);
          }
        }
      }
      buttonEls.clear();
      buttonRects.clear();
      claims.fill(null);
      state.stickX = 0;
      state.stickY = 0;
      state.yawBar = 0;
      container = null;
      probeEl = null;
      overlayRootEl = null;
      stickBaseEl = null;
      stickKnobEl = null;
      yawBarEl = null;
      throttleEl = null;
    },
  };
  return reader;
};
