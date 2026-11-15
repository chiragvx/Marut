/**
 * src/briefing/script.ts — a mission intro's script: timed beats the war-room scene
 * (src/briefing/intro.ts) plays. A new mission's intro is a new script (src/briefing/scripts/) and
 * its narration lines (src/briefing/lines.json, rendered to public/audio/briefing/<id>.mp3).
 *
 * Everything on screen is a function of the intro's clock (beats start at `t` seconds), so the dev
 * hold (?briefing=<mission>,<t>) and a skip land on the same picture a full play does.
 */
import BRIEFING_LINES from './lines.json';
import { PLACES, type MapPoint } from './mapData';

export type BriefingLineId = keyof typeof BRIEFING_LINES;
export const BRIEFING_LINE_IDS = Object.keys(BRIEFING_LINES) as BriefingLineId[];
/** The spoken text of a narration line (the table the voice is recorded from). */
export const briefingLineText = (id: string): string | undefined => (BRIEFING_LINES as Record<string, string>)[id];

/**
 * A camera pose, from the point it looks at: `dist` room metres away, from compass bearing `az`
 * (degrees: 180 = from the south, looking north up the map) and `el` degrees above it. `look` is a
 * point on the map (at the map's surface there) or 'table' (the middle of the table, for the
 * shots of the room).
 */
export interface CameraPose {
  look: MapPoint | 'table';
  dist: number;
  az: number;
  el: number;
  /** Vertical field of view, degrees (default 40). */
  fov?: number;
  /** Raise the look point, room metres. */
  lift?: number;
}

export type Ease = 'linear' | 'inOut' | 'out';

export type BriefingBeat =
  /** A narration line: its voice (public/audio/briefing/<id>.mp3) and its subtitle, typed out. */
  | { t: number; kind: 'line'; id: BriefingLineId; subtitle: string }
  /** The camera moves from `from` to `to` over `dur` seconds (cuts to `from` at `t`). */
  | { t: number; kind: 'shot'; dur: number; from: CameraPose; to: CameraPose; ease?: Ease }
  /** A red pin drops on a place under attack, and keeps pulsing. */
  | { t: number; kind: 'pin'; at: MapPoint }
  /** An advance arrow draws along the path over `dur` seconds (hostile: red; friendly: the C-17's route, dashed). */
  | { t: number; kind: 'arrow'; path: readonly MapPoint[]; dur: number; side: 'hostile' | 'friendly'; width?: number }
  /** A hand-drawn front line across a valley, drawn over `dur`; its teeth face the enemy side (left of the path). */
  | { t: number; kind: 'front'; path: readonly MapPoint[]; dur: number }
  /** The objective: a ring on the map with a label. */
  | { t: number; kind: 'objective'; at: MapPoint; label: string }
  /** Place names to show from here on (the others fade out). */
  | { t: number; kind: 'labels'; show: readonly string[] }
  /** A card over the picture for `dur` seconds: the opening security card, or the mission's title card. */
  | { t: number; kind: 'card'; style: 'classified' | 'mission'; dur: number; lines: readonly string[] }
  /** The date / time and place stamp, typed out in a corner, for `dur` seconds. */
  | { t: number; kind: 'stamp'; dur: number; lines: readonly string[] }
  /** A low synthesised hit (no recordings). */
  | { t: number; kind: 'sting' };

export interface BriefingScript {
  id: string;
  /** The mission this intro plays before. */
  missionId: string;
  /** When the intro ends (the Continue prompt shows; the picture holds on the last shot). */
  durationSec: number;
  beats: readonly BriefingBeat[];
}

/**
 * Everything wrong with a script ([] = fine): beats out of time order or past the end, a line id
 * with no text, an unknown place, a shot or draw with no length, a gap with no camera.
 */
export function validateBriefingScript(s: BriefingScript): string[] {
  const errs: string[] = [];
  let last = -Infinity;
  const point = (p: MapPoint | 'table', where: string): void => {
    if (typeof p === 'string' && p !== 'table' && !PLACES[p]) errs.push(`${where}: unknown place '${p}'`);
  };
  s.beats.forEach((b, i) => {
    const where = `beat ${i} (${b.kind} at ${b.t})`;
    if (!(b.t >= 0)) errs.push(`${where}: negative time`);
    if (b.t < last) errs.push(`${where}: before the beat ahead of it`);
    last = Math.max(last, b.t);
    if (b.t > s.durationSec) errs.push(`${where}: after the end (${s.durationSec} s)`);
    switch (b.kind) {
      case 'line':
        if (!briefingLineText(b.id)) errs.push(`${where}: no line '${b.id}' in lines.json`);
        if (!b.subtitle.trim()) errs.push(`${where}: empty subtitle`);
        break;
      case 'shot':
        if (!(b.dur > 0)) errs.push(`${where}: no duration`);
        point(b.from.look, where);
        point(b.to.look, where);
        break;
      case 'pin':
        point(b.at, where);
        break;
      case 'objective':
        point(b.at, where);
        break;
      case 'arrow':
      case 'front':
        if (b.path.length < 2) errs.push(`${where}: a path needs two points`);
        if (!(b.dur > 0)) errs.push(`${where}: no duration`);
        b.path.forEach((p) => point(p, where));
        break;
      case 'labels':
        b.show.forEach((p) => point(p, where));
        break;
      case 'card':
      case 'stamp':
        if (!(b.dur > 0)) errs.push(`${where}: no duration`);
        break;
      default:
        break;
    }
  });
  if (!s.beats.some((b) => b.kind === 'shot' && b.t === 0)) errs.push('no camera shot at t = 0');
  return errs;
}

/** The narration line ids a script says, in order. */
export const scriptLineIds = (s: BriefingScript): BriefingLineId[] => s.beats.flatMap((b) => (b.kind === 'line' ? [b.id] : []));
