import { describe, expect, it } from 'vitest';
import { noseSteerTarget, oleoTarget, OLEO_COMPRESS_M, OLEO_EXTEND_M } from '../../src/render/meshAircraftRenderer';
import { blurScale } from '../../src/render/motionBlur';

describe('nose wheel steering', () => {
  it('follows the rudder on the ground with the gear down, full authority at taxi speed', () => {
    expect(noseSteerTarget(0.349066, 3, true, 1)).toBeCloseTo(0.5236, 3);
    expect(noseSteerTarget(-0.349066, 3, true, 1)).toBeCloseTo(-0.5236, 3);
  });
  it('loses authority with speed', () => {
    const slow = noseSteerTarget(0.349066, 3, true, 1);
    const fast = noseSteerTarget(0.349066, 60, true, 1);
    expect(fast).toBeGreaterThan(0);
    expect(fast).toBeLessThan(slow * 0.3);
  });
  it('is centred in the air and while the gear moves', () => {
    expect(noseSteerTarget(0.3, 3, false, 1)).toBe(0);
    expect(noseSteerTarget(0.3, 3, true, 0.5)).toBe(0);
  });
});

describe('oleo', () => {
  it('hangs fully extended in the air and with the gear moving', () => {
    expect(oleoTarget(10, 0, false, 1)).toBe(-OLEO_EXTEND_M);
    expect(oleoTarget(-1, 0, true, 0.5)).toBe(-OLEO_EXTEND_M);
  });
  it('compresses to put the tyre on the ground, within its stroke', () => {
    expect(oleoTarget(-0.05, 0, true, 1)).toBeCloseTo(0.05, 6);
    expect(oleoTarget(-1, 0, true, 1)).toBe(OLEO_COMPRESS_M);
  });
  it('sits in the modelled pose on the ground when no ground height is known', () => {
    expect(oleoTarget(0, undefined, true, 1)).toBe(0);
  });
});

describe('camera-turn motion blur', () => {
  it('is off for gentle turns, view cuts and strength 0', () => {
    expect(blurScale((10 * Math.PI) / 180 / 60, 1 / 60, 1)).toBe(0); // 10 deg/s
    expect(blurScale(1.0, 1 / 60, 1)).toBe(0); // a cut
    expect(blurScale(0.05, 1 / 60, 0)).toBe(0);
  });
  it('grows with the turn rate and does not depend on the frame rate', () => {
    const rate = 3; // rad/s
    const at60 = blurScale(rate / 60, 1 / 60, 1) * (rate / 60);
    const at30 = blurScale(rate / 30, 1 / 30, 1) * (rate / 30);
    expect(at60).toBeGreaterThan(0);
    expect(at30).toBeCloseTo(at60, 9);
    expect(blurScale(5 / 60, 1 / 60, 1) * (5 / 60)).toBeGreaterThan(at60);
  });
});
