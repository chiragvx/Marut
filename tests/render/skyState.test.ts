/**
 * tests/render/skyState.test.ts — time of day (sun, moon, light, sky) and weather presets/dynamics.
 */
import { describe, expect, test } from 'vitest';
import {
  computeSkyLight,
  createDynamicWeather,
  createSkyLight,
  latitudeFor,
  lerpWeather,
  moonDirAt,
  sunDirAt,
  weatherPreset,
  type Dir3,
} from '../../src/render/skyState';

const elevDeg = (d: Dir3): number => (Math.asin(d.y) * 180) / Math.PI;
const GOA = latitudeFor('coastal');
const ZENITH: [number, number, number] = [0.25, 0.45, 0.66];
const HORIZON: [number, number, number] = [0.77, 0.83, 0.87];

describe('sun and moon', () => {
  test('the sun rises in the east around 07:00 and sets in the west around 18:30 (IST, Goa)', () => {
    const d = { x: 0, y: 0, z: 0 };
    expect(elevDeg(sunDirAt(12.8, GOA, d))).toBeGreaterThan(55);
    expect(elevDeg(sunDirAt(6.8, GOA, d))).toBeLessThan(0);
    expect(elevDeg(sunDirAt(7.4, GOA, d))).toBeGreaterThan(0);
    expect(sunDirAt(8, GOA, d).x).toBeGreaterThan(0.5); // east
    expect(elevDeg(sunDirAt(18.3, GOA, d))).toBeGreaterThan(0);
    expect(elevDeg(sunDirAt(18.8, GOA, d))).toBeLessThan(0);
    expect(sunDirAt(17.5, GOA, d).x).toBeLessThan(-0.5); // west
    // Winter sun: due south of overhead at noon.
    expect(sunDirAt(12.78, GOA, d).z).toBeGreaterThan(0);
  });

  test('the full moon is up at night', () => {
    const d = { x: 0, y: 0, z: 0 };
    expect(elevDeg(moonDirAt(23, GOA, d))).toBeGreaterThan(40);
    expect(elevDeg(moonDirAt(12, GOA, d))).toBeLessThan(0);
  });
});

describe('light and sky', () => {
  const at = (h: number, w = weatherPreset('clear', 'coastal')) => {
    const s = { x: 0, y: 0, z: 0 };
    const m = { x: 0, y: 0, z: 0 };
    return computeSkyLight(sunDirAt(h, GOA, s), moonDirAt(h, GOA, m), ZENITH, HORIZON, w, createSkyLight());
  };
  const lum = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

  test('midday: full sun, blue sky, no stars or lights', () => {
    const l = at(12.5);
    expect(lum(l.keyCol)).toBeGreaterThan(0.55);
    expect(l.stars).toBe(0);
    expect(l.lights).toBe(0);
    l.zenith.forEach((c, i) => expect(c).toBeCloseTo(ZENITH[i]!, 6));
  });

  test('night: dim moonlight from the moon, dark sky, stars and lights on', () => {
    const l = at(23);
    expect(lum(l.keyCol)).toBeLessThan(0.2);
    expect(lum(l.keyCol)).toBeGreaterThan(0.01);
    expect(l.keyDir.y).toBeGreaterThan(0.5); // the moon, high up
    expect(lum(l.zenith)).toBeLessThan(0.03);
    expect(l.stars).toBeGreaterThan(0.9);
    expect(l.lights).toBe(1);
    expect(l.glare).toBe(0);
  });

  test('sunset is warm', () => {
    const l = at(18.3);
    expect(l.keyCol[0]).toBeGreaterThan(l.keyCol[2] * 1.5);
    expect(l.glow[0]).toBeGreaterThan(l.glow[2] * 2);
  });

  test('overcast takes most of the sunlight and greys the sky; fog hides the stars', () => {
    const clear = at(12.5);
    const oc = at(12.5, weatherPreset('overcast', 'coastal'));
    expect(lum(oc.keyCol)).toBeLessThan(lum(clear.keyCol) * 0.3);
    expect(Math.abs(oc.zenith[2] - oc.zenith[0])).toBeLessThan(Math.abs(clear.zenith[2] - clear.zenith[0]) * 0.3);
    expect(oc.glare).toBeLessThan(0.1);
    expect(at(23, weatherPreset('fog', 'farmland')).stars).toBe(0);
  });
});

describe('weather', () => {
  test('presets range from clear to rain', () => {
    expect(weatherPreset('fog', 'farmland').visKm).toBeLessThan(2);
    expect(weatherPreset('rain', 'coastal').rain).toBe(1);
    expect(weatherPreset('off', 'coastal').cumulus).toBe(0);
    const mid = lerpWeather(weatherPreset('fog', 'farmland'), weatherPreset('clear', 'farmland'), 0.5, weatherPreset('clear', 'farmland'));
    expect(mid.visKm).toBeGreaterThan(1);
    expect(mid.visKm).toBeLessThan(35);
  });

  test('dynamic weather changes preset every few minutes, blending smoothly', () => {
    const dyn = createDynamicWeather('farmland', 1234);
    const seen = new Set<string>();
    let prevVis = dyn.current.visKm;
    let maxStep = 0;
    for (let t = 0; t < 3 * 3600; t += 1) {
      const w = dyn.update(1);
      seen.add(dyn.preset);
      maxStep = Math.max(maxStep, Math.abs(Math.log(w.visKm / prevVis)));
      prevVis = w.visKm;
      expect(w.deck).toBeGreaterThanOrEqual(0);
      expect(w.deck).toBeLessThanOrEqual(1);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
    // No jumps: at most a few percent of visibility change per second.
    expect(maxStep).toBeLessThan(0.1);
  });

  test('dynamic weather is repeatable for a seed', () => {
    const a = createDynamicWeather('coastal', 42);
    const b = createDynamicWeather('coastal', 42);
    for (let t = 0; t < 2000; t++) {
      a.update(1);
      b.update(1);
    }
    expect(a.current).toEqual(b.current);
  });
});
