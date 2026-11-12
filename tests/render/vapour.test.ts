import { describe, expect, it } from 'vitest';
import { airHumidity, createVapourDrive, vapourDrive } from '../../src/render/vapour';
import { weatherPreset } from '../../src/render/skyState';

const ID = { x: 0, y: 0, z: 0, w: 1 };
/** Level jet (identity attitude) flying at `speed` with angle of attack `alphaDeg`. */
const vel = (speed: number, alphaDeg: number) => {
  const a = (alphaDeg * Math.PI) / 180;
  return { x: speed * Math.cos(a), y: -speed * Math.sin(a), z: 0 };
};
/** Angle of attack giving load factor n at speed and altitude (the module's lift model). */
function alphaFor(n: number, speed: number, alt: number): number {
  const q = 0.5 * 1.225 * Math.exp(-alt / 8500) * speed * speed;
  return ((n * 11500 * 9.81) / (q * 38.4 * 3.0) * 180) / Math.PI;
}

describe('vapour drive', () => {
  const d = createVapourDrive();
  it('nothing in cruise or on the ground', () => {
    vapourDrive(500, vel(230, alphaFor(1, 230, 500)), ID, 1, false, d);
    expect(d.loadFactor).toBeCloseTo(1, 1);
    expect(d.wing).toBe(0);
    expect(d.tip).toBe(0);
    vapourDrive(0, vel(80, 10), ID, 1, true, d);
    expect(d.wing + d.tip + d.cone).toBe(0);
  });
  it('a hard pull in humid air low down: tip trails first, then the wing', () => {
    vapourDrive(500, vel(230, alphaFor(3.5, 230, 500)), ID, 0.9, false, d);
    expect(d.tip).toBeGreaterThan(d.wing);
    vapourDrive(500, vel(230, alphaFor(6.5, 230, 500)), ID, 0.9, false, d);
    expect(d.wing).toBeGreaterThan(0.8);
    expect(d.tip).toBeGreaterThan(0.9);
  });
  it('dry air needs a much harder pull; high up it fades', () => {
    vapourDrive(500, vel(230, alphaFor(5, 230, 500)), ID, 0.1, false, d);
    expect(d.wing).toBe(0);
    vapourDrive(500, vel(230, alphaFor(5, 230, 500)), ID, 0.9, false, d);
    const low = d.wing;
    vapourDrive(8000, vel(260, alphaFor(5, 260, 8000)), ID, 0.9, false, d);
    expect(d.wing).toBeLessThan(low * 0.3);
  });
  it('the cone only near Mach 1 in humid air', () => {
    for (const [m, on] of [[0.8, false], [0.97, true], [1.2, false]] as const) {
      vapourDrive(300, vel(m * 339.5, 0.5), ID, 0.8, false, d);
      if (on) expect(d.cone).toBeGreaterThan(0.5);
      else expect(d.cone).toBe(0);
    }
    vapourDrive(300, vel(0.97 * 339.5, 0.5), ID, 0.1, false, d);
    expect(d.cone).toBe(0);
  });
});

describe('air humidity', () => {
  it('rises from clear to fog, and the coast is wetter than the plains', () => {
    const clear = airHumidity(weatherPreset('clear', 'farmland'), 'farmland');
    const rain = airHumidity(weatherPreset('rain', 'farmland'), 'farmland');
    const fog = airHumidity(weatherPreset('fog', 'farmland'), 'farmland');
    expect(rain).toBeGreaterThan(clear);
    expect(fog).toBeGreaterThan(0.9);
    expect(airHumidity(weatherPreset('clear', 'coastal'), 'coastal')).toBeGreaterThan(clear);
  });
});
