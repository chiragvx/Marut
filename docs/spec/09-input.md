# 09 — Input

Reads: `00-architecture.md`, `contracts/core.ts`, this file, `contracts/input.ts`. Nothing else. Where anything below appears to disagree with `core.ts`, `core.ts` wins (see section 9).

## 1. Purpose & scope

This module turns live human input — keyboard, mouse, Gamepad API, touchscreen, and phone/tablet DeviceOrientation ("gyro") — into `PilotInputs` (`core.ts`), the exact same shape `src/ai`'s `AiPilot` produces. It is the **only** module allowed to touch `window`, `document`, `navigator`, `Touch*`, `Gamepad*`, `DeviceOrientationEvent`, `localStorage`, or Pointer Lock. It owns:

- Five raw device readers (keyboard/mouse/gamepad/touch/DeviceOrientation), each a thin, testable polling surface over the corresponding browser API.
- A shared, from-scratch numeric shaping layer (linear/radial dead zone, response curve, ramp-with-centering, rising-edge detection) used identically by every device so behaviour is consistent and independently unit-testable without a browser.
- An `InputMap`: rebindable keyboard/gamepad bindings plus per-device tuning (dead zones, curve exponents, sensitivities), persisted to `localStorage` as versioned JSON via `Result`-returning, never-throwing load/parse functions.
- `PlayerInputSystem` — the single object `src/main.ts` (module 10) talks to. It structurally implements core.ts's `Pilot` interface (so it can be tested and reasoned about the same way `AiPilot` is) but is designed to run **on the main thread**, once per animation frame, with its output forwarded to the sim worker via the existing `SimInputMessage` — see section 9 for why, and why that is the only architecturally possible answer given device APIs are main-thread-only.

Out of scope: anything that decides what a control *does* (flight dynamics, weapon firing, camera behaviour) — this module only ever produces `PilotInputs` values and a tiny set of opaque `MetaAction` events (`cameraCycle`, `menuToggle`) for the host application to interpret. Out of scope: drawing the flight HUD (that's `src/hud`) — this module draws only its **own** touch-control overlay (stick/yaw-bar/throttle/buttons), which is not part of the HUD.

## 2. Owned files

| path | purpose |
|---|---|
| `src/input/keyboard.ts` | `KeyboardReader`: tracks held `KeyboardEvent.code`s via `keydown`/`keyup` listeners. |
| `src/input/mouse.ts` | `MouseReader`: Pointer Lock lifecycle, button state, per-frame relative movement accumulator. |
| `src/input/gamepad.ts` | `GamepadReader`: polls `navigator.getGamepads()`, exposes axis/button values with the digital-press threshold. |
| `src/input/touch.ts` | `TouchReader`: creates and manages this module's own DOM touch-control overlay (stick, yaw bar, throttle slider, buttons) and multi-touch identifier tracking. |
| `src/input/deviceOrientation.ts` | `DeviceOrientationReader`: iOS permission flow, calibration baseline, shaped pitch/roll sample. |
| `src/input/deadzones.ts` | The five pure shaping primitives (`applyLinearDeadzone`, `applyRadialDeadzone`, `shapeCurve`, `moveTowardZero`, `updateKeyAxis`) and `createEdgeDetector`. DOM-free; importable under plain Node. |
| `src/input/inputMap.ts` | `InputMapData`/`InputMap`, `DEFAULT_INPUT_MAP_DATA`, `parseInputMapData`/`serializeInputMapData`/`loadInputMap`/`saveInputMapData`, `detectDefaultControlScheme`. |
| `src/input/playerPilot.ts` | `createPlayerInputSystem`: composes the five readers + `InputMap` + the shaping layer into `PlayerInputSystem`, implements the per-scheme assembly algorithm (section 4.11), rebinding, meta-action dispatch. |
| `src/input/index.ts` | Barrel re-export: `createPlayerInputSystem`, all named types/constants from the files above. |

No other files. This module never creates a directory outside `src/input/`.

## 3. Public API

Everything below restates `contracts/input.ts` (the literal source of truth); see that file for full JSDoc. All are exported from `src/input/index.ts`.

### 3.1 Pure shaping primitives (`deadzones.ts`)

```ts
function applyLinearDeadzone(raw: number, deadzone: number): number;
function applyRadialDeadzone(x: number, y: number, deadzone: number, out: {x:number;y:number}): {x:number;y:number};
function shapeCurve(normalized: number, exponent: number): number;
function moveTowardZero(value: number, maxDelta: number): number;
function updateKeyAxis(
  current: number, negativeHeld: boolean, positiveHeld: boolean,
  rampPerSec: number, centerPerSec: number,
  minValue: number, maxValue: number, centerValue: number,
  dtSec: number
): number;
function createEdgeDetector(): EdgeDetector; // { risingEdge(down: boolean): boolean; reset(): void }
```

### 3.2 Device readers

```ts
function createKeyboardReader(target: Window): KeyboardReader; // isDown(code), dispose()
function createMouseReader(target: Window, pointerLockTarget: HTMLElement): MouseReader;
  // isPointerLocked(), requestPointerLock(), exitPointerLock(), isButtonDown(id), consumeDelta(out), dispose()
function createGamepadReader(target: Window): GamepadReader;
  // connected, axisValue(i), buttonValue(i), buttonDown(i), poll(), dispose()
function createTouchReader(): TouchReader;
  // state: TouchControlsState, attach(container), relayout(), dispose()
function createDeviceOrientationReader(target: Window): DeviceOrientationReader;
  // available, calibrated, requestPermission(), calibrate(), sample(out), dispose()
```

### 3.3 Input map / persistence (`inputMap.ts`)

```ts
const DEFAULT_INPUT_MAP_DATA: InputMapData; // section 5.1/5.2
function parseInputMapData(json: string): Result<InputMapData, string>;
function serializeInputMapData(data: InputMapData): string;
function loadInputMap(storage: StorageLike): InputMapData; // never throws; falls back to DEFAULT_INPUT_MAP_DATA
function saveInputMapData(storage: StorageLike, data: InputMapData): void;
function detectDefaultControlScheme(nav: {maxTouchPoints:number}, hasPhysicalKeyboardHint: boolean): InputControlScheme;
```

### 3.4 Top level (`playerPilot.ts`)

```ts
function createPlayerInputSystem(config: PlayerInputConfig): PlayerInputSystem;

interface PlayerInputSystem extends Pilot {          // update(ctx, dtSec, out): void — ctx UNUSED, see section 9
  readonly inputMap: InputMap;
  getControlScheme(): InputControlScheme;
  setControlScheme(scheme: InputControlScheme): void;
  onMetaAction(handler: (action: MetaAction) => void): () => void;
  startRebind(action: RebindableAction, deviceKind: RebindDeviceKind): void;
  cancelRebind(): void;
  isRebinding(): boolean;
  onRebindComplete(handler: (result: RebindResult) => void): () => void;
  saveInputMap(): void;
  resetInputMapToDefaults(): void;
  isGyroAvailable(): boolean;
  isGyroCalibrated(): boolean;
  requestGyroPermission(): Promise<boolean>;
  calibrateGyro(): void;
  readonly touchState: TouchControlsState;
  dispose(): void;
}
```

## 4. Design & algorithms

### 4.1 Pure shaping primitives — exact formulas

```
applyLinearDeadzone(raw, dz):
  s = sign(raw); m = |raw|
  return m <= dz ? 0 : s * (m - dz) / (1 - dz)

applyRadialDeadzone(x, y, dz, out):
  m = hypot(x, y)
  if m <= dz: out.x = 0; out.y = 0; return out
  scale = (m - dz) / (1 - dz) / m
  out.x = x * scale; out.y = y * scale; return out

shapeCurve(n, k): return sign(n) * |n|^k        // k=1 identity; n in [-1,1] -> result in [-1,1]

moveTowardZero(v, maxDelta):
  if v > 0: return max(v - maxDelta, 0)
  if v < 0: return min(v + maxDelta, 0)
  return 0

updateKeyAxis(cur, neg, pos, rampPerSec, centerPerSec, minV, maxV, centerV, dt):
  target = pos && !neg ? maxV : (neg && !pos ? minV : centerV)
  rate   = (pos !== neg) ? rampPerSec : centerPerSec   // neither or both held -> centering rate
  maxDelta = rate * dt
  if cur < target: return min(cur + maxDelta, target)
  if cur > target: return max(cur - maxDelta, target)
  return cur
```

Worked numeric checks (used verbatim as test fixtures in section 7):

- `applyLinearDeadzone(0.5, 0.1)` = `(0.5-0.1)/0.9` = `0.444444...`. `applyLinearDeadzone(0.05, 0.1)` = `0`. `applyLinearDeadzone(1.0, 0.1)` = `1.0` exactly (endpoint preserved).
- `applyRadialDeadzone(0.6, 0.8, 0.2, out)`: `mag = 1.0` exactly (3-4-5 triangle) → `scale = (1-0.2)/1/1 = 0.8` → `out = (0.48, 0.64)`.
- `applyRadialDeadzone(0.1, 0.1, 0.2, out)`: `mag ≈ 0.14142 < 0.2` → `out = (0, 0)`.
- `shapeCurve(0.5, 2)` = `0.25`. `shapeCurve(-0.5, 2)` = `-0.25`. `shapeCurve(1, 1.6)` = `1` exactly.
- `moveTowardZero(1.0, 0.4)` = `0.6`. `moveTowardZero(0.3, 0.4)` = `0` (does not overshoot to `-0.1`).
- `updateKeyAxis` chain from `0`, `positiveHeld=true`, `rampPerSec=2.5`, four steps of `dt=0.1`: `0.25 → 0.5 → 0.75 → 1.0`; a fifth step stays at `1.0` (clamped, not `1.25`). Then release both, `centerPerSec=4.0`, three steps of `dt=0.1`: `1.0 → 0.6 → 0.2 → 0.0` (third step: `max(0.2-0.4,0)=0`, not `-0.2`).

### 4.2 Keyboard axis integration

`pitch`, `roll`, `yaw`, `throttle` are each driven by one `updateKeyAxis` call per `update()`, reading the two bound keys' held state from `KeyboardReader.isDown`. Constants (section 5.3):

| axis | rampPerSec | centerPerSec | min | max | center | effect |
|---|---|---|---|---|---|---|
| pitch/roll/yaw | `KEYBOARD_AXIS_RAMP_RATE_PER_SEC = 2.5` | `KEYBOARD_AXIS_CENTER_RATE_PER_SEC = 4.0` | -1 | 1 | 0 | full deflection in 0.4 s, returns to center in 0.25 s when released |
| throttle | `KEYBOARD_THROTTLE_RAMP_RATE_PER_SEC = 0.5` | `0` | 0 | 1 | 0 (unused) | full range in 2.0 s; `centerPerSec=0` makes `updateKeyAxis` HOLD the current value when both keys are released (its `rate` becomes 0 so `maxDelta=0`) instead of returning to 0 — this is what gives keyboard throttle realistic "stays where you left it" behaviour with the single shared function from 4.1 |

Each axis's ramp state (`current` above) is persisted in `PlayerInputSystem`'s internal state across calls, one `number` per axis, initialized to `0`.

### 4.3 Mouse-aim (optional, keyboard+mouse scheme only)

Disabled by default (`InputMapData.mouse.enabled = false`). When enabled and the browser holds Pointer Lock on `PlayerInputConfig.touchOverlayContainer`:

```
// per update(), BEFORE adding this frame's movement:
mouseStickX = moveTowardZero(mouseStickX, MOUSE_RECENTER_RATE_PER_SEC * dtSec)
mouseStickY = moveTowardZero(mouseStickY, MOUSE_RECENTER_RATE_PER_SEC * dtSec)
{dxPx, dyPx} = mouseReader.consumeDelta(scratch)
mouseStickX = clamp(mouseStickX + dxPx * sensitivityPerPx, -1, 1)
mouseStickY = clamp(mouseStickY + dyPx * sensitivityPerPx, -1, 1)
roll  = shapeCurve(mouseStickX, curveExponent)
pitch = shapeCurve(-mouseStickY, curveExponent)   // screen +Y (down) accumulates positive mouseStickY = "pushed forward" = nose DOWN, so pitch is its negation
```

This *replaces* (not adds to) keyboard's `pitch`/`roll` output for that `update()` call; `yaw` and `throttle` always come from keyboard regardless of mouse-aim. `PlayerInputSystem` requests Pointer Lock itself: it attaches a `click` listener to `touchOverlayContainer` at construction and calls `mouseReader.requestPointerLock()` from inside that handler (a user gesture) whenever `mouse.enabled && controlScheme === 'keyboardMouse' && !mouseReader.isPointerLocked()`. `Escape` releases Pointer Lock automatically (browser-enforced); `mouseStickX/Y` are NOT reset on lock loss (they simply stop receiving deltas and recenter via `moveTowardZero` like any other frame).

### 4.4 Button semantics — passthrough vs. toggle vs. meta-edge

This split exists because `core.ts` documents three different contracts for different `PilotInputs` boolean fields, and this module must match all three exactly:

| category | fields | rule | why |
|---|---|---|---|
| **Raw passthrough** | `trigger`, `launch`, `cycleWeapon`, `cycleTarget`, `afterburner`, `brakes` | output = current bound key/button's raw held state (0/1 for `brakes`) every `update()`, unfiltered | `core.ts`'s own field comments say `launch`/`cycleWeapon`/`cycleTarget` are "edge-triggered by the **consumer**" (src/combat/src/core) — this module must NOT also edge-trigger them, or a press could be silently swallowed if the consumer's own edge check and this module's disagree on which tick is "the" rising edge. `trigger`/`afterburner`/`brakes` have no edge-trigger note in `core.ts` at all — they are plain level state by construction (a trigger is meant to be held). |
| **Internal toggle (persisted level)** | `gearDown`, `airbrake`, `nwsEnabled` | one `EdgeDetector` per field; `risingEdge(rawHeld)` on the bound key/button flips a persisted internal `boolean` (`gearDownState` etc., initial `false`); output = that persisted boolean every `update()`, regardless of current key state | These `PilotInputs` fields are themselves *level* state ("commanded down", "extended") but a toggle-style control (press once = extend, press again = retract) is the only sane keyboard/gamepad/touch mapping for a two-position lever with one binding. The persisted state survives scheme switches (switching from keyboard to gamepad mid-flight does not raise the gear). |
| **Meta (not in `PilotInputs`)** | `cameraCycle`, `menuToggle` | one `EdgeDetector` per action; on a rising edge, every handler registered via `onMetaAction` is called once, synchronously, inside that `update()` call | These never reach `PilotInputs`; core.ts has no opinion on them. Firing exactly once per press (not once per tick held) is this module's own job since nothing downstream will do it. |

Exactly one device family's readers feed the button pipeline per `update()` call, selected by `getControlScheme()` — see 4.8. Edge detectors are **not** reset when the scheme changes (only their *input source* changes), so a key already held on the outgoing scheme cannot cause a spurious edge; the gear/airbrake/NWS/meta `EdgeDetector`s track "is the bound control for this action, on the *current* scheme, held" and are naturally quiescent for schemes that aren't active.

### 4.5 Touch controls

**Layout** (all fixed pixel/percentage values, computed by `TouchReader.relayout()` from `touchOverlayContainer.getBoundingClientRect()`; see section 5.4 for the constants table). `index.html`'s viewport meta tag sets `viewport-fit=cover` (`10-core-worker.md` section 5.4), which lets the page draw under an iPhone's rounded corners/notch/Dynamic-Island and the home-indicator gesture area — every "N px from the `<edge>`" offset below is therefore `N + safeAreaInsetPx(<edge>)`, not a bare pixel constant. `relayout()` reads the four inset values once (from a 1×1 probe `<div>` styled `position: fixed; top: env(safe-area-inset-top); right: env(safe-area-inset-right); bottom: env(safe-area-inset-bottom); left: env(safe-area-inset-left); visibility: hidden` appended to `touchOverlayContainer`, via `getBoundingClientRect()`/`getComputedStyle()` — the only DOM-CSS-dependent measurement this file needs, since layout itself is computed in JS, not pure CSS) and caches them until the next `relayout()` call (resize/orientation-change), so this is not a per-frame cost:

- **Left stick**: *floating* — spawns centered on the finger's `touchstart` position, but only accepts a `touchstart` inside the rectangle `{ left: 0, top: 0, width: 50%, height: 78% }` of the container (leaves room for the utility-button row at the top and the yaw bar at the bottom). Radius `touch.stickRadiusPx` (default `70`).
- **Yaw bar**: fixed rectangle, bottom-center, width `2 × touch.yawBarHalfWidthPx + 40` px, height `48` px, centered horizontally, `12px + safeAreaInsetPx('bottom')` from the bottom edge — the home-indicator swipe-up gesture zone on a notched iPhone in landscape sits exactly where a bare `12px` offset would otherwise place this bar.
- **Throttle slider**: fixed rectangle, right edge, width `TOUCH_THROTTLE_SLIDER_WIDTH_PX = 48` px, height `touch.throttleSliderHeightPx` (default `220`), vertically centered, `12px + safeAreaInsetPx('right')` from the right edge — avoids the rounded-corner mask / edge-swipe recognizer strip on a notched phone held in landscape with the notch on the right.
- **Combat button cluster** (`trigger`, `launch`, `cycleWeapon`, `cycleTarget`): 2×2 grid, `TOUCH_BUTTON_SIZE_PX = 56` px squares, `8` px gaps, anchored bottom-right (`12px + safeAreaInsetPx('right')` / `12px + safeAreaInsetPx('bottom')`), directly above the throttle slider's top edge.
- **Utility button row** (`gearToggle`, `airbrakeToggle`, `afterburner`, `nwsToggle`, `brakes`): 5 buttons in a row, `TOUCH_BUTTON_SIZE_SMALL_PX = 44` px squares, `6` px gaps, anchored top-right (`12px + safeAreaInsetPx('top')` / `12px + safeAreaInsetPx('right')`).
- **Meta button row** (`cameraCycle`, `menuToggle`): 2 buttons, `44` px squares, `6` px gap, anchored top-left (`12px + safeAreaInsetPx('top')` / `12px + safeAreaInsetPx('left')`).

On a device with no safe-area insets (desktop, most Android phones, an iPhone in portrait with no bottom bar concern), `env(safe-area-inset-*)` resolves to `0px` and every offset above reduces exactly to the original bare `12px`/edge-anchor value — this is a pure widening of the existing layout, never a behaviour change on hardware without a notch/home-indicator.

All overlay elements: `position: absolute`, `touch-action: none` (prevents the browser's default scroll/zoom gestures from stealing the touch), semi-transparent (`background: rgba(255,255,255,0.12)`, `border: 1px solid rgba(255,255,255,0.4)`) — flat, wireframe-consistent placeholder styling, no theming requirements beyond this.

**Multi-touch identifier claiming.** `TouchReader` keeps a fixed-size table of `MAX_CONCURRENT_TOUCHES = 10` slots (`{identifier: number, zone: TouchZoneId} | null`), pre-allocated at `attach()`. On `touchstart`, for each new `Touch` in the event: iterate the fixed zone list (stick spawn-rect, yaw bar rect, throttle rect, then each button rect) in that fixed order, hit-test the touch's client (x,y) against the first zone whose rect contains it **and** which has no existing claim, and if found, write `{identifier, zone}` into the first empty slot. On `touchmove`, for each changed `Touch`, find its slot by `identifier` and update that zone's derived value (stick/yaw bar: recompute from the *spawn* center, not the live rect — the stick and yaw bar are relative-drag controls; buttons ignore `touchmove`). On `touchend`/`touchcancel`, clear the slot; if the zone was `stick` or `yawBar`, its output resets to `(0,0)`/`0` immediately (no inertia); if `throttle`, its last absolute value is retained (section 3.4/`TouchControlsState.throttle`); if a button, its `buttons[zone]` entry becomes `false`.

**Stick math** (spawn center `(cx, cy)`, live touch `(tx, ty)`, both in the container's local pixel space, +y down):

```
dx = tx - cx; dy = ty - cy
r  = touch.stickRadiusPx
nx = clamp(dx / r, -1, 1); ny = clamp(dy / r, -1, 1)
{x: rx, y: ry} = applyRadialDeadzone(nx, ny, touch.stickDeadzoneFrac, scratch)
stickX = shapeCurve(rx, touch.stickCurveExponent)         // -> PilotInputs.roll directly
stickY = shapeCurve(-ry, touch.stickCurveExponent)        // finger UP (ty<cy, dy<0, ny<0) -> -ry>0 -> pitch positive (nose up), matching a stick pulled back
```

**Yaw bar math** (fixed rect center `(bx, by)`, half-width `w = touch.yawBarHalfWidthPx`; no vertical component):

```
dx = clamp((tx - bx) / w, -1, 1)
yawBar = shapeCurve(applyLinearDeadzone(dx, touch.yawBarDeadzoneFrac), touch.stickCurveExponent)  // reuses the stick's curve exponent; no separate field
```

**Throttle slider math** (fixed rect top `topY`, height `h = touch.throttleSliderHeightPx`; ABSOLUTE position, not relative-drag):

```
frac = clamp(1 - (ty - topY) / h, 0, 1)   // touching the top of the bar -> 1 (full mil power), bottom -> 0 (idle)
```
written directly to `TouchControlsState.throttle` on every `touchmove` for the claimed identifier; unchanged on `touchend` (holds last position, matching a physical throttle detent).

`touchGyro` scheme hides/disables the stick zone (its `touchstart` hit-test is skipped entirely, freeing that screen area) and sources `stickX`/`stickY`-equivalent pitch/roll from `DeviceOrientationReader.sample()` instead (section 4.7); the yaw bar, throttle slider and all buttons are unchanged from plain `touch`.

### 4.6 Gamepad mapping

Uses the Gamepad API's `'standard'` mapping. `GamepadReader.poll()` must be called exactly once per `PlayerInputSystem.update()`, before any `axisValue`/`buttonValue`/`buttonDown` call that update (re-reading `navigator.getGamepads()` is what makes the snapshot for that frame; the contract's `poll()` docstring states this ordering requirement explicitly so the implementer cannot call the read methods against a stale frame).

```
rawRoll  = axisValue(axes.roll.axisIndex)  * (axes.roll.invert  ? -1 : 1)   // default index 0, invert=false
rawPitch = axisValue(axes.pitch.axisIndex) * (axes.pitch.invert ? -1 : 1)   // default index 1, invert=false
{x: dzRoll, y: dzPitch} = applyRadialDeadzone(rawRoll, rawPitch, gamepad.deadzone, scratch)
roll  = shapeCurve(dzRoll,  gamepad.stickCurveExponent)
pitch = shapeCurve(dzPitch, gamepad.stickCurveExponent)

rawYaw = axisValue(axes.yaw.axisIndex) * (axes.yaw.invert ? -1 : 1)         // default index 2, invert=false
yaw = shapeCurve(applyLinearDeadzone(rawYaw, gamepad.deadzone), gamepad.yawCurveExponent)

throttleUp   = buttonValue(gamepad.throttleUpButtonIndex)    // default index 7 (right trigger, analog 0..1)
throttleDown = buttonValue(gamepad.throttleDownButtonIndex)  // default index 6 (left trigger, analog 0..1)
throttle = clamp(throttle + (throttleUp - throttleDown) * KEYBOARD_THROTTLE_RAMP_RATE_PER_SEC * dtSec, 0, 1)
```

Throttle deliberately reuses `KEYBOARD_THROTTLE_RAMP_RATE_PER_SEC` (one rate constant for "how fast the throttle lever moves" regardless of input device) and the SAME persisted `throttle` state variable as the keyboard path — only one of the two input paths is consulted per `update()` (whichever `getControlScheme()` currently selects), but the underlying `throttle` accumulator is shared so switching schemes mid-flight does not jump the lever.

Buttons: `buttonDown(index) = buttonValue(index) > GAMEPAD_BUTTON_DIGITAL_THRESHOLD (0.5)`. Default index table in section 5.5.

### 4.7 DeviceOrientation (gyro)

`DeviceOrientationReader` listens for `deviceorientation` events, keeping the latest raw `{beta, gamma}` (degrees, per the DOM spec). `available` becomes `true` on the first real event received (distinguishing "not supported" from "supported but not yet calibrated"). `calibrate()` stores the current raw `{beta, gamma}` as `{betaZero, gammaZero}` and sets `calibrated = true`.

```
sample(out):
  if !calibrated: out.pitchRad = 0; out.rollRad = 0; return out
  dPitch = (beta  - betaZero)  / gyro.maxTiltDeg   // gyro.maxTiltDeg default 35 (deg for full deflection)
  dRoll  = (gamma - gammaZero) / gyro.maxTiltDeg
  dPitch = applyLinearDeadzone(clamp(dPitch, -1, 1), gyro.deadzoneFrac) * (gyro.invertPitch ? -1 : 1)
  dRoll  = applyLinearDeadzone(clamp(dRoll,  -1, 1), gyro.deadzoneFrac) * (gyro.invertRoll  ? -1 : 1)
  out.pitchRad = shapeCurve(dPitch, gyro.curveExponent)   // "Rad" suffix names the PilotInputs field it feeds, not a physical radian angle — it is still a normalized [-1,1] command
  out.rollRad  = shapeCurve(dRoll,  gyro.curveExponent)
  return out
```

`requestPermission()` wraps `(DeviceOrientationEvent as any).requestPermission?.()` (iOS 13+ only; resolves `true` immediately on platforms without this static method) and MUST be invoked from inside a user-gesture handler — this module exposes it on `PlayerInputSystem` precisely so the host application's settings screen can wire a "Enable motion controls" button tap to it (see section 9, this is a module-10-mediated integration point since `src/ui` cannot import `src/input` directly).

Sign convention is fixed by this document (tilting the device so its top edge moves away from the player increases `beta`; tilting its right edge down increases `gamma`, both per the WHATWG DeviceOrientationEvent spec's own definition) but is known to vary in practice across OS/browser/screen-orientation combinations — this is exactly what `invertPitch`/`invertRoll` in `InputMapData.gyro` exist to correct at runtime; see section 9.

### 4.8 Control scheme selection

`InputMapData.controlScheme` is one persisted value, not a per-frame race between devices. First run (no valid persisted `InputMapData`): `detectDefaultControlScheme({maxTouchPoints: navigator.maxTouchPoints}, hasPhysicalKeyboardHint)` picks `'touch'` when `maxTouchPoints > 0 && !hasPhysicalKeyboardHint`, else `'keyboardMouse'` (`hasPhysicalKeyboardHint` is supplied by the caller — module 10/11's job to derive, e.g. from a media query or explicit device class; this module does not compute it itself, it only consumes the boolean, keeping the function pure and testable). Mid-session: `setControlScheme()` is the only way the scheme changes; `PlayerInputSystem` never auto-switches on its own (auto-switching was considered and rejected — see section 9 — in favour of an explicit, testable, single-writer state machine). `src/main.ts` (module 10) is expected to call `setControlScheme('gamepad')` when it observes a `gamepadconnected` event, since Gamepad connection events are not something this module listens for on its own initiative beyond `GamepadReader.poll()`'s per-frame re-read of `navigator.getGamepads()` — polling for `connected` is available via `GamepadReader.connected` for whoever wires this decision.

### 4.9 Rebinding

`startRebind(action, deviceKind)` sets an internal `pendingRebind = {action, deviceKind}` and returns immediately (non-blocking). On every subsequent `update()` while `pendingRebind` is set, BEFORE the normal assembly step, this module scans for a capture event instead of computing `PilotInputs`:

- `deviceKind === 'keyboard'`: iterate a fixed candidate list of ~40 common `KeyboardEvent.code` values (the same universe as `DEFAULT_INPUT_MAP_DATA`'s bindings plus common alternates: letters, arrows, `Space`, `Enter`, `Escape`, `Tab`, `ShiftLeft/Right`, `PageUp/Down`) and take the first whose `keyboardReader.isDown(code)` is `true` this frame that was `false` last frame (tracked via one `EdgeDetector` per candidate, allocated once at `createPlayerInputSystem`, not per rebind).
- `deviceKind === 'gamepad'`: for a `LogicalAxis` target, take the first `axisIndex in 0..7` whose `|gamepadReader.axisValue(axisIndex)| > REBIND_AXIS_THRESHOLD (0.5)`, capturing `{axisIndex, invert: axisValue < 0}` (so pushing the intended "positive" direction during rebind always records `invert` such that the captured direction becomes `+1`); for any other `RebindableAction`, take the first `buttonIndex in 0..16` whose `gamepadReader.buttonValue(buttonIndex) > REBIND_BUTTON_THRESHOLD (0.5)`.

On a capture, the corresponding entry in `inputMap.data` (a shallow-cloned `InputMapData`, then `inputMap.replace(...)`) is overwritten, `pendingRebind` is cleared, and every `onRebindComplete` handler fires once with `{action, deviceKind, binding, cancelled:false}`. `cancelRebind()` clears `pendingRebind` without touching bindings and fires handlers with `cancelled:true`. Rebinding does not auto-save; the caller calls `saveInputMap()` explicitly (so a settings screen can offer Cancel/Apply). Throttle's two gamepad trigger indices and all touch-layout constants are **not** rebindable (no `RebindableAction` covers them) — only keyboard keys, gamepad axes (pitch/roll/yaw only), and gamepad/keyboard button actions are.

### 4.10 Persistence

`loadInputMap(storage)`: reads `storage.getItem(INPUT_MAP_STORAGE_KEY)`; if `null`, returns `DEFAULT_INPUT_MAP_DATA` (a fresh deep clone, never the shared const, so callers can mutate freely). Otherwise calls `parseInputMapData(json)`; on `{ok:false}` (malformed JSON, or `.version !== INPUT_MAP_VERSION`) it likewise returns a fresh clone of `DEFAULT_INPUT_MAP_DATA` — **never throws**, per `00-architecture.md`'s error-handling rule for untrusted data. `saveInputMapData(storage, data)` calls `storage.setItem(INPUT_MAP_STORAGE_KEY, serializeInputMapData(data))`; a `setItem` exception (quota exceeded, private-browsing restrictions) is caught internally and silently ignored — losing a binding customization is not a fatal error, and the contract's `SaveInputMapData` signature returns `void` with no `Result`, so failure has no observable effect beyond the save not sticking. `createPlayerInputSystem` calls `loadInputMap(config.storage ?? config.window.localStorage)` once at construction unless `config.initialInputMapData` is supplied (tests always supply this, to avoid touching real `localStorage`).

### 4.11 Assembly algorithm — `PlayerInputSystem.update(ctx, dtSec, out)`

```
1. dt = clamp(dtSecRaw, 0, INPUT_MAX_DT_SEC)                     // INPUT_MAX_DT_SEC = 0.25
2. if pendingRebind: run 4.9's capture scan; return WITHOUT touching `out` this call
   (the caller is expected to not be flying during a rebind UI flow; `out` simply keeps
   whatever PilotInputs it held from the previous call)
3. if gamepadReader.connected: gamepadReader.poll()
4. scheme = current controlScheme
5. compute (rawPitch, rawRoll, rawYaw, throttle-delta-or-absolute) per 4.2/4.3/4.6/4.5/4.7
   depending on `scheme`, updating persisted ramp/accumulator state as specified there
6. compute the six passthrough booleans (4.4 row 1) by reading `scheme`'s own trigger/
   launch/cycleWeapon/cycleTarget/afterburner/brakes source directly (raw held state)
7. compute the three toggle booleans (4.4 row 2): for each, edgeDetector.risingEdge(rawHeld)
   -> if true, persistedState = !persistedState
8. compute meta actions (4.4 row 3): for each, edgeDetector.risingEdge(rawHeld) -> if true,
   call every handler registered via onMetaAction(action)
9. write out.pitch/out.roll/out.yaw/out.throttle/out.afterburner/out.brakes/out.gearDown/
   out.airbrake/out.trigger/out.launch/out.cycleWeapon/out.cycleTarget/out.nwsEnabled
   from steps 5-7. `out` is the SAME object identity passed in; only its fields are mutated.
```

`ctx` (the `PilotContext`) is read nowhere in this algorithm — see section 9.

## 5. Data

### 5.1 `InputMapData` shape (JSON-serializable; matches `contracts/input.ts` exactly)

```json
{
  "version": 1,
  "controlScheme": "keyboardMouse",
  "keyboard": {
    "axes": {
      "pitch":    { "negative": "KeyW", "positive": "KeyS" },
      "roll":     { "negative": "KeyA", "positive": "KeyD" },
      "yaw":      { "negative": "KeyQ", "positive": "KeyE" },
      "throttle": { "negative": "PageDown", "positive": "PageUp" }
    },
    "buttons": {
      "trigger": "Space", "launch": "Enter", "cycleWeapon": "Tab", "cycleTarget": "KeyT",
      "gearToggle": "KeyG", "airbrakeToggle": "KeyB", "afterburner": "ShiftLeft",
      "brakes": "KeyX", "nwsToggle": "KeyN"
    },
    "meta": { "cameraCycle": "KeyV", "menuToggle": "Escape" }
  },
  "gamepad": {
    "axes": {
      "pitch": { "axisIndex": 1, "invert": false },
      "roll":  { "axisIndex": 0, "invert": false },
      "yaw":   { "axisIndex": 2, "invert": false }
    },
    "throttleUpButtonIndex": 7, "throttleDownButtonIndex": 6,
    "buttons": {
      "trigger": { "buttonIndex": 0 }, "launch": { "buttonIndex": 1 },
      "gearToggle": { "buttonIndex": 2 }, "airbrakeToggle": { "buttonIndex": 3 },
      "brakes": { "buttonIndex": 4 }, "afterburner": { "buttonIndex": 5 },
      "cycleWeapon": { "buttonIndex": 8 }, "cycleTarget": { "buttonIndex": 12 },
      "nwsToggle": { "buttonIndex": 10 }
    },
    "meta": { "cameraCycle": { "buttonIndex": 11 }, "menuToggle": { "buttonIndex": 9 } },
    "deadzone": 0.12, "stickCurveExponent": 1.6, "yawCurveExponent": 1.3
  },
  "mouse": { "enabled": false, "sensitivityPerPx": 0.0022, "curveExponent": 1.4, "recenterRatePerSec": 3.0 },
  "touch": { "stickRadiusPx": 70, "stickDeadzoneFrac": 0.08, "stickCurveExponent": 1.6,
             "yawBarHalfWidthPx": 90, "yawBarDeadzoneFrac": 0.05, "throttleSliderHeightPx": 220 },
  "gyro": { "maxTiltDeg": 35, "deadzoneFrac": 0.05, "curveExponent": 1.0, "invertPitch": false, "invertRoll": false }
}
```

This literal object is `DEFAULT_INPUT_MAP_DATA`.

### 5.2 Default keyboard bindings

| action | key (`KeyboardEvent.code`) | axis direction |
|---|---|---|
| pitch nose up | `KeyS` | positive |
| pitch nose down | `KeyW` | negative |
| roll right | `KeyD` | positive |
| roll left | `KeyA` | negative |
| yaw right | `KeyE` | positive |
| yaw left | `KeyQ` | negative |
| throttle up | `PageUp` | positive |
| throttle down | `PageDown` | negative |
| afterburner (hold) | `ShiftLeft` | — |
| gear toggle | `KeyG` | — |
| airbrake toggle | `KeyB` | — |
| wheel brakes (hold) | `KeyX` | — |
| gun trigger (hold) | `Space` | — |
| missile launch (hold) | `Enter` | — |
| cycle weapon (hold) | `Tab` | — |
| cycle target (hold) | `KeyT` | — |
| NWS toggle | `KeyN` | — |
| camera cycle (meta) | `KeyV` | — |
| menu toggle (meta) | `Escape` | — |

All bound keys' `keydown` events call `preventDefault()` on `config.window` to stop the browser's own handling (`Tab` moving focus, `Space`/`PageUp/Down` scrolling the page) — this is `keyboard.ts`'s job, checked against the CURRENT `InputMapData` (so a rebound key's old default, if no longer bound to anything, stops being intercepted).

### 5.3 Ramp / center-rate constants

| constant | value | units | meaning |
|---|---|---|---|
| `KEYBOARD_AXIS_RAMP_RATE_PER_SEC` | 2.5 | 1/s (of a 2-wide [-1,1] range) | pitch/roll/yaw: 0→±1 in 0.4 s |
| `KEYBOARD_AXIS_CENTER_RATE_PER_SEC` | 4.0 | 1/s | pitch/roll/yaw: ±1→0 in 0.25 s on release |
| `KEYBOARD_THROTTLE_RAMP_RATE_PER_SEC` | 0.5 | 1/s (of a 1-wide [0,1] range) | throttle: 0→1 in 2.0 s; also gamepad-trigger throttle rate (4.6) |
| `INPUT_MAX_DT_SEC` | 0.25 | s | defensive per-call `dtSec` clamp, mirrors the sim's own accumulator clamp (00-architecture.md §4) |

### 5.4 Touch layout constants

| constant | value | units |
|---|---|---|
| `TOUCH_STICK_RADIUS_PX` | 70 | px |
| `TOUCH_STICK_DEADZONE_FRAC` | 0.08 | fraction of radius |
| `TOUCH_YAW_BAR_HALF_WIDTH_PX` | 90 | px |
| `TOUCH_YAW_BAR_DEADZONE_FRAC` | 0.05 | fraction of half-width |
| `TOUCH_THROTTLE_SLIDER_HEIGHT_PX` | 220 | px |
| `TOUCH_THROTTLE_SLIDER_WIDTH_PX` | 48 | px (fixed layout constant, not in `InputMapData`) |
| `TOUCH_BUTTON_SIZE_PX` | 56 | px (combat cluster) |
| `TOUCH_BUTTON_SIZE_SMALL_PX` | 44 | px (utility/meta clusters) |
| `MAX_CONCURRENT_TOUCHES` | 10 | count |

### 5.5 Default gamepad bindings (Standard Gamepad Mapping)

| action | index | button/axis name |
|---|---|---|
| roll | axis 0 | left stick X |
| pitch | axis 1 | left stick Y (no invert: pulling the stick toward the player = positive = nose up) |
| yaw | axis 2 | right stick X |
| throttle up | button 7 | right trigger (analog) |
| throttle down | button 6 | left trigger (analog) |
| trigger (gun) | button 0 | A / Cross |
| launch missile | button 1 | B / Circle |
| gear toggle | button 2 | X / Square |
| airbrake toggle | button 3 | Y / Triangle |
| wheel brakes | button 4 | LB / L1 |
| afterburner | button 5 | RB / R1 |
| cycle weapon | button 8 | Back / Select |
| menu toggle (meta) | button 9 | Start |
| NWS toggle | button 10 | L3 (left stick click) |
| camera cycle (meta) | button 11 | R3 (right stick click) |
| cycle target | button 12 | D-pad up |

`GAMEPAD_BUTTON_DIGITAL_THRESHOLD = 0.5`, `DEFAULT_GAMEPAD_DEADZONE = 0.12`, `DEFAULT_STICK_CURVE_EXPONENT (gamepad.stickCurveExponent default) = 1.6`, `DEFAULT_YAW_CURVE_EXPONENT (gamepad.yawCurveExponent default) = 1.3`, `REBIND_AXIS_THRESHOLD = 0.5`, `REBIND_BUTTON_THRESHOLD = 0.5`.

### 5.6 Persistence constants

`INPUT_MAP_STORAGE_KEY = 'tejas.inputMap.v1'`, `INPUT_MAP_VERSION = 1`.

## 6. Performance budget

- `PlayerInputSystem.update()` runs once per `requestAnimationFrame` (module 10's job to call it; up to ~240 Hz on high-refresh displays) on the **main thread only** — it is never on the sim worker's 120 Hz hot path, so the "no allocation in hot paths" rule from `00-architecture.md` §2 still applies here (a main-thread frame budget is real, especially on the low end of the mobile quality tiers) but is less strict than the worker/render hot paths.
- No `new` inside `update()`, `poll()`, `sample()`, or any of the five shaping-primitive functions. All scratch objects (`{x,y}` pairs for `applyRadialDeadzone`, the `DeviceOrientationSample` passed to `sample()`, the mouse-delta scratch) are allocated once at `createPlayerInputSystem` and reused every call.
- `TouchReader`'s per-slot claim table (`MAX_CONCURRENT_TOUCHES = 10` fixed array, pre-allocated at `attach()`) means `touchstart`/`touchmove`/`touchend` handlers never allocate a `Map` or grow an array — a linear scan of ≤10 slots.
- `GamepadReader.poll()` calling `navigator.getGamepads()` is a browser-internal allocation this module cannot avoid (the spec returns a fresh array each call in most implementations); this is the one accepted exception, called at most once per `update()`.
- `EdgeDetector` instances (3 toggles + 2 meta + up to 17 rebind-candidate keyboard detectors) are all allocated once at construction, never per-frame.
- Touch overlay DOM elements are created once in `TouchReader.attach()` and only have their `style.transform`/`style.opacity` mutated per frame — no per-frame `createElement`/`appendChild`.
- Mobile budget: the touch overlay is ≤ 15 DOM elements total (1 stick + 1 yaw bar + 1 throttle + 4 combat buttons + 5 utility buttons + 2 meta buttons + a couple of visual sub-elements for the stick's knob/base); this is negligible next to the render/terrain budgets in `08-render.md`/`04-terrain.md` and is not gated by quality tier (touch controls render identically on every tier — `QualityTier` never affects `src/input`, per `00-architecture.md` §14).

## 7. Unit tests to write

All under `tests/input/`, mirroring `src/input/<file>.ts`. Files marked "DOM-free" run under plain Node (no `jsdom` needed — they import only `src/input/deadzones.ts` / `src/input/inputMap.ts`'s pure functions).

- `tests/input/deadzones.test.ts` (DOM-free):
  - `applyLinearDeadzone(0.5, 0.1)` → `toBeCloseTo(0.444444, 5)`; `applyLinearDeadzone(0.05, 0.1)` → `toBe(0)`; `applyLinearDeadzone(1.0, 0.1)` → `toBe(1.0)`; `applyLinearDeadzone(-0.5, 0.1)` → `toBeCloseTo(-0.444444, 5)`.
  - `applyRadialDeadzone(0.6, 0.8, 0.2, out)` → `out.x` `toBeCloseTo(0.48, 6)`, `out.y` `toBeCloseTo(0.64, 6)`.
  - `applyRadialDeadzone(0.1, 0.1, 0.2, out)` → `out.x === 0 && out.y === 0`.
  - `shapeCurve(0.5, 2)` → `toBe(0.25)`; `shapeCurve(-0.5, 2)` → `toBe(-0.25)`; `shapeCurve(1, 1.6)` → `toBe(1)`; `shapeCurve(0.5, 1)` → `toBe(0.5)`.
  - `moveTowardZero(1.0, 0.4)` → `toBe(0.6)`; `moveTowardZero(0.3, 0.4)` → `toBe(0)`; `moveTowardZero(-0.5, 0.2)` → `toBeCloseTo(-0.3,6)`.
  - `updateKeyAxis` ramp-up sequence: starting `0`, `positiveHeld=true`, `rampPerSec=2.5`, `centerPerSec=4.0`, `min=-1,max=1,center=0`, four calls with `dt=0.1` → `[0.25, 0.5, 0.75, 1.0]` (assert each); fifth call still `1.0`.
  - `updateKeyAxis` centering sequence continuing from `1.0`, both released, three calls `dt=0.1` → `[0.6, 0.2, 0]` (assert third is exactly `0`, not negative).
  - `updateKeyAxis` throttle-hold: `current=0.6`, both released, `rampPerSec=0.5, centerPerSec=0, min=0,max=1,center=0`, one call `dt=1.0` → `toBe(0.6)` (unchanged — proves the `centerPerSec=0` hold behaviour from §4.2).
  - `createEdgeDetector().risingEdge(...)` fed `[false,true,true,false,true]` → returns `[false,true,false,false,true]`.

- `tests/input/inputMap.test.ts` (DOM-free):
  - `parseInputMapData(JSON.stringify(DEFAULT_INPUT_MAP_DATA))` → `{ok:true, value: <deep-equal to DEFAULT_INPUT_MAP_DATA>}`.
  - `parseInputMapData("not json")` → `{ok:false}`.
  - `parseInputMapData(JSON.stringify({...DEFAULT_INPUT_MAP_DATA, version: 999}))` → `{ok:false}`.
  - `loadInputMap` against a fake `StorageLike` whose `getItem` returns `null` → deep-equals `DEFAULT_INPUT_MAP_DATA`, and mutating the result does not mutate a second `loadInputMap()` call's result (proves it clones, not shares, the default).
  - `loadInputMap` against a fake storage pre-seeded with corrupted JSON → falls back to defaults without throwing.
  - `detectDefaultControlScheme({maxTouchPoints:5}, false)` → `'touch'`; `detectDefaultControlScheme({maxTouchPoints:0}, false)` → `'keyboardMouse'`; `detectDefaultControlScheme({maxTouchPoints:5}, true)` → `'keyboardMouse'`.

- `tests/input/playerPilot.test.ts` (jsdom environment; uses `initialInputMapData` to avoid real storage, and a fake `KeyboardReader`/`GamepadReader` injected — see note below):
  - With `controlScheme:'keyboardMouse'` and a fake `KeyboardReader.isDown('KeyS')` returning `true`: three `update()` calls at `dt=0.1` each produce `out.pitch` `≈ [0.25, 0.5, 0.75]` (within `1e-9`), matching §4.2's table directly.
  - `trigger`/`launch`/`cycleWeapon`/`cycleTarget` pass through raw held state unfiltered: holding the bound key `true` for 3 consecutive `update()` calls yields `out.trigger === true` on all 3 calls (NOT only the first — proves no accidental edge-triggering of a field `core.ts` says the consumer edge-triggers).
  - `gearDown` toggle: bound key held `true` for exactly one `update()` call then released → `out.gearDown` becomes `true` and STAYS `true` across subsequent calls with the key released; a second press/release cycle sets it back to `false`.
  - `onMetaAction('cameraCycle', ...)` fires exactly once across 5 consecutive `update()` calls where the bound key is held for all 5 (not once per call).
  - `startRebind('pitch', 'keyboard')` then simulating `KeyW` newly pressed on the next `update()` → `onRebindComplete` fires with `{action:'pitch', deviceKind:'keyboard', binding:'KeyW', cancelled:false}`, and a subsequent normal `update()` with `KeyW` held drives `pitch` negative (proves the rebind actually took effect, not just that the callback fired).
  - `ctx` is never read: pass a `PilotContext`-shaped object whose every getter throws, call `update(thatObject, 0.1, out)`, assert it does not throw — a direct, mechanical check of the section-9 design decision.

*(Implementation note the module-12 author will need: `playerPilot.test.ts` requires injecting fake device readers rather than real DOM events; `PlayerInputConfig` as specified takes only `window`/`touchOverlayContainer`/`storage`/`initialInputMapData`, all DOM-shaped — under `jsdom`, `window` and a `document.createElement('div')` container are real enough for `KeyboardReader`/`MouseReader` to attach real listeners to, and tests dispatch real synthetic `KeyboardEvent`s at `window` rather than injecting fakes; `GamepadReader` needs `navigator.getGamepads` stubbed on the `jsdom` `window.navigator`, since `jsdom` does not implement the Gamepad API — module 12's test setup stubs `window.navigator.getGamepads = () => [...]` per-test as needed for the gamepad-specific cases.)*

## 8. Acceptance criteria

1. `contracts/input.ts` compiles standalone with `tsc --noEmit --strict` alongside `contracts/core.ts` only (no other contract import) — verified during drafting with `tsc --noEmit --strict --noUncheckedIndexedAccess --lib ES2022,DOM`.
2. `src/input/index.ts` exports `createPlayerInputSystem`, and the object it returns structurally satisfies core.ts's `Pilot` interface (`update(ctx: PilotContext, dtSec: number, out: PilotInputs): void`) — checkable as `const p: Pilot = createPlayerInputSystem(cfg);`.
3. Every `tests/input/*.test.ts` file listed in section 7 exists and passes under `vitest run`.
4. `DEFAULT_INPUT_MAP_DATA` round-trips: `parseInputMapData(serializeInputMapData(DEFAULT_INPUT_MAP_DATA))` is `{ok:true}` and deep-equals `DEFAULT_INPUT_MAP_DATA`.
5. No file under `src/input/` imports anything from `src/math`, `src/physics`, `src/ai`, `src/combat`, `src/terrain`, `src/airport`, `src/render`, `src/hud`, `src/ui`, or `src/core` — grep-checkable (`^import .* from '\.\./(math|physics|ai|combat|terrain|airport|render|hud|ui|core)'` over `src/input/**` must have zero matches), per `00-architecture.md` §10's dependency rule for this module.
6. `PlayerInputSystem.update()` never reads any property of its `ctx` argument — mechanically checked by test 7's "throwing ctx" case.
7. Holding a bound `launch`/`cycleWeapon`/`cycleTarget`/`trigger` control across multiple consecutive `update()` calls yields the same `true` value on every call (no internal edge-triggering of these four fields) — checked by the corresponding test in section 7.
8. `gearDown`/`airbrake`/`nwsEnabled` persist across control-scheme switches: toggle `gearDown` true under `'keyboardMouse'`, call `setControlScheme('gamepad')`, call `update()` with no gamepad input at all — `out.gearDown` is still `true`.
9. `saveInputMap()` followed by a fresh `loadInputMap(sameStorage)` reproduces the saved `InputMapData` exactly (deep equality).
10. `applyLinearDeadzone`, `applyRadialDeadzone`, `shapeCurve`, `moveTowardZero`, `updateKeyAxis` are all pure (no shared mutable module-level state, verified by calling each twice with identical arguments and asserting identical results) and allocate no new object except the required `out` parameter of `applyRadialDeadzone` (which the caller supplies).
11. The touch overlay attached via `TouchReader.attach(container)` creates all DOM elements as descendants of `container` (none attached elsewhere in the document) and `dispose()` removes every one of them plus all event listeners (checkable via `container.children.length === 0` after `dispose()` in a jsdom test, and via a listener-count check module 12's harness performs).

## 9. Open assumptions

- **`Pilot.update()` runs on the main thread, not inside `sim.worker.ts`.** `core.ts` says `src/core` "calls `update` on every Pilot-bearing aircraft entity once per SIM_DT_SEC" and that `src/input`'s `PlayerPilot` implements `Pilot` — read completely literally, this would require calling this module's code from *inside the sim worker*, which is architecturally impossible: keyboard/mouse/Gamepad API/Touch/DeviceOrientation/`localStorage` are main-thread/Window APIs unavailable in a Worker global scope, and `00-architecture.md` §2 explicitly confirms the concurrency model (main thread = "input capture"; sim worker = "physics, AI, combat"). The only mechanism `core.ts` actually provides for main-thread-computed input to reach the sim worker is the already-fixed `SimInputMessage` (`{type:'input', entityId, inputs: PilotInputs}`) in `MainToSimMessage`. I have therefore designed `PlayerInputSystem` to structurally implement `Pilot` (so it is testable and swappable with `AiPilot` in principle) but to be **called by `src/main.ts` on the main thread** once per animation frame, with the resulting `out: PilotInputs` then forwarded verbatim as a `SimInputMessage`. Because `PlayerInputSystem.update()` never reads its `ctx` argument (section 4.11), module 10 does not need to construct a real, worker-quality `PilotContext` for the player on the main thread — any structurally-typed placeholder is safe to pass, which is what makes this design not depend on any unpublished detail of module 10's implementation. This is the single most important cross-module assumption in this spec; if module 10 turns out to expect something different (e.g. a raw-device-state message instead of a full `PilotInputs`), the fix is confined to `src/main.ts` and does not touch this module's contract.
- **Meta actions (`cameraCycle`, `menuToggle`) are consumed by `src/main.ts`, not directly by `src/render`/`src/ui`.** `src/input` cannot import `src/render` or `src/ui` (§10's dependency rule), so `onMetaAction`'s handlers are necessarily registered by whatever module 10 wires — this module only guarantees the callback fires on the correct rising edge, not what happens next.
- **`hasPhysicalKeyboardHint` for `detectDefaultControlScheme` is supplied by the caller.** This module does not itself infer "does this device have a physical keyboard" (there is no reliable browser API for that); module 10/11 is assumed to pass a reasonable heuristic (e.g. a `(pointer: fine)` media query result, or simply `false` on any platform where `maxTouchPoints > 0`). The function's own contract is intentionally narrow (pure, two booleans in, one enum out) so this assumption is cheap to satisfy however the caller chooses.
- **Automatic per-axis device-priority racing was considered and rejected** in favour of one explicit, persisted `controlScheme` (section 4.8). A frame-by-frame "whichever device moved most recently wins, per axis" scheme is common in shipped games but is not exactly reproducible/testable the way this project's determinism and acceptance-test requirements need, and was judged to add cross-device interaction bugs (e.g. idle controller drift stealing control from keyboard) for no benefit this project's control surface needs. If this is wrong for the intended feel, it is a `09-input.md`-only change (the `InputMapData.controlScheme` field and `setControlScheme` already form the seam a future auto-switcher would hook into).
- **DeviceOrientation axis sign convention (section 4.7) is fixed to one reading of the WHATWG spec** and is known to be inconsistent across real devices/browsers/screen orientations. This is mitigated, not eliminated, by the runtime `invertPitch`/`invertRoll` settings and by requiring an explicit `calibrate()` step (which at least fixes the *zero point* correctly regardless of sign) — a genuinely device-correct implementation would need per-device testing this spec cannot perform. Flagged here rather than left as a `TBD`: the formula is exact and testable, its real-world "feel" on a given phone is not guaranteed.
- **No public Tejas-specific input/HOTAS reference exists** (this is a generic-flight-sim control scheme, not modeled on the real Tejas's actual HOTAS layout, which is not publicly documented in enough detail to reproduce). The keyboard/gamepad default bindings in section 5 are this project's own convention, chosen for mnemonic consistency (S=aft=nose up, PageUp/Down for throttle matching common PC flight-sim defaults) rather than drawn from any real-aircraft or real-HOTAS source.
- **Touch overlay visual styling is intentionally minimal** (semi-transparent flat rectangles/circle, no icons/labels beyond what section 5's table implies), matching the whole project's wireframe-placeholder aesthetic (`00-architecture.md`'s wireframe aircraft model) rather than inventing a polished mobile-game HUD style this spec has no authority to standardize for other modules.
