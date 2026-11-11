/**
 * src/script/director.ts — a mission's scripted events: the radio calls, the objective tracker and
 * the objective markers, driven by what happens in flight (as a mission script in a shooter does
 * it: phases, one-shot triggers, cool-downs and timers). Runs on the main thread from the snapshots
 * and events the sim sends; it never changes the simulation (the sim decides success or failure).
 *
 * A script (src/script/missions/*.ts) extends ScriptBase: `update` once per snapshot, `event` per
 * sim event. main.ts reads `objective()`, `markers()` and `drain()` (new radio calls) after each.
 */
import type { EntityId, SimEvent } from '../contracts/core';
import type { HudSteerpoint } from '../contracts/render';
import { compose, line, type Phrase, type RadioClipId, type RadioPriority, type Transmission } from './radio';

export interface ScriptAircraft {
  id: EntityId;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** What the script sees each snapshot. */
export interface ScriptFrame {
  /** Sim time, s. */
  t: number;
  player: ScriptAircraft & { headingRad: number; aglM: number; onGround: boolean; alive: boolean };
  /** Hostile aircraft still alive. */
  hostiles: readonly ScriptAircraft[];
  /** The player's designated air target (EntityId) or -1, and LockStateCode. */
  targetId: number;
  lockState: number;
  warningBits: number;
  rwrCount: number;
  /** Designated ground point (SPI). */
  spiValid: boolean;
  spiX: number;
  spiZ: number;
  /** DlzCode of the selected guided weapon. */
  dlz: number;
}

export interface ObjectiveView {
  /** 1-based step of `steps`. */
  step: number;
  steps: number;
  title: string;
  detail: string;
  /** Bumped when the objective changes (the tracker flashes). */
  serial: number;
}

export interface MissionScript {
  update(f: ScriptFrame): void;
  event(e: SimEvent, playerId: EntityId): void;
  objective(): ObjectiveView | undefined;
  /** Objective markers for the HUD (objective: true). */
  markers(): readonly HudSteerpoint[];
  /** Radio calls since the last call. */
  drain(): Transmission[];
  /** How long the debrief waits after success, for the closing call, s. */
  readonly outroSec: number;
}

export abstract class ScriptBase implements MissionScript {
  readonly outroSec: number = 7;
  protected t = 0;
  private outbox: Transmission[] = [];
  private fired = new Set<string>();
  private lastSaid = new Map<string, number>();
  private timers = new Map<string, number>();
  private obj: ObjectiveView | undefined;
  protected marks: HudSteerpoint[] = [];

  constructor(
    /** The controller's callsign (subtitle label). */
    protected readonly controller: string,
    /** The player's callsign (subtitle label of the player's own calls). */
    protected readonly callsign: string
  ) {}

  abstract update(f: ScriptFrame): void;
  abstract event(e: SimEvent, playerId: EntityId): void;

  objective(): ObjectiveView | undefined {
    return this.obj;
  }
  markers(): readonly HudSteerpoint[] {
    return this.marks;
  }
  drain(): Transmission[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  /** True the first time only. */
  protected once(key: string): boolean {
    if (this.fired.has(key)) return false;
    this.fired.add(key);
    return true;
  }
  protected done(key: string): boolean {
    return this.fired.has(key);
  }
  /** True (and restarts the cool-down) when `key` has not fired within `sec`. */
  protected ready(key: string, sec: number): boolean {
    const last = this.lastSaid.get(key);
    if (last !== undefined && this.t - last < sec) return false;
    this.lastSaid.set(key, this.t);
    return true;
  }
  /** Starts (or restarts) a timer of `sec`. */
  protected arm(key: string, sec: number): void {
    this.timers.set(key, this.t + sec);
  }
  protected disarm(key: string): void {
    this.timers.delete(key);
  }
  /** True once, when an armed timer runs out. */
  protected expired(key: string): boolean {
    const at = this.timers.get(key);
    if (at === undefined || this.t < at) return false;
    this.timers.delete(key);
    return true;
  }

  protected setObjective(step: number, steps: number, title: string, detail: string): void {
    const changed = !this.obj || this.obj.title !== title || this.obj.step !== step;
    this.obj = { step, steps, title, detail, serial: (this.obj?.serial ?? 0) + (changed ? 1 : 0) };
  }

  /** The controller says the phrases (as one transmission). */
  protected say(priority: RadioPriority, ...parts: (Phrase | RadioClipId)[]): void {
    const p = compose(...parts.map((x) => (typeof x === 'string' ? line(x) : x)));
    this.outbox.push({ from: this.controller, text: p.text, clips: p.clips, priority, maxAgeSec: priority === 0 ? 4 : priority === 1 ? 12 : 25 });
  }
  /** The player's own call (a p_* clip in the pilot's voice), said before a reply queued with it. */
  protected own(clip: RadioClipId, text: string, priority: RadioPriority = 1): void {
    this.outbox.push({ from: this.callsign, text, clips: [clip], priority, maxAgeSec: priority === 0 ? 6 : 20, own: true });
  }
}
