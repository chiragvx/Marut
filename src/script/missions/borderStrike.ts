/**
 * src/script/missions/borderStrike.ts — "Precision Strike": Vajra 1, airborne east of the border
 * with two Griffin LGBs and the Litening pod, against the PAF Shahbaz fuel depot. Netra reads the
 * target coordinates, sends the jet to IP Alpha, calls the threats (early-warning radar, SAM radar
 * spikes and launches), talks the pilot's eyes onto the depot (runway -> tower -> the berm with four
 * tanks), checks the pilot's mark and calls the hits.
 *
 *   1 Ingress       to IP Alpha, low          -> within 2.5 km of the IP (or 15 km of the target)
 *   2 Find target   talk-on, pod, designate   -> a mark on the depot
 *   3 Destroy       release, lase, hits       -> four of the five depot targets (the sim ends it)
 *   4 Egress
 */
import type { EntityId, SimEvent } from '../../contracts/core';
import { DlzCode, WarningBit } from '../../contracts/core';
import type { AirportLayout } from '../../contracts/airport';
import { ScriptBase, type ScriptFrame } from '../director';
import { RadioPriority, coordsPhrase, compassPhrase, digits, distancePhrase, words, type Phrase } from '../radio';
import { bearingDeg, BORDER_GEO, compass8, FT_PER_M, formatLatLon, threeDigits, toLatLon } from '../geo';

const STEPS = 4;
const AIRPORT = 'pafb-shahbaz';
const GROUP = 'fuel-depot';
/** Depot targets the objective needs (4 of the 5: four tanks and the pump house). */
const NEED = 4;
const IP_BEFORE_M = 14000;
const AT_IP_M = 2500;
/** A mark this close to the depot's centre is on it; this far off, the wrong place. */
const GOOD_MARK_M = 150;
const BAD_MARK_M = 400;

export interface StrikeGeometry {
  target: { x: number; y: number; z: number };
  ip: { x: number; z: number };
}

/** The depot's centre (its fuel tanks) and IP Alpha, on the line from the start to the target. */
export function strikeGeometry(layouts: readonly AirportLayout[], start: { x: number; z: number }): StrikeGeometry {
  const a = layouts.find((l) => l.id === AIRPORT);
  const tanks = (a?.structures ?? []).filter((s) => s.group === GROUP && s.kind === 'fuel_tank');
  const x = tanks.length ? tanks.reduce((n, s) => n + s.worldX, 0) / tanks.length : -29600;
  const z = tanks.length ? tanks.reduce((n, s) => n + s.worldZ, 0) / tanks.length : 10800;
  const dx = start.x - x;
  const dz = start.z - z;
  const d = Math.hypot(dx, dz) || 1;
  return { target: { x, y: a?.elevationM ?? 190, z }, ip: { x: x + (dx / d) * IP_BEFORE_M, z: z + (dz / d) * IP_BEFORE_M } };
}

export class BorderStrikeScript extends ScriptBase {
  private phase: 'ingress' | 'find' | 'destroy' | 'egress' = 'ingress';
  private readonly geo: StrikeGeometry;
  private readonly coords: string;
  private readonly killed = new Set<string>();
  private lastWarn = 0;
  private lastMarkX = NaN;
  private lastMarkZ = NaN;
  private goodMark = false;

  constructor(layouts: readonly AirportLayout[], start: { x: number; z: number }) {
    super('NETRA', 'VAJRA 1');
    this.geo = strikeGeometry(layouts, start);
    const ll = toLatLon(this.geo.target.x, this.geo.target.z, BORDER_GEO);
    this.coords = formatLatLon(ll.latDeg, ll.lonDeg);
  }

  private coordsCall(): Phrase {
    const ll = toLatLon(this.geo.target.x, this.geo.target.z, BORDER_GEO);
    return coordsPhrase(ll.latDeg, ll.lonDeg);
  }

  update(f: ScriptFrame): void {
    this.t = f.t;
    const p = f.player;
    const tg = this.geo.target;
    const dTarget = Math.hypot(tg.x - p.x, tg.z - p.z);
    const brg = threeDigits(bearingDeg(p.x, p.z, tg.x, tg.z));
    const left = NEED - Math.min(NEED, this.killed.size);
    this.marks =
      this.phase === 'egress'
        ? []
        : [...(this.phase === 'ingress' ? [{ name: 'IP Alpha', x: this.geo.ip.x, y: tg.y, z: this.geo.ip.z, objective: true }] : []), { name: 'Fuel depot', x: tg.x, y: tg.y + 6, z: tg.z, objective: true }];
    if (!p.alive) return;

    // The threats: the early-warning radar sees you, a SAM radar locks, a launch.
    const warn = f.warningBits;
    if (f.rwrCount > 0 && p.aglM > 200 && this.done('brief') && this.once('painted')) this.say(RadioPriority.High, 'vajra_netra', 'strike_painted');
    if ((warn & WarningBit.MissileLaunch) !== 0 && (this.lastWarn & WarningBit.MissileLaunch) === 0 && this.ready('sam', 8)) {
      this.say(RadioPriority.Urgent, 'strike_sam');
      this.own('p_vajra_defending', 'Defending!');
    }
    else if ((warn & WarningBit.MissileLock) !== 0 && (this.lastWarn & WarningBit.MissileLock) === 0 && this.ready('spike', 20)) this.say(RadioPriority.High, 'strike_spiked');
    this.lastWarn = warn;

    if (this.phase === 'ingress') {
      if (f.t > 1.5 && this.once('brief')) {
        this.say(RadioPriority.High, 'vajra_netra', 'strike_brief', this.coordsCall(), 'elevation', words(Math.max(100, Math.round((tg.y * FT_PER_M) / 100) * 100)), 'feet');
        this.say(RadioPriority.Normal, 'strike_push');
        this.own('p_vajra_wilco', 'Wilco.', RadioPriority.Normal);
      }
      const dIp = Math.hypot(this.geo.ip.x - p.x, this.geo.ip.z - p.z);
      const ipBrg = threeDigits(bearingDeg(p.x, p.z, this.geo.ip.x, this.geo.ip.z));
      this.setObjective(1, STEPS, 'Fly to IP Alpha: stay low', `IP ${ipBrg}° · ${(dIp / 1000).toFixed(1)} km · target ${this.coords}`);
      if (dIp < AT_IP_M || dTarget < IP_BEFORE_M + 1000) {
        this.phase = 'find';
        const nm = Math.max(1, Math.round(dTarget / 1852));
        this.own('p_vajra_ip', 'IP inbound.', RadioPriority.High);
        this.say(RadioPriority.High, 'vajra_netra', 'strike_ip', digits(brg), words(nm), 'miles');
        this.say(RadioPriority.Normal, 'strike_talk1');
        this.say(RadioPriority.Normal, 'strike_talk2');
      } else return;
    }

    // The pilot's mark (SPI): on the depot, or a correction from it.
    if (f.spiValid && this.phase !== 'egress') {
      const off = Math.hypot(f.spiX - tg.x, f.spiZ - tg.z);
      const moved = !(Math.hypot(f.spiX - this.lastMarkX, f.spiZ - this.lastMarkZ) < 80);
      if (off < GOOD_MARK_M) {
        if (!this.goodMark) {
          this.goodMark = true;
          this.own('p_vajra_captured', 'Captured.', RadioPriority.High);
          this.say(RadioPriority.High, 'vajra_netra', 'strike_good_mark');
          if (this.phase === 'find') this.phase = 'destroy';
        }
      } else if (off > BAD_MARK_M && moved && this.ready('badmark', 12)) {
        this.goodMark = false;
        const dir = compass8(bearingDeg(f.spiX, f.spiZ, tg.x, tg.z));
        this.say(RadioPriority.High, 'strike_bad_mark', distancePhrase(off), compassPhrase(dir), 'of_mark');
        this.lastMarkX = f.spiX;
        this.lastMarkZ = f.spiZ;
      }
    } else this.goodMark = false;

    if (this.phase === 'find') {
      this.setObjective(2, STEPS, 'Find the fuel depot and designate it', `Depot ${brg}° · ${(dTarget / 1000).toFixed(1)} km · four tanks in an earth berm, NE of the tower`);
      if (dTarget < 12000 && !f.spiValid && this.once('pod')) this.say(RadioPriority.Normal, 'strike_pod');
    }
    if (this.phase === 'destroy') {
      const rng = f.dlz === DlzCode.InRange ? 'IN RANGE' : f.dlz === DlzCode.OutOfRange ? 'OUT OF RANGE' : f.spiValid ? 'MARKED' : 'NO MARK';
      this.setObjective(3, STEPS, 'Destroy the fuel depot', `${this.killed.size} / ${NEED} destroyed · ${(dTarget / 1000).toFixed(1)} km · ${rng}`);
      if (f.dlz === DlzCode.InRange && this.goodMark && this.ready('inrange', 40)) this.say(RadioPriority.Normal, 'strike_in_range');
      if (this.expired('nohits') && left > 0) this.say(RadioPriority.Normal, 'vajra_netra', 'strike_no_hits');
    }
  }

  event(e: SimEvent, playerId: EntityId): void {
    switch (e.type) {
      case 'missileLaunch':
        if (e.shooterId !== playerId) break;
        if (e.weapon === 'guided_bomb' || e.weapon === 'bomb') {
          this.own('p_vajra_bombs', 'Bombs away!');
          if (this.ready('away', 10)) this.say(RadioPriority.Normal, 'strike_away');
          this.arm('nohits', 35);
        }
        break;
      case 'groundKill': {
        if (e.groupId !== GROUP || !e.targetId.startsWith(`${AIRPORT}:`) || this.killed.has(e.targetId)) break;
        this.killed.add(e.targetId);
        this.disarm('nohits');
        if (this.phase !== 'egress') this.phase = 'destroy';
        const left = NEED - this.killed.size;
        if (left > 0 && this.ready('hit', 3)) this.say(RadioPriority.High, 'strike_hit', words(left), 'remaining');
        break;
      }
      case 'missionEnded':
        if (e.outcome === 'success' && this.phase !== 'egress') {
          this.phase = 'egress';
          this.marks = [];
          this.say(RadioPriority.Urgent, 'strike_shack');
          this.setObjective(4, STEPS, 'Depot destroyed: egress east', 'Low and fast');
        }
        break;
      default:
        break;
    }
  }
}
