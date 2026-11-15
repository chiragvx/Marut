/**
 * tests/briefing/briefing.test.ts — campaigns (grouping, order, unlocking), the mission intros'
 * scripts (every beat valid, every line recorded, lines not talking over each other), and the
 * war-room table map (built from the game's terrain, with no boundary of any kind on it).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { CAMPAIGNS, HIMALAYA_CAMPAIGN, campaignMissionIds, campaignMissionOpen, campaignOf, campaignSlotStates, type Campaign } from '../../src/core/missions/campaigns';
import { MISSIONS, PLAYABLE_MISSIONS } from '../../src/core/missions/catalogue';
import { isBuiltinMissionId } from '../../src/core/missions/index';
import { BRIEFINGS, briefingFor } from '../../src/briefing';
import BRIEFING_LINES from '../../src/briefing/lines.json';
import { BRIEFING_LINE_IDS, scriptLineIds, validateBriefingScript, type BriefingScript } from '../../src/briefing/script';
import { MAP_LINE_KINDS, PLACES, buildMapGrid, gridHeightAt, worldOf } from '../../src/briefing/mapData';
import { createTableMap } from '../../src/briefing/tableMap';
import { createRoom } from '../../src/briefing/room';
import { heightAt, waterLevelAt } from '../../src/terrain/himalaya/height';

const AUDIO_DIR = 'public/audio/briefing';

/**
 * Length of an MP3 (MPEG-1/2 Layer III, constant bit rate) from its size and its first frame's bit
 * rate: enough to check the script leaves each line room (a replacement recording too long for its
 * slot fails here, naming the line).
 */
function mp3Seconds(path: string): number {
  const b = readFileSync(path);
  let i = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) i = 10 + (((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f));
  while (i < b.length - 4 && !(b[i] === 0xff && (b[i + 1]! & 0xe0) === 0xe0)) i++;
  const mpeg1 = (b[i + 1]! & 0x18) === 0x18;
  const idx = b[i + 2]! >> 4;
  const kbps = (mpeg1 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[idx] ?? 0;
  return ((b.length - i) * 8) / (kbps * 1000);
}

describe('campaigns', () => {
  it('Operation Him Setu holds the six-mission Himalaya arc, Simikot Lifeline in slot 2', () => {
    expect(HIMALAYA_CAMPAIGN.slots.map((s) => s.title)).toEqual(['First Lift', 'Simikot Lifeline', 'Lipulekh Watch', 'Kailash Sweep', 'Lights Out', 'Taxiway']);
    expect(HIMALAYA_CAMPAIGN.slots.map((s) => s.slot)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(campaignOf('himalaya-airdrop')?.slot.slot).toBe(2);
    for (const s of HIMALAYA_CAMPAIGN.slots) expect(s.teaser.length).toBeGreaterThan(10);
  });

  it('holds only missions that exist, each once; Free Flight stays out', () => {
    const ids = campaignMissionIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(isBuiltinMissionId(id)).toBe(true);
      expect(MISSIONS.some((m) => m.id === id)).toBe(true);
    }
    for (const id of ['himalaya-free', 'himalaya-ngari', 'himalaya-simikot']) expect(campaignOf(id)).toBeUndefined();
    // The border and Konkan missions are in no campaign.
    for (const m of MISSIONS.filter((x) => x.baseId === 'bathinda' || x.baseId === 'hansa')) expect(campaignOf(m.id)).toBeUndefined();
  });

  it('with one mission built it is simply open; the rest are coming soon', () => {
    expect(campaignSlotStates(HIMALAYA_CAMPAIGN, {})).toEqual(['soon', 'open', 'soon', 'soon', 'soon', 'soon']);
    expect(campaignMissionOpen('himalaya-airdrop', {}, (id) => PLAYABLE_MISSIONS.includes(id))).toBe(true);
  });

  it('built missions unlock in order, each when every built one before it is done', () => {
    const c: Campaign = {
      ...HIMALAYA_CAMPAIGN,
      slots: [
        { slot: 1, title: 'A', teaser: 'a', aircraft: 'C-17', missionId: 'border-duel' },
        { slot: 2, title: 'B', teaser: 'b', aircraft: 'C-17' },
        { slot: 3, title: 'C', teaser: 'c', aircraft: 'C-17', missionId: 'border-strike' },
        { slot: 4, title: 'D', teaser: 'd', aircraft: 'C-17', missionId: 'himalaya-airdrop' },
      ],
    };
    expect(campaignSlotStates(c, {})).toEqual(['open', 'soon', 'locked', 'locked']);
    expect(campaignSlotStates(c, { 'border-duel': { completed: true } })).toEqual(['open', 'soon', 'open', 'locked']);
    expect(campaignSlotStates(c, { 'border-duel': { completed: true }, 'border-strike': { completed: true } })).toEqual(['open', 'soon', 'open', 'open']);
    // A built mission this build does not open shows locked.
    expect(campaignSlotStates(c, {}, (id) => id !== 'border-duel')).toEqual(['locked', 'soon', 'locked', 'locked']);
  });

  it('every campaign has a name and a story line', () => {
    for (const c of CAMPAIGNS) {
      expect(c.name).toMatch(/^Operation /);
      expect(c.blurb.length).toBeGreaterThan(20);
    }
  });
});

describe('mission intro scripts', () => {
  it('every campaign mission with an intro has a valid script', () => {
    expect(briefingFor('himalaya-airdrop')).toBeDefined();
    for (const s of BRIEFINGS) {
      expect(validateBriefingScript(s)).toEqual([]);
      expect(campaignOf(s.missionId)).toBeDefined();
    }
  });

  it('beats are in time order, start with a shot, and run 45-75 s', () => {
    for (const s of BRIEFINGS) {
      const ts = s.beats.map((b) => b.t);
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
      expect(s.beats[0]).toMatchObject({ t: 0, kind: 'shot' });
      expect(s.durationSec).toBeGreaterThanOrEqual(45);
      expect(s.durationSec).toBeLessThanOrEqual(75);
    }
  });

  it('every line it says is in the lines table and has its recording (public/audio/briefing/<id>.mp3)', () => {
    for (const s of BRIEFINGS) {
      for (const id of scriptLineIds(s)) {
        expect(BRIEFING_LINE_IDS).toContain(id);
        expect(existsSync(`${AUDIO_DIR}/${id}.mp3`), `${id}.mp3`).toBe(true);
        expect(readFileSync(`${AUDIO_DIR}/${id}.mp3`).length).toBeGreaterThan(2000);
      }
    }
    // Every line in the table belongs to an intro (no orphan recordings to keep in step).
    const said = new Set(BRIEFINGS.flatMap(scriptLineIds));
    for (const id of Object.keys(BRIEFING_LINES)) expect(said.has(id as never), id).toBe(true);
    // Ids are br_<intro>_<nn>: the radio's ids never collide with them.
    for (const id of Object.keys(BRIEFING_LINES)) expect(id).toMatch(/^br_[a-z]+_\d\d$/);
  });

  it('each line finishes before the next starts, and the last before the end', () => {
    for (const s of BRIEFINGS) {
      const lines = s.beats.filter((b) => b.kind === 'line');
      lines.forEach((b, i) => {
        if (b.kind !== 'line') return;
        const len = mp3Seconds(`${AUDIO_DIR}/${b.id}.mp3`);
        expect(len, `${b.id} length`).toBeGreaterThan(1);
        expect(len, `${b.id} length`).toBeLessThan(20);
        const end = b.t + len;
        const next = lines[i + 1];
        expect(end, `${b.id} runs into the next line`).toBeLessThanOrEqual((next ? next.t : s.durationSec) + 0.25);
      });
    }
  });

  it('the validator catches a broken script', () => {
    const bad: BriefingScript = {
      id: 'bad',
      missionId: 'himalaya-airdrop',
      durationSec: 50,
      beats: [
        { t: 1, kind: 'line', id: 'br_nope_01' as never, subtitle: 'x' },
        { t: 0.5, kind: 'pin', at: 'atlantis' },
        { t: 2, kind: 'arrow', side: 'hostile', dur: 0, path: ['hilsa'] },
        { t: 60, kind: 'sting' },
      ],
    };
    const errs = validateBriefingScript(bad).join('\n');
    expect(errs).toMatch(/no line 'br_nope_01'/);
    expect(errs).toMatch(/unknown place 'atlantis'/);
    expect(errs).toMatch(/before the beat ahead of it/);
    expect(errs).toMatch(/two points/);
    expect(errs).toMatch(/after the end/);
    expect(errs).toMatch(/no camera shot at t = 0/);
  });
});

describe('the war-room table map', () => {
  // A coarse grid of the real Himalaya terrain (the game's own height function).
  const grid = buildMapGrid(heightAt, waterLevelAt, 40);

  it('is the game terrain: heights match the terrain at its samples', () => {
    const i = 17, j = 23;
    expect(grid.h[j * grid.n + i]).toBeCloseTo(Math.max(heightAt(grid.xs[i]!, grid.zs[j]!), waterLevelAt(grid.xs[i]!, grid.zs[j]!)), 0);
    const s = worldOf('simikot');
    expect(gridHeightAt(grid, s.x, s.z)).toBeGreaterThan(1500);
  });

  it('draws no boundary: only rivers, grid squares and the story marks, and no country fills', () => {
    expect(MAP_LINE_KINDS as readonly string[]).not.toContain('boundary');
    expect(MAP_LINE_KINDS as readonly string[]).not.toContain('border');
    for (const s of BRIEFINGS) {
      const map = createTableMap(s);
      map.setGrid(grid);
      map.update(s.durationSec, 0.03);
      const kinds = new Set<string>();
      map.group.traverse((o) => {
        expect(o.name).not.toMatch(/border|boundary|frontier|country|claim|loc\b|lac\b/i);
        const k = o.userData.lineKind as string | undefined;
        if (k !== undefined) {
          expect(MAP_LINE_KINDS as readonly string[]).toContain(k);
          kinds.add(k);
        }
        // Every line-like object is tagged: an untagged ribbon could be anything.
        if (o instanceof THREE.Mesh && (o.material as THREE.Material) instanceof THREE.ShaderMaterial) expect(k).toBeDefined();
      });
      expect(kinds.has('river')).toBe(true);
      expect(kinds.has('arrow')).toBe(true);
      // The relief is coloured by height only: one mesh with vertex colours, no per-country material.
      const relief = map.group.getObjectByName('relief') as THREE.Mesh;
      expect((relief.material as THREE.MeshBasicMaterial).vertexColors).toBe(true);
      expect(map.group.children.filter((o) => o.name === 'relief')).toHaveLength(1);
      map.dispose();
    }
  });

  it('names places, never countries', () => {
    for (const p of Object.values(PLACES)) expect(p.name).not.toMatch(/\b(india|china|nepal|tibet|pakistan)\b/i);
    for (const s of BRIEFINGS) {
      for (const b of s.beats) if (b.kind === 'objective') expect(b.label).not.toMatch(/\b(india|china|nepal|tibet)\b/i);
    }
  });

  it('the room builds (officers, screens, lamps) without a page', () => {
    const room = createRoom();
    room.update(1, 1 / 60);
    let officers = 0;
    room.group.traverse((o) => {
      if (o.name === 'officer') officers++;
    });
    expect(officers).toBeGreaterThanOrEqual(6);
    room.dispose();
  });
});
