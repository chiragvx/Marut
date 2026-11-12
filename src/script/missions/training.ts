/**
 * src/script/missions/training.ts — Flight School: four short lessons, each a walkthrough with an
 * instructor (GURU) on the radio. A lesson is a list of steps; each step says its line as it
 * starts, shows what to do (a prompt with the keys, the matching on-screen buttons glowing) and
 * waits for the pilot to do it. Lines for a step the pilot has already finished are dropped unsaid,
 * so the instructor never lags behind. The lesson decides its own ending (outcome()).
 *
 *   1 Takeoff & Handling   throttle, afterburner, rotate, gear, climb, level off, turn, camera
 *   2 Approach & Landing   slow down, gear, airbrake, glide path (PAPI), flare, stop; go-around
 *   3 Bad-Weather Landing  descend through cloud, ILS needles, crosswind, minimums, land
 *   4 Radar & Drones       scope, RWR tones, scan mode, range, designate, lock, missile, gun
 */
import type { EntityId, SimEvent } from '../../contracts/core';
import { LockStateCode, RadarModeCode, WeaponKindCode } from '../../contracts/core';
import type { AirportLayout } from '../../contracts/airport';
import { ScriptBase, type PromptControl, type ScriptFrame, type ScriptOutcome, type ScriptPrompt } from '../director';
import { RadioPriority, line, type RadioClipId } from '../radio';
import { wrapDeg } from '../geo';

const DEG = Math.PI / 180;
const KMH = 3.6;
/** The instructor's and the student's callsigns. */
const INSTRUCTOR = 'GURU';
const STUDENT = 'CADET';
/** Glide path angle and the height it crosses the threshold at. */
const GLIDE_RAD = 3 * DEG;
const THRESHOLD_CROSSING_M = 15;

/** The values a step compares against: the frame as the step began. */
interface StepStart {
  t: number;
  headingRad: number;
  cameraChanges: number;
  radarRangeChanges: number;
  radarMode: number;
}

export interface LessonStep {
  /** The objective tracker's title. */
  title: string;
  /** Said as the step starts (dropped if the step is over before its turn comes). */
  say?: readonly RadioClipId[];
  /** What to do, with {control} markers. */
  prompt?: string | ((f: ScriptFrame) => string);
  highlight?: readonly PromptControl[];
  /** The tracker's live line. */
  detail?: (f: ScriptFrame, s: StepStart) => string;
  /** The step is done. */
  done: (f: ScriptFrame, s: StepStart) => boolean;
  /** Not done before this long, s (time to listen). */
  minSec?: number;
  /** Skip the step (it does not apply now). */
  skip?: (f: ScriptFrame) => boolean;
}

/** Runs a lesson's steps in order; the lessons add their own watchers and events. */
export abstract class LessonScript extends ScriptBase {
  override readonly outroSec: number = 9;
  protected stepNo = 0;
  protected readonly steps: LessonStep[] = [];
  private start: StepStart = { t: 0, headingRad: 0, cameraChanges: 0, radarRangeChanges: 0, radarMode: 0 };
  private result: ScriptOutcome | undefined;
  private finishing = false;
  private promptNow: ScriptPrompt | undefined;
  private praise = 0;
  /** Set when the lesson's last step is done: its closing line. */
  protected abstract readonly closing: readonly RadioClipId[];

  constructor() {
    super(INSTRUCTOR, STUDENT);
    this.objectiveLabel = 'Step';
  }

  prompt(): ScriptPrompt | undefined {
    return this.promptNow;
  }
  outcome(): ScriptOutcome | undefined {
    return this.result;
  }

  /** The lesson's own checks, every frame before the step's (warnings, callouts). */
  protected watch(_f: ScriptFrame): void {}

  /** An instruction for step `n`: dropped if the lesson has moved past it by its turn. */
  protected teach(n: number, clips: readonly RadioClipId[]): void {
    this.sayTagged(clips, () => this.stepNo !== n);
  }
  protected sayTagged(clips: readonly RadioClipId[], stale?: () => boolean, priority: RadioPriority = RadioPriority.Normal): void {
    if (clips.length === 0) return;
    const parts = clips.map((c) => line(c));
    const text = parts.map((p) => p.text).join(' ');
    this.pushTx({ from: INSTRUCTOR, text, clips: [...clips], priority, maxAgeSec: 45, ...(stale ? { stale } : {}) });
  }

  /** Jumps to step `n` (a go-around goes back). */
  protected goTo(n: number, f: ScriptFrame): void {
    this.stepNo = n;
    this.enter(f);
  }

  private enter(f: ScriptFrame): void {
    this.start = { t: f.t, headingRad: f.player.headingRad, cameraChanges: f.cameraChanges, radarRangeChanges: f.radarRangeChanges, radarMode: f.radarMode };
    const st = this.steps[this.stepNo];
    if (st?.say) this.teach(this.stepNo, st.say);
  }

  update(f: ScriptFrame): void {
    this.t = f.t;
    if (!f.player.alive || this.result) {
      this.promptNow = undefined;
      return;
    }
    if (this.stepNo === 0 && this.once('begin')) this.enter(f);
    this.watch(f);
    if (this.finishing) {
      this.promptNow = undefined;
      // The closing line said: the lesson is over.
      if (!f.radioBusy && this.t - this.start.t > 1.5) this.result = 'success';
      return;
    }
    // The current step; straight on through any the pilot has already done (or that do not apply).
    for (let guard = 0; guard <= this.steps.length; guard++) {
      const st = this.steps[this.stepNo];
      if (!st) return;
      if (st.skip?.(f)) {
        this.stepNo += 1;
        this.enter(f);
        continue;
      }
      this.setObjective(this.stepNo + 1, this.steps.length, st.title, st.detail?.(f, this.start) ?? '');
      const text = typeof st.prompt === 'function' ? st.prompt(f) : st.prompt;
      this.promptNow = text ? { text, highlight: st.highlight ?? [] } : undefined;
      if (f.t - this.start.t < (st.minSec ?? 0) || !st.done(f, this.start)) return;
      // Done: a word of praise now and then, and the next step.
      this.stepNo += 1;
      if (this.stepNo >= this.steps.length) {
        this.finishing = true;
        this.promptNow = undefined;
        this.start.t = f.t;
        this.setObjective(this.steps.length, this.steps.length, 'Lesson complete', '');
        this.sayTagged(this.closing, undefined, RadioPriority.High);
        return;
      }
      const next = this.stepNo;
      if (this.praise++ % 3 === 1) this.sayTagged([this.praise % 2 ? 'tr_good' : 'tr_nice'], () => this.stepNo !== next);
      this.enter(f);
    }
  }

  event(_e: SimEvent, _playerId: EntityId): void {}

}

// ---- Shared bits ------------------------------------------------------------------------------

/** Heading change since the step began, rad (+ = right). */
const turned = (f: ScriptFrame, s: StepStart): number => wrapDeg(((f.player.headingRad - s.headingRad) * 180) / Math.PI) * DEG;
const kmh = (mps: number): string => `${Math.round(mps * KMH)} km/h`;
const metres = (m: number): string => `${Math.round(m / 10) * 10} m`;

/** Where the player is relative to a runway's approach: along the centre line, across it, and the glide path. */
export interface Approach {
  /** Distance to the threshold along the approach (+ = before it), m. */
  alongM: number;
  /** + = right of the centre line (looking down the approach), m. */
  crossM: number;
  /** Height above the glide path (+ = high), m. */
  aboveM: number;
  /** Heading off the runway's (+ = right of it), rad. */
  headingOffRad: number;
}

export function approachTo(rwy: { x: number; z: number; elevationM: number; headingRad: number }, p: { x: number; y: number; z: number; headingRad: number }): Approach {
  const dx = Math.sin(rwy.headingRad);
  const dz = -Math.cos(rwy.headingRad);
  const rx = p.x - rwy.x;
  const rz = p.z - rwy.z;
  const alongM = -(rx * dx + rz * dz);
  // Right of the centre line, looking along the runway heading: (cos h, sin h) in (x, z).
  const crossM = rx * Math.cos(rwy.headingRad) + rz * Math.sin(rwy.headingRad);
  const gp = rwy.elevationM + THRESHOLD_CROSSING_M + Math.max(0, alongM) * Math.tan(GLIDE_RAD);
  return { alongM, crossM, aboveM: p.y - gp, headingOffRad: wrapDeg(((p.headingRad - rwy.headingRad) * 180) / Math.PI) * DEG };
}

function runwayOf(layouts: readonly AirportLayout[], airportId: string, runwayId: string): { x: number; z: number; elevationM: number; headingRad: number; lengthM: number } {
  const a = layouts.find((l) => l.id === airportId);
  const r = a?.runways.find((x) => x.id === runwayId);
  if (!r) return { x: 29450, z: -11903, elevationM: 190, headingRad: 2.28132, lengthM: 2739 };
  return { x: r.thresholdWorldX, z: r.thresholdWorldZ, elevationM: r.elevationM ?? a!.elevationM, headingRad: r.headingRad, lengthM: r.lengthM };
}

/** Basic airmanship warnings for any lesson in the air. */
function airmanship(s: LessonScript & { readyPub(key: string, sec: number): boolean; sayPub(clips: RadioClipId[]): void }, f: ScriptFrame, opts: { slowMps: number }): void {
  if (f.player.onGround) return;
  if (f.player.aglM < 120 && f.vsMps < -18 && s.readyPub('low', 8)) s.sayPub(['tr_low']);
  else if (f.iasMps < opts.slowMps && f.player.aglM > 60 && s.readyPub('slow', 15)) s.sayPub(['tr_slow']);
  else if (Math.abs(f.rollRad) > 100 * DEG && s.readyPub('bank', 15)) s.sayPub(['tr_bank']);
  else if (f.pitchRad > 35 * DEG && f.iasMps < 130 && s.readyPub('steep', 15)) s.sayPub(['tr_steep']);
}

/** A lesson with the airmanship warnings exposed to the helper above. */
abstract class AirLesson extends LessonScript {
  readyPub(key: string, sec: number): boolean {
    return this.ready(key, sec);
  }
  sayPub(clips: RadioClipId[]): void {
    this.sayTagged(clips, undefined, RadioPriority.High);
  }
}

// ---- 1: Takeoff & Handling ----------------------------------------------------------------------

export class TakeoffLesson extends AirLesson {
  protected readonly closing: readonly RadioClipId[] = ['t1_done'];
  private levelSince = -1;
  private wingsLevelSince = -1;

  constructor() {
    super();
    this.steps.push(
      {
        title: 'Throttle up',
        say: ['t1_intro'],
        prompt: 'Push the throttle all the way up: hold {throttleUp}',
        highlight: ['throttleUp'],
        detail: (f) => `Throttle ${Math.round(f.throttle * 100)}%`,
        done: (f) => f.throttle > 0.95 || f.afterburner,
      },
      {
        title: 'Afterburner',
        say: ['t1_ab'],
        prompt: 'Hold {afterburner} for the afterburner',
        highlight: ['afterburner'],
        detail: (f) => kmh(f.iasMps),
        done: (f) => f.afterburner || f.iasMps > 60,
      },
      {
        title: 'Accelerate to 250 km/h',
        prompt: 'Keep the power on. Steer with {rollLeft} / {rollRight} (rudder on the ground) to stay on the centre line',
        detail: (f) => `${kmh(f.iasMps)} · rotate at 250 km/h`,
        done: (f) => f.iasMps * KMH >= 245 || !f.player.onGround,
      },
      {
        title: 'Rotate',
        say: ['t1_rotate'],
        prompt: 'Ease back: hold {noseUp} gently until the nose is 10° up',
        highlight: ['noseUp'],
        detail: (f) => `${kmh(f.iasMps)} · pitch ${Math.round(f.pitchRad / DEG)}°`,
        done: (f) => !f.player.onGround && f.player.aglM > 15,
      },
      {
        title: 'Gear up',
        say: ['t1_gear'],
        prompt: 'Raise the gear: press {gear}',
        highlight: ['gear'],
        detail: (f) => `Gear ${f.gearDown ? 'DOWN' : 'UP'} · ${kmh(f.iasMps)}`,
        done: (f) => !f.gearDown,
      },
      {
        title: 'Climb to 1,500 m',
        say: ['t1_climb'],
        prompt: 'Let go of {afterburner}. Hold about 10° nose up ({noseUp} / {noseDown}) to 1,500 m',
        highlight: ['afterburner'],
        detail: (f) => `${metres(f.altMslM)} of 1,500 m · ${kmh(f.iasMps)}`,
        done: (f) => f.altMslM >= 1450,
      },
      {
        title: 'Level off',
        say: ['t1_level'],
        prompt: 'Ease {noseDown} until the climb stops; throttle back with {throttleDown} to about 75%',
        highlight: ['noseDown', 'throttleDown'],
        detail: (f) => `Climbing ${f.vsMps.toFixed(0)} m/s · throttle ${Math.round(f.throttle * 100)}%`,
        done: (f) => {
          const level = Math.abs(f.vsMps) < 5 && Math.abs(f.pitchRad) < 6 * DEG;
          if (!level) this.levelSince = -1;
          else if (this.levelSince < 0) this.levelSince = f.t;
          return level && f.t - this.levelSince > 2;
        },
      },
      {
        title: 'Turn 90°',
        say: ['t1_turn'],
        prompt: 'Roll to 45° with {rollLeft} or {rollRight}, then pull gently with {noseUp}',
        highlight: ['rollLeft', 'rollRight', 'noseUp'],
        detail: (f, s) => `Bank ${Math.round(Math.abs(f.rollRad) / DEG)}° · turned ${Math.round(Math.abs(turned(f, s)) / DEG)}° of 90°`,
        done: (f, s) => Math.abs(turned(f, s)) >= 80 * DEG,
      },
      {
        title: 'Roll out',
        say: ['t1_rollout'],
        prompt: 'Roll the wings level with {rollLeft} / {rollRight}',
        highlight: ['rollLeft', 'rollRight'],
        detail: (f) => `Bank ${Math.round(Math.abs(f.rollRad) / DEG)}°`,
        done: (f) => {
          const lvl = Math.abs(f.rollRad) < 8 * DEG;
          if (!lvl) this.wingsLevelSince = -1;
          else if (this.wingsLevelSince < 0) this.wingsLevelSince = f.t;
          return lvl && f.t - this.wingsLevelSince > 1;
        },
      },
      {
        title: 'Try the camera views',
        say: ['t1_camera'],
        prompt: 'Press {camera} to change the view. Try three of them',
        highlight: ['camera'],
        detail: (f, s) => `${Math.min(3, f.cameraChanges - s.cameraChanges)} of 3 views`,
        done: (f, s) => f.cameraChanges - s.cameraChanges >= 3,
      }
    );
  }

  protected override watch(f: ScriptFrame): void {
    if (this.stepNo >= 4) airmanship(this, f, { slowMps: 75 });
  }
}

// ---- 2 and 3: landings -------------------------------------------------------------------------

/** Glide path and centre-line coaching shared by both landing lessons. */
abstract class LandingLesson extends AirLesson {
  protected readonly rwy: ReturnType<typeof runwayOf>;
  protected app: Approach = { alongM: 0, crossM: 0, aboveM: 0, headingOffRad: 0 };
  /** Index of the "fly the approach" step (go-arounds return here), and of the flare step. */
  protected approachStep = 0;
  protected flareStep = 0;
  private goingAround = false;
  private stopped = -1;

  constructor(layouts: readonly AirportLayout[]) {
    super();
    this.rwy = runwayOf(layouts, 'bhisiana-afs', '13');
  }

  protected glideText(): string {
    const a = this.app.aboveM;
    const path = Math.abs(a) < 15 ? 'ON PATH' : a > 0 ? `HIGH ${Math.round(a)} m` : `LOW ${Math.round(-a)} m`;
    const c = this.app.crossM;
    const line = Math.abs(c) < 20 ? 'ON CENTRE LINE' : c > 0 ? `${Math.round(c)} m RIGHT` : `${Math.round(-c)} m LEFT`;
    return `${path} · ${line}`;
  }

  protected flySteps(): LessonStep[] {
    return [
      {
        title: 'Flare and touch down',
        say: ['t2_flare'],
        prompt: 'Throttle to idle with {throttleDown}; raise the nose gently with {noseUp}',
        highlight: ['throttleDown', 'noseUp'],
        detail: (f) => `Height ${Math.round(f.player.aglM)} m · sinking ${(-f.vsMps).toFixed(1)} m/s · ${kmh(f.iasMps)}`,
        done: (f) => f.player.onGround,
      },
      {
        title: 'Brake to a stop',
        say: ['t2_touchdown'],
        prompt: 'Brakes: the airbrake {brakes} brakes the wheels too. Keep straight with the rudder',
        highlight: ['brakes'],
        detail: (f) => kmh(f.iasMps),
        done: (f) => {
          const still = f.player.onGround && f.iasMps < 4;
          if (!still) this.stopped = -1;
          else if (this.stopped < 0) this.stopped = f.t;
          return still && f.t - this.stopped > 1;
        },
      },
    ];
  }

  protected override watch(f: ScriptFrame): void {
    this.app = approachTo(this.rwy, { x: f.player.x, y: f.player.y, z: f.player.z, headingRad: f.player.headingRad });
    const end = this.rwy.lengthM;
    // The objective marker: the runway threshold, until the wheels are on it.
    this.marks = f.player.onGround ? [] : [{ name: 'Runway 13', x: this.rwy.x, y: this.rwy.elevationM, z: this.rwy.z, objective: true }];
    if (!f.player.onGround) airmanship(this, f, { slowMps: 62 });
    // Missed it: past the far end still flying, or crossed the threshold far too high.
    const missed = !f.player.onGround && ((this.app.alongM < -end * 0.6 && f.player.aglM > 15) || (this.app.alongM < 0 && this.app.alongM > -400 && this.app.aboveM > 120));
    if (!this.goingAround && this.stepNo >= this.approachStep && missed) {
      this.goingAround = true;
      this.sayTagged(['t2_goaround'], undefined, RadioPriority.Urgent);
    }
    if (this.goingAround) {
      // Back on a long final, roughly lined up: fly the approach again.
      if (this.app.alongM > 7000 && Math.abs(this.app.crossM) < 1500 && Math.abs(this.app.headingOffRad) < 35 * DEG) {
        this.goingAround = false;
        this.goTo(this.approachStep, f);
      } else if (this.app.alongM < 6000 && this.ready('lineup', 40)) {
        this.sayTagged(['t2_lineup'], undefined, RadioPriority.Normal);
      }
    }
  }

  protected goAroundPrompt(): ScriptPrompt | undefined {
    if (!this.goingAround) return undefined;
    return { text: 'Go around: full power {throttleUp}, climb with {noseUp}, gear up {gear}. Turn back and line up on a long final (7 km+)', highlight: ['throttleUp', 'noseUp', 'gear'] };
  }

  override prompt(): ScriptPrompt | undefined {
    return this.goAroundPrompt() ?? super.prompt();
  }

  /** Coaching on the approach: high/low and left/right, on a cool-down. */
  protected coach(f: ScriptFrame, heavyWeather: boolean): void {
    if (f.player.onGround || this.goingAround) return;
    const a = this.app;
    if (a.alongM < 600) return;
    // Allowed error grows with distance (the glide path is wider far out).
    const tol = Math.max(18, a.alongM * 0.008);
    if (a.aboveM > tol * 2 && this.ready('gs', 14)) this.sayTagged(['t2_high']);
    else if (a.aboveM < -tol * 1.5 && this.ready('gs', 12)) this.sayTagged(['t2_low']);
    else if (Math.abs(a.aboveM) < tol * 0.6 && this.done('wasOff') && this.ready('onpath', 25)) this.sayTagged(['t2_onpath']);
    if (Math.abs(a.aboveM) > tol * 1.5) this.once('wasOff');
    const ctol = Math.max(40, a.alongM * 0.02);
    if (Math.abs(a.crossM) > ctol && this.ready('loc', heavyWeather ? 10 : 14)) {
      // Right of the line: steer left.
      this.sayTagged([a.crossM > 0 ? 't3_left' : 't3_right']);
      if (heavyWeather && this.once('crab')) this.sayTagged(['t3_crab']);
    }
  }
}

export class LandingLessonScript extends LandingLesson {
  protected readonly closing: readonly RadioClipId[] = ['t2_done'];

  constructor(layouts: readonly AirportLayout[]) {
    super(layouts);
    this.steps.push(
      {
        title: 'Slow down below 400 km/h',
        say: ['t2_intro'],
        prompt: 'Throttle back to about 50% with {throttleDown}. Keep the nose on the runway',
        highlight: ['throttleDown'],
        detail: (f) => `${kmh(f.iasMps)} · throttle ${Math.round(f.throttle * 100)}% · ${(this.app.alongM / 1000).toFixed(1)} km`,
        done: (f) => f.iasMps * KMH < 400,
      },
      {
        title: 'Gear down',
        say: ['t2_gear'],
        prompt: 'Lower the gear: press {gear}',
        highlight: ['gear'],
        detail: (f) => `Gear ${f.gearPos > 0.95 ? 'DOWN' : f.gearDown ? 'IN TRANSIT' : 'UP'}`,
        done: (f) => f.gearPos > 0.95,
      },
      {
        title: 'Airbrake out',
        say: ['t2_airbrake'],
        prompt: 'Extend the airbrake: press {airbrake}',
        highlight: ['airbrake'],
        detail: () => 'Airbrake IN',
        done: (f) => f.airbrake,
      },
      {
        title: 'Fly the glide path',
        say: ['t2_papi', 't2_speed'],
        prompt: 'PAPI: 2 white + 2 red. Nose {noseUp} / {noseDown} for the path, {throttleUp} / {throttleDown} for 270 km/h',
        highlight: ['noseUp', 'noseDown', 'throttleUp', 'throttleDown'],
        detail: (f) => `${(this.app.alongM / 1000).toFixed(1)} km · ${kmh(f.iasMps)} · ${this.glideText()}`,
        done: (f) => this.app.alongM < 250 || (f.player.aglM < 20 && this.app.alongM < 1500),
      },
      ...this.flySteps()
    );
    this.approachStep = 3;
    this.flareStep = 4;
  }

  protected override watch(f: ScriptFrame): void {
    super.watch(f);
    if (this.stepNo === this.approachStep) this.coach(f, false);
  }
}

export class WeatherLandingLesson extends LandingLesson {
  protected readonly closing: readonly RadioClipId[] = ['t3_done'];
  /** Cloud deck, m MSL (the farmland theatre's stratus: src/render/scene.ts DECK_LEVELS). */
  private readonly deckBase = 1150;
  private readonly deckTop = 1600;
  private wasInCloud = false;

  constructor(layouts: readonly AirportLayout[]) {
    super(layouts);
    this.steps.push(
      {
        title: 'Descend to 1,200 m',
        say: ['t3_intro'],
        prompt: 'Throttle back {throttleDown}, nose down {noseDown}. Descend into the cloud to 1,200 m',
        highlight: ['throttleDown', 'noseDown'],
        detail: (f) => `${metres(f.altMslM)} · descending ${Math.max(0, -f.vsMps).toFixed(0)} m/s · ${kmh(f.iasMps)}`,
        done: (f) => f.altMslM < 1320,
      },
      {
        title: 'Find the ILS needles',
        say: ['t3_ils'],
        prompt: 'Yellow needles on the HUD: steer toward the upright one. Hold 1,200 m until the flat one comes down to the centre',
        highlight: ['rollLeft', 'rollRight'],
        detail: () => this.glideText(),
        minSec: 4,
        done: () => this.app.aboveM > -40 || this.app.alongM < 15000,
      },
      {
        title: 'Gear down, airbrake out',
        say: ['t3_gear'],
        prompt: 'Gear down {gear}, airbrake out {airbrake}, then follow the glide path down',
        highlight: ['gear', 'airbrake'],
        detail: (f) => `Gear ${f.gearPos > 0.95 ? 'DOWN' : 'UP'} · airbrake ${f.airbrake ? 'OUT' : 'IN'}`,
        done: (f) => f.gearPos > 0.95 && f.airbrake,
      },
      {
        title: 'Fly the ILS to minimums',
        prompt: 'Keep both needles centred. Crosswind from the right: aim a little right. 270 km/h',
        highlight: ['rollLeft', 'rollRight', 'noseUp', 'noseDown'],
        detail: (f) => `${(this.app.alongM / 1000).toFixed(1)} km · ${kmh(f.iasMps)} · ${this.glideText()} · ${Math.round(f.player.aglM)} m`,
        done: (f) => f.player.aglM < 65 || this.app.alongM < 300,
      },
      {
        title: 'Minimums: land',
        say: ['t3_minimums'],
        prompt: 'Runway in sight: keep coming. Over the threshold, idle {throttleDown} and flare {noseUp}',
        highlight: ['throttleDown', 'noseUp'],
        detail: (f) => `${Math.round(f.player.aglM)} m · ${this.glideText()}`,
        done: (f) => f.player.aglM < 12 || this.app.alongM < 100,
      },
      ...this.flySteps()
    );
    this.approachStep = 3;
    this.flareStep = 5;
  }

  protected override watch(f: ScriptFrame): void {
    super.watch(f);
    const inCloud = f.altMslM < this.deckTop && f.altMslM > this.deckBase;
    if (inCloud && this.once('cloud')) this.sayTagged(['t3_cloud'], undefined, RadioPriority.High);
    if (inCloud) this.wasInCloud = true;
    if (this.wasInCloud && f.altMslM < this.deckBase - 80 && this.app.alongM < 9000 && this.once('breakout')) this.sayTagged(['t3_breakout'], undefined, RadioPriority.High);
    if (this.stepNo >= 2 && this.stepNo <= 4) this.coach(f, true);
  }
}

// ---- 4: Radar & target drones ------------------------------------------------------------------

const isMissile = (w: number): boolean => w === WeaponKindCode.ir_missile || w === WeaponKindCode.radar_missile;
const WEAPON_NAME: readonly string[] = ['Gun', 'Heat-seeking missile', 'Radar missile', 'Bomb', 'Rockets', 'Guided bomb', 'AGM', 'ARM'];

export class DroneLesson extends AirLesson {
  protected readonly closing: readonly RadioClipId[] = ['t4_kill2'];
  private readonly droneIds = new Set<EntityId>();
  private kills = 0;
  private missilesFired = 0;
  private nearest: { id: EntityId; rangeM: number } | undefined;
  private farSince = -1;

  constructor() {
    super();
    const RWS = RadarModeCode.rws;
    this.steps.push(
      {
        title: 'The radar scope',
        say: ['t4_intro'],
        prompt: 'The radar scope is bottom right: you are at the bottom, contacts are boxes',
        detail: (f) => `${f.trackCount} contact${f.trackCount === 1 ? '' : 's'} on the scope`,
        minSec: 6,
        done: (f) => !f.radioBusy,
      },
      {
        title: 'The radar warning receiver',
        say: ['t4_rwr'],
        prompt: 'The RWR (bottom left) shows radars looking at you, and beeps',
        minSec: 6,
        skip: (f) => f.rwrCount === 0,
        done: (f) => !f.radioBusy,
      },
      {
        title: 'Change the radar mode',
        say: ['t4_mode'],
        prompt: 'Press {radarMode} to switch the radar to dogfight mode (ACM)',
        highlight: ['radarMode'],
        detail: (f) => `Radar: ${f.radarMode === RWS ? 'RWS (search)' : 'ACM (dogfight)'}`,
        done: (f, s) => f.radarMode !== s.radarMode,
      },
      {
        title: 'Back to search',
        say: ['t4_mode_back'],
        prompt: 'Press {radarMode} again: back to search (RWS)',
        highlight: ['radarMode'],
        detail: (f) => `Radar: ${f.radarMode === RWS ? 'RWS (search)' : 'ACM (dogfight)'}`,
        done: (f) => f.radarMode === RWS,
      },
      {
        title: 'Zoom the scope',
        say: ['t4_range'],
        prompt: 'Change the scope range: {radarRange}',
        highlight: ['radarRange'],
        detail: (f, s) => `${Math.min(2, f.radarRangeChanges - s.radarRangeChanges)} of 2 changes`,
        done: (f, s) => f.radarRangeChanges - s.radarRangeChanges >= 2,
      },
      {
        title: 'Designate a drone',
        say: ['t4_target'],
        prompt: 'Press {target} to designate the nearest drone',
        highlight: ['target'],
        detail: () => this.rangeText(),
        done: (f) => this.droneIds.has(f.targetId as EntityId),
      },
      {
        title: 'Select a missile',
        say: ['t4_select'],
        prompt: 'Press {weapon} until a missile is selected (ASRAAM: heat-seeker, Astra: radar)',
        highlight: ['weapon'],
        detail: (f) => `Selected: ${WEAPON_NAME[f.weaponIdx] ?? '?'}`,
        skip: (f) => isMissile(f.weaponIdx),
        done: (f) => isMissile(f.weaponIdx),
      },
      {
        title: 'Lock on',
        say: ['t4_lock'],
        prompt: (f) =>
          !isMissile(f.weaponIdx)
            ? 'Select a missile: {weapon}'
            : !this.droneIds.has(f.targetId as EntityId)
              ? 'Lost it: press {target} again'
              : f.weaponIdx === WeaponKindCode.ir_missile
                ? 'Heat-seeker: point the nose at the box, inside about 10 km, and wait for LOCK'
                : 'Keep the box inside the radar scan and wait for LOCK',
        highlight: ['target'],
        detail: (f) => `${this.rangeText()} · ${f.lockState === LockStateCode.locked ? 'LOCKED' : f.lockState === LockStateCode.tracking ? 'TRACKING' : 'NO LOCK'}`,
        done: (f) => f.lockState === LockStateCode.locked && this.droneIds.has(f.targetId as EntityId),
      },
      {
        title: 'Fire a missile',
        say: ['t4_fire'],
        prompt: (f) => (f.weaponIdx === WeaponKindCode.gun ? 'Gun selected: press {weapon} for a missile, then {launch}' : 'Press {launch} to fire'),
        highlight: ['launch'],
        detail: (f) => `${this.rangeText()} · ${f.lockState === LockStateCode.locked ? 'LOCKED' : 'NO LOCK: wait, or {target}'}`.replace('{target}', 'T'),
        done: () => this.missilesFired > 0 || this.kills > 0,
      },
      {
        title: 'Splash the first drone',
        say: ['t4_fox'],
        prompt: 'Watch the missile. If it misses: lock again ({target}) and fire ({launch})',
        highlight: ['target', 'launch'],
        detail: () => this.rangeText(),
        done: () => this.kills >= 1,
      },
      {
        title: 'Guns: the second drone',
        say: ['t4_kill1', 't4_gun'],
        prompt: (f) =>
          f.weaponIdx !== WeaponKindCode.gun ? 'Press {weapon} until GUN is selected' : (this.nearest?.rangeM ?? 1e9) > 1000 ? 'Get behind the drone, inside 1 km' : 'Pipper on the drone: hold {trigger}',
        highlight: ['weapon', 'trigger'],
        detail: (f) => `${f.weaponIdx === WeaponKindCode.gun ? 'GUN' : 'Select the GUN'} · ${this.rangeText()}`,
        done: () => this.kills >= 2,
      }
    );
    this.gunStep = this.steps.length - 1;
  }

  /** The guns step's index. */
  private readonly gunStep: number;

  private rangeText(): string {
    const n = this.nearest;
    return n ? `Drone ${(n.rangeM / 1000).toFixed(1)} km` : 'Drone';
  }

  protected override watch(f: ScriptFrame): void {
    for (const h of f.hostiles) this.droneIds.add(h.id);
    // The nearest drone, and the markers.
    let best: { id: EntityId; rangeM: number } | undefined;
    for (const h of f.hostiles) {
      const r = Math.hypot(h.x - f.player.x, h.y - f.player.y, h.z - f.player.z);
      if (!best || r < best.rangeM) best = { id: h.id, rangeM: r };
    }
    this.nearest = best;
    this.marks = f.hostiles.map((h) => ({ name: 'Drone', x: h.x, y: h.y, z: h.z, objective: true }));
    airmanship(this, f, { slowMps: 85 });
    // Gun step: far from the drone for a while: "get closer".
    if (this.stepNo === this.gunStep && best && best.rangeM > 3000) {
      if (this.farSince < 0) this.farSince = f.t;
      if (f.t - this.farSince > 25 && this.ready('closer', 30)) this.sayTagged(['t4_closer']);
    } else this.farSince = -1;
    if (this.expired('missed') && this.kills === 0) this.sayTagged(['t4_missed'], undefined, RadioPriority.High);
  }

  override event(e: SimEvent, playerId: EntityId): void {
    if (e.type === 'missileLaunch' && e.shooterId === playerId && (e.weapon === 'ir_missile' || e.weapon === 'radar_missile')) {
      this.missilesFired += 1;
      this.own(e.weapon === 'ir_missile' ? 'p_cadet_fox2' : 'p_cadet_fox3', e.weapon === 'ir_missile' ? 'Fox 2!' : 'Fox 3!');
      this.arm('missed', 35);
    } else if (e.type === 'gunFire' && e.shooterId === playerId && this.stepNo === this.gunStep && this.ready('guns', 30)) {
      this.own('p_cadet_guns', 'Guns, guns!');
    } else if (e.type === 'kill' && this.droneIds.has(e.targetId)) {
      this.kills += 1;
      this.disarm('missed');
      if (e.sourceId === playerId) this.own('p_cadet_splash', 'Splash one!');
    }
  }
}
