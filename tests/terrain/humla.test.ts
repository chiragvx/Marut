/**
 * tests/terrain/humla.test.ts — the Humla Karnali round Simikot (src/terrain/himalaya/humla.ts):
 * Simikot's strip on a broad, gently sloping terrace; the river a long way below it; a valley, not
 * a slot gorge, from Hilsa down past Simikot; and the height function deterministic (the main
 * thread, the sim worker and the terrain worker each import their own copy).
 */
import { describe, expect, test, vi } from 'vitest';
import { heightAt } from '../../src/terrain/himalaya/height';
import { AIRFIELDS, HUMLA_RIVER, SIMIKOT_SHELF, geo } from '../../src/terrain/himalaya/layout';

const simikot = AIRFIELDS.find((a) => a.id === 'simikot')!;
const [sx, sz] = geo(simikot.lat, simikot.lon);
const th = (simikot.headingDeg * Math.PI) / 180;
const ax = Math.sin(th), az = -Math.cos(th); // along the runway (east-south-east)
const rx = Math.cos(th), rz = Math.sin(th); // to its right (south-south-west)
/** World point `a` m along the runway from its middle and `c` m to its right (south). */
const at = (a: number, c: number): [number, number] => [sx + ax * a + rx * c, sz + az * a + rz * c];

/** The river's points (map nodes) in world coordinates. */
const river = HUMLA_RIVER.nodes.map((n) => ({ ...n, w: geo(n.lat, n.lon) }));

describe('Simikot on its terrace', () => {
  test('the strip is at the field elevation (2,971 m, CAAN AIP), end to end', () => {
    expect(simikot.elev).toBe(2971);
    expect(simikot.lengthM).toBe(650);
    expect(simikot.widthM).toBe(20);
    for (let a = -325; a <= 325; a += 25) for (const c of [-10, 0, 10]) expect(Math.abs(heightAt(...at(a, c)) - 2971)).toBeLessThan(0.01);
  });

  test('the terrace round it is broad and gently sloping: ~2.4 km by ~0.8 km of ground under 10% (the graded field banks under 25%)', () => {
    const grades: number[] = [];
    let lo = Infinity, hi = -Infinity;
    for (let a = -1200; a <= 1200; a += 100) {
      for (let c = -450; c <= 350; c += 50) {
        const [x, z] = at(a, c);
        const h = heightAt(x, z);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
        grades.push(Math.hypot(heightAt(x + 25, z) - heightAt(x - 25, z), heightAt(x, z + 25) - heightAt(x, z - 25)) / 50);
      }
    }
    grades.sort((p, q) => p - q);
    expect(grades[Math.floor(grades.length * 0.9)]!).toBeLessThan(0.1);
    expect(grades[grades.length - 1]!).toBeLessThan(0.25);
    // The whole terrace within ~±70 m of the strip: one shelf, not a ledge cut into a slope.
    expect(hi - 2971).toBeLessThan(70);
    expect(2971 - lo).toBeLessThan(70);
    expect(SIMIKOT_SHELF.alongM * 2).toBeGreaterThanOrEqual(3000);
  });

  test('the ground rises behind it (north) to ridges and falls in front (south) to the river', () => {
    const north = Math.max(...[3000, 4000, 5000, 6000].map((c) => heightAt(...at(0, -c))));
    expect(north).toBeGreaterThan(3900);
    let bed = Infinity, bedC = 0;
    for (let c = 0; c <= 4000; c += 25) {
      const h = heightAt(...at(0, c));
      if (h < bed) { bed = h; bedC = c; }
    }
    // The Karnali 550-800 m below the strip, 1.5-3 km away: a deep valley under a high terrace.
    expect(2971 - bed).toBeGreaterThan(550);
    expect(2971 - bed).toBeLessThan(800);
    expect(bedC).toBeGreaterThan(1500);
    expect(bedC).toBeLessThan(3000);
  });
});

describe('the Humla Karnali is a valley, not a slot gorge', () => {
  /** Width of the valley `aboveM` over the river bed at river node `i` (across the local course), m. */
  function widthAbove(i: number, aboveM: number): { width: number; bed: number } {
    const p = river[i]!, q = river[i + 1] ?? river[i - 1]!;
    const dx = q.w[0] - p.w[0], dz = q.w[1] - p.w[1];
    const l = Math.hypot(dx, dz);
    const nx = -dz / l, nz = dx / l;
    // The bed: the lowest point within 600 m across.
    let bed = Infinity, b0 = 0;
    for (let o = -600; o <= 600; o += 10) {
      const h = heightAt(p.w[0] + nx * o, p.w[1] + nz * o);
      if (h < bed) { bed = h; b0 = o; }
    }
    const edge = (sgn: number): number => {
      for (let o = 0; o <= 8000; o += 20) if (heightAt(p.w[0] + nx * (b0 + sgn * o), p.w[1] + nz * (b0 + sgn * o)) > bed + aboveM) return o;
      return 8000;
    };
    return { width: edge(1) + edge(-1), bed };
  }

  test('from Hilsa down past Simikot: 300 m above the river the valley is over 1 km wide, 600 m above over 2 km (a slot gorge: a few hundred metres)', () => {
    const hilsa = river.findIndex((n) => Math.abs(n.lat - 30.152) < 1e-6);
    const below = river.findIndex((n) => n.lat < 29.9);
    expect(hilsa).toBeGreaterThan(0);
    for (let i = hilsa; i <= below; i++) {
      const w300 = widthAbove(i, 300), w600 = widthAbove(i, 600);
      expect(w300.width, `node ${i} (${river[i]!.lat}, ${river[i]!.lon})`).toBeGreaterThan(1000);
      expect(w600.width, `node ${i}`).toBeGreaterThan(2000);
    }
  });

  test('the river falls steadily from Hilsa (~3,650 m) to below Simikot (~2,300 m)', () => {
    const beds = river.map((_, i) => widthAbove(Math.min(i, river.length - 2), 0).bed);
    const hilsa = river.findIndex((n) => Math.abs(n.lat - 30.152) < 1e-6);
    expect(Math.abs(beds[hilsa]! - 3650)).toBeLessThan(60);
    for (let i = hilsa + 1; i < river.length; i++) expect(beds[i]!).toBeLessThan(beds[i - 1]! + 15);
    const nearSimikot = river.reduce((b, n, i) => (Math.hypot(n.w[0] - sx, n.w[1] - sz) < Math.hypot(river[b]!.w[0] - sx, river[b]!.w[1] - sz) ? i : b), 0);
    expect(beds[nearSimikot]!).toBeLessThan(2400);
  });
});

describe('determinism', () => {
  test('a fresh copy of the module (another worker) gives bit-identical heights', async () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 300; i++) pts.push([sx - 30000 + ((i * 7919) % 60000), sz - 30000 + ((i * 104729) % 60000)]);
    for (let a = -2000; a <= 2000; a += 400) pts.push(at(a, 300));
    const first = pts.map(([x, z]) => heightAt(x, z));
    vi.resetModules();
    const fresh = await import('../../src/terrain/himalaya/height');
    expect(fresh.heightAt).not.toBe(heightAt);
    // Evaluated in another order, too (no hidden state between calls).
    const again = pts.slice().reverse().map(([x, z]) => fresh.heightAt(x, z)).reverse();
    expect(again).toEqual(first);
  });
});
