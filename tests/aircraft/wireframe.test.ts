import { describe, it, expect } from 'vitest';
import { tejasDefinition } from '../../src/aircraft';

const CONTROL_GROUP_NAMES = ['elevonL', 'elevonR', 'rudder', 'noseGear', 'mainGearL', 'mainGearR'];

describe('tejasWireframe', () => {
  const wf = tejasDefinition.wireframe;

  it('every edge index pair references a valid vertex', () => {
    for (const [a, b] of wf.edges) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(wf.vertices.length);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(wf.vertices.length);
    }
  });

  it('every group vertexIndices entry references a valid vertex', () => {
    for (const group of wf.groups) {
      for (const idx of group.vertexIndices) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(wf.vertices.length);
      }
    }
  });

  it('all six control group names appear exactly once each', () => {
    const names = wf.groups.map((g) => g.name);
    for (const required of CONTROL_GROUP_NAMES) {
      expect(names.filter((n) => n === required).length).toBe(1);
    }
  });

  it('no group name outside the six control names, and no case-insensitive collision', () => {
    const seenLower = new Map<string, string>();
    for (const group of wf.groups) {
      expect(CONTROL_GROUP_NAMES).toContain(group.name);
      const lower = group.name.toLowerCase();
      if (seenLower.has(lower)) {
        expect(seenLower.get(lower)).toBe(group.name);
      }
      seenLower.set(lower, group.name);
    }
  });
});
