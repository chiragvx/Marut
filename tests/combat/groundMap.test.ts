/**
 * tests/combat/groundMap.test.ts — the ground-map radar: it shows the targets ahead within the range
 * their return is seen at and in line of sight (nearest first), and the target key steps the
 * designated point through the briefed aim points and then the contacts, wrapping round.
 */
import { describe, expect, it } from 'vitest';
import { createGroundMapState, createWeaponsState, designatedMapIndex, loadBriefedTarget, stepGroundDesignation, updateGroundMap } from '../../src/combat';
import { GroundMapKind, MAX_GROUND_CONTACTS, type HeightSampler } from '../../src/contracts/core';
import type { GroundMapCandidate } from '../../src/contracts/combat';

const flat = (h = 0): HeightSampler => ({ seed: 0, heightAt: () => h, normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o) });
/** A 600 m ridge across the track (north of the aircraft) between z = -10.2 km and -9.8 km. */
const RIDGE: HeightSampler = { seed: 0, heightAt: (_x, z) => (z < -9800 && z > -10200 ? 600 : 0), normalAt: (_x, _z, o) => ((o.x = 0), (o.y = 1), (o.z = 0), o) };
const OWN = { x: 0, y: 1000, z: 0 };
const NORTH = 0;

const cand = (key: number, x: number, z: number, rcsM2 = 20, kind: number = GroundMapKind.Vehicle, group = key): GroundMapCandidate => ({ key, group, x, y: 0, z, rcsM2, kind });

function sweep(cands: GroundMapCandidate[], sampler = flat()) {
  const map = createGroundMapState();
  updateGroundMap(map, OWN, NORTH, cands, cands.length, sampler, 0);
  return map;
}

describe('ground map', () => {
  it('shows what is ahead and in range, nearest first; not what is behind or too small for its range', () => {
    const map = sweep([cand(1, 0, -20000), cand(2, 0, -5000), cand(3, 0, 8000), cand(4, 30000, -1000), cand(5, 0, -16000, 1), cand(6, 0, -12000, 1)]);
    expect(map.contacts.slice(0, map.count).map((c) => c.key)).toEqual([2, 6, 1]);
  });

  it('lists the nearest unit of each group first, so a convoy does not crowd out the other targets', () => {
    const convoy = Array.from({ length: 20 }, (_, i) => cand(100 + i, i * 20, -6000 - i * 20, 20, GroundMapKind.Vehicle, 1));
    const map = sweep([...convoy, cand(7, 0, -11000, 100, GroundMapKind.Structure, 2), cand(8, 0, -9000, 30, GroundMapKind.AirDefence, 3)]);
    expect(map.count).toBe(MAX_GROUND_CONTACTS);
    expect(map.contacts.slice(0, 4).map((c) => c.key)).toEqual([100, 8, 7, 101]);
  });

  it('does not show a target hidden behind a ridge', () => {
    const map = sweep([cand(1, 0, -12000), cand(2, 0, -6000)], RIDGE);
    expect(map.contacts.slice(0, map.count).map((c) => c.key)).toEqual([2]);
  });

  it('keeps room for the briefed aim points', () => {
    const cands = Array.from({ length: 30 }, (_, i) => cand(i, 0, -2000 - i * 100));
    const map = createGroundMapState();
    map.briefed = [{ x: 0, y: 0, z: -9000 }, { x: 50, y: 0, z: -9000 }];
    updateGroundMap(map, OWN, NORTH, cands, cands.length, flat(), 0);
    expect(map.count).toBe(MAX_GROUND_CONTACTS - 2);
  });

  it('the target key steps through the briefed points, then the contacts, and wraps round', () => {
    const st = createWeaponsState({ stations: [] }, 1);
    st.groundMap = createGroundMapState();
    loadBriefedTarget(st, [{ x: 0, y: 0, z: -9000 }]);
    st.groundMap.briefed = st.briefed!.points;
    updateGroundMap(st.groundMap, OWN, NORTH, [cand(7, 100, -4000), cand(8, -100, -6000)], 2, flat(), 0);
    expect(designatedMapIndex(st)).toBe(0);
    const seen: { x: number; z: number }[] = [];
    for (let i = 0; i < 4; i++) {
      expect(stepGroundDesignation(st)).toBe(true);
      seen.push({ x: st.spi.x, z: st.spi.z });
    }
    expect(seen).toEqual([{ x: 100, z: -4000 }, { x: -100, z: -6000 }, { x: 0, z: -9000 }, { x: 100, z: -4000 }]);
    // Back on the briefed point it is the briefed target again (the GPS weapons step through it).
    stepGroundDesignation(st);
    stepGroundDesignation(st);
    expect(st.briefed?.next).toBe(0);
  });

  it('with nothing on the map the target key does nothing', () => {
    const st = createWeaponsState({ stations: [] }, 1);
    st.groundMap = createGroundMapState();
    expect(stepGroundDesignation(st)).toBe(false);
    expect(st.spiValid).toBe(false);
  });
});
