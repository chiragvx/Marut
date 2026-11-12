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
  /** Checked when its turn comes: true drops it unsaid (a lesson's step already done). */
  stale?: () => boolean;
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
  t1_intro: "Good morning, cadet. This is Guru, your instructor. You're lined up on runway 13, ready to go. First, the throttle: push it all the way up.",
  t1_rotate: '250 km/h. Ease the stick back, gently. Lift the nose about 10°.',
  t1_climb: "Gear's up. Let go of the afterburner, and keep climbing to 1,500 m.",
  t1_level: '1,500 m. Ease the nose down and level off. Bring the throttle back to about three quarters.',
  t1_turn: 'Now a turn. Roll to about 45° of bank, then pull gently and hold your height. Turn 90°, either way.',
  t1_rollout: "That's 90°. Roll the wings level.",
  t2_intro: "Runway 13 is straight ahead, 12 km. You're a little high and fast. Bring the throttle back to about half, and let the speed come down.",
  t2_gear: 'Under 400 km/h. Gear down.',
  t2_speed: 'Hold about 270 km/h. Use the throttle for speed, and the nose for the glide path.',
  t3_intro: "The weather's bad at Bhisiana: rain, a low cloud deck, and a gusty crosswind from the right. You'll fly the ILS. Bring the throttle back and descend to 1,200 m. You'll go into the cloud.",
  t3_ils: 'Look at the HUD. The two needles are the ILS: the upright one is the runway centre line, the flat one is the glide path. Fly toward the needles to centre them.',
  t4_mode: 'Press the radar mode button to change the scan. Search mode (RWS) sees far. Dogfight mode (ACM) looks at a small box straight ahead, for close fights.',
  t4_gun: 'Now the second one, with the gun. Press weapon until the gun is selected. Get behind the drone, inside 1 km, put the pipper on it, and hold the trigger.',
  t4_closer: 'Get closer. Inside 1 km.',
  t4_select: 'You have the gun selected. Press weapon, and pick a missile. The ASRAAM is a heat-seeker for close in; the Astra is radar guided, for long range.',
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
