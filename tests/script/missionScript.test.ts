import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { aspectOf, BORDER_GEO, braa, compass8, formatLatLon, threeDigits, toLatLon } from '../../src/script/geo';
import { braaPhrase, coordsPhrase, digits, distancePhrase, RADIO_CLIP_IDS, words } from '../../src/script/radio';
import type { ScriptFrame } from '../../src/script/director';
import { BorderDuelScript } from '../../src/script/missions/borderDuel';
import { BorderStrikeScript, strikeGeometry } from '../../src/script/missions/borderStrike';
import { createMissionScript } from '../../src/script';
import { resolveBuiltinMission } from '../../src/core/missions';
import type { AirportLayout } from '../../src/contracts/airport';
import { DlzCode, LockStateCode } from '../../src/contracts/core';

function frame(over: Partial<Omit<ScriptFrame, 'player'>> & { player?: Partial<ScriptFrame['player']> } = {}): ScriptFrame {
  const { player, ...rest } = over;
  return {
    t: 0,
    hostiles: [],
    targetId: -1,
    lockState: 0,
    warningBits: 0,
    rwrCount: 0,
    spiValid: false,
    spiX: 0,
    spiZ: 0,
    dlz: 0,
    ...rest,
    player: { id: 1, x: 30500, y: 190, z: -11000, vx: 0, vy: 0, vz: 0, headingRad: 0, aglM: 0, onGround: true, alive: true, ...player },
  };
}

describe('script geo', () => {
  it('anchors the border theatre on Bhisiana and reads coordinates out in degrees and minutes', () => {
    const a = toLatLon(BORDER_GEO.x, BORDER_GEO.z, BORDER_GEO);
    expect(a.latDeg).toBeCloseTo(30.2703, 6);
    expect(formatLatLon(a.latDeg, a.lonDeg)).toBe("N30°16.2' E074°45.3'");
    // 1 km north is ~0.54 minutes of latitude.
    const n = toLatLon(BORDER_GEO.x, BORDER_GEO.z - 1000, BORDER_GEO);
    expect((n.latDeg - a.latDeg) * 60).toBeCloseTo(0.539, 2);
  });
  it('gives BRAA and aspect the way a controller calls them', () => {
    // Bandit 10 nm due west at 12,000 ft heading east (at the viewer): hot.
    const b = braa(0, 0, { x: -18520, y: 3658, z: 0, vx: 200, vz: 0 });
    expect(threeDigits(b.bearing)).toBe('270');
    expect(b.rangeNm).toBe(10);
    expect(b.angels).toBe(12);
    expect(b.aspect).toBe('hot');
    expect(aspectOf(-18520, 0, -200, 0, 0, 0)).toBe('cold');
    expect(aspectOf(-18520, 0, 0, 200, 0, 0)).toBe('beaming');
    expect(threeDigits(0.2)).toBe('360');
    expect(compass8(50)).toBe('ne');
  });
});

describe('radio phrases', () => {
  it('says numbers as words and bearings digit by digit', () => {
    expect(words(32).clips).toEqual(['t30', 'n2']);
    expect(words(9).clips).toEqual(['w9']);
    expect(words(600).clips).toEqual(['n6', 'hundred']);
    expect(digits('259').clips).toEqual(['n2', 'n5', 'n9']);
    expect(distancePhrase(480).text).toBe('500 metres');
    expect(distancePhrase(2300).clips).toEqual(['n2', 'kilometres']);
    const p = braaPhrase({ bearing: 265, rangeNm: 32, angels: 12, cherubs: false, aspect: 'hot' });
    expect(p.text).toBe('Single group, BRAA 265, 32, angels 12, hot, hostile.');
    expect(coordsPhrase(30.0745, 74.1306).text).toBe("N 30°04.5', E 074°07.8'.");
  });
  it('has a recorded clip for every line', () => {
    for (const id of RADIO_CLIP_IDS) expect(existsSync(`public/audio/radio/${id}.mp3`), id).toBe(true);
  });
});

describe('Border Duel script', () => {
  const bandit = { id: 7, x: 6000, y: 3500, z: -6000, vx: 220, vy: 0, vz: -40 };
  it('runs scramble -> intercept -> engage -> splash with Netra on the radio', () => {
    const s = new BorderDuelScript();
    s.update(frame({ t: 2, hostiles: [bandit] }));
    expect(s.objective()!.step).toBe(1);
    const scramble = s.drain();
    expect(scramble.map((x) => x.clips.at(-1))).toEqual(['duel_scramble', 'p_tiger_wilco']);
    expect(scramble[1]).toMatchObject({ from: 'TIGER 1', own: true, text: 'Wilco.' });
    expect(s.markers()[0]).toMatchObject({ name: 'Bandit', objective: true });

    s.update(frame({ t: 40, hostiles: [bandit], player: { onGround: false, aglM: 400, y: 600, headingRad: (270 * Math.PI) / 180 } }));
    expect(s.objective()!.step).toBe(2);
    expect(s.drain().map((x) => x.clips[1])).toEqual(['duel_airborne']);
    // The first BRAA call six seconds later.
    s.update(frame({ t: 47, hostiles: [bandit], player: { onGround: false, aglM: 400, y: 600, headingRad: (270 * Math.PI) / 180 } }));
    const call = s.drain()[0]!;
    expect(call.text).toMatch(/^Tiger one, Netra\. Single group, BRAA 2\d\d, \d+, angels 11, /);

    s.update(frame({ t: 60, hostiles: [bandit], targetId: 7, lockState: LockStateCode.locked, player: { onGround: false, aglM: 400, y: 600 } }));
    expect(s.objective()!.step).toBe(3);
    expect(s.drain().map((x) => x.clips.at(-1))).toEqual(['p_tiger_contact', 'duel_contact', 'duel_lock']);

    s.event({ type: 'missileLaunch', shooterId: 1, missileId: 50, weapon: 'radar_missile' }, 1);
    expect(s.drain().map((x) => x.text)).toEqual(['Fox 3!', 'Netra copies fox.']);
    s.event({ type: 'kill', targetId: 7, sourceId: 50 }, 1);
    expect(s.objective()!.step).toBe(4);
    expect(s.markers()).toEqual([]);
    expect(s.drain().at(-1)!.clips).toEqual(['duel_splash']);
  });
  it('calls a hostile launch at once, as an urgent call', () => {
    const s = new BorderDuelScript();
    s.update(frame({ t: 2, hostiles: [bandit] }));
    s.drain();
    s.event({ type: 'missileLaunch', shooterId: 7, missileId: 51, weapon: 'radar_missile' }, 1);
    const [c] = s.drain();
    expect(c!.clips).toContain('duel_defend');
    expect(c!.priority).toBe(0);
  });
});

describe('Precision Strike script', () => {
  const mission = resolveBuiltinMission('border-strike');
  const layouts = mission.world.airports as readonly AirportLayout[];
  const start = { x: 15000, z: 2000 };
  const geo = strikeGeometry(layouts, start);

  it('finds the depot and puts IP Alpha 14 km short of it on the inbound line', () => {
    expect(geo.target.x).toBeCloseTo(-29603.6, 0);
    expect(Math.hypot(geo.ip.x - geo.target.x, geo.ip.z - geo.target.z)).toBeCloseTo(14000, 0);
    expect(createMissionScript(mission)).toBeInstanceOf(BorderStrikeScript);
    expect(createMissionScript(resolveBuiltinMission('border-free'))).toBeUndefined();
  });

  it('briefs, sends the jet to the IP, talks it onto the depot, checks the mark and calls the hits', () => {
    const s = new BorderStrikeScript(layouts, start);
    const air = { onGround: false, aglM: 120, y: 300 };
    s.update(frame({ t: 2, player: { ...air, ...start } }));
    const brief = s.drain();
    expect(brief[0]!.text).toMatch(/Target coordinates: N 30°0\d\.\d', E 074°0\d\.\d'\. Elevation 600 feet\./);
    expect(brief.slice(1).map((x) => x.clips[0])).toEqual(['strike_push', 'p_vajra_wilco']);
    expect(s.markers().map((m) => m.name)).toEqual(['IP Alpha', 'Fuel depot']);

    s.update(frame({ t: 200, player: { ...air, x: geo.ip.x, z: geo.ip.z } }));
    expect(s.objective()!.step).toBe(2);
    expect(s.drain().map((x) => x.clips.find((c) => c.startsWith('strike_') || c.startsWith('p_')))).toEqual(['p_vajra_ip', 'strike_ip', 'strike_talk1', 'strike_talk2']);

    // A mark 800 m south of the depot: the depot is north of it.
    s.update(frame({ t: 210, spiValid: true, spiX: geo.target.x, spiZ: geo.target.z + 800, player: { ...air, x: geo.ip.x, z: geo.ip.z } }));
    expect(s.drain()[0]!.text).toBe('Negative, wrong target. The depot is 800 metres north of your mark.');
    s.update(frame({ t: 230, spiValid: true, spiX: geo.target.x + 30, spiZ: geo.target.z, dlz: DlzCode.InRange, player: { ...air, x: geo.ip.x, z: geo.ip.z } }));
    expect(s.objective()!.step).toBe(3);
    expect(s.drain().map((x) => x.clips.at(-1))).toEqual(['p_vajra_captured', 'strike_good_mark', 'strike_in_range']);

    s.event({ type: 'missileLaunch', shooterId: 1, missileId: 60, weapon: 'guided_bomb' }, 1);
    expect(s.drain().map((x) => x.text)).toEqual(['Bombs away!', 'Copy release. Keep the laser on it till impact.']);
    const kill = (id: string) => ({ type: 'groundKill' as const, entityId: -1, targetId: `pafb-shahbaz:${id}`, typeId: 'fuel_tank', groupId: 'fuel-depot', team: 1 as const, sourceId: 60, pos: { x: 0, y: 0, z: 0 }, burnSec: 300 });
    s.event(kill('FUEL-TANK-107'), 1);
    expect(s.drain()[0]!.text).toBe('Good hit! Tank burning. 3 remaining.');
    s.event(kill('FUEL-TANK-107'), 1); // the same target again: no new call
    expect(s.drain()).toEqual([]);
    s.event({ type: 'missionEnded', outcome: 'success', objectivesCompleted: ['obj-depot'], objectivesTotal: 1 }, 1);
    expect(s.objective()!.step).toBe(4);
    expect(s.drain()[0]!.clips).toEqual(['strike_shack']);
  });
});
