/**
 * src/script/missions/simikotAirdrop.ts — "Simikot Lifeline": a C-17 (Skylord 1) from Indian
 * airspace to Simikot, Humla, at dusk under a low overcast, to airdrop supplies for the Nepal Army
 * on DZ Tango. Netra briefs (the Chinese advance from Hilsa, the weather, the fuel jettison), talks
 * the letdown under the cloud and the run-in, gives the red and green lights from the computed
 * release point (CARP: where a stick released now would land, src/core/airdrop.ts predictCdsDrop),
 * calls the missile launches (MANPADS on the Hilsa side) and grades each stick where it lands.
 *
 *   1 Transit      to LETDOWN above the cloud; jettison fuel (advised, not required)
 *   2 Letdown      down through the cloud inside 3 km of LETDOWN, level 4,600 m under the base
 *   3 Run-in/drop  IP -> DZ Tango, ramp open, 150 m above the ground, 140 kt, release on green
 *   4 Climb-out    full power, flares, climb ahead to 6,500 m
 *   5 (bonus)      land at Simikot, or leave the area
 *
 * A miss (centre of the stick 300 m or more from the T, or the loads wrecked by a release too low)
 * means another pass, as many as it takes (reserve bundles once the rigged load is gone). The
 * mission ends in success once an acceptable stick is down and the jet is clear (landed at Simikot,
 * 30 km away or 8 minutes later); the sim ends it in failure if the jet is lost.
 *
 * Why here: the Humla Karnali gorge beside Simikot is too narrow in this terrain for a 52 m-span
 * jet to fly a straight run-in and climb out of (docs/spec/himalaya-theatre.md wanted a DZ beside
 * the strip), so DZ Tango is on the open shoulder 7.8 km north-west of the town (~3,915 m), the one
 * spot near Simikot with a straight run-in and climb-out under 10 % (searched over the terrain).
 */
import type { EntityId, SimEvent } from '../../contracts/core';
import { AirdropStateCode, WarningBit } from '../../contracts/core';
import { predictCdsDrop } from '../../core/airdrop';
import { ScriptBase, type ScriptAtmosphere, type ScriptFrame, type ScriptPrompt } from '../director';
import { RadioPriority, compassPhrase, distancePhrase } from '../radio';
import { bearingDeg, compass8, threeDigits } from '../geo';

const KT = 0.514444;
const STEPS = 5;

/** DZ Tango (the T's bar), and the ground there (the terrain's height, checked by the tests). */
export const DZ_TANGO = { x: 65411, z: 67782 } as const;
export const DZ_GROUND_M = 3915;
/** The run-in track, deg true (IP -> DZ). */
export const RUN_IN_DEG = 305;
export const SIMIKOT = { x: 70811.5, z: 73382.2 } as const;
const POINTS = {
  LETDOWN: { x: 77239, z: 81042, ground: 2725 },
  IP: { x: 71364, z: 71971, ground: 4209 },
  EXIT: { x: 54981, z: 60499, ground: 4528 },
};
/** The cloud deck over the valley, m above sea level, and the visibility under it. */
export const DECK_BASE_M = 5000;
export const DECK_TOP_M = 6000;
/** Fuel the jettison advice aims at, kg. */
export const ADVISED_FUEL_KG = 40000;

/** Grade bands of a stick's centre from the T, m. */
export const GRADE_BANDS = { excellent: 50, good: 150, acceptable: 300 } as const;
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

type Phase = 'transit' | 'letdown' | 'runin' | 'egress' | 'reattack' | 'done';

export class SimikotAirdropScript extends ScriptBase {
  override readonly outroSec = 6;
  private phase: Phase = 'transit';
  private readonly wind: { x: number; y: number; z: number };
  private readonly sticks: Stick[] = [];
  private lastWarn = 0;
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

  constructor(wind: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }) {
    super('NETRA', 'SKYLORD 1');
    this.wind = { ...wind };
    this.atmos = {
      weather: { deckBaseM: DECK_BASE_M, deckTopM: DECK_TOP_M, visKm: 6 },
      timeOfDayH: 18.1,
      // Four times real time: the light goes during the transit, dark at the DZ.
      timeRate: 4,
      markers: dzMarkers(),
    };
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

  results(): { tiles: { label: string; value: string }[]; lines: string[] } {
    const graded = this.sticks.filter((s) => s.grade);
    const best = graded.filter((s) => gradeSucceeds(s.grade!)).sort((a, b) => a.distM! - b.distM!)[0];
    const wrecked = this.sticks.reduce((n, s) => n + s.landed.filter((l) => l.destroyed).length, 0);
    return {
      tiles: [
        { label: 'Drop', value: best ? `${GRADE_TEXT[best.grade!]} · ${Math.round(best.distM!)} m` : 'None' },
        { label: 'Passes', value: String(graded.length) },
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
    if ((f.warningBits & WarningBit.MissileLaunch) !== 0) return { text: 'Missile! Flares {flare} · full power · climb', highlight: ['flare', 'throttleUp'] };
    if (this.phase === 'transit') {
      if (!this.dumped && (f.fuelKg ?? 0) > ADVISED_FUEL_KG + 2000) return { text: f.fuelDumping ? 'Jettisoning fuel: switch off {fuelDump} at about 40 t' : 'Jettison fuel {fuelDump} (advised): down to about 40 t', highlight: ['fuelDump'] };
      return { text: 'Fly to LETDOWN above the cloud, then descend there', highlight: [] };
    }
    if (this.phase === 'letdown') return { text: 'Descend inside 3 km of LETDOWN · level 4,600 m under the cloud', highlight: [] };
    if (this.phase === 'reattack') return { text: 'Come around: climb out, back to LETDOWN or the IP, run in again', highlight: [] };
    if (this.phase === 'egress') return { text: 'Climb out: full power, 6,500 m', highlight: ['throttleUp'] };
    // Run-in.
    if ((f.rampPos ?? 0) < 0.98) return { text: 'Open the ramp {ramp}', highlight: ['ramp'] };
    if (this.greenGiven && !this.passReleased) return { text: 'GREEN LIGHT: release {drop}', highlight: ['drop'] };
    return { text: '150 m above the ground, 140 kt · release {drop} on the green light', highlight: ['drop'] };
  }

  update(f: ScriptFrame): void {
    this.t = f.t;
    this.lastFrame = f;
    const p = f.player;
    this.updateMarks();
    if (!p.alive) return;

    if (f.fuelDumping) this.everDumping = true;
    const warn = f.warningBits;
    if ((warn & WarningBit.MissileLaunch) !== 0 && (this.lastWarn & WarningBit.MissileLaunch) === 0 && this.ready('sam', 6)) {
      this.say(RadioPriority.Urgent, 'ad_sam');
      this.own('p_skylord_flares', 'Flares!', RadioPriority.Urgent);
    }
    this.lastWarn = warn;
    if (f.enginesRunning !== undefined && f.enginesRunning < 4 && !this.engineOutCalled && this.done('brief')) {
      this.engineOutCalled = true;
      this.say(RadioPriority.High, 'ad_engine');
    }

    const dDz = Math.hypot(DZ_TANGO.x - p.x, DZ_TANGO.z - p.z);
    const dIp = Math.hypot(POINTS.IP.x - p.x, POINTS.IP.z - p.z);
    const dLet = Math.hypot(POINTS.LETDOWN.x - p.x, POINTS.LETDOWN.z - p.z);
    const brgDz = bearingDeg(p.x, p.z, DZ_TANGO.x, DZ_TANGO.z);
    const hdgDeg = ((p.headingRad * 180) / Math.PI + 360) % 360;
    const towardDz = Math.abs((((brgDz - hdgDeg) % 360) + 540) % 360 - 180) < 60;
    const fuelT = (f.fuelKg ?? 0) / 1000;

    if (this.phase === 'transit') {
      if (f.t > 2 && this.once('brief')) {
        this.say(RadioPriority.High, 'ad_netra', 'ad_brief');
        this.say(RadioPriority.Normal, 'ad_weather');
        if ((f.fuelKg ?? 0) > ADVISED_FUEL_KG + 2000) this.say(RadioPriority.Normal, 'ad_dump');
        this.own('p_skylord_wilco', 'Wilco.', RadioPriority.Normal);
      }
      if (f.fuelDumping && this.once('dumping')) this.own('p_skylord_dumping', 'Dumping fuel.', RadioPriority.Normal);
      if (!this.dumped && this.everDumping && (f.fuelKg ?? Infinity) <= ADVISED_FUEL_KG + 500) {
        this.dumped = true;
        if (f.fuelDumping) this.say(RadioPriority.Normal, 'ad_dump_enough');
      }
      if (!this.everDumping && dLet < 25000 && (f.fuelKg ?? 0) > ADVISED_FUEL_KG + 5000 && this.once('dumpRemind')) this.say(RadioPriority.Normal, 'ad_dump_remind');
      const brg = threeDigits(bearingDeg(p.x, p.z, POINTS.LETDOWN.x, POINTS.LETDOWN.z));
      this.setObjective(1, STEPS, 'Fly to LETDOWN above the cloud', `${brg}° · ${(dLet / 1000).toFixed(0)} km · fuel ${fuelT.toFixed(1)} t${f.fuelDumping ? ' (jettisoning)' : ''}`);
      if (dLet < 15000) {
        this.phase = 'letdown';
        this.say(RadioPriority.High, 'ad_letdown');
      }
    }

    if (this.phase === 'letdown') {
      const under = f.altMslM < DECK_BASE_M - 100;
      this.setObjective(2, STEPS, 'Let down under the cloud at LETDOWN', `${(dLet / 1000).toFixed(1)} km · ${Math.round(f.altMslM)} m · level 4,600 m under the base (5,000 m)`);
      if (under && this.once('below')) this.say(RadioPriority.Normal, 'ad_below');
    }

    if (this.phase === 'transit' || this.phase === 'letdown' || this.phase === 'reattack') {
      const under = f.altMslM < DECK_BASE_M;
      if ((dIp < 3000 && under) || (dDz < 9000 && under && towardDz && this.phase !== 'transit')) this.startRunIn();
    }

    if (this.phase === 'reattack') {
      const brg = threeDigits(bearingDeg(p.x, p.z, POINTS.IP.x, POINTS.IP.z));
      this.setObjective(3, STEPS, 'Come around for another pass', `IP ${brg}° · ${(dIp / 1000).toFixed(1)} km · run in on ${RUN_IN_DEG}° · ${this.sticks.length} pass${this.sticks.length === 1 ? '' : 'es'} so far`);
    }

    if (this.phase === 'runin') this.runIn(f, dDz);

    if (this.phase === 'egress') {
      this.setObjective(4, STEPS, 'Climb out: full power to 6,500 m', `${Math.round(f.altMslM)} m · ${(dDz / 1000).toFixed(1)} km past the DZ`);
      if (this.succeeded && (f.altMslM > 6000 || dDz > 12000)) {
        this.phase = 'done';
        this.completeAt = f.t;
        this.say(RadioPriority.High, 'ad_netra', 'ad_complete');
      }
    }

    if (this.phase === 'done') {
      const dSim = Math.hypot(SIMIKOT.x - p.x, SIMIKOT.z - p.z);
      this.setObjective(5, STEPS, 'Supplies delivered', `Land at Simikot (runway 28) for a bonus, or head home · Simikot ${(dSim / 1000).toFixed(1)} km`);
      if (this.result === undefined) {
        const speed = Math.hypot(p.vx, p.vz);
        if (p.onGround && dSim < 1500 && speed < 3) {
          this.landedAtSimikot = true;
          this.finish('ad_landed');
        } else if (dDz > 30000 || f.t - this.completeAt > 480) this.finish('ad_home');
      }
    }
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
    if (this.ready('ip', 30)) {
      this.own('p_skylord_ip', 'IP inbound.', RadioPriority.High);
      this.say(RadioPriority.High, 'ad_ip');
    }
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
      const dx = DZ_TANGO.x - hit.x;
      const dz = DZ_TANGO.z - hit.z;
      this.carp = { x: p.x + dx, z: p.z + dz, aheadM: dx * tx + dz * tz };
    }
    const ahead = this.carp?.aheadM ?? dDz;
    const ias = f.iasMps;
    const agl = p.aglM;
    const ramp = (f.rampPos ?? 0) >= 0.98;
    this.setObjective(
      3,
      STEPS,
      this.passReleased ? 'Load away: climb out' : 'Run in and drop on DZ Tango',
      `${(dDz / 1000).toFixed(1)} km · release in ${Math.max(0, Math.round(ahead / Math.max(gs, 1)))} s · ${Math.round(agl)} m AGL · ${Math.round(ias / KT)} kt · ramp ${ramp ? 'OPEN' : 'CLOSED'}`
    );
    if (this.passReleased) return;
    const secs = ahead / Math.max(gs, 1);
    if (secs < 75 && secs > 20 && !ramp && this.ready('ramp', 25)) this.say(RadioPriority.High, 'ad_ramp');
    if (secs < 62 && secs > 30 && !this.redGiven) {
      this.redGiven = true;
      this.say(RadioPriority.Normal, 'ad_one_min');
    }
    if (secs < 30 && secs > 3) {
      if (agl < 110 && this.ready('low', 10)) this.say(RadioPriority.High, 'ad_too_low');
      else if (ias > 158 * KT && this.ready('fast', 10)) this.say(RadioPriority.High, 'ad_too_fast');
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

  private updateMarks(): void {
    const m: { name: string; x: number; y: number; z: number; objective: true }[] = [];
    const dz = { name: 'DZ TANGO', x: DZ_TANGO.x, y: DZ_GROUND_M, z: DZ_TANGO.z, objective: true as const };
    if (this.phase === 'transit') m.push({ name: 'LETDOWN', x: POINTS.LETDOWN.x, y: POINTS.LETDOWN.ground, z: POINTS.LETDOWN.z, objective: true });
    if (this.phase === 'letdown' || this.phase === 'reattack') m.push({ name: 'IP', x: POINTS.IP.x, y: POINTS.IP.ground, z: POINTS.IP.z, objective: true });
    if (this.phase === 'reattack' || this.phase === 'letdown') m.push(dz);
    if (this.phase === 'runin') {
      m.push(dz);
      if (this.carp && !this.passReleased) m.push({ name: 'CARP', x: this.carp.x, y: DZ_GROUND_M, z: this.carp.z, objective: true });
    }
    if (this.phase === 'egress') m.push({ name: 'EXIT', x: POINTS.EXIT.x, y: POINTS.EXIT.ground, z: POINTS.EXIT.z, objective: true });
    if (this.phase === 'done') m.push({ name: 'SIMIKOT', x: SIMIKOT.x, y: 2971, z: SIMIKOT.z, objective: true });
    this.marks = m;
  }

  event(e: SimEvent, playerId: EntityId): void {
    switch (e.type) {
      case 'airdropRelease': {
        if (e.entityId !== playerId) break;
        this.sticks.push({ stickId: e.stickId, count: e.count, iasMps: e.iasMps, aglM: e.aglM, landed: [] });
        this.passReleased = true;
        this.own('p_skylord_load_clear', 'Load clear!', RadioPriority.High);
        if (this.phase === 'runin' || this.phase === 'reattack') {
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
    s.distM = Math.hypot(cx - DZ_TANGO.x, cz - DZ_TANGO.z);
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
        const dir = compass8(bearingDeg(DZ_TANGO.x, DZ_TANGO.z, cx, cz));
        this.say(RadioPriority.High, 'ad_drop_miss', distancePhrase(d), compassPhrase(dir), 'ad_of_dz', 'ad_come_around');
        break;
      }
      case 'destroyed':
        this.say(RadioPriority.High, 'ad_drop_destroyed', 'ad_come_around');
        break;
    }
    if (gradeSucceeds(s.grade)) {
      this.succeeded = true;
      if (this.phase === 'runin' || this.phase === 'reattack') this.phase = 'egress';
    } else if (!this.succeeded && this.phase !== 'runin') this.phase = 'reattack';
  }
}

/** The DZ's marks: a lit T (bar across the run-in at the DZ, stem back towards the approach) and orange smoke beside it. */
function dzMarkers(): NonNullable<ScriptAtmosphere['markers']> {
  const r = (RUN_IN_DEG * Math.PI) / 180;
  const tx = Math.sin(r);
  const tz = -Math.cos(r);
  // Across the track (to the right of the run-in).
  const lx = -tz;
  const lz = tx;
  const lamp = (along: number, across: number) => ({ x: DZ_TANGO.x + tx * along + lx * across, z: DZ_TANGO.z + tz * along + lz * across, aglM: 1.2, r: 2.6, g: 1.7, b: 0.7 });
  const lamps = [-50, -25, 0, 25, 50].map((a) => lamp(0, a));
  for (const b of [30, 60, 90, 120]) lamps.push(lamp(-b, 0));
  // A red beacon at the far end of the stem (the approach end), for the line-up.
  lamps.push({ ...lamp(-150, 0), r: 3, g: 0.25, b: 0.15 });
  return { lamps, smoke: [{ x: DZ_TANGO.x + lx * 90, z: DZ_TANGO.z + lz * 90, aglM: 0, r: 1.0, g: 0.42, b: 0.1 }] };
}
