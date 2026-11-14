/**
 * src/ui/audio/targetParam.ts — an AudioParam that is only told about a new value when it has
 * really changed. Every `setTargetAtTime` costs main-thread time (the browser records an
 * automation event, and a long list of them is slow to search), and the sound's code calls them
 * many times a second for values that mostly sit still (a jet in steady flight, a camera fixed to
 * the airframe). Skipping a call whose target is within `absEps + relEps x |value|` of the last
 * one sent changes nothing audible (the param is already heading there).
 */

/** The bit of an AudioParam this needs (a fake in the tests). */
export interface TargetSink {
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
}

export class TargetParam {
  private last = NaN;
  constructor(
    readonly param: TargetSink,
    private readonly absEps = 1e-4,
    private readonly relEps = 0,
  ) {}

  /** Heads for `v` (time constant `tc`, s) unless it is already heading (near enough) there. Returns whether a call was made. */
  to(v: number, t: number, tc: number): boolean {
    // NaN (nothing sent yet) never compares: always sends.
    if (Math.abs(v - this.last) <= this.absEps + this.relEps * Math.abs(v)) return false;
    this.param.setTargetAtTime(v, t, tc);
    this.last = v;
    return true;
  }

  /** Forget the last value (e.g. after the param was set some other way). */
  reset(): void {
    this.last = NaN;
  }
}
