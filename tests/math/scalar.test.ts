import { describe, it, expect } from 'vitest';
import {
  clamp,
  clamp01,
  inverseLerp,
  smoothstep,
  wrapAngleSigned,
  wrapAngleUnsigned,
  sign,
  lerp,
  degToRad,
  radToDeg,
  approxEqual,
} from '../../src/math';

describe('scalar helpers', () => {
  it('clamp / clamp01', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
  });

  it('lerp', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
  });

  it('inverseLerp', () => {
    expect(inverseLerp(10, 20, 15)).toBe(0.5);
    expect(inverseLerp(10, 20, 5)).toBe(0);
    expect(inverseLerp(10, 10, 5)).toBe(0);
  });

  it('smoothstep', () => {
    expect(smoothstep(0, 10, 5)).toBe(0.5);
    expect(smoothstep(0, 10, 2.5)).toBeCloseTo(0.15625, 9);
    expect(smoothstep(5, 5, 3)).toBe(0);
    expect(smoothstep(5, 5, 7)).toBe(1);
  });

  it('wrapAngleUnsigned / wrapAngleSigned', () => {
    expect(wrapAngleUnsigned(-1)).toBeCloseTo(5.283185307179586, 9);
    expect(wrapAngleSigned(4)).toBeCloseTo(-2.283185307179586, 9);
  });

  it('sign, including -0', () => {
    expect(sign(-0)).toBe(0);
    expect(Object.is(sign(-0), -0)).toBe(false);
    expect(sign(5)).toBe(1);
    expect(sign(-5)).toBe(-1);
    expect(sign(0)).toBe(0);
  });

  it('degToRad / radToDeg round trip', () => {
    expect(degToRad(180)).toBeCloseTo(Math.PI, 9);
    expect(radToDeg(Math.PI)).toBeCloseTo(180, 9);
  });

  it('approxEqual', () => {
    expect(approxEqual(1, 1.0000001)).toBe(true);
    expect(approxEqual(1, 1.1)).toBe(false);
    expect(approxEqual(1, 1.5, 1)).toBe(true);
  });
});
