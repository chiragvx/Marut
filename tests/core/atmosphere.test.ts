import { describe, expect, it } from 'vitest';
import { isaAtmosphere } from '../../src/core/atmosphere';

describe('isaAtmosphere', () => {
  it('sea level', () => {
    const r = isaAtmosphere(0);
    expect(Math.abs(r.airDensityKgM3 - 1.225)).toBeLessThan(0.001);
    expect(Math.abs(r.soundSpeedMps - 340.29)).toBeLessThan(0.01);
  });

  it('tropopause (11000 m)', () => {
    const r = isaAtmosphere(11000);
    expect(Math.abs(r.airDensityKgM3 - 0.363917)).toBeLessThan(0.0005);
    expect(Math.abs(r.soundSpeedMps - 295.069)).toBeLessThan(0.01);
  });

  it('5000 m', () => {
    const r = isaAtmosphere(5000);
    expect(Math.abs(r.airDensityKgM3 - 0.736116)).toBeLessThan(0.001);
  });
});
