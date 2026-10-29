/**
 * src/ui/audio/rwrTones.ts — the radar-warning receiver's tones, in the style of the F/A-18's
 * ALR-67 (synthesised; no recorded sound), from the snapshot's RWR list (SnapshotRwr):
 *
 * - a new ground or ship radar, or one that changes state: a single 455 Hz tone, 0.335 s;
 * - a new aircraft radar: a falling "waterfall" of 550, 520, 490 and 470 Hz, 0.083 s each;
 * - a radar locks on: 455/555 Hz alternating every 0.25 s, for LOCK_TONE_SEC;
 * - a missile guided at you: 455/555 Hz alternating every 0.1 s, for as long as it is inbound.
 *
 * `stepRwrTones` (pure, tested) works out what to sound from one RWR picture to the next; an
 * emitter is "the same" as one seen before when it has the same symbol within MATCH_RAD of bearing,
 * and is forgotten FORGET_SEC after it was last seen (so one that comes back is new again).
 */
import { MAX_RWR_CONTACTS, RWR_BASE, SNAPSHOT_RWR_STRIDE, SnapshotHud, SnapshotRwr } from '../../contracts/core';
import { AudioChannel, type AudioBus } from './audioBus';

/** RWR symbol codes (RWR_SYMBOLS) that are aircraft: JF-17, F-16, Tejas, other fighter. */
const AIRCRAFT_SYMBOLS: ReadonlySet<number> = new Set([7, 8, 9, 10]);
const MATCH_RAD = (20 * Math.PI) / 180;
export const FORGET_SEC = 4;
export const LOCK_TONE_SEC = 2;

export const RWR_NEW_RADAR_HZ = 455;
const NEW_RADAR_SEC = 0.335;
export const RWR_WATERFALL_HZ: readonly number[] = [550, 520, 490, 470];
const WATERFALL_STEP_SEC = 0.083;
const WARBLE_LO_HZ = 455;
const WARBLE_HI_HZ = 555;
const LOCK_PERIOD_SEC = 0.25;
const LAUNCH_PERIOD_SEC = 0.1;
const VOLUME = 0.12;

/** One RWR entry (from the snapshot). */
export interface RwrEmitter {
  symbol: number;
  bearingRad: number;
  /** 0 search, 1 tracking you, 2 missile guided at you. */
  state: number;
}

interface Known extends RwrEmitter {
  lastSeenSec: number;
}

export interface RwrToneState {
  known: Known[];
  /** Lock warble until this time, s. */
  lockUntilSec: number;
}

/** What to sound this step. */
export interface RwrToneCommand {
  /** New (or changed) radars: a 455 Hz tone. */
  newRadar: boolean;
  /** A new aircraft: the waterfall. */
  newAircraft: boolean;
  /** The lock warble is sounding. */
  lock: boolean;
  /** The launch warble is sounding. */
  launch: boolean;
}

export const createRwrToneState = (): RwrToneState => ({ known: [], lockUntilSec: -1 });

const angleDiff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

export function stepRwrTones(st: RwrToneState, emitters: readonly RwrEmitter[], nowSec: number, out: RwrToneCommand): RwrToneCommand {
  out.newRadar = false;
  out.newAircraft = false;
  out.launch = false;
  st.known = st.known.filter((k) => nowSec - k.lastSeenSec <= FORGET_SEC);
  const matched = new Set<Known>();
  for (const e of emitters) {
    if (e.symbol <= 0) continue;
    let best: Known | undefined;
    let bestD = MATCH_RAD;
    for (const k of st.known) {
      if (k.symbol !== e.symbol || matched.has(k)) continue;
      const d = angleDiff(k.bearingRad, e.bearingRad);
      if (d <= bestD) {
        bestD = d;
        best = k;
      }
    }
    const aircraft = AIRCRAFT_SYMBOLS.has(e.symbol);
    if (!best) {
      best = { symbol: e.symbol, bearingRad: e.bearingRad, state: e.state, lastSeenSec: nowSec };
      st.known.push(best);
      if (aircraft) out.newAircraft = true;
      else out.newRadar = true;
      if (e.state >= 1) st.lockUntilSec = nowSec + LOCK_TONE_SEC;
    } else {
      // Up from search to a lock: the lock warble (and, for a ground radar, its status tone).
      if (e.state >= 1 && best.state < 1) {
        st.lockUntilSec = nowSec + LOCK_TONE_SEC;
        if (!aircraft) out.newRadar = true;
      }
      best.state = e.state;
      best.bearingRad = e.bearingRad;
      best.lastSeenSec = nowSec;
    }
    matched.add(best);
    if (e.state >= 2) out.launch = true;
  }
  out.lock = !out.launch && nowSec < st.lockUntilSec;
  return out;
}

/** The warble's frequency at time t (alternating every `period` s). */
export const warbleHz = (t: number, period: number): number => (Math.floor(t / period) % 2 === 0 ? WARBLE_LO_HZ : WARBLE_HI_HZ);

export interface RwrTonePlayer {
  /** From the latest snapshot's HUD block. */
  update(hud: Float64Array, hudBase: number, nowSec: number): void;
  silence(): void;
  /** Forget the emitters (a new flight). */
  reset(): void;
}

export function createRwrTonePlayer(bus: AudioBus): RwrTonePlayer {
  const st = createRwrToneState();
  const cmd: RwrToneCommand = { newRadar: false, newAircraft: false, lock: false, launch: false };
  const emitters: RwrEmitter[] = Array.from({ length: MAX_RWR_CONTACTS }, () => ({ symbol: 0, bearingRad: 0, state: 0 }));
  let warbleOsc: OscillatorNode | null = null;
  let warbleGain: GainNode | null = null;
  let warbleOn = false;

  const beep = (freqs: readonly number[], stepSec: number): void => {
    const ac = bus.context();
    const dest = bus.channel(AudioChannel.Tones);
    if (!ac || !dest) return;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'sine';
    const t0 = ac.currentTime + 0.01;
    freqs.forEach((f, i) => osc.frequency.setValueAtTime(f, t0 + i * stepSec));
    const end = t0 + freqs.length * stepSec;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(VOLUME, t0 + 0.005);
    g.gain.setValueAtTime(VOLUME, end - 0.005);
    g.gain.linearRampToValueAtTime(0, end);
    osc.connect(g).connect(dest);
    osc.start(t0);
    osc.stop(end + 0.02);
  };

  const setWarble = (on: boolean, period: number): void => {
    const ac = bus.context();
    const dest = bus.channel(AudioChannel.Tones);
    if (!ac || !dest) return;
    if (!warbleOsc) {
      warbleOsc = ac.createOscillator();
      warbleOsc.type = 'sine';
      warbleGain = ac.createGain();
      warbleGain.gain.value = 0;
      warbleOsc.connect(warbleGain).connect(dest);
      warbleOsc.start();
    }
    if (on) warbleOsc.frequency.setValueAtTime(warbleHz(ac.currentTime, period), ac.currentTime);
    if (on !== warbleOn) warbleGain!.gain.setTargetAtTime(on ? VOLUME : 0, ac.currentTime, 0.004);
    warbleOn = on;
  };

  return {
    update(hud, hudBase, nowSec) {
      const n = Math.min(hud[hudBase + SnapshotHud.RWR_COUNT] ?? 0, MAX_RWR_CONTACTS);
      for (let i = 0; i < n; i++) {
        const o = hudBase + RWR_BASE + i * SNAPSHOT_RWR_STRIDE;
        emitters[i]!.symbol = hud[o + SnapshotRwr.SYMBOL] ?? 0;
        emitters[i]!.bearingRad = hud[o + SnapshotRwr.BEARING_RAD] ?? 0;
        emitters[i]!.state = hud[o + SnapshotRwr.STATE] ?? 0;
      }
      stepRwrTones(st, emitters.slice(0, n), nowSec, cmd);
      if (cmd.newAircraft) beep(RWR_WATERFALL_HZ, WATERFALL_STEP_SEC);
      else if (cmd.newRadar) beep([RWR_NEW_RADAR_HZ], NEW_RADAR_SEC);
      if (cmd.launch) setWarble(true, LAUNCH_PERIOD_SEC);
      else if (cmd.lock) setWarble(true, LOCK_PERIOD_SEC);
      else if (warbleOn) setWarble(false, LOCK_PERIOD_SEC);
    },
    silence() {
      if (warbleOn) setWarble(false, LOCK_PERIOD_SEC);
    },
    reset() {
      st.known = [];
      st.lockUntilSec = -1;
      if (warbleOn) setWarble(false, LOCK_PERIOD_SEC);
    },
  };
}
