/**
 * src/combat/airDefence.ts — surface-to-air defences: every air-defence site of the mission (its
 * system from the site template: contracts/ground.ts AirDefenceSystem) sensing, tracking and
 * engaging hostile aircraft.
 *
 * Per site, each tick:
 *   - Sensing (SENSE_HZ): its search radar sees hostile aircraft out to searchRangeM x (RCS/5)^1/4,
 *     never below minAltAglM above the ground (clutter), and only with a terrain line of sight;
 *     early-warning sites feed their team's air-defence network. An 'ambush' site keeps its radars
 *     silent until the network reports a target near its envelope. Optical sites (guns without
 *     radar, MANPADS) see out to their search range with a line of sight.
 *   - Tracking: the engagement radar holds the chosen target (in its range, above minAltAglM, in
 *     sight); after lockTimeSec it has a firing solution.
 *   - Engaging: inside the envelope (slant range, height), with fewer than `salvo` missiles already
 *     in the air at the target and the salvo interval gone by, a launcher with rounds left fires.
 *     Guns fire lead-computed rounds while the target is in reach.
 * Radar-guided SAMs guide only while their site's engagement radar tracks the target (`guiding`),
 * so a radar that is silenced or destroyed leaves its missiles flying blind: the point of SEAD.
 * Emissions (search, track, guiding a launch) feed the radar-warning receivers. Deterministic
 * (own PRNG stream), allocation-light (spawn requests are new objects, as for aircraft).
 */
import { NO_ENTITY_ID, type EntityId, type HeightSampler, type SimEvent, type Team, type Vec3Like } from '../contracts/core';
import type { AirDefenceSystem } from '../contracts/ground';
import { ProjectileKind, type DetectableEntity, type ProjectileSpawnRequest, type WeaponProfile } from '../contracts/combat';
import { GROUND_UNIT_TYPES, WEAPONS } from '../catalog';
import { terrainLineOfSight } from './lineOfSight';
import { velocityAlignQuat } from './gunBallistics';

/** A radar site sees an anti-radiation missile diving at it inside this range, and shuts down with this probability. */
const ARM_WARNING_M = 30000;
const ARM_SHUTDOWN_P = 0.65;
/**
 * The launch zone against a target flying away is shorter than against one coming in (the missile
 * has to chase it): the site's maximum range scaled from 1 (closing at 200 m/s or more) down to
 * 0.45 (opening at 250 m/s).
 */
function launchZoneFactor(target: DetectableEntity, centre: Vec3Like, range: number): number {
  const closing = -((target.pos.x - centre.x) * target.vel.x + (target.pos.y - centre.y) * target.vel.y + (target.pos.z - centre.z) * target.vel.z) / Math.max(range, 1);
  return Math.max(0.45, Math.min(1, 0.75 + (0.25 * closing) / 200));
}

/** A SAM leaves its launcher along the line of sight raised by this, and at least this far above the horizon, rad. */
const SAM_LAUNCH_LIFT_RAD = 0.17;
const SAM_LAUNCH_MIN_ELEV_RAD = 0.35;
/** Sensing and target choice run at this rate. */
const SENSE_HZ = 10;
/** An ambush site's radars come on when the network sees a target inside this many times its maximum range. */
const AMBUSH_CUE_FACTOR = 1.3;
/** Height of a radar's antenna above the ground (for terrain masking), m. */
const ANTENNA_M = 8;
/** Above this height (m above the ground) a target is clear of ground clutter. */
const LOW_CLUTTER_AGL_M = 300;
const RCS_REF_M2 = 5;
const GRAVITY = 9.80665;

/** One air-defence site as the mission places it. */
export interface AdSiteSpec {
  id: string;
  team: Team;
  system: AirDefenceSystem;
  emcon: 'active' | 'ambush';
}
/** One ground unit belonging to an air-defence site. */
export interface AdUnitSpec {
  entityId: EntityId;
  siteId: string;
  typeId: string;
}

export type AdRole = 'search' | 'track' | 'launcher' | 'gun' | 'manpads' | 'none';

/** A radar emission: which unit, what it is doing (0 search, 1 tracking, 2 guiding a missile), at whom. */
export interface AdEmission {
  entityId: EntityId;
  team: Team;
  symbol: string;
  state: 0 | 1 | 2;
  targetId: EntityId;
  pos: Vec3Like;
}

interface AdUnit {
  id: EntityId;
  role: AdRole;
  ammo: number;
  alive: boolean;
  pos: Vec3Like;
  cooldownSec: number;
}

interface AdSite {
  spec: AdSiteSpec;
  weapon: WeaponProfile | undefined;
  units: AdUnit[];
  targetId: EntityId;
  trackSec: number;
  cooldownSec: number;
  /** Search radar transmitting / engagement radar tracking (as of the last sensing). */
  searching: boolean;
  tracking: boolean;
  /** Radars off until this time (a site hiding from an anti-radiation missile). */
  silentUntilSec: number;
  /** Seconds this site has been suppressed: silenced by an anti-radiation missile, or its radars destroyed. */
  suppressedSec: number;
  nextLauncher: number;
}

function roleOf(typeId: string): AdRole {
  const t = GROUND_UNIT_TYPES[typeId];
  if (!t) return 'none';
  if (t.category === 'radar') return t.id === 'radar-track' ? 'track' : 'search';
  if (t.category === 'sam_launcher') return 'launcher';
  if (t.category === 'aaa') return 'gun';
  if (t.category === 'manpads') return 'manpads';
  return 'none';
}

export class AirDefenceNetwork {
  private readonly sites: AdSite[] = [];
  private readonly siteByUnit = new Map<EntityId, AdSite>();
  /** Missiles in the air: which site fired it, and at whom. */
  private readonly missiles = new Map<EntityId, { site: AdSite; targetId: EntityId }>();
  private readonly emissionsOut: AdEmission[] = [];
  /** The team's network picture: targets its early-warning (and search) radars see, by team. */
  private readonly netTargets: [Set<EntityId>, Set<EntityId>] = [new Set(), new Set()];
  private senseDueSec = 0;
  /** Anti-radiation missiles already seen by the sites they dive at. */
  private readonly armsSeen = new Set<EntityId>();
  private rng: number;

  constructor(sites: readonly AdSiteSpec[], units: readonly AdUnitSpec[], seed: number) {
    this.rng = seed >>> 0 || 1;
    for (const spec of sites) {
      this.sites.push({
        spec,
        weapon: spec.system.weapon ? WEAPONS[spec.system.weapon] : undefined,
        units: [],
        targetId: NO_ENTITY_ID,
        trackSec: 0,
        cooldownSec: 0,
        searching: false,
        tracking: false,
        silentUntilSec: -1,
        suppressedSec: 0,
        nextLauncher: 0,
      });
    }
    for (const u of units) {
      const site = this.sites.find((s) => s.spec.id === u.siteId);
      if (!site) continue;
      const role = roleOf(u.typeId);
      const ammo = GROUND_UNIT_TYPES[u.typeId]?.rounds ?? 0;
      site.units.push({ id: u.entityId, role, ammo, alive: true, pos: { x: 0, y: 0, z: 0 }, cooldownSec: 0 });
      this.siteByUnit.set(u.entityId, site);
    }
  }

  /** Radars transmitting now (for radar-warning receivers and anti-radiation missiles). */
  emissions(): readonly AdEmission[] {
    return this.emissionsOut;
  }

  /** A radar-guided SAM fired by `ownerId` still gets guidance on `targetId` (its site's engagement radar tracks it). */
  guiding(ownerId: EntityId, targetId: EntityId): boolean {
    const site = this.siteByUnit.get(ownerId);
    if (!site) return false;
    if (site.spec.system.sensor !== 'radar') return true;
    return site.tracking && site.targetId === targetId;
  }

  /** Whether `id` is one of the network's units (its missiles are guided by the network). */
  owns(id: EntityId): boolean {
    return this.siteByUnit.has(id);
  }

  missileLaunched(missileId: EntityId, ownerId: EntityId, targetId: EntityId): void {
    const site = this.siteByUnit.get(ownerId);
    if (site) this.missiles.set(missileId, { site, targetId });
  }

  missileGone(missileId: EntityId): void {
    this.missiles.delete(missileId);
  }

  /** Radars of the site owning `unitId` go silent for `sec` (hiding from an anti-radiation missile). */
  silence(unitId: EntityId, untilSec: number): void {
    const site = this.siteByUnit.get(unitId);
    if (site) site.silentUntilSec = Math.max(site.silentUntilSec, untilSec);
  }

  /**
   * An anti-radiation missile `missileId` is in the air: each radar site it is diving at (within
   * ARM_WARNING_M, heading for it) sees it once and, with probability ARM_SHUTDOWN_P, shuts its
   * radars down for 60-90 s (its SAMs lose guidance: the site is suppressed).
   */
  armInbound(missileId: EntityId, team: Team, pos: Vec3Like, vel: Vec3Like, simTimeSec: number): void {
    if (this.armsSeen.has(missileId)) return;
    const sp = Math.hypot(vel.x, vel.y, vel.z) || 1;
    for (const site of this.sites) {
      if (site.spec.team === team || site.spec.system.sensor !== 'radar' || !(site.searching || site.tracking)) continue;
      const c = siteCentre(site);
      const dx = c.x - pos.x, dy = c.y - pos.y, dz = c.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > ARM_WARNING_M || (dx * vel.x + dy * vel.y + dz * vel.z) / (d * sp) < 0.8) continue;
      this.armsSeen.add(missileId);
      if (this.rand() < ARM_SHUTDOWN_P) site.silentUntilSec = Math.max(site.silentUntilSec, simTimeSec + 60 + 30 * this.rand());
    }
  }

  /** Seconds site `siteId` has spent suppressed (silenced by an ARM or radars destroyed). */
  suppressedSec(siteId: string): number {
    return this.sites.find((s) => s.spec.id === siteId)?.suppressedSec ?? 0;
  }

  /** The site of a unit (for tests and the debrief). */
  siteOf(unitId: EntityId): string | undefined {
    return this.siteByUnit.get(unitId)?.spec.id;
  }

  step(
    simTimeSec: number,
    dtSec: number,
    entities: readonly DetectableEntity[],
    isDestroyed: (id: EntityId) => boolean,
    sampler: HeightSampler,
    outRequests: ProjectileSpawnRequest[],
    outEvents: SimEvent[],
  ): void {
    // Unit positions and health.
    for (const site of this.sites) {
      for (const u of site.units) {
        const e = findEntity(entities, u.id);
        u.alive = !!e && e.alive && !isDestroyed(u.id);
        if (e) {
          u.pos.x = e.pos.x;
          u.pos.y = e.pos.y;
          u.pos.z = e.pos.z;
        }
      }
    }
    this.senseDueSec -= dtSec;
    if (this.senseDueSec <= 0) {
      const senseDt = Math.max(dtSec, 1 / SENSE_HZ);
      this.senseDueSec = 1 / SENSE_HZ;
      this.sense(simTimeSec, senseDt, entities, sampler);
    }
    for (const site of this.sites) {
      this.engage(site, dtSec, entities, outRequests, outEvents);
      // Suppressed: hiding from an ARM, or every radar destroyed (radar sites only).
      if (site.spec.system.sensor === 'radar') {
        const radarsLeft = site.units.some((u) => (u.role === 'search' || u.role === 'track') && u.alive);
        if (!radarsLeft || simTimeSec < site.silentUntilSec) site.suppressedSec += dtSec;
      }
    }
    this.buildEmissions();
  }

  private sense(simTimeSec: number, dt: number, entities: readonly DetectableEntity[], sampler: HeightSampler): void {
    // The network picture from every radar that can see (EW sites and search radars).
    for (const s of this.netTargets) s.clear();
    for (const site of this.sites) {
      const sys = site.spec.system;
      const silent = simTimeSec < site.silentUntilSec;
      const searchUnit = site.units.find((u) => u.role === 'search' && u.alive);
      site.searching = false;
      if (sys.sensor !== 'radar' || !searchUnit || silent) continue;
      // An ambush site only lights its search radar when cued (checked below, after the net is known).
      if (site.spec.emcon === 'ambush' && sys.maxRangeM > 0) continue;
      site.searching = true;
      for (const e of entities) {
        if (this.canSee(e, site, searchUnit, sys.searchRangeM, sampler)) this.netTargets[site.spec.team]!.add(e.id);
      }
    }
    for (const site of this.sites) {
      const sys = site.spec.system;
      if (sys.maxRangeM <= 0) continue; // sensor-only site
      const silent = simTimeSec < site.silentUntilSec;
      const net = this.netTargets[site.spec.team]!;
      const trackUnit = site.units.find((u) => (u.role === 'track' || (sys.sensor === 'optical' && u.role !== 'none')) && u.alive);
      const searchUnit = site.units.find((u) => u.role === 'search' && u.alive);
      // Ambush: radars come on when the network sees a target near the envelope.
      if (site.spec.emcon === 'ambush' && sys.sensor === 'radar') {
        let cued = false;
        for (const e of entities) {
          if (!net.has(e.id)) continue;
          if (distance(e.pos, siteCentre(site)) < sys.maxRangeM * AMBUSH_CUE_FACTOR) cued = true;
        }
        site.searching = cued && !!searchUnit && !silent;
      }
      // Keep the target while it can still be tracked, else take the nearest the site (or the net) sees.
      let target: DetectableEntity | undefined = site.targetId !== NO_ENTITY_ID ? findEntity(entities, site.targetId) : undefined;
      const sensorUnit = trackUnit ?? searchUnit;
      const canTrack = (e: DetectableEntity | undefined): boolean =>
        !!e && !!trackUnit && !silent && this.canSee(e, site, trackUnit, sys.sensor === 'radar' ? sys.trackRangeM : sys.searchRangeM, sampler);
      if (!canTrack(target)) {
        target = undefined;
        let best = Infinity;
        for (const e of entities) {
          const seen = sys.sensor === 'radar' ? (site.searching && sensorUnit && this.canSee(e, site, sensorUnit, sys.searchRangeM, sampler)) || net.has(e.id) : sensorUnit && this.canSee(e, site, sensorUnit, sys.searchRangeM, sampler);
          if (!seen || !canTrack(e)) continue;
          const d = distance(e.pos, siteCentre(site));
          if (d < best) {
            best = d;
            target = e;
          }
        }
        if (target?.id !== site.targetId) site.trackSec = 0;
      }
      site.targetId = target ? target.id : NO_ENTITY_ID;
      site.tracking = !!target;
      site.trackSec = target ? site.trackSec + dt : 0;
    }
  }

  /** Whether `e` is a hostile aircraft `sensor` (at the site) can see within `rangeM` (RCS-scaled for radars). */
  private canSee(e: DetectableEntity, site: AdSite, sensor: AdUnit, rangeM: number, sampler: HeightSampler): boolean {
    if (e.kind !== 'aircraft' || !e.alive || e.team === site.spec.team) return false;
    const sys = site.spec.system;
    const d = distance(e.pos, sensor.pos);
    let reach = rangeM;
    const agl = e.pos.y - sampler.heightAt(e.pos.x, e.pos.z);
    if (agl < sys.minAltAglM) return false;
    if (sys.sensor === 'radar') {
      reach *= Math.pow(Math.max(0.1, (e.radarSignature?.broadsideRcsM2 ?? 4) * 0.5 + (e.radarSignature?.noseOnRcsM2 ?? 2) * 0.5) / RCS_REF_M2, 0.25);
      // Low down, ground clutter cuts the radar's reach (to 30% at its floor, full above ~300 m)...
      const c = Math.min(1, Math.max(0, (agl - sys.minAltAglM) / (LOW_CLUTTER_AGL_M - sys.minAltAglM)));
      reach *= 0.3 + 0.7 * c * c * (3 - 2 * c);
      // ...and the earth's curve hides it beyond the radar horizon (4/3 earth: 4.12 km x (sqrt h1 + sqrt h2)).
      reach = Math.min(reach, 4120 * (Math.sqrt(ANTENNA_M) + Math.sqrt(Math.max(0, agl))));
    }
    if (d > reach) return false;
    _eye.x = sensor.pos.x;
    _eye.y = sensor.pos.y + ANTENNA_M;
    _eye.z = sensor.pos.z;
    return terrainLineOfSight(sampler, _eye, e.pos, 0, 30, 80);
  }

  private engage(site: AdSite, dtSec: number, entities: readonly DetectableEntity[], outRequests: ProjectileSpawnRequest[], outEvents: SimEvent[]): void {
    const sys = site.spec.system;
    const w = site.weapon;
    site.cooldownSec -= dtSec;
    if (!w || !site.tracking || site.trackSec < sys.lockTimeSec) return;
    const target = findEntity(entities, site.targetId);
    if (!target) return;
    const centre = siteCentre(site);
    const range = distance(target.pos, centre);
    if (range < sys.minRangeM || range > sys.maxRangeM * launchZoneFactor(target, centre, range) || target.pos.y - centre.y > sys.maxAltM) return;

    if (w.kind === 'gun') {
      // Each gun lays a lead-computed burst at the target.
      for (const u of site.units) {
        u.cooldownSec -= dtSec;
        if (u.role !== 'gun' || !u.alive || u.ammo <= 0 || u.cooldownSec > 0) continue;
        u.cooldownSec += w.roundIntervalSec;
        u.ammo--;
        leadPoint(u.pos, target, w.launchSpeedMps, _aim);
        const dx = _aim.x - u.pos.x, dy = _aim.y - u.pos.y - 2, dz = _aim.z - u.pos.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        const disp = (w.dispersionMrad / 1000) * 2;
        const vx = dx / len + (this.rand() - 0.5) * disp, vy = dy / len + (this.rand() - 0.5) * disp, vz = dz / len + (this.rand() - 0.5) * disp;
        const pos = { x: u.pos.x, y: u.pos.y + 2, z: u.pos.z };
        outRequests.push({ kind: ProjectileKind.Bullet, ownerId: u.id, team: site.spec.team, posWorld: pos, rotWorld: { x: 0, y: 0, z: 0, w: 1 }, velWorld: { x: vx * w.launchSpeedMps, y: vy * w.launchSpeedMps, z: vz * w.launchSpeedMps }, profile: w });
        outEvents.push({ type: 'gunFire', shooterId: u.id, pos, dir: { x: vx, y: vy, z: vz } });
      }
      return;
    }

    // Missiles: a salvo at the target, one launch per interval.
    if (site.cooldownSec > 0) return;
    let inFlight = 0;
    for (const m of this.missiles.values()) if (m.site === site && m.targetId === target.id) inFlight++;
    if (inFlight >= sys.salvo) return;
    const role: AdRole = sys.sensor === 'optical' ? 'manpads' : 'launcher';
    const n = site.units.length;
    let launcher: AdUnit | undefined;
    for (let k = 0; k < n; k++) {
      const u = site.units[(site.nextLauncher + k) % n]!;
      if (u.role === role && u.alive && u.ammo > 0) {
        launcher = u;
        site.nextLauncher = (site.nextLauncher + k + 1) % n;
        break;
      }
    }
    if (!launcher) return;
    launcher.ammo--;
    site.cooldownSec = sys.salvoIntervalSec;
    const dx = target.pos.x - launcher.pos.x, dy = target.pos.y - launcher.pos.y, dz = target.pos.z - launcher.pos.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const shoulder = role === 'manpads';
    // A MANPADS is aimed at the target. A TEL's missile pitches over towards it straight after the
    // launch (a vertical launch's turnover, or an inclined launcher): it leaves along the line of
    // sight raised by SAM_LAUNCH_LIFT_RAD (at least SAM_LAUNCH_MIN_ELEV_RAD), close to a collision
    // course for proportional navigation to take over.
    const v = w.launchSpeedMps;
    let vel: Vec3Like;
    if (shoulder) vel = { x: (dx / len) * v, y: (dy / len) * v, z: (dz / len) * v };
    else {
      const h = Math.hypot(dx, dz) || 1;
      const el = Math.max(Math.atan2(dy, h) + SAM_LAUNCH_LIFT_RAD, SAM_LAUNCH_MIN_ELEV_RAD);
      vel = { x: (dx / h) * Math.cos(el) * v, y: Math.sin(el) * v, z: (dz / h) * Math.cos(el) * v };
    }
    const pos = { x: launcher.pos.x, y: launcher.pos.y + (shoulder ? 1.5 : 5), z: launcher.pos.z };
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    velocityAlignQuat(vel.x, vel.y, vel.z, rot);
    outRequests.push({ kind: w.kind === 'ir_missile' ? ProjectileKind.IrMissile : ProjectileKind.RadarMissile, ownerId: launcher.id, team: site.spec.team, posWorld: pos, rotWorld: rot, velWorld: vel, targetId: target.id, profile: w });
    outEvents.push({ type: 'missileLaunch', shooterId: launcher.id, missileId: NO_ENTITY_ID, weapon: w.kind });
  }

  private buildEmissions(): void {
    const out = this.emissionsOut;
    out.length = 0;
    for (const site of this.sites) {
      const sys = site.spec.system;
      if (sys.sensor !== 'radar' || !sys.rwrSymbol) continue;
      let guidingTarget = false;
      for (const m of this.missiles.values()) if (m.site === site && m.targetId === site.targetId) guidingTarget = true;
      for (const u of site.units) {
        if (!u.alive) continue;
        if (u.role === 'search' && site.searching) out.push({ entityId: u.id, team: site.spec.team, symbol: sys.rwrSymbol, state: 0, targetId: NO_ENTITY_ID, pos: u.pos });
        if (u.role === 'track' && site.tracking) out.push({ entityId: u.id, team: site.spec.team, symbol: sys.rwrSymbol, state: guidingTarget ? 2 : 1, targetId: site.targetId, pos: u.pos });
      }
    }
  }

  private rand(): number {
    let t = (this.rng = (this.rng + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

const _eye = { x: 0, y: 0, z: 0 };
const _aim = { x: 0, y: 0, z: 0 };
const _centre = { x: 0, y: 0, z: 0 };

function findEntity(entities: readonly DetectableEntity[], id: EntityId): DetectableEntity | undefined {
  for (let i = 0; i < entities.length; i++) if (entities[i]!.id === id) return entities[i];
  return undefined;
}

function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** The site's centre (its first unit; they are all within a few hundred metres). */
function siteCentre(site: AdSite): Vec3Like {
  const u = site.units[0];
  if (u) {
    _centre.x = u.pos.x;
    _centre.y = u.pos.y;
    _centre.z = u.pos.z;
  }
  return _centre;
}

/** Where to aim a round of muzzle speed `v` from `from` to meet `target` (constant velocity, gravity drop). */
function leadPoint(from: Vec3Like, target: DetectableEntity, v: number, out: Vec3Like): Vec3Like {
  let t = distance(target.pos, from) / v;
  for (let i = 0; i < 3; i++) {
    out.x = target.pos.x + target.vel.x * t;
    out.y = target.pos.y + target.vel.y * t + 0.5 * GRAVITY * t * t;
    out.z = target.pos.z + target.vel.z * t;
    t = distance(out, from) / v;
  }
  return out;
}
