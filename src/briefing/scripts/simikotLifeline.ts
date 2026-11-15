/**
 * src/briefing/scripts/simikotLifeline.ts — the intro to "Simikot Lifeline" (himalaya-airdrop),
 * Operation Him Setu mission 2. A fictional story that follows the mission's situation
 * (src/core/missions/catalogue.ts): Chinese forces have hit Nepal's border posts and are pushing
 * down the Karnali from Hilsa; Nepal has asked India for help; one C-17 drops supplies to the Nepal
 * Army on the runway at Simikot.
 *
 * Beat times follow the narration's length (public/audio/briefing/br_ska_*.mp3, 1.8-10.7 s each):
 * a replacement recording that runs longer needs its line's start, and the ones after it, moved.
 */
import type { BriefingScript } from '../script';

/** The drop zone (the middle of Simikot's strip) and the C-17's start, world metres (src/script/missions/simikotAirdrop.ts DZ, the mission's playerStart). */
const DZ = { x: 70811.5, z: 73382.2 };
const C17_START = { x: 92025, z: 94595 };

export const SIMIKOT_LIFELINE_BRIEFING: BriefingScript = {
  id: 'simikot-lifeline',
  missionId: 'himalaya-airdrop',
  durationSec: 70,
  beats: [
    // The room: the officers round the glowing table, the wall screens behind.
    { t: 0, kind: 'shot', dur: 9, from: { look: 'table', dist: 5.6, az: 186, el: 15, fov: 38, lift: 0.25 }, to: { look: 'table', dist: 4.5, az: 176, el: 19, fov: 38, lift: 0.2 }, ease: 'out' },
    { t: 0.1, kind: 'card', style: 'classified', dur: 4.9, lines: ['Restricted', 'Joint Operations Room', 'Operation Him Setu'] },
    { t: 0.5, kind: 'sting' },
    { t: 3, kind: 'line', id: 'br_ska_01', subtitle: "At first light, Chinese troops crossed into Humla and overran the Nepal Army's border posts at Hilsa, Yari and Limi." },
    { t: 4.6, kind: 'labels', show: ['ngari', 'purang', 'lipulekh', 'simikot', 'naini', 'kailash', 'karnali'] },
    { t: 5.2, kind: 'stamp', dur: 7, lines: ['14 OCT · 09:05 IST', 'HUMLA · KARNALI SECTOR'] },
    // Over the table to the border posts: the pins drop as they are named.
    { t: 8.5, kind: 'shot', dur: 5, from: { look: 'yari', dist: 1.15, az: 202, el: 40, fov: 36 }, to: { look: 'yari', dist: 0.78, az: 190, el: 46, fov: 36 }, ease: 'inOut' },
    { t: 8.5, kind: 'labels', show: ['hilsa', 'yari', 'limi', 'purang', 'karnali', 'simikot', 'humla'] },
    { t: 10.1, kind: 'pin', at: 'hilsa' },
    { t: 11.0, kind: 'pin', at: 'yari' },
    { t: 11.9, kind: 'pin', at: 'limi' },
    // The advance: from Purang to Hilsa, then down the Karnali; a second column from Limi.
    { t: 13.4, kind: 'shot', dur: 7.6, from: { look: { lat: 30.1, lon: 81.47 }, dist: 0.95, az: 178, el: 56, fov: 36 }, to: { look: { lat: 30.06, lon: 81.55 }, dist: 0.72, az: 166, el: 52, fov: 36 }, ease: 'inOut' },
    { t: 13.4, kind: 'line', id: 'br_ska_02', subtitle: 'Within hours, their columns were moving down the Karnali gorge. Towards Simikot.' },
    { t: 13.6, kind: 'arrow', side: 'hostile', dur: 2.6, width: 0.009, path: ['purang', { lat: 30.3, lon: 81.18 }, { lat: 30.18, lon: 81.3 }] },
    { t: 15.2, kind: 'arrow', side: 'hostile', dur: 4.8, path: ['hilsa', { lat: 30.12, lon: 81.42 }, { lat: 30.07, lon: 81.53 }, { lat: 30.035, lon: 81.62 }] },
    { t: 16.4, kind: 'arrow', side: 'hostile', dur: 3.6, width: 0.009, path: ['limi', { lat: 30.18, lon: 81.55 }, { lat: 30.09, lon: 81.56 }] },
    { t: 17, kind: 'labels', show: ['hilsa', 'yari', 'limi', 'kermi', 'karnali', 'simikot', 'humla'] },
    // The garrison's line above Kermi.
    { t: 21, kind: 'shot', dur: 11.4, from: { look: { x: 63000, z: 70600 }, dist: 0.56, az: 224, el: 36, fov: 34 }, to: { look: { x: 63600, z: 70900 }, dist: 0.4, az: 206, el: 32, fov: 34 }, ease: 'inOut' },
    { t: 21, kind: 'line', id: 'br_ska_03', subtitle: 'The garrison is dug in above Kermi, holding the valley. The road is cut. They are running out of food, ammunition and medicine.' },
    { t: 22.4, kind: 'front', dur: 3, path: [{ x: 62170, z: 75200 }, { x: 63300, z: 72800 }, { x: 64250, z: 70900 }, { x: 65000, z: 69000 }, { x: 65790, z: 66960 }] },
    // The room again: low, through the officers.
    { t: 32.4, kind: 'shot', dur: 6.6, from: { look: 'table', dist: 3.3, az: 226, el: 13, fov: 40, lift: 0.2 }, to: { look: 'table', dist: 2.9, az: 242, el: 15, fov: 40, lift: 0.18 }, ease: 'linear' },
    { t: 32.4, kind: 'line', id: 'br_ska_04', subtitle: 'Kathmandu has asked New Delhi for help. There is no road in.' },
    { t: 32.4, kind: 'labels', show: ['simikot', 'hilsa', 'purang', 'lipulekh', 'gunji', 'naini', 'ngari'] },
    // The way in: up the Karnali gorge from the south-east, on 315.
    { t: 39, kind: 'shot', dur: 8.2, from: { look: { x: 83000, z: 85500 }, dist: 1.05, az: 196, el: 58, fov: 36 }, to: { look: { x: 79000, z: 81500 }, dist: 0.74, az: 182, el: 54, fov: 36 }, ease: 'inOut' },
    { t: 39, kind: 'line', id: 'br_ska_05', subtitle: 'So we go in by air. One C-17, up the Karnali from the south-east, under the ridgelines.' },
    { t: 39, kind: 'labels', show: ['simikot', 'kermi', 'karnali', 'humla', 'saipal'] },
    { t: 40.4, kind: 'arrow', side: 'friendly', dur: 5.6, width: 0.006, path: [{ x: 99000, z: 99600 }, C17_START, { x: 82000, z: 84300 }, { x: 75500, z: 77900 }, DZ] },
    // The objective: push in on the strip.
    { t: 47.2, kind: 'shot', dur: 13, from: { look: DZ, dist: 0.62, az: 152, el: 46, fov: 34 }, to: { look: DZ, dist: 0.27, az: 138, el: 38, fov: 34 }, ease: 'inOut' },
    { t: 47.2, kind: 'line', id: 'br_ska_06', subtitle: 'The drop zone is the runway at Simikot. 650 metres, on a shelf, 3,000 metres up.' },
    { t: 48.4, kind: 'labels', show: ['kermi', 'karnali'] },
    { t: 48.4, kind: 'objective', at: DZ, label: 'DZ · Simikot strip' },
    { t: 51, kind: 'card', style: 'mission', dur: 7.5, lines: ['Mission 02', 'Simikot Lifeline', 'C-17 · CDS airdrop · 16 × A-22', 'DZ 29°58′N 081°49′E · elev 2,971 m'] },
    { t: 51.2, kind: 'sting' },
    { t: 56.4, kind: 'line', id: 'br_ska_07', subtitle: 'Sixteen tonnes, at 180 knots. One pass. Then climb out of that valley.' },
    { t: 60, kind: 'shot', dur: 14, from: { look: DZ, dist: 0.27, az: 138, el: 38, fov: 34 }, to: { look: DZ, dist: 0.23, az: 122, el: 36, fov: 34 }, ease: 'linear' },
    { t: 65.4, kind: 'line', id: 'br_ska_08', subtitle: 'They are waiting for you.' },
  ],
};
