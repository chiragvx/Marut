/**
 * src/script/missions/simikotAirdrop.ts — "Simikot Lifeline": a C-17 (Skylord 1) airdrops supplies
 * for the Nepal Army on the runway at Simikot, Humla, on a clear morning. Netra briefs (the Chinese
 * advance from Hilsa, the optional fuel jettison); Simikot Tower, a Nepalese controller on the
 * ground, talks the jet down the glidepath (Mission.dropApproach: a localiser and 3° glidepath up
 * the Karnali gorge on 315 to 150 m over the strip, flown on the HUD's ILS needles). Netra gives
 * the red and green lights from the computed release point (CARP: where a stick released now would
 * land, src/core/airdrop.ts predictCdsDrop) and grades each stick where it lands.
 *
 * The threat is a surprise: MANPADS teams on the ridge north-west of the field (a hidden ground
 * group: no steerpoint, mark or briefing line) open fire on the run-in, and the tower calls it as the
 * first missile goes up. Flares, full power, and the climb-out (a left turn with the valley, through
 * the notch at the strip's west end, src/terrain/himalaya/layout.ts 'simikot-west').
 *
 *   1 Inbound      the glidepath from the south-east; jettison fuel if wanted (not needed)
 *   2 Run-in/drop  ramp open, ~150 m over the strip, 180 kt (flaps 1/2), release on green
 *   3 Climb-out    flares, full power, left with the valley
 *   4 (bonus)      land at Simikot, or leave the area
 *
 * A miss (centre of the stick 350 m or more from the T, or the loads wrecked by a release too low)
 * means another pass, as many as it takes (reserve bundles once the rigged load is gone). The
 * mission ends in success once an acceptable stick is down and the jet is clear (landed at Simikot,
 * 30 km away or 8 minutes later); the sim ends it in failure if the jet is lost.
 *
 * Why the run-in is not the runway's own axis: the straight runway 28 final crosses a 4,800 m ridge
 * 5-7 km east of the field (real Simikot has a curved approach up a ravine). The Karnali gorge from
 * the south-east is the one straight line onto the strip with a 3° path clear of the ground, so the
 * run-in crosses the strip at ~30° on 315.
 */
import type { DropApproach, EntityId, SimEvent } from '../../contracts/core';
import { AirdropStateCode, WarningBit } from '../../contracts/core';
import { predictCdsDrop } from '../../core/airdrop';
import { dropBeamAt, newDropBeamState } from '../../core/dropBeam';
import { ScriptBase, type ScriptAtmosphere, type ScriptFrame, type ScriptPrompt } from '../director';
import { RadioPriority, compassPhrase, compose, distancePhrase, line, type RadioClipId } from '../radio';
import { bearingDeg, compass8 } from '../geo';

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
/** Fuel the jettison advice aims at, kg. */
export const ADVISED_FUEL_KG = 30000;
/**
 * The drop speed, KIAS (the HUD's speed is IAS), and the "too fast" call. At the mission's weight
 * (~188 t) the alpha limiter holds level flight down to ~170 KIAS flaps up, ~150 with slats and
 * ~135 with flaps 1/2 at Simikot's height; 180 kt with flaps 1/2 leaves a wide margin either side
 * (and is inside the 1/2 placard, 250 kt; the 3/4 detent's 190 kt is too close).
 */
export const DROP_KT = 180;
export const TOO_FAST_KT = 220;
/** The run-in starts this far out on the approach. */
const RUN_IN_M = 14000;

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
  private lastWarn = 0;
  private launches = 0;
  private dumped = false;
  private everDumping = false;
  private passReleased = false;
  private greenGiven = false;
  private redGiven = false;
  /** The release point now (CARP) and how far ahead of the jet it is along the track, m. */
  private carp: { x: number; z: number; aheadM: number } | undefined;
  private carpAt = -1;
  private hits = 0;
  private engineOutCalled = false;
  private succeeded = false;
  private completeAt = -1;
  private landedAtSimikot = false;
  private result: 'success' | undefined;
  private endAt = -1;
  private lastFrame: ScriptFrame | undefined;
  private readonly atmos: ScriptAtmosphere;

  constructor(wind: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }, approach: DropApproach = SIMIKOT_APPROACH) {
    super('NETRA', 'SKYLORD 1');
    this.wind = { ...wind };
    this.approach = approach;
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
        ...(this.launches > 0 ? [{ label: 'Missiles evaded', value: `${Math.max(0, this.launches - this.hits)} of ${this.launches}` }] : []),
        ...(wrecked > 0 ? [{ label: 'Bundles wrecked', value: String(wrecked) }] : []),
        { label: 'Simikot', value: this.landedAtSimikot ? 'Landed' : '—' },
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
    if (this.phase === 'egress') return { text: 'Climb out: full power, turn left with the valley', highlight: ['throttleUp'] };
    if (this.phase === 'inbound') {
      if (!this.dumped && f.fuelDumping) return { text: 'Jettisoning fuel: switch off {fuelDump} at about 30 t (optional)', highlight: ['fuelDump'] };
      return { text: `Fly the glidepath (HUD needles) · flaps 1/2 · ${DROP_KT} kt`, highlight: [] };
    }
    // Run-in.
    if ((f.rampPos ?? 0) < 0.98) return { text: 'Open the ramp {ramp}', highlight: ['ramp'] };
    if (this.greenGiven && !this.passReleased) return { text: 'GREEN LIGHT: release {drop}', highlight: ['drop'] };
    return { text: `Hold the glidepath, ${DROP_KT} kt · release {drop} on the green light`, highlight: ['drop'] };
  }

  /** Simikot Tower, on the ground at the strip. */
  private tower(priority: RadioPriority, ...parts: RadioClipId[]): void {
    const p = compose(...parts.map((x) => line(x)));
    this.pushTx({ from: 'SIMIKOT TOWER', text: p.text, clips: p.clips, priority, maxAgeSec: priority === 0 ? 4 : priority === 1 ? 12 : 25 });
  }

  update(f: ScriptFrame): void {
    this.t = f.t;
    this.lastFrame = f;
    const p = f.player;
    const b = dropBeamAt({ x: p.x, y: p.y, z: p.z }, this.approach, this.beam);
    this.updateMarks();
    if (!p.alive) return;

    if (f.fuelDumping) this.everDumping = true;
    const warn = f.warningBits;
    // Later launches (the MAWS's warning): Netra's call. The first is the tower's (event()).
    if ((warn & WarningBit.MissileLaunch) !== 0 && (this.lastWarn & WarningBit.MissileLaunch) === 0 && this.launches > 1 && this.ready('sam', 6)) {
      this.say(RadioPriority.Urgent, 'ad_sam');
      if (this.ready('flaresCall', 10)) this.own('p_skylord_flares', 'Flares!', RadioPriority.Urgent);
    }
    this.lastWarn = warn;
    if (f.enginesRunning !== undefined && f.enginesRunning < 4 && !this.engineOutCalled && this.done('brief')) {
      this.engineOutCalled = true;
      this.say(RadioPriority.High, 'ad_engine');
    }

    const dDz = Math.hypot(DZ.x - p.x, DZ.z - p.z);
    const fuelT = (f.fuelKg ?? 0) / 1000;

    if (f.t > 2 && this.once('brief')) {
      this.say(RadioPriority.High, 'ad_netra', 'ad_brief');
      this.say(RadioPriority.Normal, 'ad_weather');
      if ((f.fuelKg ?? 0) > ADVISED_FUEL_KG + 2000) this.say(RadioPriority.Normal, 'ad_dump');
      this.own('p_skylord_tower', 'Simikot Tower, Skylord 1, on the glidepath, inbound for the drop.', RadioPriority.Normal);
      this.tower(RadioPriority.Normal, 'tw_contact');
    }
    if (f.fuelDumping && this.once('dumping')) this.own('p_skylord_dumping', 'Dumping fuel.', RadioPriority.Normal);
    if (!this.dumped && this.everDumping && (f.fuelKg ?? Infinity) <= ADVISED_FUEL_KG + 500) {
      this.dumped = true;
      if (f.fuelDumping) this.say(RadioPriority.Normal, 'ad_dump_enough');
    }

    // On the approach side, lined up: the run-in (again, after a pass that came round).
    const lined = b.alongM > 2500 && b.alongM < RUN_IN_M && Math.abs(b.crossM) < Math.max(400, b.alongM * 0.35) && towards(p, DZ);
    if (this.phase === 'inbound' || this.phase === 'reattack') {
      if (this.phase === 'inbound') {
        this.setObjective(1, STEPS, 'Fly the glidepath to Simikot', `${(dDz / 1000).toFixed(1)} km · glidepath ${Math.round(b.pathAltM)} m (you ${fmtSigned(b.highM)} m) · fuel ${fuelT.toFixed(1)} t${f.fuelDumping ? ' (jettisoning)' : ''}`);
        this.glidepathCalls(f, b.valid);
      } else {
        this.setObjective(2, STEPS, 'Come around for another pass', `${(dDz / 1000).toFixed(1)} km · rejoin the glidepath south-east of the field, track 315 · ${this.sticks.length} pass${this.sticks.length === 1 ? '' : 'es'} so far`);
        if (b.valid) this.glidepathCalls(f, true);
      }
      if (lined) this.startRunIn();
    }

    if (this.phase === 'runin') this.runIn(f, dDz);

    if (this.phase === 'egress') {
      const dOut = Math.hypot(CLIMB_OUT.x - p.x, CLIMB_OUT.z - p.z);
      this.setObjective(3, STEPS, 'Climb out: full power, left with the valley', `${Math.round(f.altMslM)} m · valley ${(dOut / 1000).toFixed(1)} km`);
      if (this.succeeded && (f.altMslM > 5000 || dDz > 12000)) {
        this.phase = 'done';
        this.completeAt = f.t;
        this.say(RadioPriority.High, 'ad_netra', 'ad_complete');
      }
    }

    if (this.phase === 'done') {
      this.setObjective(4, STEPS, 'Supplies delivered', `Land at Simikot for a bonus, or head home · Simikot ${(dDz / 1000).toFixed(1)} km`);
      if (this.result === undefined) {
        const speed = Math.hypot(p.vx, p.vz);
        if (p.onGround && dDz < 1500 && speed < 3) {
          this.landedAtSimikot = true;
          this.finish('ad_landed');
        } else if (dDz > 30000 || f.t - this.completeAt > 480) this.finish('ad_home');
      }
    }
  }

  /** The tower's glidepath calls: high, low, off the track (a call every 15 s at most, not near the strip). */
  private glidepathCalls(f: ScriptFrame, valid: boolean): void {
    const b = this.beam;
    if (!this.done('brief') || f.t < 40) return;
    if (!valid) {
      if (b.alongM > 0 && b.alongM < 25000 && Math.hypot(DZ.x - f.player.x, DZ.z - f.player.z) < 25000 && this.ready('join', 45)) this.tower(RadioPriority.Normal, 'tw_join');
      return;
    }
    if (b.alongM < 3000 || !this.ready('gp', 15)) return;
    const tol = Math.max(60, b.alongM * 0.004);
    if (b.highM > tol * 1.5) this.tower(RadioPriority.Normal, 'tw_high');
    else if (b.highM < -tol) this.tower(RadioPriority.High, 'tw_low');
    else if (b.crossM > Math.max(250, b.alongM * 0.03)) this.tower(RadioPriority.Normal, 'tw_right');
    else if (b.crossM < -Math.max(250, b.alongM * 0.03)) this.tower(RadioPriority.Normal, 'tw_left');
    else this.disarm('gp');
  }

  private finish(clip: 'ad_landed' | 'ad_home'): void {
    this.result = 'success';
    this.endAt = this.t + this.outroSec;
    this.say(RadioPriority.Urgent, clip);
  }

  private startRunIn(): void {
    this.phase = 'runin';
    this.passReleased = false;
    this.greenGiven = false;
    this.redGiven = false;
    if (this.ready('final', 30)) this.tower(RadioPriority.High, 'tw_final');
  }

  /** The run-in: the CARP, the red and green lights, and the checks on the ramp, speed and height. */
  private runIn(f: ScriptFrame, dDz: number): void {
    const p = f.player;
    const gs = Math.hypot(p.vx, p.vz);
    if (f.t - this.carpAt >= 0.2 && gs > 20) {
      this.carpAt = f.t;
      const hit = predictCdsDrop({ x: p.x, y: p.y, z: p.z }, { x: p.vx, y: p.vy, z: p.vz }, DZ_GROUND_M, this.wind);
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
    if (secs < 90 && secs > 20 && !ramp && this.ready('ramp', 25)) this.say(RadioPriority.High, 'ad_ramp');
    if (secs < 62 && secs > 30 && !this.redGiven) {
      this.redGiven = true;
      this.say(RadioPriority.Normal, 'ad_one_min');
    }
    if (secs < 30 && secs > 3) {
      if (overDz < 90 && this.ready('low', 10)) this.say(RadioPriority.High, 'ad_too_low');
      else if (ias > TOO_FAST_KT * KT && this.ready('fast', 10)) this.say(RadioPriority.High, 'ad_too_fast');
    }
    // Green a second and a half early: the call takes that long to say.
    if (!this.greenGiven && ramp && f.airdropState === AirdropStateCode.Armed && ahead < gs * 1.5 && ahead > -gs * 2) {
      this.greenGiven = true;
      this.say(RadioPriority.Urgent, 'ad_green');
    }
    if (ahead < -gs * 4 && dDz < 4000 && this.ready('overshoot', 20)) {
      this.say(RadioPriority.High, 'ad_overshoot', 'ad_come_around');
      this.phase = 'reattack';
    }
  }

  /** Navigation: the DZ only (the route's one steerpoint); on the run-in, the release point too; after the drop, the valley to climb out along. */
  private updateMarks(): void {
    const m: { name: string; x: number; y: number; z: number; objective: true }[] = [];
    if (this.phase === 'runin' && this.carp && !this.passReleased) m.push({ name: 'CARP', x: this.carp.x, y: DZ_GROUND_M, z: this.carp.z, objective: true });
    if (this.phase === 'egress') m.push({ name: 'CLIMB OUT', x: CLIMB_OUT.x, y: 2600, z: CLIMB_OUT.z, objective: true });
    this.marks = m;
  }

  event(e: SimEvent, playerId: EntityId): void {
    switch (e.type) {
      case 'airdropRelease': {
        if (e.entityId !== playerId) break;
        this.sticks.push({ stickId: e.stickId, count: e.count, iasMps: e.iasMps, aglM: e.aglM, landed: [] });
        this.passReleased = true;
        this.own('p_skylord_load_clear', 'Load clear!', RadioPriority.High);
        if (this.phase !== 'done') {
          this.phase = 'egress';
          if (this.ready('climb', 60)) this.say(RadioPriority.Normal, 'ad_climb');
        }
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
        if (this.launches === 1) {
          // The surprise: the tower sees the first one go up.
          this.tower(RadioPriority.Urgent, 'tw_launch');
          this.own('p_skylord_flares', 'Flares!', RadioPriority.Urgent);
          this.ready('flaresCall', 10);
          this.ready('sam', 6);
        }
        break;
      case 'hit':
        if (e.targetId !== playerId) break;
        this.hits += 1;
        if (this.ready('hit', 8)) this.say(RadioPriority.Urgent, 'ad_hit');
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
    const d = s.distM;
    switch (s.grade) {
      case 'excellent':
        this.say(RadioPriority.High, 'ad_drop_shack');
        break;
      case 'good':
        this.say(RadioPriority.High, 'ad_drop_good', distancePhrase(d), 'ad_from_t');
        break;
      case 'acceptable':
        this.say(RadioPriority.High, 'ad_drop_ok', distancePhrase(d), 'ad_from_t', 'ad_recover');
        break;
      case 'miss': {
        const dir = compass8(bearingDeg(DZ.x, DZ.z, cx, cz));
        this.say(RadioPriority.High, 'ad_drop_miss', distancePhrase(d), compassPhrase(dir), 'ad_of_dz', 'ad_come_around');
        break;
      }
      case 'destroyed':
        this.say(RadioPriority.High, 'ad_drop_destroyed', 'ad_come_around');
        break;
    }
    if (gradeSucceeds(s.grade)) {
      if (!this.succeeded) this.tower(RadioPriority.Normal, 'tw_thanks');
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
