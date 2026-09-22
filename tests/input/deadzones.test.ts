import { describe, it, expect } from 'vitest';
import {
  applyLinearDeadzone,
  applyRadialDeadzone,
  shapeCurve,
  moveTowardZero,
  updateKeyAxis,
  createEdgeDetector,
} from '../../src/input/deadzones';

describe('applyLinearDeadzone', () => {
  it('rescales values outside the dead zone and preserves endpoints', () => {
    expect(applyLinearDeadzone(0.5, 0.1)).toBeCloseTo(0.444444, 5);
    expect(applyLinearDeadzone(0.05, 0.1)).toBe(0);
    expect(applyLinearDeadzone(1.0, 0.1)).toBe(1.0);
    expect(applyLinearDeadzone(-0.5, 0.1)).toBeCloseTo(-0.444444, 5);
  });
});

describe('applyRadialDeadzone', () => {
  it('rescales a 3-4-5 vector outside the dead zone', () => {
    const out = { x: 0, y: 0 };
    applyRadialDeadzone(0.6, 0.8, 0.2, out);
    expect(out.x).toBeCloseTo(0.48, 6);
    expect(out.y).toBeCloseTo(0.64, 6);
  });

  it('zeroes a vector inside the dead zone', () => {
    const out = { x: 1, y: 1 };
    applyRadialDeadzone(0.1, 0.1, 0.2, out);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });
});

describe('shapeCurve', () => {
  it('applies sign(n) * |n|^exponent', () => {
    expect(shapeCurve(0.5, 2)).toBe(0.25);
    expect(shapeCurve(-0.5, 2)).toBe(-0.25);
    expect(shapeCurve(1, 1.6)).toBe(1);
    expect(shapeCurve(0.5, 1)).toBe(0.5);
  });
});

describe('moveTowardZero', () => {
  it('moves toward zero without overshooting', () => {
    expect(moveTowardZero(1.0, 0.4)).toBe(0.6);
    expect(moveTowardZero(0.3, 0.4)).toBe(0);
    expect(moveTowardZero(-0.5, 0.2)).toBeCloseTo(-0.3, 6);
  });
});

describe('updateKeyAxis', () => {
  it('ramps up toward maxValue at rampPerSec, then clamps', () => {
    let v = 0;
    const expected = [0.25, 0.5, 0.75, 1.0];
    for (const e of expected) {
      v = updateKeyAxis(v, false, true, 2.5, 4.0, -1, 1, 0, 0.1);
      expect(v).toBeCloseTo(e, 9);
    }
    v = updateKeyAxis(v, false, true, 2.5, 4.0, -1, 1, 0, 0.1);
    expect(v).toBe(1.0);
  });

  it('centers at centerPerSec when released, never overshooting past center', () => {
    let v = 1.0;
    const expected = [0.6, 0.2, 0];
    for (const e of expected) {
      v = updateKeyAxis(v, false, false, 2.5, 4.0, -1, 1, 0, 0.1);
      expect(v).toBeCloseTo(e, 9);
    }
  });

  it('holds its value when centerPerSec is 0 (throttle-style)', () => {
    const v = updateKeyAxis(0.6, false, false, 0.5, 0, 0, 1, 0, 1.0);
    expect(v).toBe(0.6);
  });
});

describe('createEdgeDetector', () => {
  it('fires only on the false->true transition', () => {
    const detector = createEdgeDetector();
    const sequence = [false, true, true, false, true];
    const results = sequence.map((down) => detector.risingEdge(down));
    expect(results).toEqual([false, true, false, false, true]);
  });

  it('reset() clears the internal held state', () => {
    const detector = createEdgeDetector();
    expect(detector.risingEdge(true)).toBe(true);
    detector.reset();
    expect(detector.risingEdge(true)).toBe(true);
  });
});
