/**
 * tests/ui/releaseTone.test.ts — the CCRP release tone: silent until five seconds out, a beep on each
 * second, then each half second in the last two, steady at the release point, silent otherwise.
 */
import { describe, expect, it } from 'vitest';
import { AgCueCode } from '../../src/contracts/core';
import { releaseToneOn } from '../../src/ui/releaseTone';

/** The tone's on/off over a countdown from `t0` to 0 in 10 ms steps: the start times of each beep. */
function beeps(cue: number, t0: number): number[] {
  const starts: number[] = [];
  let prev = false;
  for (let t = t0; t > 0; t = Math.round((t - 0.01) * 100) / 100) {
    const on = releaseToneOn(cue, t);
    if (on && !prev) starts.push(t);
    prev = on;
  }
  return starts;
}

describe('release tone', () => {
  it('beeps each second from five seconds out, each half second in the last two', () => {
    expect(beeps(AgCueCode.Releasing, 8)).toEqual([4.99, 3.99, 2.99, 1.99, 1.49, 0.99, 0.49]);
  });

  it('is steady at the release point and silent for the other cues', () => {
    expect(releaseToneOn(AgCueCode.Release, 0)).toBe(true);
    for (const c of [AgCueCode.None, AgCueCode.Designate, AgCueCode.Ccip, AgCueCode.Steer, AgCueCode.Away, AgCueCode.Passed]) expect(beeps(c, 5)).toEqual([]);
  });
});
