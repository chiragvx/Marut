import { describe, expect, it } from 'vitest';
import { GCAS_WARN_CLEARANCE_M, gcasClearanceM } from '../../src/core/gcas';
import { GCAS_NO_THREAT_M, type HeightSampler } from '../../src/contracts/core';

const flat = (h: number): HeightSampler => ({ seed: 0, heightAt: () => h, normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o) });
/** Flat at 0, then a ridge rising to 600 m 3-4 km north (-z). */
const ridge: HeightSampler = {
  seed: 0,
  heightAt: (_x, z) => (z < -3000 ? Math.min(600, (-z - 3000) * 0.6) : 0),
  normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o),
};
const dive = (deg: number, v: number): { x: number; y: number; z: number } => ({ x: 0, y: -Math.sin((deg * Math.PI) / 180) * v, z: -Math.cos((deg * Math.PI) / 180) * v });

describe('ground-collision warning', () => {
  it('stays quiet in level flight at low level and high up', () => {
    expect(gcasClearanceM({ x: 0, y: 60, z: 0 }, dive(0, 230), 0, flat(0))).toBeGreaterThan(GCAS_WARN_CLEARANCE_M);
    expect(gcasClearanceM({ x: 0, y: 9000, z: 0 }, dive(0, 250), 0, flat(0))).toBe(GCAS_NO_THREAT_M);
  });

  it('warns in a steep dive close to the ground, not in the same dive high up', () => {
    // A 5 g recovery from a 45 deg dive at 250 m/s takes ~550 m.
    expect(gcasClearanceM({ x: 0, y: 500, z: 0 }, dive(45, 250), 0, flat(0))).toBeLessThan(GCAS_WARN_CLEARANCE_M);
    expect(gcasClearanceM({ x: 0, y: 4000, z: 0 }, dive(45, 250), 0, flat(0))).toBeGreaterThan(GCAS_WARN_CLEARANCE_M);
  });

  it('a bank to roll out of costs height: inverted warns earlier than wings level', () => {
    const level = gcasClearanceM({ x: 0, y: 1500, z: 0 }, dive(30, 250), 0, flat(0));
    const inverted = gcasClearanceM({ x: 0, y: 1500, z: 0 }, dive(30, 250), Math.PI, flat(0));
    expect(inverted).toBeLessThan(level - 50);
  });

  it('warns of a ridge ahead in level flight only when a pull-up into a climb would no longer clear it', () => {
    expect(gcasClearanceM({ x: 0, y: 150, z: -2500 }, dive(0, 230), 0, ridge)).toBeLessThan(GCAS_WARN_CLEARANCE_M);
    expect(gcasClearanceM({ x: 0, y: 150, z: -1500 }, dive(0, 230), 0, ridge)).toBeGreaterThan(GCAS_WARN_CLEARANCE_M);
    expect(gcasClearanceM({ x: 0, y: 150, z: 20000 }, dive(0, 230), 0, ridge)).toBeGreaterThan(GCAS_WARN_CLEARANCE_M);
  });
});
