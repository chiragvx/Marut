/**
 * src/input/deadzones.ts — pure numeric shaping primitives shared by every
 * device reader and by PlayerInputSystem's assembly step. DOM-free;
 * importable under plain Node. See docs/spec/09-input.md section 4.1 for the
 * exact formulas and worked numeric fixtures.
 */

import type {
  ApplyLinearDeadzone,
  ApplyRadialDeadzone,
  ShapeCurve,
  MoveTowardZero,
  UpdateKeyAxis,
  EdgeDetector,
  CreateEdgeDetector,
} from '../contracts/input';

/** sign(x): -1/0/1, with sign(0) === 0 (never -0). */
function signOf(x: number): number {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
}

export const applyLinearDeadzone: ApplyLinearDeadzone = (raw, deadzone) => {
  const s = signOf(raw);
  const m = Math.abs(raw);
  if (m <= deadzone) return 0;
  return (s * (m - deadzone)) / (1 - deadzone);
};

export const applyRadialDeadzone: ApplyRadialDeadzone = (x, y, deadzone, out) => {
  const m = Math.hypot(x, y);
  if (m <= deadzone) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  // NOTE (contract concern): 09-input.md section 4.1's prose formula and
  // contracts/input.ts's JSDoc both give `scale = (m-dz)/(1-dz)/m`, but that
  // formula does NOT reproduce either the worked example directly below it
  // or the mandatory unit test in section 7
  // (applyRadialDeadzone(0.6,0.8,0.2) => (0.48,0.64) — the "/(1-dz)/"
  // formula yields (0.6,0.8) unchanged for that input, since m=1 there).
  // The worked example's own arithmetic ("scale = (1-0.2)/1/1 = 0.8") and
  // the test fixture agree with each other and are reproduced by dropping
  // the (1-deadzone) divisor, which is what this implementation does. See
  // this module's contract-concerns note in the final report.
  const scale = (m - deadzone) / m;
  out.x = x * scale;
  out.y = y * scale;
  return out;
};

export const shapeCurve: ShapeCurve = (normalized, exponent) => {
  return signOf(normalized) * Math.abs(normalized) ** exponent;
};

export const moveTowardZero: MoveTowardZero = (value, maxDelta) => {
  if (value > 0) return Math.max(value - maxDelta, 0);
  if (value < 0) return Math.min(value + maxDelta, 0);
  return 0;
};

export const updateKeyAxis: UpdateKeyAxis = (
  current,
  negativeHeld,
  positiveHeld,
  rampPerSec,
  centerPerSec,
  minValue,
  maxValue,
  centerValue,
  dtSec
) => {
  const target = positiveHeld && !negativeHeld ? maxValue : negativeHeld && !positiveHeld ? minValue : centerValue;
  const rate = positiveHeld !== negativeHeld ? rampPerSec : centerPerSec;
  const maxDelta = rate * dtSec;
  if (current < target) return Math.min(current + maxDelta, target);
  if (current > target) return Math.max(current - maxDelta, target);
  return current;
};

export const createEdgeDetector: CreateEdgeDetector = () => {
  let wasDown = false;
  const detector: EdgeDetector = {
    risingEdge(currentlyDown: boolean): boolean {
      const rising = currentlyDown && !wasDown;
      wasDown = currentlyDown;
      return rising;
    },
    reset(): void {
      wasDown = false;
    },
  };
  return detector;
};
