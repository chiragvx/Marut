import { describe, expect, it } from 'vitest';
import { machConeState, soundSpeedAt } from '../../src/ui/audio/sonicBoom';

describe('sonic boom', () => {
  it('speed of sound falls with altitude to the tropopause', () => {
    expect(soundSpeedAt(0)).toBeCloseTo(340.3, 1);
    expect(soundSpeedAt(11000)).toBeCloseTo(295.1, 0);
    expect(soundSpeedAt(15000)).toBeCloseTo(soundSpeedAt(11000), 6);
  });

  it('no cone below the speed of sound', () => {
    expect(machConeState({ x: -100, y: 0, z: 0 }, { x: 300, y: 0, z: 0 }, 340)).toBe('subsonic');
  });

  it('ahead of the jet and beside it, the cone has not arrived; well behind it, it has', () => {
    const vel = { x: 680, y: 0, z: 0 }; // Mach 2: half-angle 30 deg
    const c = 340;
    // Listener 300 m off the flight path; jet (rel = jet - listener) still 500 m short of abeam.
    expect(machConeState({ x: -500, y: 0, z: 300 }, vel, c)).toBe('outside');
    // Abeam: still outside (the cone trails the jet).
    expect(machConeState({ x: 0, y: 0, z: 300 }, vel, c)).toBe('outside');
    // 300 / tan(30) = 520 m past: on the cone. 450 m past: outside; 600 m past: inside.
    expect(machConeState({ x: 450, y: 0, z: 300 }, vel, c)).toBe('outside');
    expect(machConeState({ x: 600, y: 0, z: 300 }, vel, c)).toBe('inside');
  });
});
