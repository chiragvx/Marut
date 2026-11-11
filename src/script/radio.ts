/**
 * src/script/radio.ts — radio transmissions: what is said (recorded clips, src/script/radioLines.json,
 * rendered to public/audio/radio by tools/audio/genRadio.mjs) and the subtitle shown with it.
 * Numbers are said the way a controller says them: bearings and coordinates digit by digit
 * ("two six five", "niner"), ranges and altitudes as words ("thirty two", "angels twelve").
 */
import RADIO_LINES from './radioLines.json';
import { COMPASS_WORDS, threeDigits, type Braa, type Compass8 } from './geo';

export type RadioClipId = keyof typeof RADIO_LINES;
export const RADIO_CLIP_IDS = Object.keys(RADIO_LINES) as RadioClipId[];

/** Lower is more urgent; an Urgent call cuts off a less urgent one in progress. */
export const RadioPriority = { Urgent: 0, High: 1, Normal: 2, Chatter: 3 } as const;
export type RadioPriority = (typeof RadioPriority)[keyof typeof RadioPriority];

export interface Transmission {
  /** Who is talking (the subtitle's label): a controller's callsign, or the player's. */
  from: string;
  /** The subtitle. */
  text: string;
  /** The clips said in order; empty: subtitle only (the player's own calls). */
  clips: readonly RadioClipId[];
  priority: RadioPriority;
  /** Dropped if it has waited longer than this to be said, s. */
  maxAgeSec: number;
  /** The player's own call (subtitle in the player's colour). */
  own?: boolean;
}

/** Subtitles where the spoken text is spelled for the voice. */
const SUBTITLE: Partial<Record<RadioClipId, string>> = {
  duel_contact: "That's your bandit. Hostile, JF-17. Cleared to engage.",
  duel_scramble: 'Scramble, scramble. Single bandit has crossed the border west of Bathinda, inbound to the base. Take off runway 13, turn west and climb.',
  strike_brief: 'Your target is the fuel depot at PAF Shahbaz: four storage tanks inside an earth berm. Target coordinates:',
  strike_push: 'Push to IP Alpha. Stay low, under 500 feet, and keep under their radar.',
  strike_sam: 'SAM launch! SAM launch! Break, and chaff!',
  strike_ip: 'IP. Turn in. Target bears',
  strike_talk2: 'From the tower, go north-east 500 metres: a square earth berm with four round tanks. That is your target.',
  braa: 'Single group, BRAA',
};

/** A run of clips and its subtitle text. */
export interface Phrase {
  clips: RadioClipId[];
  text: string;
}

export const line = (id: RadioClipId): Phrase => ({ clips: [id], text: SUBTITLE[id] ?? RADIO_LINES[id] });

/** Joins phrases into one transmission's clips and subtitle. */
export function compose(...parts: Phrase[]): Phrase {
  return { clips: parts.flatMap((p) => p.clips), text: parts.map((p) => p.text).join(' ').replace(/\s+([,.:;!?])/g, '$1') };
}

const DIGIT: readonly RadioClipId[] = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'];

/** Digits said one by one ("two six five"); the subtitle shows the digits. */
export function digits(s: string): Phrase {
  return { clips: [...s].filter((c) => c >= '0' && c <= '9').map((c) => DIGIT[Number(c)]!), text: s };
}

/** 0..99 said as words ("thirty two"); n * 100 for round hundreds ("five hundred"). */
export function words(n: number): Phrase {
  n = Math.max(0, Math.round(n));
  if (n >= 100) {
    const h = Math.min(9, Math.round(n / 100));
    return { clips: [...words(h).clips, 'hundred'], text: String(h * 100) };
  }
  const one = (k: number): RadioClipId => (k === 9 ? 'w9' : DIGIT[k]!);
  if (n < 10) return { clips: [one(n)], text: String(n) };
  if (n < 20) return { clips: [`w${n}` as RadioClipId], text: String(n) };
  const tens = `t${Math.floor(n / 10) * 10}` as RadioClipId;
  return { clips: n % 10 ? [tens, one(n % 10)] : [tens], text: String(n) };
}

/** "Single group, BRAA two six five, thirty two, angels twelve, hot, hostile." */
export function braaPhrase(b: Braa): Phrase {
  const asp: Record<Braa['aspect'], Phrase> = {
    hot: line('hot'),
    flanking: line('flanking'),
    beaming: line('beaming'),
    cold: line('cold'),
  };
  const brg = threeDigits(b.bearing);
  return {
    clips: [...line('braa').clips, ...digits(brg).clips, ...words(Math.min(99, b.rangeNm)).clips, ...line(b.cherubs ? 'cherubs' : 'angels').clips, ...words(b.angels).clips, ...asp[b.aspect].clips],
    text: `Single group, BRAA ${brg}, ${b.rangeNm}, ${b.cherubs ? 'cherubs' : 'angels'} ${b.angels}, ${asp[b.aspect].text}`,
  };
}

/** A distance on the ground: hundreds of metres, or kilometres. */
export function distancePhrase(m: number): Phrase {
  if (m < 950) {
    const h = Math.max(1, Math.round(m / 100));
    return { clips: [...words(h).clips, 'hundred', 'metres'], text: `${h * 100} metres` };
  }
  const km = Math.min(99, Math.round(m / 1000));
  return { clips: [...words(km).clips, 'kilometres'], text: `${km} kilometres` };
}

export const compassPhrase = (c: Compass8): Phrase => ({ clips: [`d_${c}` as RadioClipId], text: COMPASS_WORDS[c] });

/** "North three zero, zero four decimal five, east zero seven four, zero seven decimal eight." */
export function coordsPhrase(latDeg: number, lonDeg: number): Phrase {
  const part = (v: number, word: RadioClipId, degDigits: number, label: string): Phrase => {
    const a = Math.abs(v);
    let d = Math.floor(a);
    let m = Math.round((a - d) * 600) / 10;
    if (m >= 60) {
      d += 1;
      m = 0;
    }
    const dd = String(d).padStart(degDigits, '0');
    const [mi, mf] = m.toFixed(1).padStart(4, '0').split('.') as [string, string];
    return { clips: [word, ...digits(dd).clips, ...digits(mi).clips, 'decimal', ...digits(mf).clips], text: `${label} ${dd}°${mi}.${mf}'` };
  };
  const n = part(latDeg, 'north', 2, 'N');
  const e = part(lonDeg, 'east', 3, 'E');
  return { clips: [...n.clips, ...e.clips], text: `${n.text}, ${e.text}.` };
}
