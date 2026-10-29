/**
 * src/ui/releaseTone.ts — the release tone for a CCRP bomb attack (Web Audio), from the snapshot's
 * release cue (SnapshotHudExt.AG_CUE): from TONE_LEAD_SEC before the release point a short beep each
 * second, every half second in the last two, a steady tone at the release point, and silence once
 * the bomb is away (or the cue is anything else). The audio context starts on the first tone (after
 * the pilot's key presses, so the browser lets it play).
 */
import { AgCueCode } from '../contracts/core';

/** Beeps start this long before the release point, s. */
export const TONE_LEAD_SEC = 5;
const BEEP_SEC = 0.12;
const FREQ_HZ = 1000;
const VOLUME = 0.08;

export interface ReleaseTone {
  /** From the latest snapshot: the release cue and the seconds to release. */
  update(cue: number, timeToReleaseSec: number): void;
  /** Off (paused, menus, mission over). */
  silence(): void;
  setEnabled(on: boolean): void;
}

/** True while the tone sounds for this cue and time to release (beeps on the second, then the half second). */
export function releaseToneOn(cue: number, t: number): boolean {
  if (cue === AgCueCode.Release) return true;
  if ((cue !== AgCueCode.Hold && cue !== AgCueCode.Releasing) || t > TONE_LEAD_SEC || t <= 0) return false;
  const period = t <= 2 ? 0.5 : 1;
  return t % period > period - BEEP_SEC;
}

export function createReleaseTone(): ReleaseTone {
  let ac: AudioContext | null = null;
  let gain: GainNode | null = null;
  let on = false;
  let enabled = true;

  const ensure = (): boolean => {
    if (ac) return true;
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor) return false;
    try {
      ac = new Ctor();
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = FREQ_HZ;
      gain = ac.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(ac.destination);
      osc.start();
      return true;
    } catch {
      ac = null;
      return false;
    }
  };

  const set = (want: boolean): void => {
    if (want === on) return;
    if (want && !ensure()) return;
    on = want;
    if (!ac || !gain) return;
    if (want && ac.state === 'suspended') void ac.resume();
    gain.gain.setTargetAtTime(want ? VOLUME : 0, ac.currentTime, 0.004);
  };

  return {
    update(cue, t) {
      set(enabled && releaseToneOn(cue, t));
    },
    silence() {
      set(false);
    },
    setEnabled(v) {
      enabled = v;
      if (!v) set(false);
    },
  };
}
