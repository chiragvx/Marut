/**
 * src/script/missions/borderDuel.ts — "Border Duel": one JF-17 crosses the border for Bathinda;
 * Tiger 1 scrambles from runway 13. Netra (the AEW&C) runs the intercept: the scramble, vectors and
 * BRAA calls to the bandit until the pilot's own radar has it, clearance to engage, threat calls
 * (missile in the air, merged, bandit near the base) and the splash.
 *
 *   1 Scramble      take off            -> airborne (above 150 m)
 *   2 Intercept     BRAA calls, vectors -> the bandit designated on the radar
 *   3 Engage        lock, fox, misses   -> bandit killed
 *   4 Splash        RTB
 */
import type { EntityId, SimEvent } from '../../contracts/core';
import { LockStateCode, WarningBit } from '../../contracts/core';
import { ScriptBase, type ScriptAircraft, type ScriptFrame } from '../director';
import { RadioPriority, braaPhrase, digits, line } from '../radio';
import { braa, BORDER_GEO, FT_PER_M, threeDigits, wrapDeg, type Aspect } from '../geo';

const STEPS = 4;
/** The base the bandit is heading for. */
const BASE = { x: BORDER_GEO.x, z: BORDER_GEO.z };
const BRAA_EVERY_SEC = 30;
/** No BRAA calls inside this range (visual, the merge), m. */
const BRAA_MIN_M = 9000;
const ASPECT_WORD: Record<Aspect, string> = { hot: 'HOT', flanking: 'FLANKING', beaming: 'BEAMING', cold: 'COLD' };

export function braaDetail(px: number, pz: number, b: ScriptAircraft): string {
  const r = braa(px, pz, b);
  const km = Math.hypot(b.x - px, b.z - pz) / 1000;
  const ft = Math.round((b.y * FT_PER_M) / 500) * 500;
  return `${threeDigits(r.bearing)}° · ${(km / 1.852).toFixed(0)} NM (${km.toFixed(0)} km) · ${ft.toLocaleString('en-US')} ft · ${ASPECT_WORD[r.aspect]}`;
}

export class BorderDuelScript extends ScriptBase {
  private phase: 'scramble' | 'intercept' | 'engage' | 'splash' = 'scramble';
  private bandit: ScriptAircraft | undefined;
  private readonly hostileIds = new Set<EntityId>();
  private lastAspect: Aspect | undefined;
  private offCourseSince = -1;

  constructor() {
    super('NETRA', 'TIGER 1');
  }

  update(f: ScriptFrame): void {
    this.t = f.t;
    const p = f.player;
    for (const h of f.hostiles) this.hostileIds.add(h.id);
    this.bandit = f.hostiles[0];
    const b = this.bandit;
    this.marks = b && this.phase !== 'splash' ? [{ name: 'Bandit', x: b.x, y: b.y, z: b.z, objective: true }] : [];
    if (!p.alive) return;

    if (this.phase === 'scramble') {
      if (f.t > 1.5 && this.once('scramble')) this.say(RadioPriority.High, 'tiger_netra', 'duel_scramble');
      if (p.onGround || p.aglM <= 150) {
        this.setObjective(1, STEPS, 'Scramble: take off from runway 13', b ? `Bandit ${braaDetail(p.x, p.z, b)}` : 'Bandit inbound from the west');
        return;
      }
      this.phase = 'intercept';
      this.say(RadioPriority.High, 'tiger_netra', 'duel_airborne');
      this.arm('braa', 6);
    }
    if (!b) return;
    const designated = f.targetId === b.id;
    const r = braa(p.x, p.z, b);
    const rangeM = Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z);

    if (this.phase === 'intercept') {
      this.setObjective(2, STEPS, 'Intercept the bandit', braaDetail(p.x, p.z, b));
      // BRAA on a schedule, and when the bandit's aspect changes.
      // (Inside ~5 nm the pilot has it visually: no more BRAA.)
      const far = rangeM > BRAA_MIN_M;
      if ((this.expired('braa') && far) || (far && this.lastAspect !== undefined && r.aspect !== this.lastAspect && this.ready('aspect', 15))) {
        this.say(RadioPriority.Normal, 'tiger_netra', braaPhrase(r));
        this.arm('braa', BRAA_EVERY_SEC);
      }
      // Pointing well away from the bandit for a while: a vector.
      const off = wrapDeg(r.bearing - (p.headingRad * 180) / Math.PI);
      if (Math.abs(off) > 50 && rangeM > 8000) {
        if (this.offCourseSince < 0) this.offCourseSince = f.t;
        if (f.t - this.offCourseSince > 10 && this.ready('vector', 25)) this.say(RadioPriority.Normal, 'tiger_netra', off < 0 ? 'come_left' : 'come_right', digits(threeDigits(r.bearing)));
      } else this.offCourseSince = -1;
      if (designated) {
        this.phase = 'engage';
        this.say(RadioPriority.High, 'tiger_netra', 'duel_contact');
      }
    }

    if (this.phase === 'engage') {
      const lock = f.lockState === LockStateCode.locked && designated;
      this.setObjective(3, STEPS, 'Engage the JF-17: cleared hot', `${(rangeM / 1000).toFixed(1)} km · ${lock ? 'LOCKED' : designated ? 'TRACKING' : 'NO RADAR TRACK'} · ${ASPECT_WORD[r.aspect]}`);
      if (lock && this.once('lock')) this.say(RadioPriority.Normal, 'duel_lock');
      // Lost the track: BRAA again now and then.
      if (!designated && rangeM > BRAA_MIN_M && this.expired('braa')) {
        this.say(RadioPriority.Normal, 'tiger_netra', braaPhrase(r));
        this.arm('braa', 40);
      }
      if (designated) this.arm('braa', 15);
      if (this.expired('missed')) this.say(RadioPriority.Normal, 'tiger_netra', 'duel_missed');
    }

    if (rangeM < 2500 && this.once('merge')) this.say(RadioPriority.High, 'tiger_netra', 'duel_merge');
    if (Math.hypot(b.x - BASE.x, b.z - BASE.z) < 12000 && this.once('base')) this.say(RadioPriority.High, 'tiger_netra', 'duel_base');
    if ((f.warningBits & WarningBit.MissileLaunch) !== 0 && this.ready('defend', 12)) this.say(RadioPriority.Urgent, 'tiger_netra', 'duel_defend');
    this.lastAspect = r.aspect;
  }

  event(e: SimEvent, playerId: EntityId): void {
    switch (e.type) {
      case 'missileLaunch':
        if (e.shooterId === playerId) {
          if (e.weapon === 'radar_missile' || e.weapon === 'ir_missile') {
            this.own(e.weapon === 'radar_missile' ? 'Fox 3!' : 'Fox 2!');
            if (this.ready('fox', 15)) this.say(RadioPriority.Chatter, line('duel_fox'));
            this.arm('missed', 30);
          }
        } else if (this.hostileIds.has(e.shooterId) && this.ready('defend', 12)) {
          this.say(RadioPriority.Urgent, 'tiger_netra', 'duel_defend');
        }
        break;
      case 'hit':
        if (e.targetId === playerId && this.ready('hit', 20)) this.say(RadioPriority.High, 'tiger_netra', 'duel_hit');
        break;
      case 'kill':
        if (this.hostileIds.has(e.targetId)) {
          this.disarm('missed');
          if (e.sourceId === playerId) this.own('Splash one!');
          this.phase = 'splash';
          this.marks = [];
          this.say(RadioPriority.High, 'duel_splash');
          this.setObjective(4, STEPS, 'Splash one: return to base', 'Picture clean');
        }
        break;
      default:
        break;
    }
  }
}
