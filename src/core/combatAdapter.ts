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

import { EntityKind, NO_ENTITY_ID } from '../contracts/core';
import type { Contact, EntityId, EntityState, SimEvent } from '../contracts/core';
import type { CombatPort, CombatTickContext, EventQueue } from '../contracts/sim';
import type { CombatPortWithContacts, WorldCombatTickContext } from './combatContext';
import { subSeed } from './seed';
import { tejasDefinition } from '../aircraft';
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
} from '../combat';
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
  ProjectileState,
  WeaponsLoadout,
  WeaponsState,
  WeaponStationSpec,
} from '../contracts/combat';
import type { WeaponKind } from '../contracts/core';

/** Built once from `tejasDefinition.hardpoints` (10-core-worker.md section 9 item 11's exact per-type maxCount division rule). This project has exactly one AircraftDefinition, so one static loadout suffices. */
function buildTejasLoadout(): WeaponsLoadout {
  const hardpoints = tejasDefinition.hardpoints.filter((h) => h.type !== 'fuel_tank');
  const countByType = new Map<string, number>();
  for (const h of hardpoints) countByType.set(h.type, (countByType.get(h.type) ?? 0) + 1);
  const maxAmmoByType: Record<string, number> = {
    gun: GUN_MAX_AMMO_ROUNDS,
    ir_missile: IR_MAX_AMMO_MISSILES,
    radar_missile: RADAR_MISSILE_MAX_AMMO,
  };
  const stations: WeaponStationSpec[] = hardpoints.map((h) => {
    const typeCount = countByType.get(h.type) ?? 1;
    const totalAmmo = maxAmmoByType[h.type] ?? 0;
    return {
      hardpointId: h.id,
      posBodyM: h.posBodyM,
      weapon: h.type as WeaponKind,
      maxCount: Math.floor(totalAmmo / typeCount),
    };
  });
  return { stations };
}

const TEJAS_LOADOUT = buildTejasLoadout();

/** Fixed default combat environment (module 10 does not currently thread per-projectile atmosphere sampling through — see the class-level note below); acceptable simplification given no aircraft/module needs projectile-altitude-varying air density for gameplay purposes yet. */
function defaultCombatEnvironment(): CombatEnvironment {
  return { airDensityKgM3: 1.225, windWorldMps: { x: 0, y: 0, z: 0 }, gravityMps2: 9.80665 };
}

const EMPTY_CONTACTS: readonly Contact[] = [];

export function createCombatAdapter(): CombatPort & CombatPortWithContacts {
  const weaponsStates = new Map<EntityId, WeaponsState>();
  const detectableScratch: DetectableEntity[] = [];
  // Reused view over detectableScratch[0..liveCount), rebuilt (references
  // only, no new DetectableEntity objects) every tick instead of
  // detectableScratch.slice(0, liveCount) — see 10-core-worker.md's
  // no-allocation-in-hot-path rule; this array's `.length` is truncated/
  // extended in place, never replaced with a fresh array.
  const allEntitiesScratch: DetectableEntity[] = [];
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
  const storesLoadScratch = { massKg: 0, dragAreaM2: 0 };
  /** Projectiles finished this tick, despawned only after the step loop (see that loop's comment). */
  const despawnScratch: EntityId[] = [];

  function ensureDetectableCapacity(n: number): void {
    while (detectableScratch.length < n) {
      detectableScratch.push({ id: NO_ENTITY_ID, team: 0, kind: EntityKind.Aircraft, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, alive: false });
    }
  }

  return {
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
        allEntitiesScratch[i] = d;
      }
      const allEntities = allEntitiesScratch;

      // Discover new aircraft; create their WeaponsState.
      for (let i = 0; i < liveCount; i++) {
        const e = ctx.liveAt(i);
        if (e.kind !== EntityKind.Aircraft) continue;
        if (weaponsStates.has(e.id)) continue;
        weaponsStates.set(e.id, createWeaponsState(TEJAS_LOADOUT, subSeed(ctx.missionSeed, 'combat:' + e.id)));
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

        writeCombatStatus(state, mustGetCombatStatus(ctx, observer.id));

        const lockedTarget = state.lockedTargetId !== undefined ? findDetectable(allEntities, state.lockedTargetId) : undefined;
        outRequestsScratch.length = 0;
        fireEventsScratch.length = 0;
        fireWeapons(observer.id, observer, damage, lockedTarget, inputs, state, ctx.simTimeSec, dtSec, outRequestsScratch, fireEventsScratch);
        // Carried weapons' mass/drag for the flight model, from the counts left after this tick's
        // firing (EntityState.storesMassKg/storesDragAreaM2's doc comment).
        computeStoresLoad(state, storesLoadScratch);
        observer.storesMassKg = storesLoadScratch.massKg;
        observer.storesDragAreaM2 = storesLoadScratch.dragAreaM2;

        for (const req of outRequestsScratch) {
          if (freeProjectileIndices.length === 0) continue;
          // headingRad here is only a placeholder for SpawnSpec's initial-rot
          // construction; the exact rotWorld/velWorld below immediately
          // overwrite it once the entity exists (SpawnSpec's headingRad+
          // speedMps pair cannot itself express an arbitrary 3D launch
          // vector — see this file's header note).
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
          }
          const poolIndex = freeProjectileIndices.pop() as number;
          const slot = projectilePool[poolIndex] as ProjectileState;
          initProjectile(slot, req, ctx.simTimeSec);
          projectileIndexByEntityId.set(spawnedId, poolIndex);
          if (req.kind !== 'bullet') patchNextMissileLaunchId(fireEventsScratch, spawnedId);
        }
        // Forwarded only now, after the spawns above: weaponStation.ts emits each missileLaunch
        // with missileId=NO_ENTITY_ID and leaves it to core to patch in the spawned id (07-combat.md
        // section 3.1). Forwarding before the spawn left it at -1, so the renderer's smoke trail
        // (effects.ts, keyed on missileId) never found the missile.
        for (const ev of fireEventsScratch) eventsOut.push(ev);
      }

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
        const result = stepProjectile(state, projectile, allEntities, ctx.sampler, combatEnv, dtSec, state);
        if (result.outcome === ProjectileOutcome.Flying) continue;

        if (result.outcome === ProjectileOutcome.DirectHit || result.outcome === ProjectileOutcome.ProximityDetonation) {
          const targetId = result.hitTargetId;
          if (targetId !== undefined) {
            const targetState = findLiveState(ctx, targetId);
            const targetDamage = targetState ? ctx.getDamage(targetId) : undefined;
            if (targetState && targetDamage) {
              const wstate = weaponsStates.get(projectile.ownerId);
              const rng = wstate ? wstate.rng : { seedState: subSeed(ctx.missionSeed, 'combat:hit:' + state.id) };
              hitEventsScratch.length = 0;
              resolveProjectileHit(result, projectile.ownerId, projectile.kind, targetState, targetDamage, rng, hitEventsScratch);
              for (const ev of hitEventsScratch) eventsOut.push(ev);
            }
          }
        }

        resetProjectile(projectile);
        freeProjectileIndices.push(poolIndex);
        projectileIndexByEntityId.delete(state.id);
        despawnScratch.push(state.id);
      }
      for (let k = 0; k < despawnScratch.length; k++) ctx.despawn(despawnScratch[k]!);
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
