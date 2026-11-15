/**
 * src/briefing/scripts/simikotLifeline.ts — the intro to "Simikot Lifeline" (himalaya-airdrop),
 * Operation Him Setu mission 2. A fictional story that follows the mission's situation
 * (src/core/missions/catalogue.ts): on 14 October at 04:40 Chinese troops crossed into Humla and
 * overran the posts at Hilsa, Yari and Limi; the garrison holds above Kermi; one C-17 drops their
 * supplies on the strip at Simikot.
 *
 * Sound: the score (public/audio/briefing/score_silent_advance.mp3) from the first frame, and one
 * continuous narration recording (simikot_narration.mp3, 53.7 s) from NARRATION_AT, its words
 * the lines br_ska_01..12 of src/briefing/lines.json (with their delivery tags: the text it was
 * generated from). The cue times below are the recording's own, seconds from its start, read from
 * its silences (ffmpeg silencedetect -38 dB, 0.22 s); a new take needs them measured again.
 *
 * The beats follow the words: the stamp with the date, the pins as the posts are named, the
 * columns' arrows down the gorge, the garrison's line above Kermi, the strip close-up with the DZ
 * ring, the ridges for the MANPADS warning (no marker, and the camera looks along the approach
 * south-east of the strip, away from the real site, so the in-game surprise stays), and the wide
 * view with the mission card for "Jai Hind".
 *
 * Six camera moves, slow and eased, each cut hidden in a dip to black or a soft wipe.
 */
import type { BriefingScript, NarrationCue } from '../script';

/** The drop zone (the middle of Simikot's strip), world metres (src/script/missions/simikotAirdrop.ts DZ). */
const DZ = { x: 70811.5, z: 73382.2 };

/** The narration starts this far into the intro, once the opening card has settled, s. */
export const NARRATION_AT = 4;
/** The narration's cues, seconds from the start of simikot_narration.mp3. */
export const SIMIKOT_NARRATION_CUES: readonly NarrationCue[] = [
  { at: 0.0, end: 4.72, line: 'br_ska_01' },
  { at: 5.45, end: 6.69, line: 'br_ska_02' },
  { at: 7.27, end: 12.38, line: 'br_ska_03' },
  { at: 12.86, end: 16.03, line: 'br_ska_04' },
  { at: 16.53, end: 19.09, line: 'br_ska_05' },
  { at: 19.67, end: 23.31, line: 'br_ska_06' },
  { at: 23.99, end: 28.28, line: 'br_ska_07' },
  { at: 28.81, end: 35.21, line: 'br_ska_08' },
  { at: 35.73, end: 42.2, line: 'br_ska_09' },
  { at: 42.67, end: 48.98, line: 'br_ska_10' },
  { at: 49.42, end: 52.68, line: 'br_ska_11' },
  { at: 53.08, end: 53.6, line: 'br_ska_12' },
];
/** A moment of the narration as intro time: `at` s into the recording. */
const v = (at: number): number => Math.round((NARRATION_AT + at) * 100) / 100;

export const SIMIKOT_LIFELINE_BRIEFING: BriefingScript = {
  id: 'simikot-lifeline',
  missionId: 'himalaya-airdrop',
  durationSec: 70,
  beats: [
    // The room: the glowing table, the wall screens behind; the opening card over the score.
    { t: 0, kind: 'shot', dur: 5.6, from: { look: 'table', dist: 6.2, az: 186, el: 15, fov: 36, lift: 0.22 }, to: { look: 'table', dist: 5.2, az: 180, el: 19, fov: 36, lift: 0.2 }, ease: 'out' },
    { t: 0, kind: 'score', clip: 'score_silent_advance', gain: 0.42, duckDb: -9, fadeOutSec: 5 },
    { t: 0.4, kind: 'card', style: 'classified', dur: 4.4, lines: ['Restricted · Joint Operations Room', 'Operation Him Setu'] },
    { t: v(0), kind: 'narration', clip: 'simikot_narration', gain: 2, cues: SIMIKOT_NARRATION_CUES },

    // "On the 14th of October ...": the date. "Hilsa, Yari and Limi": the pins. "columns ... down the Karnali gorge": the arrows.
    { t: 5, kind: 'shot', dur: 18.6, transition: 'fade', from: { look: 'yari', dist: 1.3, az: 204, el: 44, fov: 34 }, to: { look: { lat: 30.05, lon: 81.55 }, dist: 0.8, az: 180, el: 51, fov: 34 }, ease: 'inOut' },
    { t: 5, kind: 'labels', show: ['hilsa', 'yari', 'limi', 'purang', 'karnali', 'simikot', 'humla'] },
    { t: 5.4, kind: 'stamp', dur: 8, lines: ['14 OCT · 04:40 LOCAL', 'HUMLA · KARNALI SECTOR'] },
    { t: v(7.3), kind: 'pin', at: 'hilsa' },
    { t: v(7.9), kind: 'pin', at: 'yari' },
    { t: v(8.6), kind: 'pin', at: 'limi' },
    { t: v(14.2), kind: 'arrow', side: 'hostile', dur: 3.4, width: 0.0042, path: ['purang', { lat: 30.3, lon: 81.18 }, { lat: 30.18, lon: 81.3 }] },
    { t: v(14.6), kind: 'arrow', side: 'hostile', dur: 4.6, path: ['hilsa', { lat: 30.12, lon: 81.42 }, { lat: 30.07, lon: 81.53 }, { lat: 30.035, lon: 81.62 }] },
    { t: v(15.2), kind: 'arrow', side: 'hostile', dur: 3.6, width: 0.0042, path: ['limi', { lat: 30.18, lon: 81.55 }, { lat: 30.09, lon: 81.56 }] },
    { t: v(16.6), kind: 'labels', show: ['hilsa', 'yari', 'limi', 'kermi', 'karnali', 'simikot', 'humla'] },

    // "holding above Kermi": the garrison's line.
    { t: v(19.38), kind: 'shot', dur: 9.4, transition: 'wipe', from: { look: { x: 63000, z: 70600 }, dist: 0.6, az: 222, el: 38, fov: 33 }, to: { look: { x: 63600, z: 70900 }, dist: 0.44, az: 208, el: 34, fov: 33 }, ease: 'inOut' },
    { t: v(20.6), kind: 'front', dur: 2.6, path: [{ x: 62170, z: 75200 }, { x: 63300, z: 72800 }, { x: 64250, z: 70900 }, { x: 65000, z: 69000 }, { x: 65790, z: 66960 }] },

    // "a C-17 to the Simikot airstrip" / "an extremely short runway": the strip close-up.
    { t: v(28.55), kind: 'shot', dur: 14.1, transition: 'fade', from: { look: DZ, dist: 0.58, az: 152, el: 44, fov: 33 }, to: { look: DZ, dist: 0.3, az: 134, el: 34, fov: 33 }, ease: 'inOut' },
    { t: v(28.55), kind: 'labels', show: ['simikot', 'kermi', 'karnali', 'saipal'] },
    { t: v(32.9), kind: 'objective', at: DZ, label: 'DZ · Simikot strip' },
    { t: v(33.1), kind: 'labels', show: ['kermi', 'karnali', 'saipal'] },

    // "beware of portable MANPADS": a slow look along the ridges of the approach, no marker.
    { t: v(42.44), kind: 'shot', dur: 7.2, transition: 'wipe', from: { look: { x: 73600, z: 75600 }, dist: 0.42, az: 238, el: 22, fov: 34 }, to: { look: { x: 73200, z: 75000 }, dist: 0.38, az: 252, el: 25, fov: 34 }, ease: 'inOut' },

    // "We cannot let Simikot fall": the whole map, wide; "Jai Hind" on the mission card.
    { t: v(49.2), kind: 'shot', dur: 16.8, transition: 'fade', from: { look: { lat: 30.12, lon: 81.5 }, dist: 2.1, az: 184, el: 60, fov: 36 }, to: { look: { lat: 30.08, lon: 81.6 }, dist: 1.75, az: 176, el: 56, fov: 36 }, ease: 'inOut' },
    { t: v(49.2), kind: 'labels', show: ['simikot', 'humla', 'ngari', 'purang', 'kailash', 'lipulekh', 'karnali'] },
    { t: v(52.8), kind: 'card', style: 'mission', dur: 13.2, lines: ['Mission 02', 'Simikot Lifeline', 'C-17 · CDS airdrop · 16 × A-22', 'DZ 29°58′N 081°49′E · elev 2,971 m'] },
  ],
};
