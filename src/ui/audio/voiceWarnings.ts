/**
 * src/ui/audio/voiceWarnings.ts — what the voice warning system ("Betty") says, and when, from the
 * snapshot: the warning bits (WarningBit), the autopilot's disconnect flash, the chaff and flares
 * left, and the fuel. Pure (tested); src/ui/audio/voicePlayer.ts says the lines.
 *
 * Each line is said once when its warning comes on; a few repeat while it lasts (PULL UP, a missile
 * inbound, the stall). A warning that clears and comes back is not said again until it has been
 * clear for its `rearmSec` (REARM_SEC by default): a hard pull bobbing over the G limit is one
 * OVER G, not one every few seconds; a lock that drops and re-acquires, one RADAR LOCK. Countermeasures: "low" at a quarter of what was loaded, "out"
 * at none. Bingo: at BINGO_FRAC of the fullest the tanks have been this flight.
 *
 * The voice files are public/audio/voice/<id>.mp3 (see VOICE_LINES' `text` for what each says).
 */
import { AutopilotFlag, WarningBit } from '../../contracts/core';

/** Lower is more urgent. A line of priority <= INTERRUPT_PRIORITY cuts off a less urgent one. */
export interface VoiceLineDef {
  id: string;
  text: string;
  priority: number;
  /** Said again every this many seconds while the warning lasts. */
  repeatSec?: number;
  /** Clear this long before it is said again when it comes back, s (default REARM_SEC). */
  rearmSec?: number;
}

export const VOICE_LINES = {
  pullUp: { id: 'pull_up', text: 'Pull up', priority: 1, repeatSec: 1.4 },
  engineFire: { id: 'engine_fire', text: 'Engine fire', priority: 2, repeatSec: 6 },
  missileLaunch: { id: 'missile_launch', text: 'Missile launch', priority: 3, repeatSec: 3 },
  stall: { id: 'stall', text: 'Angle of attack', priority: 4, repeatSec: 3 },
  overG: { id: 'over_g', text: 'Over G', priority: 5, rearmSec: 10 },
  overspeed: { id: 'overspeed', text: 'Overspeed', priority: 6, rearmSec: 5 },
  gear: { id: 'gear', text: 'Gear', priority: 7, rearmSec: 10 },
  configuration: { id: 'configuration', text: 'Configuration', priority: 8, rearmSec: 5 },
  radarLock: { id: 'radar_lock', text: 'Radar lock', priority: 9, rearmSec: 6 },
  fuelLow: { id: 'fuel_low', text: 'Fuel low', priority: 10, rearmSec: 30 },
  bingo: { id: 'bingo', text: 'Bingo fuel', priority: 11 },
  autopilotOff: { id: 'autopilot_off', text: 'Autopilot disengaged', priority: 12 },
  chaffOut: { id: 'chaff_out', text: 'Chaff out', priority: 13 },
  flareOut: { id: 'flare_out', text: 'Flare out', priority: 13 },
  chaffLow: { id: 'chaff_low', text: 'Chaff low', priority: 14 },
  flareLow: { id: 'flare_low', text: 'Flare low', priority: 14 },
  warning: { id: 'warning', text: 'Warning', priority: 15 },
} as const satisfies Record<string, VoiceLineDef>;
export type VoiceLineKey = keyof typeof VOICE_LINES;
export const ALL_VOICE_LINES: readonly VoiceLineDef[] = Object.values(VOICE_LINES);

export const INTERRUPT_PRIORITY = 3;
export const REARM_SEC = 2;
export const BINGO_FRAC = 0.15;
export const CM_LOW_FRAC = 0.25;

/** Warning bits and their lines, most urgent first. */
const BIT_LINES: readonly [number, VoiceLineDef][] = [
  [WarningBit.TerrainPullUp, VOICE_LINES.pullUp],
  [WarningBit.EngineFire, VOICE_LINES.engineFire],
  [WarningBit.MissileLaunch, VOICE_LINES.missileLaunch],
  [WarningBit.Stall, VOICE_LINES.stall],
  [WarningBit.OverG, VOICE_LINES.overG],
  [WarningBit.Overspeed, VOICE_LINES.overspeed],
  [WarningBit.GearUnsafe, VOICE_LINES.gear],
  [WarningBit.ConfigWarning, VOICE_LINES.configuration],
  [WarningBit.MissileLock, VOICE_LINES.radarLock],
  [WarningBit.LowFuel, VOICE_LINES.fuelLow],
];

export interface VoiceInputs {
  warningBits: number;
  apFlags: number;
  chaff: number;
  flares: number;
  fuelKg: number;
  alive: boolean;
}

interface BitTrack {
  on: boolean;
  /** When it last came on and was said, and when it last cleared, s. */
  saidSec: number;
  clearedSec: number;
}

export interface VoiceWarningState {
  bits: BitTrack[];
  apFlash: boolean;
  chaff: number;
  chaffMax: number;
  flares: number;
  flaresMax: number;
  fuelMaxKg: number;
  bingoSaid: boolean;
  started: boolean;
}

export function createVoiceWarningState(): VoiceWarningState {
  return {
    bits: BIT_LINES.map(() => ({ on: false, saidSec: -Infinity, clearedSec: -Infinity })),
    apFlash: false,
    chaff: 0,
    chaffMax: 0,
    flares: 0,
    flaresMax: 0,
    fuelMaxKg: 0,
    bingoSaid: false,
    started: false,
  };
}

/** Countermeasures: a rise is a rearm (the new count is the full load); a fall across a quarter, low; to none, out. */
function stepCm(count: number, last: number, max: number, low: VoiceLineDef, outLine: VoiceLineDef, out: VoiceLineDef[]): number {
  if (count > last) return Math.max(count, max);
  if (count < last && max > 0) {
    if (count === 0) out.push(outLine);
    else if (count <= Math.floor(max * CM_LOW_FRAC) && last > Math.floor(max * CM_LOW_FRAC)) out.push(low);
  }
  return max;
}

/** The lines to say now (most urgent first), into `out`. */
export function stepVoiceWarnings(st: VoiceWarningState, inp: VoiceInputs, nowSec: number, out: VoiceLineDef[]): VoiceLineDef[] {
  out.length = 0;
  if (!inp.alive) {
    for (const b of st.bits) b.on = false;
    return out;
  }
  if (!st.started) {
    // The first look at a new flight: what is loaded is the full load (nothing to say about it).
    st.started = true;
    st.chaff = st.chaffMax = inp.chaff;
    st.flares = st.flaresMax = inp.flares;
    st.apFlash = (inp.apFlags & AutopilotFlag.ApOffFlash) !== 0;
  }
  BIT_LINES.forEach(([bit, line], i) => {
    const b = st.bits[i]!;
    const on = (inp.warningBits & bit) !== 0;
    if (on && !b.on) {
      if (nowSec - b.clearedSec >= (line.rearmSec ?? REARM_SEC) || line.repeatSec !== undefined) {
        out.push(line);
        b.saidSec = nowSec;
      }
    } else if (on && line.repeatSec !== undefined && nowSec - b.saidSec >= line.repeatSec) {
      out.push(line);
      b.saidSec = nowSec;
    } else if (!on && b.on) {
      b.clearedSec = nowSec;
    }
    b.on = on;
  });

  const apFlash = (inp.apFlags & AutopilotFlag.ApOffFlash) !== 0;
  if (apFlash && !st.apFlash) out.push(VOICE_LINES.autopilotOff);
  st.apFlash = apFlash;

  st.chaffMax = stepCm(inp.chaff, st.chaff, st.chaffMax, VOICE_LINES.chaffLow, VOICE_LINES.chaffOut, out);
  st.chaff = inp.chaff;
  st.flaresMax = stepCm(inp.flares, st.flares, st.flaresMax, VOICE_LINES.flareLow, VOICE_LINES.flareOut, out);
  st.flares = inp.flares;

  // Bingo: from the fullest the tanks have been; refuelling (above the line again) re-arms it.
  st.fuelMaxKg = Math.max(st.fuelMaxKg, inp.fuelKg);
  const bingo = st.fuelMaxKg > 0 && inp.fuelKg < st.fuelMaxKg * BINGO_FRAC;
  const lowOn = (inp.warningBits & WarningBit.LowFuel) !== 0;
  if (bingo && !st.bingoSaid) {
    st.bingoSaid = true;
    if (!lowOn) out.push(VOICE_LINES.bingo);
  } else if (!bingo && inp.fuelKg > st.fuelMaxKg * (BINGO_FRAC + 0.05)) {
    st.bingoSaid = false;
  }

  out.sort((a, b) => a.priority - b.priority);
  return out;
}
