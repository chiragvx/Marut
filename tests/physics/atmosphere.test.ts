import { describe, it, expect } from 'vitest';
import { sampleAtmosphere } from '../../src/physics';
import type { AtmosphereSample } from '../../src/contracts/flight';

function sample(altM: number): AtmosphereSample {
  const out: AtmosphereSample = { densityKgM3: 0, pressurePa: 0, temperatureK: 0, soundSpeedMps: 0 };
  return sampleAtmosphere(altM, out);
}

describe('sampleAtmosphere', () => {
  it('sea level (h=0) matches the ISA reference table', () => {
    const s = sample(0);
    expect(s.densityKgM3).toBeCloseTo(1.225, 3);
    expect(s.temperatureK).toBeCloseTo(288.15, 3);
    expect(s.soundSpeedMps).toBeCloseTo(340.294, 2);
    expect(s.pressurePa).toBeCloseTo(101325.0, 0);
  });

  it('tropopause (h=11000) matches the ISA reference table', () => {
    const s = sample(11000);
    expect(s.densityKgM3).toBeCloseTo(0.36392, 3);
    expect(Math.abs(s.pressurePa - 22632.1)).toBeLessThan(1);
  });

  it('h=20000 matches the ISA reference table', () => {
    const s = sample(20000);
    expect(s.densityKgM3).toBeCloseTo(0.088035, 4);
  });

  it('density decreases monotonically between h=0 and h=11000', () => {
    const s0 = sample(0).densityKgM3;
    const s55 = sample(5500).densityKgM3;
    const s11 = sample(11000).densityKgM3;
    expect(s55).toBeLessThan(s0);
    expect(s55).toBeGreaterThan(s11);
  });

  it('clamps above 20000 m to the 20000 m formula (no third layer)', () => {
    const s20 = sample(20000);
    const s30 = sample(30000);
    expect(s30.densityKgM3).toBeCloseTo(s20.densityKgM3, 6);
    expect(s30.temperatureK).toBeCloseTo(s20.temperatureK, 6);
  });

  it('extrapolates layer 1 unclamped below 0 m', () => {
    const sBelow = sample(-500);
    expect(sBelow.temperatureK).toBeGreaterThan(288.15);
    expect(sBelow.densityKgM3).toBeGreaterThan(1.225);
  });
});
