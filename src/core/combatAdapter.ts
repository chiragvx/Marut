/**
 * src/core/combatAdapter.ts — adapts module 07's real, fine-grained combat
 * exports (contracts/combat.ts) to the single `CombatPort.step` entry point
 * `World` calls. See 10-core-worker.md section 9 item 11 for the exact
 * mechanism this file implements (per-entity `WeaponsState` cache, the one
 * static `WeaponsLoadout` derived from `tejasDefinition.hardpoints`, and the
 * `maxCount`-per-station division rule).
 *
 * Two things `CombatTickContext` (contracts/sim.ts) alone does not expose —
 * each aircraft's current `PilotInputs` and its `AircraftTelemetry.altAglM`,
 * both required by `UpdateSensors`/`FireWeapons` (contracts/combat.ts) — are
 * read through `WorldCombatTickContext` (./combatContext.ts), a private
 * extension `world.ts`'s concrete `combatCtx` object satisfies structurally.
 */

import { EntityKind, MAX_RWR_CONTACTS, NO_ENTITY_ID, RWR_SYMBOLS, STORE_IDS, isAirToGroundKind } from '../contracts/core';
import type { CombatStatus, Contact, EntityId, EntityState, SimEvent, Vec3Like } from '../contracts/core';
import type { CombatPort, CombatTickContext, EventQueue } from '../contracts/sim';
import type { LoadoutPreset } from '../contracts/aircraft';
import type { CombatPortWithAirDefence, CombatPortWithBriefing, CombatPortWithContacts, CombatPortWithRearm, CombatPortWithStores, WorldCombatTickContext } from './combatContext';
import { subSeed } from './seed';
import { getAircraftDefinition, getLoadout } from '../aircraft';
import { RADARS, SENSOR_PODS, WEAPONS } from '../catalog';
import { isaDensityKgM3 } from '../combat/isaDensity';
import {
  createWeaponsState,
  updateSensors,
  fireWeapons,
  stepProjectile,
  resolveProjectileHit,
  writeCombatStatus,
  createProjectilePool,
  resetProjectile,
  initProjectile,
  computeStoresLoad,
  countermeasureRelease,
  combatRand01,
  updateAgSight,
  loadBriefedTarget,
  designatePoint,
  cycleSelectedStore,
  updatePod,
  AirDefenceNetwork,
  type AdEmission,
  createDecoyPool,
  launchDecoy,
  stepDecoy,
  flareSeductionChance,
  chaffSeductionChance,
  DECOY_ID_BASE,
  type Decoy,
} from '../combat';
import { Quat } from '../math';
import {
  GUN_MAX_AMMO_ROUNDS,
  IR_MAX_AMMO_MISSILES,
  RADAR_MISSILE_MAX_AMMO,
  MAX_PROJECTILES,
  ProjectileOutcome,
} from '../contracts/combat';
import type {
  CombatEnvironment,
  DetectableEntity,
  ProjectileSpawnRequest,
  RadarSignature,
  ProjectileState,
  SensorPodProfile,
  WeaponsLoadout,
  WeaponsState,
  WeaponStationSpec,
} from '../contracts/combat';
import type { WeaponKind } from '../contracts/core';

/**
 * An aircraft type's weapons: its default loadout's weapon stations (stores and counts from the
 * catalogue), and its radar. Cached per type id. Unknown types / types without stations fall back
 * to the generic profiles (one gun station).
 */
const loadoutCache = new Map<string, WeaponsLoadout>();
function loadoutFor(defId: string | undefined, fit?: LoadoutPreset): WeaponsLoadout {
  const key = `${defId ?? ''}|${fit ? JSON.stringify(fit.fit) : ''}`;
  const cached = loadoutCache.get(key);
  if (cached) return cached;
  const def = defId ? getAircraftDefinition(defId) : undefined;
  const preset = fit ?? (def ? getLoadout(def) : undefined);
  const stations: WeaponStationSpec[] = [];
  let pod: SensorPodProfile | undefined;
  if (def?.stations && preset) {
    for (const st of def.stations) {
      const fit = preset.fit[st.id];
      if (fit && SENSOR_PODS[fit.store]) pod = SENSOR_PODS[fit.store];
      const profile = fit ? WEAPONS[fit.store] : undefined;
      if (!fit || !profile || fit.count <= 0) continue;
      stations.push({ hardpointId: st.id, posBodyM: st.posBodyM, weapon: profile.kind, maxCount: fit.count * (profile.roundsPerStore ?? 1), profile });
    }
  } else {
    stations.push({ hardpointId: 'gun', posBodyM: { x: 3.5, y: -0.2, z: 0.3 }, weapon: 'gun', maxCount: GUN_MAX_AMMO_ROUNDS });
  }
  const radar = def?.sensors?.radar ? RADARS[def.sensors.radar] : undefined;
  const cm = def?.sensors?.countermeasures;
  const out: WeaponsLoadout = { stations, ...(radar ? { radar } : {}), ...(cm ? { countermeasures: cm } : {}), ...(pod ? { pod } : {}) };
  loadoutCache.set(key, out);
  return out;
}

/** Default combat environment: still air, standard gravity, ISA density at each projectile's altitude. */
function defaultCombatEnvironment(): CombatEnvironment {
  // Density by each projectile's own altitude (was sea level for everything, which cut missile
  // ranges at altitude by a factor of two or more).
  return { airDensityKgM3: 1.225, windWorldMps: { x: 0, y: 0, z: 0 }, gravityMps2: 9.80665, densityAtAltitude: isaDensityKgM3 };
}

const EMPTY_CONTACTS: readonly Contact[] = [];
/** Radar-warning receiver: how far it hears radars, how many it lists, and fighters' symbols by type. */
const RWR_RANGE_M = 250000;
const AIRCRAFT_RWR_SYMBOL: Readonly<Record<string, string>> = { 'jf-17': 'J', 'f-16': 'F', 'tejas-mk1a': 'T' };
/** A laser-guided bomb's owner lases for it in its last seconds of flight; its seeker sees a spot out to this range. */
const LASE_TERMINAL_SEC = 12;
/** An aircraft that crashes within this long of being hit is the shooter's kill, s. */
const CRASH_CREDIT_SEC = 90;
/** Anti-radiation missiles: a pre-briefed one looks for a radar within this of its point once this close; inside this, its memory of a radar that falls silent is exact. */
const ARM_BRIEFED_SEARCH_M = 25000;
const ARM_BRIEFED_RADIUS_M = 1500;
const ARM_MEMORY_EXACT_M = 8000;
const LASER_SEEKER_RANGE_M = 15000;
/** Flares and chaff in the air at once, all aircraft together. */
const MAX_DECOYS = 96;
const RIGHT_BODY = { x: 0, y: 0, z: 1 };

/** An aircraft type's radar signature and hit ellipsoid (cached). */
const signatureCache = new Map<string, { radar: RadarSignature; hitEllipsoidBodyM: Vec3Like } | null>();
function signatureFor(defId: string | undefined): { radar: RadarSignature; hitEllipsoidBodyM: Vec3Like } | undefined {
  if (!defId) return undefined;
  let sig = signatureCache.get(defId);
  if (sig === undefined) {
    const s = getAircraftDefinition(defId)?.signature;
    sig = s ? { radar: { noseOnRcsM2: s.rcsNoseOnM2, broadsideRcsM2: s.rcsBroadsideM2 }, hitEllipsoidBodyM: s.hitEllipsoidBodyM } : null;
    signatureCache.set(defId, sig);
  }
  return sig ?? undefined;
}

export function createCombatAdapter(): CombatPort & CombatPortWithContacts & CombatPortWithRearm & CombatPortWithStores & CombatPortWithAirDefence & CombatPortWithBriefing {
  const weaponsStates = new Map<EntityId, WeaponsState>();
  /** Aircraft hit but not (yet) killed: who hit them last and when (a crippled jet that crashes later is that shooter's kill). */
  const lastHitBy = new Map<EntityId, { sourceId: EntityId; timeSec: number }>();
  const detectableScratch: DetectableEntity[] = [];
  // Reused view over detectableScratch[0..liveCount), rebuilt (references
  // only, no new DetectableEntity objects) every tick instead of
  // detectableScratch.slice(0, liveCount) — see 10-core-worker.md's
  // no-allocation-in-hot-path rule; this array's `.length` is truncated/
  // extended in place, never replaced with a fresh array.
  const allEntitiesScratch: DetectableEntity[] = [];
  const emissionScratch: { trackedTargetId: EntityId | undefined; lockedTargetId: EntityId | undefined }[] = [];
  const liveIdsScratch = new Set<EntityId>();
  const contactsScratchByObserver = new Map<EntityId, Contact[]>();
  const projectilePool: ProjectileState[] = createProjectilePool(MAX_PROJECTILES);
  const projectileIndexByEntityId = new Map<EntityId, number>();
  const freeProjectileIndices: number[] = [];
  for (let i = projectilePool.length - 1; i >= 0; i--) freeProjectileIndices.push(i);
  const combatEnv = defaultCombatEnvironment();
  const outRequestsScratch: ProjectileSpawnRequest[] = [];
  // Hoisted per-aircraft-per-tick event scratch (previously fresh arrays
  // allocated inside the per-aircraft loop every tick) — reset via
  // `.length = 0` exactly like outRequestsScratch already was.
  const sensorEventsScratch: SimEvent[] = [];
  const fireEventsScratch: SimEvent[] = [];
  const hitEventsScratch: SimEvent[] = [];
  const groundEventsScratch: SimEvent[] = [];
  const prevPos = { x: 0, y: 0, z: 0 };
  const impact = { x: 0, y: 0, z: 0 };
  const storesLoadScratch = { massKg: 0, dragAreaM2: 0 };
  /** Projectiles finished this tick, despawned only after the step loop (see that loop's comment). */
  const despawnScratch: EntityId[] = [];
  // Flares and chaff in the air: flown here, shown to missiles as extra (kind 'effect') entities.
  const decoys: Decoy[] = createDecoyPool(MAX_DECOYS);
  const decoyDetectables: DetectableEntity[] = decoys.map(() => ({ id: NO_ENTITY_ID, team: 0, kind: EntityKind.Effect, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, alive: true }));
  let decoySerial = 0;
  const releaseScratch = { flares: 0, chaff: 0 };
  /** Laser spots this tick (pods lasing), by team; and the aircraft whose laser-guided bombs are in the terminal phase (lase for them). */
  const laserSpots: { team: number; x: number; y: number; z: number }[] = [];
  let laserSpotCount = 0;
  let autoLaseOwners = new Set<EntityId>();
  let autoLaseNext = new Set<EntityId>();
  const rightScratch = { x: 0, y: 0, z: 0 };

  /** Releases `n` decoys of `kind` from `owner` and gives each enemy missile guiding on it a chance to take the bait. */
  function releaseDecoys(kind: 'flare' | 'chaff', n: number, owner: EntityState, rng: { seedState: number }, liveCount: number, ctx: WorldCombatTickContext, eventsOut: EventQueue): void {
    Quat.rotate(owner.rot, RIGHT_BODY, rightScratch);
    for (let k = 0; k < n; k++) {
      let d: Decoy | undefined;
      for (let i = 0; i < decoys.length; i++) if (!decoys[i]!.active) { d = decoys[i]; break; }
      if (!d) return;
      launchDecoy(d, DECOY_ID_BASE + (decoySerial++ % DECOY_ID_BASE), kind, owner.id, owner.pos, owner.vel, rightScratch, k % 2 === 0 ? -1 : 1);
      eventsOut.push({ type: 'countermeasure', entityId: owner.id, kind, pos: { x: d.pos.x, y: d.pos.y, z: d.pos.z }, vel: { x: d.vel.x, y: d.vel.y, z: d.vel.z } });
      for (let i = 0; i < liveCount; i++) {
        const e = ctx.liveAt(i);
        if (e.kind !== EntityKind.Missile) continue;
        const pi = projectileIndexByEntityId.get(e.id);
        if (pi === undefined) continue;
        const p = projectilePool[pi]!;
        if (p.targetId !== owner.id) continue;
        let chance = 0;
        if (kind === 'flare' && p.kind === 'ir_missile' && p.guidance === 'ir_homing') {
          chance = flareSeductionChance(p.profile?.ir?.flareResistance, e.pos, owner.pos, owner.vel, owner.afterburnerOn);
        } else if (kind === 'chaff' && p.kind === 'radar_missile' && p.guidance === 'radar_active') {
          chance = chaffSeductionChance(p.profile?.radar?.chaffResistance, e.pos, owner.pos, owner.vel);
        }
        if (chance > 0 && combatRand01(rng) < chance) p.targetId = d.id;
      }
    }
  }

  // Air defences (src/combat/airDefence.ts): built per mission (a new spec object per load).
  let adNetwork: AirDefenceNetwork | undefined;
  let adSpecRef: unknown;
  const adRequests: ProjectileSpawnRequest[] = [];
  const adEvents: SimEvent[] = [];
  /** Each emitting ground radar's state as of the last tick (radar-warning receivers read it). */
  const adEmitByEntity = new Map<EntityId, AdEmission>();
  const groundEmission = new Map<EntityId, { trackedTargetId: EntityId | undefined; lockedTargetId: EntityId | undefined }>();

  /**
   * Spawns projectile requests (an aircraft's weapons, or an air-defence site's) as entities with
   * their pool slots, and patches each launch event's missile id. `network`: the air-defence
   * network that fired them (it tracks its missiles in the air).
   */
  function spawnRequests(ctx: WorldCombatTickContext, reqs: ProjectileSpawnRequest[], events: SimEvent[], network: AirDefenceNetwork | undefined): void {
    for (const req of reqs) {
      if (freeProjectileIndices.length === 0) continue;
      // headingRad is only a placeholder for SpawnSpec's initial rotation: the exact rotWorld /
      // velWorld below overwrite it once the entity exists.
      const headingRadApprox = Math.atan2(req.velWorld.x, -req.velWorld.z);
      const spawnedId = ctx.spawn({
        kind: req.kind === 'bullet' ? EntityKind.Bullet : EntityKind.Missile,
        team: req.team,
        pos: req.posWorld,
        headingRad: headingRadApprox,
        weapon: req.kind === 'bullet' ? 'gun' : (req.kind as WeaponKind),
        shooterId: req.ownerId,
      });
      if (spawnedId === NO_ENTITY_ID) continue;
      const spawnedState = findLiveState(ctx, spawnedId);
      if (spawnedState) {
        spawnedState.vel.x = req.velWorld.x;
        spawnedState.vel.y = req.velWorld.y;
        spawnedState.vel.z = req.velWorld.z;
        spawnedState.rot.x = req.rotWorld.x;
        spawnedState.rot.y = req.rotWorld.y;
        spawnedState.rot.z = req.rotWorld.z;
        spawnedState.rot.w = req.rotWorld.w;
        // Which missile it is, for the renderer's model.
        spawnedState.stores = req.profile ? Math.max(0, STORE_IDS.indexOf(req.profile.id)) : 0;
      }
      const poolIndex = freeProjectileIndices.pop() as number;
      const slot = projectilePool[poolIndex] as ProjectileState;
      // Each projectile's own random stream (seeker noise, datalink error, fuze), reproducible per mission.
      req.rngSeed = subSeed(ctx.missionSeed, 'proj:' + spawnedId);
      initProjectile(slot, req, ctx.simTimeSec);
      projectileIndexByEntityId.set(spawnedId, poolIndex);
      if (req.kind !== 'bullet') {
        patchNextMissileLaunchId(events, spawnedId);
        if (network && req.targetId !== undefined) network.missileLaunched(spawnedId, req.ownerId, req.targetId);
      }
    }
  }

  /**
   * The aircraft's radar-warning receiver picture: every hostile radar transmitting within range —
   * ground radars (searching, tracking it, or guiding a missile at it) and hostile fighters' radars
   * (searching, or tracking / locked on it) — with its symbol, bearing and range.
   */
  function buildRwr(observer: EntityState, cs: CombatStatus, liveCount: number, ctx: WorldCombatTickContext): void {
    const list = cs.rwr ?? (cs.rwr = []);
    let n = 0;
    const put = (symbol: string, x: number, z: number, y: number, state: number): void => {
      if (n >= MAX_RWR_CONTACTS) return;
      const e = list[n] ?? (list[n] = { symbol: 0, bearingRad: 0, state: 0, rangeM: 0 });
      e.symbol = Math.max(0, RWR_SYMBOLS.indexOf(symbol));
      e.bearingRad = Math.atan2(x - observer.pos.x, -(z - observer.pos.z));
      e.rangeM = Math.hypot(x - observer.pos.x, y - observer.pos.y, z - observer.pos.z);
      e.state = state;
      n++;
    };
    for (const em of adEmitByEntity.values()) {
      if (em.team === observer.team) continue;
      const r = Math.hypot(em.pos.x - observer.pos.x, em.pos.z - observer.pos.z);
      if (r > RWR_RANGE_M) continue;
      put(em.symbol, em.pos.x, em.pos.z, em.pos.y, em.state === 0 || em.targetId !== observer.id ? 0 : em.state);
    }
    for (let i = 0; i < liveCount; i++) {
      const e = ctx.liveAt(i);
      if (e.kind !== EntityKind.Aircraft || !e.alive || e.team === observer.team) continue;
      const ws = weaponsStates.get(e.id);
      if (!ws) continue;
      if (Math.hypot(e.pos.x - observer.pos.x, e.pos.z - observer.pos.z) > ws.radar.maxRangeM) continue;
      const onMe = ws.lockedTargetId === observer.id;
      const locked = onMe && ws.lockState === 'locked' && ws.selectedWeapon === 'radar_missile';
      put(AIRCRAFT_RWR_SYMBOL[ctx.getAircraftDefId(e.id) ?? ''] ?? 'AI', e.pos.x, e.pos.z, e.pos.y, locked ? 2 : onMe ? 1 : 0);
    }
    list.length = n;
  }

  function ensureDetectableCapacity(n: number): void {
    while (detectableScratch.length < n) {
      detectableScratch.push({ id: NO_ENTITY_ID, team: 0, kind: EntityKind.Aircraft, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, alive: false });
    }
  }

  return {
    rearm(id: EntityId, frac: number): void {
      const w = weaponsStates.get(id);
      if (!w) return;
      const f = Math.max(0, Math.min(1, frac));
      for (let i = 0; i < w.stations.length; i++) {
        const st = w.stations[i]!;
        const target = f >= 1 ? st.maxCount : Math.floor(st.maxCount * f);
        if (st.count < target) st.count = target;
      }
      w.chaff = Math.max(w.chaff, f >= 1 ? w.chaffMax : Math.floor(w.chaffMax * f));
      w.flares = Math.max(w.flares, f >= 1 ? w.flaresMax : Math.floor(w.flaresMax * f));
    },

    armedFrac(id: EntityId): number {
      const w = weaponsStates.get(id);
      if (!w) return 1;
      let f = 1;
      for (let i = 0; i < w.stations.length; i++) {
        const st = w.stations[i]!;
        if (st.maxCount > 0) f = Math.min(f, st.count / st.maxCount);
      }
      return f;
    },

    stationCount(id: EntityId, hardpointId: string): number | undefined {
      const w = weaponsStates.get(id);
      if (!w) return undefined;
      for (let i = 0; i < w.stations.length; i++) if (w.stations[i]!.hardpointId === hardpointId) return w.stations[i]!.count;
      return undefined;
    },

    siteSuppressedSec(siteId: string): number {
      return adNetwork?.suppressedSec(siteId) ?? 0;
    },

    loadBriefedTarget(id: EntityId, points: readonly Vec3Like[]): void {
      const st = weaponsStates.get(id);
      if (st) loadBriefedTarget(st, points);
    },

    creditCrash(id: EntityId, simTimeSec: number): EntityId | undefined {
      const h = lastHitBy.get(id);
      lastHitBy.delete(id);
      return h && h.timeSec <= simTimeSec && simTimeSec - h.timeSec < CRASH_CREDIT_SEC ? h.sourceId : undefined;
    },

    armStrike(id: EntityId, point: Vec3Like): boolean {
      const st = weaponsStates.get(id);
      if (!st) return false;
      for (let k = 0; k < st.stations.length + 1 && !isAirToGroundKind(st.selectedWeapon); k++) cycleSelectedStore(st);
      designatePoint(st, point);
      return true;
    },

    getContacts(id: EntityId): readonly Contact[] {
      return contactsScratchByObserver.get(id) ?? EMPTY_CONTACTS;
    },
    step(dtSec: number, ctxBase: CombatTickContext, eventsOut: EventQueue): void {
      const ctx = ctxBase as unknown as WorldCombatTickContext;
      const liveCount = ctx.liveCount;
      ensureDetectableCapacity(liveCount);

      // Build the shared per-tick DetectableEntity array once.
      allEntitiesScratch.length = liveCount;
      for (let i = 0; i < liveCount; i++) {
        const e = ctx.liveAt(i);
        const d = detectableScratch[i] as DetectableEntity;
        d.id = e.id;
        d.team = e.team;
        d.kind = e.kind;
        d.pos.x = e.pos.x;
        d.pos.y = e.pos.y;
        d.pos.z = e.pos.z;
        d.vel.x = e.vel.x;
        d.vel.y = e.vel.y;
        d.vel.z = e.vel.z;
        d.rot.x = e.rot.x;
        d.rot.y = e.rot.y;
        d.rot.z = e.rot.z;
        d.rot.w = e.rot.w;
        d.alive = e.alive;
        // What this aircraft's radar is doing (from last tick's weapons state): tracking its designated
        // target, locked on it for a radar missile. Other aircraft's radar-warning receivers read it.
        const ws = e.kind === EntityKind.Aircraft ? weaponsStates.get(e.id) : undefined;
        if (ws && ws.lockedTargetId !== undefined) {
          let em = emissionScratch[i];
          if (!em) em = emissionScratch[i] = { trackedTargetId: undefined, lockedTargetId: undefined };
          em.trackedTargetId = ws.lockedTargetId;
          em.lockedTargetId = ws.lockState === 'locked' && ws.selectedWeapon === 'radar_missile' ? ws.lockedTargetId : undefined;
          d.radarEmission = em;
        } else if (e.kind === EntityKind.Ground && adEmitByEntity.has(e.id)) {
          // A ground radar: tracking (state 1) or guiding a missile (state 2) at its target.
          const ae = adEmitByEntity.get(e.id)!;
          let em = groundEmission.get(e.id);
          if (!em) groundEmission.set(e.id, (em = { trackedTargetId: undefined, lockedTargetId: undefined }));
          em.trackedTargetId = ae.state >= 1 ? ae.targetId : undefined;
          em.lockedTargetId = ae.state === 2 ? ae.targetId : undefined;
          d.radarEmission = em;
        } else {
          d.radarEmission = undefined;
        }
        const sig = e.kind === EntityKind.Aircraft ? signatureFor(ctx.getAircraftDefId(e.id)) : undefined;
        if (sig) {
          d.radarSignature = sig.radar;
          d.hitEllipsoidBodyM = sig.hitEllipsoidBodyM;
        } else {
          d.radarSignature = undefined;
          d.hitEllipsoidBodyM = undefined;
        }
        allEntitiesScratch[i] = d;
      }
      // Decoys in the air (flown on, burnt-out ones freed), after the real entities.
      for (let i = 0; i < decoys.length; i++) {
        const dc = decoys[i]!;
        if (!dc.active || !stepDecoy(dc, dtSec)) continue;
        const dd = decoyDetectables[i]!;
        dd.id = dc.id;
        dd.pos.x = dc.pos.x; dd.pos.y = dc.pos.y; dd.pos.z = dc.pos.z;
        dd.vel.x = dc.vel.x; dd.vel.y = dc.vel.y; dd.vel.z = dc.vel.z;
        allEntitiesScratch.push(dd);
      }
      const allEntities = allEntitiesScratch;

      // Discover new aircraft; create their WeaponsState.
      for (let i = 0; i < liveCount; i++) {
        const e = ctx.liveAt(i);
        if (e.kind !== EntityKind.Aircraft) continue;
        if (weaponsStates.has(e.id)) continue;
        weaponsStates.set(e.id, createWeaponsState(loadoutFor(ctx.getAircraftDefId(e.id), ctx.getLoadout?.(e.id)), subSeed(ctx.missionSeed, 'combat:' + e.id)));
      }
      // Drop WeaponsState for aircraft no longer live (reused Set, cleared
      // and refilled each tick rather than `new Set()` + `Array.from()`).
      if (weaponsStates.size > 0) {
        liveIdsScratch.clear();
        for (let i = 0; i < liveCount; i++) liveIdsScratch.add(ctx.liveAt(i).id);
        for (const id of weaponsStates.keys()) {
          if (!liveIdsScratch.has(id)) weaponsStates.delete(id);
        }
      }

      // Per-aircraft: sensors, then fire.
      for (let i = 0; i < liveCount; i++) {
        const observer = ctx.liveAt(i);
        if (observer.kind !== EntityKind.Aircraft || !observer.alive) continue;
        const state = weaponsStates.get(observer.id);
        if (!state) continue;
        const damage = ctx.getDamage(observer.id);
        if (!damage) continue;
        const inputs = ctx.getInputs(observer.id);
        if (!inputs) continue;
        const observerDetectable = detectableScratch[i] as DetectableEntity;
        const contacts = contactsScratchByObserver.get(observer.id) ?? [];
        contacts.length = 0;
        contactsScratchByObserver.set(observer.id, contacts);
        sensorEventsScratch.length = 0;

        updateSensors(
          observer.id,
          observerDetectable,
          damage,
          ctx.getAltAglM(observer.id),
          inputs,
          allEntities,
          ctx.sampler,
          state,
          ctx.simTimeSec,
          dtSec,
          contacts,
          sensorEventsScratch
        );
        for (const ev of sensorEventsScratch) eventsOut.push(ev);

        // Targeting pod: slewed / tracking / lasing; while designating, its point is the SPI.
        if (state.pod) {
          const pod = state.pod;
          if (updatePod(pod, observer, inputs, allEntities, ctx.sampler, autoLaseOwners.has(observer.id), dtSec) && pod.pointValid) {
            // Slewed off the pre-planned aim point: the pilot's own designation from now on.
            if (state.briefed && Math.hypot(pod.point.x - state.spi.x, pod.point.z - state.spi.z) > 2) state.briefed = undefined;
            state.spiValid = true;
            state.spi.x = pod.point.x;
            state.spi.y = pod.point.y;
            state.spi.z = pod.point.z;
          }
          if (pod.laser) {
            let spot = laserSpots[laserSpotCount];
            if (!spot) laserSpots.push((spot = { team: 0, x: 0, y: 0, z: 0 }));
            laserSpotCount++;
            spot.team = observer.team;
            spot.x = pod.point.x;
            spot.y = pod.point.y;
            spot.z = pod.point.z;
          }
        }
        updateAgSight(state, observer, ctx.sampler, isaDensityKgM3, dtSec);
        writeCombatStatus(state, mustGetCombatStatus(ctx, observer.id));

        const lockedTarget = state.lockedTargetId !== undefined ? findDetectable(allEntities, state.lockedTargetId) : undefined;
        outRequestsScratch.length = 0;
        fireEventsScratch.length = 0;
        fireWeapons(observer.id, observer, damage, lockedTarget, inputs, state, ctx.simTimeSec, dtSec, outRequestsScratch, fireEventsScratch);
        // Carried weapons' mass/drag for the flight model, from the counts left after this tick's
        // firing (EntityState.storesMassKg/storesDragAreaM2's doc comment).
        countermeasureRelease(state, inputs.dispenseFlare ?? false, inputs.dispenseChaff ?? false, dtSec, releaseScratch);
        if (releaseScratch.flares > 0) releaseDecoys('flare', releaseScratch.flares, observer, state.rng, liveCount, ctx, eventsOut);
        if (releaseScratch.chaff > 0) releaseDecoys('chaff', releaseScratch.chaff, observer, state.rng, liveCount, ctx, eventsOut);
        computeStoresLoad(state, storesLoadScratch);
        observer.storesMassKg = storesLoadScratch.massKg;
        observer.storesDragAreaM2 = storesLoadScratch.dragAreaM2;

        spawnRequests(ctx, outRequestsScratch, fireEventsScratch, undefined);
        // Forwarded only now, after the spawns above: weaponStation.ts emits each missileLaunch
        // with missileId=NO_ENTITY_ID and leaves it to core to patch in the spawned id (07-combat.md
        // section 3.1). Forwarding before the spawn left it at -1, so the renderer's smoke trail
        // (effects.ts, keyed on missileId) never found the missile.
        for (const ev of fireEventsScratch) eventsOut.push(ev);
      }

      // Air defences: sense, track, engage; their launches spawn like the aircraft's.
      const adSpec = ctx.airDefence;
      if (adSpec && adSpec.sites.length > 0) {
        if (!adNetwork || adSpecRef !== adSpec) {
          adNetwork = new AirDefenceNetwork(adSpec.sites, adSpec.units, subSeed(ctx.missionSeed, 'airDefence'));
          adSpecRef = adSpec;
        }
        adRequests.length = 0;
        adEvents.length = 0;
        const ground = ctx.ground;
        adNetwork.step(ctx.simTimeSec, dtSec, allEntities, (id) => ground?.isDestroyed(id) ?? false, ctx.sampler, adRequests, adEvents);
        spawnRequests(ctx, adRequests, adEvents, adNetwork);
        for (const ev of adEvents) eventsOut.push(ev);
        adEmitByEntity.clear();
        for (const em of adNetwork.emissions()) adEmitByEntity.set(em.entityId, em);
      } else if (adNetwork) {
        adNetwork = undefined;
        adEmitByEntity.clear();
      }
      // Radar-warning receivers: what each aircraft hears (ground radars, hostile fighters' radars).
      for (let i = 0; i < liveCount; i++) {
        const observer = ctx.liveAt(i);
        if (observer.kind !== EntityKind.Aircraft || !observer.alive) continue;
        const cs = ctx.getCombatStatus(observer.id);
        if (cs) buildRwr(observer, cs, liveCount, ctx);
      }

      // Laser-guided bombs: steer to a friendly laser spot inside the seeker's cone (none = fall
      // ballistic); an owner's bomb in its last LASE_TERMINAL_SEC makes that owner's pod lase.
      autoLaseNext.clear();
      for (let i = 0; i < liveCount; i++) {
        const e = ctx.liveAt(i);
        if (e.kind !== EntityKind.Missile) continue;
        const pi = projectileIndexByEntityId.get(e.id);
        if (pi === undefined) continue;
        const p = projectilePool[pi]!;
        const g = p.profile?.guided;
        if (p.kind !== 'guided_bomb' || g?.seeker !== 'laser' || !p.targetPoint) continue;
        const fall = e.pos.y - ctx.sampler.heightAt(e.pos.x, e.pos.z);
        if (fall / Math.max(20, -e.vel.y) < LASE_TERMINAL_SEC) autoLaseNext.add(p.ownerId);
        p.targetPointValid = false;
        const sp = Math.hypot(e.vel.x, e.vel.y, e.vel.z) || 1;
        const cosCone = Math.cos(((g.seekerHalfAngleDeg ?? 20) * Math.PI) / 180);
        let bestCos = cosCone;
        for (let k = 0; k < laserSpotCount; k++) {
          const s = laserSpots[k]!;
          if (s.team !== e.team) continue;
          const dx = s.x - e.pos.x, dy = s.y - e.pos.y, dz = s.z - e.pos.z;
          const d = Math.hypot(dx, dy, dz);
          if (d > LASER_SEEKER_RANGE_M || d < 1) continue;
          const c = (dx * e.vel.x + dy * e.vel.y + dz * e.vel.z) / (d * sp);
          if (c >= bestCos) {
            bestCos = c;
            p.targetPoint.x = s.x;
            p.targetPoint.y = s.y;
            p.targetPoint.z = s.z;
            p.targetPointValid = true;
          }
        }
      }
      [autoLaseOwners, autoLaseNext] = [autoLaseNext, autoLaseOwners];

      // Anti-radiation missiles: home on the radar while it transmits; when it falls silent far
      // out, fly to where they remember it (drifting with the distance still to go); pre-briefed
      // ones look for a radar near their point on the way in. The sites they dive at may hide.
      for (let i = 0; i < liveCount; i++) {
        const e = ctx.liveAt(i);
        if (e.kind !== EntityKind.Missile) continue;
        const pi = projectileIndexByEntityId.get(e.id);
        if (pi === undefined) continue;
        const p = projectilePool[pi]!;
        const a = p.profile?.arm;
        if (p.kind !== 'arm' || !a || !p.targetPoint) continue;
        if (p.targetId === NO_ENTITY_ID && p.targetPointValid) {
          const togo = Math.hypot(p.targetPoint.x - e.pos.x, p.targetPoint.z - e.pos.z);
          if (togo < ARM_BRIEFED_SEARCH_M) {
            for (const em of adEmitByEntity.values()) {
              if (em.team === e.team) continue;
              if (Math.hypot(em.pos.x - p.targetPoint.x, em.pos.z - p.targetPoint.z) < ARM_BRIEFED_RADIUS_M) p.targetId = em.entityId;
            }
          }
        }
        if (p.targetId !== NO_ENTITY_ID) {
          const radar = findLiveState(ctx, p.targetId);
          if (radar && adEmitByEntity.has(p.targetId)) {
            p.targetPoint.x = radar.pos.x;
            p.targetPoint.y = radar.pos.y + 1;
            p.targetPoint.z = radar.pos.z;
            p.targetPointValid = true;
            p.armMemory = false;
          } else if (p.targetPointValid && !p.armMemory) {
            // It went quiet: from far out the remembered aim is off by more (seeded by the missile's id).
            p.armMemory = true;
            const togo = Math.hypot(p.targetPoint.x - e.pos.x, p.targetPoint.z - e.pos.z);
            if (togo > ARM_MEMORY_EXACT_M) {
              const err = a.memoryErrorM * (togo / 30000);
              const ang = ((e.id * 2654435761) >>> 0) / 4294967296 * Math.PI * 2;
              p.targetPoint.x += Math.cos(ang) * err;
              p.targetPoint.z += Math.sin(ang) * err;
            }
          }
        }
        adNetwork?.armInbound(e.id, e.team, e.pos, e.vel, ctx.simTimeSec);
      }
      laserSpotCount = 0;

      // Step every live projectile. Finished projectiles are despawned only AFTER this loop:
      // ctx.despawn swap-removes from the pool's dense list, so despawning mid-loop both skips the
      // entity swapped into slot i and, once two projectiles finish in one tick, walks past the
      // shrunken liveCount (EntityPool.liveAt throws "denseIndex out of range").
      despawnScratch.length = 0;
      for (let i = 0; i < liveCount; i++) {
        const state = ctx.liveAt(i);
        if (state.kind !== EntityKind.Bullet && state.kind !== EntityKind.Missile) continue;
        const poolIndex = projectileIndexByEntityId.get(state.id);
        if (poolIndex === undefined) continue;
        const projectile = projectilePool[poolIndex] as ProjectileState;
        if (projectile.kind === 'radar_missile' && adNetwork?.owns(projectile.ownerId)) {
          // A SAM: guided while its site's engagement radar tracks the target.
          projectile.datalinkOk = adNetwork.guiding(projectile.ownerId, projectile.targetId);
        } else if (projectile.kind === 'radar_missile') {
          // Mid-course datalink: only while the launcher is alive and its radar still holds the
          // target in active track (not coasting on memory). Otherwise the missile flies on its last update.
          const owner = weaponsStates.get(projectile.ownerId);
          const track = owner && projectile.targetId !== undefined ? owner.tracks.get(projectile.targetId) : undefined;
          projectile.datalinkOk = track !== undefined && track.source === 'radar' && !track.memory;
        }
        prevPos.x = state.pos.x; prevPos.y = state.pos.y; prevPos.z = state.pos.z;
        const result = stepProjectile(state, projectile, allEntities, ctx.sampler, combatEnv, dtSec, state);

        // The ground: this tick's path through a ground target's box (before whatever else ended it),
        // else a warhead going off on the terrain. Air hits are resolved below as before.
        const ground = ctx.ground;
        const prof = projectile.profile;
        const airHit = result.outcome === ProjectileOutcome.DirectHit || result.outcome === ProjectileOutcome.ProximityDetonation;
        if (ground && !airHit) {
          const end = result.outcome === ProjectileOutcome.Flying ? state.pos : (result.impactPos ?? state.pos);
          const hit = ground.segmentHit(prevPos, end);
          const armed = projectile.distanceTravelledM >= (prof?.armDistanceM ?? 0);
          groundEventsScratch.length = 0;
          if (hit) {
            impact.x = prevPos.x + (end.x - prevPos.x) * hit.t;
            impact.y = prevPos.y + (end.y - prevPos.y) * hit.t;
            impact.z = prevPos.z + (end.z - prevPos.z) * hit.t;
            if (projectile.kind === 'bullet') {
              ground.gunHit(hit.key, projectile.ownerId, groundEventsScratch);
              groundEventsScratch.push({ type: 'groundImpact', pos: { x: impact.x, y: impact.y, z: impact.z }, explosiveKg: 0 });
            } else if (prof?.warhead && armed) {
              ground.blast(impact, prof.warhead, projectile.ownerId, groundEventsScratch, hit.key);
              groundEventsScratch.push({ type: 'groundImpact', pos: { x: impact.x, y: impact.y, z: impact.z }, explosiveKg: prof.warhead.explosiveKg });
            }
            for (const ev of groundEventsScratch) eventsOut.push(ev);
            resetProjectile(projectile);
            freeProjectileIndices.push(poolIndex);
            projectileIndexByEntityId.delete(state.id);
            despawnScratch.push(state.id);
            continue;
          }
          if (result.outcome === ProjectileOutcome.TerrainImpact && result.impactPos) {
            const w = projectile.kind === 'bullet' ? undefined : prof?.warhead;
            if (w && armed) {
              ground.blast(result.impactPos, w, projectile.ownerId, groundEventsScratch);
              ctx.runways?.impact(result.impactPos, w, groundEventsScratch);
            }
            groundEventsScratch.push({ type: 'groundImpact', pos: { x: result.impactPos.x, y: result.impactPos.y, z: result.impactPos.z }, explosiveKg: w && armed ? w.explosiveKg : 0 });
            for (const ev of groundEventsScratch) eventsOut.push(ev);
          }
        }
        if (result.outcome === ProjectileOutcome.Flying) continue;

        if (result.outcome === ProjectileOutcome.DirectHit || result.outcome === ProjectileOutcome.ProximityDetonation) {
          const targetId = result.hitTargetId;
          if (targetId !== undefined) {
            const targetState = findLiveState(ctx, targetId);
            const targetDamage = targetState ? ctx.getDamage(targetId) : undefined;
            if (targetState && targetDamage) {
              const wstate = weaponsStates.get(projectile.ownerId);
              const rng = wstate ? wstate.rng : { seedState: subSeed(ctx.missionSeed, 'combat:hit:' + state.id) };
              const wasIntact = targetDamage.structurePct > 0;
              hitEventsScratch.length = 0;
              const hit = resolveProjectileHit(result, projectile.ownerId, projectile.kind, targetState, targetDamage, rng, hitEventsScratch, projectile.profile);
              for (const ev of hitEventsScratch) eventsOut.push(ev);
              // The kill, credited to the shooter (once: later hits on the wreck don't count). World
              // turns the destroyed airframe into a crash on its next step.
              if (hit.targetLethal && wasIntact) {
                eventsOut.push({ type: 'kill', targetId, sourceId: projectile.ownerId });
                lastHitBy.delete(targetId);
              } else if (wasIntact && targetState.kind === EntityKind.Aircraft && hitEventsScratch.some((ev) => ev.type === 'hit')) {
                lastHitBy.set(targetId, { sourceId: projectile.ownerId, timeSec: ctx.simTimeSec });
              }
            }
          }
        }

        resetProjectile(projectile);
        freeProjectileIndices.push(poolIndex);
        projectileIndexByEntityId.delete(state.id);
        despawnScratch.push(state.id);
      }
      for (let k = 0; k < despawnScratch.length; k++) {
        adNetwork?.missileGone(despawnScratch[k]!);
        ctx.despawn(despawnScratch[k]!);
      }
    },
  };
}

/** Fills in the first still-unpatched missileLaunch event's missileId (one event per missile spawn request, in order). */
function patchNextMissileLaunchId(events: SimEvent[], missileId: EntityId): void {
  for (const ev of events) {
    if (ev.type === 'missileLaunch' && ev.missileId === NO_ENTITY_ID) {
      ev.missileId = missileId;
      return;
    }
  }
}

function findDetectable(entities: readonly DetectableEntity[], id: EntityId): DetectableEntity | undefined {
  for (const e of entities) if (e.id === id) return e;
  return undefined;
}

function findLiveState(ctx: WorldCombatTickContext, id: EntityId): EntityState | undefined {
  const n = ctx.liveCount;
  for (let i = 0; i < n; i++) {
    const e = ctx.liveAt(i);
    if (e.id === id) return e;
  }
  return undefined;
}

function mustGetCombatStatus(ctx: WorldCombatTickContext, id: EntityId) {
  const cs = ctx.getCombatStatus(id);
  if (!cs) throw new Error(`combatAdapter: World did not pre-create a CombatStatus record for aircraft ${id}`);
  return cs;
}

export const combatAdapter: CombatPort & CombatPortWithContacts = createCombatAdapter();
