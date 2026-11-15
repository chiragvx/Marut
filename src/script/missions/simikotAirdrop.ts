/**
 * src/script/missions/simikotAirdrop.ts — "Simikot Lifeline": a C-17 (Skylord 1) airdrops supplies
 * for the Nepal Army on the runway at Simikot, Humla, on a clear morning. The war-room intro
 * (src/briefing) tells the story, so the radio is sparse: Netra (the AWACS) checks the jet in and
 * closes the mission, and the drop itself is the loadmaster's, on the intercom at the ramp (ids lm_*,
 * played dry and close, not through the radio: src/script/radioPlayer.ts). The approach is flown on
 * the HUD's ILS needles (Mission.dropApproach: a localiser and 3° glidepath up the Karnali gorge on
 * 315 to 150 m over the strip); the loadmaster opens the ramp, counts down from the computed
 * release point (CARP: where a stick released now would land, src/core/airdrop.ts predictCdsDrop),
 * calls the green light and the load clear, and reports where the bundles came down.
 *
 * The threat is a surprise: a MANPADS pair at a forward post at the foot of the ridge north-west of
 * the field (a hidden ground group: no steerpoint, mark or briefing line) opens fire once the jet is
 * past the strip, and the loadmaster calls it from the ramp ("missile launch, left side, flares!").
 * Flares, full power, and the climb-out (a left turn with the valley, through the notch at the
 * strip's west end, src/terrain/himalaya/layout.ts 'simikot-west').
 *
 *   1 Inbound      the glidepath from the south-east; jettison fuel if wanted (not needed)
 *   2 Run-in/drop  ramp open, ~150 m over the strip, 180 kt (flaps 1/2), release on green: the
 *                  whole load (16 bundles, one stick) in one pass
 *   3 Climb-out    flares, full power, flaps up, left with the valley, out of the MANPADS' reach
 *   4 Complete     Netra's closing call, then the debrief
 *
 * A miss (centre of the stick 350 m or more from the T, or the loads wrecked by a release too low)
 * means another pass, as many as it takes (reserve bundles once the rigged load is gone). The
 * mission ends in success once all three objectives are met (missionComplete): an acceptable stick
 * on the ground, the threat behind the jet (no missile warning for a few seconds and out of the
 * teams' reach, or never fired on), and a safe climb-out (4,000 m or 8 km from the strip); the
 * sim ends it in failure if the jet is lost.
 *
 * Why the run-in is not the runway's own axis: the straight runway 28 final crosses a 4,800 m ridge
 * 5-7 km east of the field (real Simikot has a curved approach up a ravine). The Karnali gorge from
 * the south-east is the one straight line onto the strip with a 3° path clear of the ground, so the
 * run-in crosses the strip at ~30° on 315.
 */
import type { DropApproach, EntityId, SimEvent } from '../../contracts/core';
import { AirdropStateCode, WarningBit } from '../../contracts/core';
import { cdsRollOut, predictCdsDrop } from '../../core/airdrop';
import { dropBeamAt, newDropBeamState } from '../../core/dropBeam';
import { ScriptBase, type ScriptAtmosphere, type ScriptFrame, type ScriptPrompt } from '../director';
import { RadioPriority, compose, line, type RadioClipId } from '../radio';
import { bearingDeg } from '../geo';

const KT = 0.514444;
const STEPS = 4;

/** The DZ: the middle of the strip at Simikot, and its height. */
export const DZ = { x: 70811.5, z: 73382.2 } as const;
export const DZ_GROUND_M = 2971;
/** The run-in course, deg true (up the gorge from the south-east). */
export const RUN_IN_DEG = 315;
export const SIMIKOT = DZ;
/** The approach the mission flies when it gives none (himalayaAirdrop.json carries the same). */
export const SIMIKOT_APPROACH: DropApproach = { pos: { ...DZ }, groundM: DZ_GROUND_M, courseRad: (RUN_IN_DEG * Math.PI) / 180, glideDeg: 3, heightAglM: 150, rangeM: 34000 };
/** Where the climb-out heads once through the notch: up the Karnali, 4 km west of the strip. */
export const CLIMB_OUT = { x: DZ.x - 3600, z: DZ.z - 950 } as const;
/**
 * The drop speed, KIAS (the HUD's speed is IAS), and the "too fast" call. At the mission's weight
 * (~177 t) the alpha limiter holds level flight down to ~165 KIAS flaps up, ~145 with slats and
 * ~130 with flaps 1/2 at Simikot's height; 180 kt with flaps 1/2 leaves a wide margin either side
 * (and is inside the 1/2 placard, 250 kt; the 3/4 detent's 190 kt is too close).
 */
export const DROP_KT = 180;
export const TOO_FAST_KT = 220;
/** The bundles one release drops when the mission does not say (himalayaAirdrop.json: the whole load, 16). */
export const STICK = 16;
/**
 * Where the hidden MANPADS pair is when the mission does not say (himalayaAirdrop.json
 * 'manpads-ridge'): a forward post at the foot of the ridge north-west of the strip, 2.3 km out,
 * a little below the strip's level, overlooking the valley the climb-out turns into.
 */
export const THREAT_POS = { x: 68711, z: 72332 } as const;
/** Out of the teams' reach: their missiles' range (5 km) and a margin. */
export const THREAT_CLEAR_M = 6000;
/** A safe climb-out: this high (MSL), or this far from the strip. */
export const CLIMB_OUT_ALT_M = 4000;
export const CLIMB_OUT_DIST_M = 8000;
/** The missile warning must have been quiet this long, s. */
const WARN_QUIET_SEC = 5;
/** The run-in starts this far out on the approach. */
const RUN_IN_M = 14000;
/** The subtitle label of the loadmaster's intercom calls. */
export const LOADMASTER = 'LOADMASTER';

/** Grade bands of a stick's centre from the T, m. */
export const GRADE_BANDS = { excellent: 60, good: 175, acceptable: 350 } as const;
export type DropGrade = 'excellent' | 'good' | 'acceptable' | 'miss' | 'destroyed';

/** A stick's grade: its centre's distance from the DZ, and how many of its bundles were wrecked. */
export function gradeDrop(distM: number, destroyed: number, count: number): DropGrade {
  if (count > 0 && destroyed * 2 > count) return 'destroyed';
  if (distM < GRADE_BANDS.excellent) return 'excellent';
  if (distM < GRADE_BANDS.good) return 'good';
  if (distM < GRADE_BANDS.acceptable) return 'acceptable';
  return 'miss';
}

export const gradeSucceeds = (g: DropGrade): boolean => g === 'excellent' || g === 'good' || g === 'acceptable';

const GRADE_TEXT: Record<DropGrade, string> = { excellent: 'Excellent', good: 'Good', acceptable: 'Acceptable', miss: 'Miss', destroyed: 'Loads destroyed' };

/** The loadmaster's call on each grade (what the ramp sees of the loads coming down). */
const GRADE_CALL: Record<DropGrade, RadioClipId> = {
  excellent: 'lm_drop_shack',
  good: 'lm_drop_good',
  acceptable: 'lm_drop_ok',
  miss: 'lm_drop_miss',
  destroyed: 'lm_drop_destroyed',
};

interface Stick {
  stickId: number;
  count: number;
  iasMps: number;
  aglM: number;
  landed: { x: number; z: number; destroyed: boolean }[];
  grade?: DropGrade;
  distM?: number;
}

type Phase = 'inbound' | 'runin' | 'egress' | 'reattack' | 'done';

export class SimikotAirdropScript extends ScriptBase {
  override readonly outroSec = 6;
  private phase: Phase = 'inbound';
  private readonly wind: { x: number; y: number; z: number };
  private readonly approach: DropApproach;
  private readonly beam = newDropBeamState();
  private readonly sticks: Stick[] = [];
  private readonly stick: number;
  private launches = 0;
  private passReleased = false;
  private greenGiven = false;
  private oneMinGiven = false;
  private tenGiven = false;
  /** The ramp's position last frame (the opening / open / closing calls are on its movement). */
  private lastRamp = 0;
  private rampOpenCalled = false;
  private rampClosingCalled = false;
  /** When the last bundle of the stick just released is out (the "load clear" call), s; -1 none pending. */
  private loadClearAt = -1;
  private loadClearCount = 0;
  /** The release point now (CARP) and how far ahead of the jet it is along the track, m. */
  private carp: { x: number; z: number; aheadM: number } | undefined;
  private carpAt = -1;
  private hits = 0;
  private succeeded = false;
  private completeAt = -1;
  private lastWarnAt = -Infinity;
  private readonly threat: { x: number; z: number };
  private result: 'success' | undefined;
  private endAt = -1;
  private lastFrame: ScriptFrame | undefined;
  private readonly atmos: ScriptAtmosphere;

  constructor(wind: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }, approach: DropApproach = SIMIKOT_APPROACH, threat: { x: number; z: number } = THREAT_POS, stick: number = STICK) {
    super('NETRA', 'SKYLORD 1');
    this.wind = { ...wind };
    this.approach = approach;
    this.threat = { x: threat.x, z: threat.z };
    this.stick = Math.max(1, Math.floor(stick));
    // A clear morning; the T and smoke on the strip.
    this.atmos = { timeOfDayH: 9.5, markers: dzMarkers() };
  }

  atmosphere(): ScriptAtmosphere {
    return this.atmos;
  }

  outcome(): 'success' | undefined {
    return this.t >= this.endAt && this.endAt >= 0 ? this.result : undefined;
  }

  /** The sticks so far (tests, debrief). */
  drops(): readonly Readonly<Stick>[] {
    return this.sticks;
  }

  currentPhase(): Phase {
    return this.phase;
  }

  /** The three objectives (missionComplete ends the mission when all are met). */
  objectives(): { drop: boolean; threatClear: boolean; climbedOut: boolean } {
    const f = this.lastFrame;
    if (!f) return { drop: this.succeeded, threatClear: false, climbedOut: false };
    const p = f.player;
    const quiet = (f.warningBits & WarningBit.MissileLaunch) === 0 && f.t - this.lastWarnAt >= WARN_QUIET_SEC;
    const away = this.launches === 0 || Math.hypot(this.threat.x - p.x, this.threat.z - p.z) > THREAT_CLEAR_M;
    return {
      drop: this.succeeded,
      // Only after a release: before it, the threat is still ahead.
      threatClear: this.sticks.length > 0 && quiet && away,
      climbedOut: f.altMslM > CLIMB_OUT_ALT_M || Math.hypot(DZ.x - p.x, DZ.z - p.z) > CLIMB_OUT_DIST_M,
    };
  }

  /** When the mission was completed (the closing call), s; -1 before. */
  completedAt(): number {
    return this.completeAt;
  }

  /** Missiles fired at the jet so far (the surprise is sprung on the first). */
  missileLaunches(): number {
    return this.launches;
  }

  results(): { tiles: { label: string; value: string }[]; lines: string[] } {
    const graded = this.sticks.filter((s) => s.grade);
    const best = graded.filter((s) => gradeSucceeds(s.grade!)).sort((a, b) => a.distM! - b.distM!)[0];
    const wrecked = this.sticks.reduce((n, s) => n + s.landed.filter((l) => l.destroyed).length, 0);
    return {
      tiles: [
        { label: 'Drop', value: best ? `${GRADE_TEXT[best.grade!]} · ${Math.round(best.distM!)} m` : 'None' },
        { label: 'Passes', value: String(graded.length) },
        { label: 'Missiles evaded', value: this.launches > 0 ? `${Math.max(0, this.launches - this.hits)} of ${this.launches}` : 'None fired' },
        ...(wrecked > 0 ? [{ label: 'Bundles wrecked', value: String(wrecked) }] : []),
      ],
      lines: graded.map(
        (s, i) =>
          `Pass ${i + 1}: ${GRADE_TEXT[s.grade!]}, centre ${Math.round(s.distM!)} m from the T · released at ${Math.round(s.iasMps / KT)} kt, ${Math.round(s.aglM)} m above the ground · ${s.landed.filter((l) => l.destroyed).length} of ${s.count} wrecked`
      ),
    };
  }

  prompt(): ScriptPrompt | undefined {
    const f = this.lastFrame;
    if (!f || !f.player.alive || this.phase === 'done') return undefined;
    if ((f.warningBits & WarningBit.MissileLaunch) !== 0) return { text: 'Missile! Flares {flare} · full power', highlight: ['flare', 'throttleUp'] };
    if (this.phase === 'reattack') return { text: 'Come around: climb west with the valley, turn back above 5,000 m, rejoin the glidepath from the south-east', highlight: [] };
    if (this.phase === 'egress') return { text: 'Climb out: full power, flaps up, turn left with the valley', highlight: ['throttleUp'] };
    if (this.phase === 'inbound') {
      if (f.fuelDumping) return { text: 'Jettisoning fuel (optional): switch off {fuelDump} when you want', highlight: ['fuelDump'] };
      return { text: `Fly the glidepath (HUD needles) · flaps 1/2 · ${DROP_KT} kt`, highlight: [] };
    }
    // Run-in.
    if ((f.rampPos ?? 0) < 0.98) return { text: 'Open the ramp {ramp}', highlight: ['ramp'] };
    if (this.greenGiven && !this.passReleased) return { text: 'GREEN LIGHT: release {drop}', highlight: ['drop'] };
    return { text: `Hold the glidepath, ${DROP_KT} kt · release {drop} on the green light`, highlight: ['drop'] };
  }

  /** The loadmaster, on the intercom at the ramp. */
  private crew(priority: RadioPriority, ...parts: RadioClipId[]): void {
    const p = compose(...parts.map((x) => line(x)));
    this.pushTx({ from: LOADMASTER, text: p.text, clips: p.clips, priority, maxAgeSec: priority === 0 ? 4 : priority === 1 ? 8 : 15, intercom: true });
  }

  update(f: ScriptFrame): void {
    this.t = f.t;
    this.lastFrame = f;
    const p = f.player;
    const b = dropBeamAt({ x: p.x, y: p.y, z: p.z }, this.approach, this.beam);
    this.updateMarks();
    if (!p.alive) return;
    if ((f.warningBits & WarningBit.MissileLaunch) !== 0) this.lastWarnAt = f.t;

    const dDz = Math.hypot(DZ.x - p.x, DZ.z - p.z);
    const fuelT = (f.fuelKg ?? 0) / 1000;

    // Netra checks the jet in: the intro has told the story.
    if (f.t > 2 && this.once('brief')) this.say(RadioPriority.Normal, 'ad_netra', 'ad_checkin');

    if (this.loadClearAt >= 0 && f.t >= this.loadClearAt) {
      this.loadClearAt = -1;
      this.crew(RadioPriority.High, this.loadClearCount === 16 ? 'lm_load_clear_16' : 'lm_load_clear');
    }
    this.rampCalls(f);

    // On the approach side, lined up: the run-in (again, after a pass that came round).
    const lined = b.alongM > 2500 && b.alongM < RUN_IN_M && Math.abs(b.crossM) < Math.max(400, b.alongM * 0.35) && towards(p, DZ);
    if (this.phase === 'inbound' || this.phase === 'reattack') {
      if (this.phase === 'inbound') {
        this.setObjective(1, STEPS, 'Fly the glidepath to Simikot', `${(dDz / 1000).toFixed(1)} km · glidepath ${Math.round(b.pathAltM)} m (you ${fmtSigned(b.highM)} m) · fuel ${fuelT.toFixed(1)} t${f.fuelDumping ? ' (jettisoning)' : ''}`);
      } else {
        this.setObjective(2, STEPS, 'Come around for another pass', `${(dDz / 1000).toFixed(1)} km · rejoin the glidepath south-east of the field, track 315 · ${this.sticks.length} pass${this.sticks.length === 1 ? '' : 'es'} so far`);
      }
      if (lined) this.startRunIn();
    }

    if (this.phase === 'runin') this.runIn(f, dDz);

    if (this.phase === 'egress') {
      const o = this.objectives();
      const dOut = Math.hypot(CLIMB_OUT.x - p.x, CLIMB_OUT.z - p.z);
      const todo = [
        !o.drop ? 'drop not graded yet' : '',
        !o.threatClear ? (this.launches > 0 ? 'get clear of the missiles' : 'clear the area') : '',
        !o.climbedOut ? 'climb to 4,000 m' : '',
      ].filter(Boolean);
      this.setObjective(3, STEPS, 'Climb out: full power, left with the valley', `${Math.round(f.altMslM)} m · valley ${(dOut / 1000).toFixed(1)} km${todo.length ? ' · ' + todo.join(' · ') : ''}`);
      if (o.drop && o.threatClear && o.climbedOut) this.missionComplete();
    }

    if (this.phase === 'done') this.setObjective(4, STEPS, 'Supplies delivered', 'Mission complete');
  }

  /** The loadmaster on the ramp: coming open, open and the load ready, closing after the drop. */
  private rampCalls(f: ScriptFrame): void {
    const ramp = f.rampPos ?? 0;
    const opening = ramp > this.lastRamp + 1e-4;
    const closing = ramp < this.lastRamp - 1e-4;
    this.lastRamp = ramp;
    if (this.phase === 'done') return;
    const loadAboard = !this.passReleased;
    if (opening && ramp < 0.5 && loadAboard && this.ready('rampOpening', 30)) {
      this.rampOpenCalled = false;
      this.crew(RadioPriority.Normal, 'lm_ramp_opening');
    }
    if (ramp >= 0.98 && loadAboard && !this.rampOpenCalled) {
      this.rampOpenCalled = true;
      this.crew(RadioPriority.Normal, 'lm_ramp_open');
    }
    // Closing after the drop (called once the load is clear: the crew closes up behind it).
    if (closing && this.passReleased && this.loadClearAt < 0 && !this.rampClosingCalled) {
      this.rampClosingCalled = true;
      this.crew(RadioPriority.Normal, 'lm_ramp_closing');
    }
  }

  /** All three objectives met: Netra's closing call, and the debrief once it has been said. */
  private missionComplete(): void {
    this.phase = 'done';
    this.completeAt = this.t;
    this.result = 'success';
    this.endAt = this.t + this.outroSec;
    this.say(RadioPriority.Urgent, 'ad_netra', 'ad_complete', 'ad_home');
  }

  private startRunIn(): void {
    this.phase = 'runin';
    this.passReleased = false;
    this.greenGiven = false;
    this.oneMinGiven = false;
    this.tenGiven = false;
    this.rampClosingCalled = false;
  }

  /** Bundles the next release drops (the rigged load, then reserve sticks). */
  private nextStickCount(f: ScriptFrame): number {
    const left = f.airdropLeft ?? 0;
    return left > 0 ? Math.min(this.stick, left) : this.stick;
  }

  /** The run-in: the CARP, the countdown and the green light, and the checks on the ramp, speed and height. */
  private runIn(f: ScriptFrame, dDz: number): void {
    const p = f.player;
    const gs = Math.hypot(p.vx, p.vz);
    if (f.t - this.carpAt >= 0.2 && gs > 20) {
      this.carpAt = f.t;
      const hit = predictCdsDrop({ x: p.x, y: p.y, z: p.z }, { x: p.vx, y: p.vy, z: p.vz }, DZ_GROUND_M, this.wind, this.nextStickCount(f));
      const tx = p.vx / gs;
      const tz = p.vz / gs;
      const dx = DZ.x - hit.x;
      const dz = DZ.z - hit.z;
      this.carp = { x: p.x + dx, z: p.z + dz, aheadM: dx * tx + dz * tz };
    }
    const ahead = this.carp?.aheadM ?? dDz;
    const ias = f.iasMps;
    // Height above the strip (the gorge under the run-in is far lower).
    const overDz = p.y - DZ_GROUND_M;
    const ramp = (f.rampPos ?? 0) >= 0.98;
    this.setObjective(
      2,
      STEPS,
      this.passReleased ? 'Load away: climb out' : 'Run in and drop on the strip',
      `${(dDz / 1000).toFixed(1)} km · release in ${Math.max(0, Math.round(ahead / Math.max(gs, 1)))} s · ${Math.round(overDz)} m over the strip · ${Math.round(ias / KT)} kt · ramp ${ramp ? 'OPEN' : 'CLOSED'}`
    );
    if (this.passReleased) return;
    const secs = ahead / Math.max(gs, 1);
    if (secs < 90 && secs > 25 && (f.rampPos ?? 0) < 0.02 && this.ready('ramp', 30)) this.crew(RadioPriority.High, 'lm_ramp_needed');
    if (secs < 62 && secs > 30 && !this.oneMinGiven) {
      this.oneMinGiven = true;
      this.crew(RadioPriority.Normal, 'lm_one_min');
    }
    if (secs < 30 && secs > 3) {
      if (overDz < 90 && this.ready('low', 10)) this.crew(RadioPriority.High, 'lm_too_low');
      else if (ias > TOO_FAST_KT * KT && this.ready('fast', 10)) this.crew(RadioPriority.High, 'lm_too_fast');
    }
    if (secs < 11.5 && secs > 6 && ramp && !this.tenGiven) {
      this.tenGiven = true;
      this.crew(RadioPriority.High, 'lm_ten_sec');
    }
    // Green a second and a half early: the call takes that long to say.
    if (!this.greenGiven && ramp && f.airdropState === AirdropStateCode.Armed && ahead < gs * 1.5 && ahead > -gs * 2) {
      this.greenGiven = true;
      this.crew(RadioPriority.Urgent, 'lm_green');
    }
    if (ahead < -gs * 4 && dDz < 4000 && this.ready('overshoot', 20)) {
      this.crew(RadioPriority.High, 'lm_no_drop');
      this.phase = 'reattack';
    }
  }

  /** Navigation: the DZ only (the route's one steerpoint); on the run-in, the release point too (a bare diamond: the DZ marker already carries the name and distance); after the drop, the valley to climb out along. */
  private updateMarks(): void {
    const m: { name: string; x: number; y: number; z: number; objective: true }[] = [];
    if (this.phase === 'runin' && this.carp && !this.passReleased) m.push({ name: '', x: this.carp.x, y: DZ_GROUND_M, z: this.carp.z, objective: true });
    if (this.phase === 'egress') m.push({ name: 'CLIMB OUT', x: CLIMB_OUT.x, y: 2600, z: CLIMB_OUT.z, objective: true });
    this.marks = m;
  }

  /** Which side of the jet a launch is on, seen from its cockpit (the loadmaster calls it). */
  private launchSide(pos: { x: number; z: number } | undefined): 'left' | 'right' {
    const f = this.lastFrame;
    if (!f || !pos) return 'left';
    const h = f.player.headingRad;
    // Right of the nose: (cos h, sin h) in world x, z (heading 0 = north = -z).
    return (pos.x - f.player.x) * Math.cos(h) + (pos.z - f.player.z) * Math.sin(h) >= 0 ? 'right' : 'left';
  }

  event(e: SimEvent, playerId: EntityId): void {
    switch (e.type) {
      case 'airdropRelease': {
        if (e.entityId !== playerId) break;
        this.sticks.push({ stickId: e.stickId, count: e.count, iasMps: e.iasMps, aglM: e.aglM, landed: [] });
        this.passReleased = true;
        // "Load clear" once the last bundle of the stick is over the sill.
        this.loadClearCount = e.count;
        this.loadClearAt = this.t + cdsRollOut(Math.max(0, e.count - 1)).sec + 0.4;
        if (this.phase !== 'done') this.phase = 'egress';
        break;
      }
      case 'airdropLanded': {
        if (e.entityId !== playerId) break;
        const s = this.sticks.find((x) => x.stickId === e.stickId);
        if (!s || s.grade) break;
        s.landed.push({ x: e.pos.x, z: e.pos.z, destroyed: e.destroyed });
        if (s.landed.length >= s.count) this.grade(s);
        break;
      }
      case 'missileLaunch':
        // Nothing but the hidden teams fires in this mission (the C-17 has no missiles).
        if (e.shooterId === playerId) break;
        this.launches += 1;
        // The loadmaster sees it go up from the ramp: the first (the surprise) and each after.
        if (this.launches === 1 || this.ready('sam', 6)) {
          this.ready('sam', 6);
          this.crew(RadioPriority.Urgent, this.launchSide(e.pos) === 'left' ? 'lm_launch_left' : 'lm_launch_right');
        }
        break;
      case 'hit':
        if (e.targetId !== playerId) break;
        this.hits += 1;
        if (this.ready('hit', 8)) this.crew(RadioPriority.Urgent, 'lm_hit');
        break;
      default:
        break;
    }
  }

  private grade(s: Stick): void {
    const n = s.landed.length;
    const cx = s.landed.reduce((a, l) => a + l.x, 0) / n;
    const cz = s.landed.reduce((a, l) => a + l.z, 0) / n;
    s.distM = Math.hypot(cx - DZ.x, cz - DZ.z);
    const destroyed = s.landed.filter((l) => l.destroyed).length;
    s.grade = gradeDrop(s.distM, destroyed, n);
    this.crew(RadioPriority.High, GRADE_CALL[s.grade]);
    if (gradeSucceeds(s.grade)) {
      this.succeeded = true;
      if (this.phase === 'runin' || this.phase === 'reattack') this.phase = 'egress';
    } else if (!this.succeeded && this.phase !== 'runin') this.phase = 'reattack';
  }
}

/** Heading within 60° of the bearing to `to`. */
function towards(p: { x: number; z: number; headingRad: number }, to: { x: number; z: number }): boolean {
  const brg = bearingDeg(p.x, p.z, to.x, to.z);
  const hdg = ((p.headingRad * 180) / Math.PI + 360) % 360;
  return Math.abs((((brg - hdg) % 360) + 540) % 360 - 180) < 60;
}

const fmtSigned = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v))}`;

/** The DZ's marks on the strip: a lit T (bar across the run-in at the DZ, stem back towards the approach) and orange smoke beside it. */
function dzMarkers(): NonNullable<ScriptAtmosphere['markers']> {
  const r = (RUN_IN_DEG * Math.PI) / 180;
  const tx = Math.sin(r);
  const tz = -Math.cos(r);
  // Across the track (to the right of the run-in).
  const lx = -tz;
  const lz = tx;
  const lamp = (along: number, across: number) => ({ x: DZ.x + tx * along + lx * across, z: DZ.z + tz * along + lz * across, aglM: 1.2, r: 2.6, g: 1.7, b: 0.7 });
  const lamps = [-40, -20, 0, 20, 40].map((a) => lamp(0, a));
  for (const b of [25, 50, 75, 100]) lamps.push(lamp(-b, 0));
  // A red beacon at the far end of the stem (the approach end), for the line-up.
  lamps.push({ ...lamp(-130, 0), r: 3, g: 0.25, b: 0.15 });
  // The smoke on the strip's edge beside the T (the wind drifts it across).
  return { lamps, smoke: [{ x: DZ.x + lx * 60, z: DZ.z + lz * 60, aglM: 0, r: 1.0, g: 0.42, b: 0.1 }] };
}
