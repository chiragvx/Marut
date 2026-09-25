/**
 * src/core/entityPool.ts — pre-sized, allocation-free entity store.
 * Implements `EntityPool`/`CreateEntityPool` (contracts/sim.ts section 2)
 * and `packEntityId`/`unpackEntityId` (contracts/core.ts's `PackEntityId`/
 * `UnpackEntityId`). See 10-core-worker.md section 4.3 for the exact
 * algorithm this file follows.
 */

import {
  EntityKind,
  ENTITY_INDEX_RADIX,
  NO_ENTITY_ID,
} from '../contracts/core';
import type {
  DamageState,
  EntityId,
  EntityState,
  PackEntityId,
  Team,
  UnpackEntityId,
} from '../contracts/core';
import type { CreateEntityPool, EntityPool, EntityPoolCapacity } from '../contracts/sim';

/**
 * Extends the pinned `EntityPool` contract with a kind-scoped iterator for
 * `World`'s own internal use (steps 2-5 of `World.stepOnce`, 10-core-worker.md
 * section 4.1, only ever walk AIRCRAFT entities). Not part of
 * `contracts/sim.ts` — an internal, module-10-private extension, exactly the
 * kind of adapter-private addition 10-core-worker.md section 9 item 6
 * sanctions elsewhere (e.g. `combatAdapter.ts`'s own `getContacts`).
 */
export interface WorldEntityPool extends EntityPool {
  aircraftLiveCount(): number;
  aircraftLiveAt(index: number): EntityState;
}

/**
 * Pack (index, generation) with plain multiplication — NEVER `<<`/`>>>` (see
 * core.ts's own warning: bitwise ops coerce to signed 32-bit and would
 * corrupt the id once generation >= 0x8000).
 */
export const packEntityId: PackEntityId = (index: number, generation: number): EntityId => generation * ENTITY_INDEX_RADIX + index;

export const unpackEntityId: UnpackEntityId = (id: EntityId) => ({
  index: id % ENTITY_INDEX_RADIX,
  generation: Math.floor(id / ENTITY_INDEX_RADIX),
});

function freshEntityState(): EntityState {
  return {
    id: NO_ENTITY_ID,
    kind: EntityKind.Aircraft,
    team: 0,
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    omega: { x: 0, y: 0, z: 0 },
    alive: false,
    hp: 0,
    fuelKg: 0,
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    gearPos: 0,
    throttle: 0,
    afterburnerOn: false,
    storesMassKg: 0,
    airbrakePos: 0,
    storesDragAreaM2: 0,
    dropTankCount: 0,
    dropTankFuelKg: 0,
    flags: 0,
  };
}

function freshDamageState(): DamageState {
  return {
    structurePct: 1,
    engineHealthPct: 1,
    controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
    hydraulicsOk: true,
    fuelLeak: false,
    radarHealthPct: 1,
    gearHealthPct: 1,
  };
}

/**
 * One EntityKind's own slot storage: pre-sized array of EntityState,
 * generation counters, a free-list stack, and a dense live list with O(1)
 * swap-remove.
 *
 * `baseIndex` gives this store's slice of one GLOBAL, pool-wide index space
 * (see EntityPoolImpl's constructor): `EntityId` (core.ts) packs only
 * (index, generation) with no kind tag, so two different kinds' stores MUST
 * NOT reuse the same raw index range, or a low aircraft index and a low
 * missile index (both starting from a locally-zeroed counter) would collide
 * on the exact same packed id. Each store therefore operates on LOCAL
 * indices 0..capacity-1 internally but always packs/unpacks
 * `baseIndex + localIndex` as the id's index component.
 */
class KindStore {
  readonly kind: EntityKind;
  readonly capacity: number;
  private readonly baseIndex: number;
  private readonly slots: EntityState[];
  private readonly generation: Uint32Array;
  private readonly damage: (DamageState | undefined)[];
  /** Free LOCAL slot indices, stack order (pop from the end). */
  private readonly freeList: number[];
  /** Dense list of currently-live EntityIds (global). */
  private readonly liveDense: EntityId[];
  private liveDenseCountValue = 0;
  /** local slot index -> position in liveDense, or -1 if not live. */
  private readonly denseIndexOfSlot: Int32Array;

  constructor(kind: EntityKind, baseIndex: number, capacity: number, withDamage: boolean) {
    this.kind = kind;
    this.baseIndex = baseIndex;
    this.capacity = capacity;
    this.slots = new Array<EntityState>(capacity);
    this.generation = new Uint32Array(capacity);
    this.damage = new Array<DamageState | undefined>(capacity);
    this.freeList = new Array<number>(capacity);
    this.liveDense = new Array<EntityId>(capacity);
    this.denseIndexOfSlot = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.slots[i] = freshEntityState();
      this.damage[i] = withDamage ? freshDamageState() : undefined;
      // Push in descending order so local index 0 is allocated first (stack pop from the end).
      this.freeList[i] = capacity - 1 - i;
      this.denseIndexOfSlot[i] = -1;
    }
  }

  get liveCount(): number {
    return this.liveDenseCountValue;
  }

  /** True iff GLOBAL `globalIndex` falls inside this store's slice of the shared index space. */
  ownsGlobalIndex(globalIndex: number): boolean {
    return globalIndex >= this.baseIndex && globalIndex < this.baseIndex + this.capacity;
  }

  allocate(team: Team): EntityId {
    if (this.freeList.length === 0) return NO_ENTITY_ID;
    const index = this.freeList.pop() as number;
    const gen = this.generation[index] as number;
    const id = packEntityId(this.baseIndex + index, gen);
    const state = this.slots[index] as EntityState;
    state.id = id;
    state.kind = this.kind;
    state.team = team;
    state.pos.x = 0;
    state.pos.y = 0;
    state.pos.z = 0;
    state.rot.x = 0;
    state.rot.y = 0;
    state.rot.z = 0;
    state.rot.w = 1;
    state.vel.x = 0;
    state.vel.y = 0;
    state.vel.z = 0;
    state.omega.x = 0;
    state.omega.y = 0;
    state.omega.z = 0;
    state.alive = true;
    state.hp = 100;
    state.fuelKg = 0;
    state.elevonL = 0;
    state.elevonR = 0;
    state.rudder = 0;
    state.gearPos = 0;
    state.throttle = 0;
    state.afterburnerOn = false;
    state.storesMassKg = 0;
    state.airbrakePos = 0;
    state.storesDragAreaM2 = 0;
    state.dropTankCount = 0;
    state.dropTankFuelKg = 0;
    state.flags = 0;
    const dmg = this.damage[index];
    if (dmg) {
      dmg.structurePct = 1;
      dmg.engineHealthPct = 1;
      dmg.controlSurfaces.elevonL = 1;
      dmg.controlSurfaces.elevonR = 1;
      dmg.controlSurfaces.rudder = 1;
      dmg.hydraulicsOk = true;
      dmg.fuelLeak = false;
      dmg.radarHealthPct = 1;
      dmg.gearHealthPct = 1;
    }
    const denseIdx = this.liveDenseCountValue;
    this.liveDense[denseIdx] = id;
    this.denseIndexOfSlot[index] = denseIdx;
    this.liveDenseCountValue += 1;
    return id;
  }

  release(id: EntityId): void {
    const { index: globalIndex, generation } = unpackEntityId(id);
    if (!this.ownsGlobalIndex(globalIndex)) return;
    const index = globalIndex - this.baseIndex;
    if ((this.generation[index] as number) !== generation) return;
    // Idempotency guard: a slot no longer present in the dense live list has
    // already been released (deliberately NOT keyed on EntityState.alive,
    // which World may set false on a crash well before an explicit release —
    // see the isAlive() doc comment above).
    if ((this.denseIndexOfSlot[index] as number) === -1) return;
    const state = this.slots[index] as EntityState;
    state.alive = false;
    // Bump generation so a stale id can never be mistaken for the new occupant.
    this.generation[index] = (generation + 1) >>> 0;
    // Swap-remove from the dense live list.
    const denseIdx = this.denseIndexOfSlot[index] as number;
    const lastDenseIdx = this.liveDenseCountValue - 1;
    const lastId = this.liveDense[lastDenseIdx] as EntityId;
    this.liveDense[denseIdx] = lastId;
    const lastLocalIndex = unpackEntityId(lastId).index - this.baseIndex;
    this.denseIndexOfSlot[lastLocalIndex] = denseIdx;
    this.denseIndexOfSlot[index] = -1;
    this.liveDenseCountValue -= 1;
    // Return slot to the free list.
    this.freeList.push(index);
  }

  /**
   * True iff `id`'s slot is currently allocated by this pool (index in range
   * AND generation matches). Deliberately does NOT additionally re-check
   * `EntityState.alive` here: `World.stepOnce` (10-core-worker.md section
   * 4.1 step 5) sets a crashed aircraft's `EntityState.alive = false` while
   * deliberately leaving it allocated ("NOT immediately released from the
   * pool") so the crash event/wreckage state can be observed for a few more
   * ticks before an explicit `despawnEntity` call. If `isAlive` also gated on
   * `EntityState.alive`, that same-tick write would make the pool disagree
   * with itself (liveCount/liveAt would still enumerate the slot while
   * isAlive/get reported it gone). The only thing that changes pool-level
   * occupancy is `allocate`/`release`; `EntityState.alive` is ordinary
   * mutable entity data, exactly like `hp`.
   */
  isAlive(id: EntityId): boolean {
    const { index: globalIndex, generation } = unpackEntityId(id);
    if (!this.ownsGlobalIndex(globalIndex)) return false;
    return (this.generation[globalIndex - this.baseIndex] as number) === generation;
  }

  get(id: EntityId): EntityState | undefined {
    return this.isAlive(id) ? (this.slots[unpackEntityId(id).index - this.baseIndex] as EntityState) : undefined;
  }

  getDamage(id: EntityId): DamageState | undefined {
    if (!this.isAlive(id)) return undefined;
    return this.damage[unpackEntityId(id).index - this.baseIndex];
  }

  liveAt(denseIndex: number): EntityState {
    const id = this.liveDense[denseIndex] as EntityId;
    return this.slots[unpackEntityId(id).index - this.baseIndex] as EntityState;
  }
}

const KIND_ORDER: readonly EntityKind[] = [EntityKind.Aircraft, EntityKind.Missile, EntityKind.Bullet, EntityKind.Effect];

class EntityPoolImpl implements WorldEntityPool {
  readonly capacity: Readonly<EntityPoolCapacity>;
  private readonly stores: Record<EntityKind, KindStore>;

  constructor(capacity: EntityPoolCapacity) {
    this.capacity = capacity;
    // Each kind gets a non-overlapping slice of ONE global index space (see
    // KindStore's own header comment) — EntityId has no kind tag, so two
    // kinds' stores must never both hand out the same packed id.
    const aircraftBase = 0;
    const missileBase = aircraftBase + capacity.aircraft;
    const bulletBase = missileBase + capacity.missile;
    const effectBase = bulletBase + capacity.bullet;
    this.stores = {
      aircraft: new KindStore(EntityKind.Aircraft, aircraftBase, capacity.aircraft, true),
      missile: new KindStore(EntityKind.Missile, missileBase, capacity.missile, false),
      bullet: new KindStore(EntityKind.Bullet, bulletBase, capacity.bullet, false),
      effect: new KindStore(EntityKind.Effect, effectBase, capacity.effect, false),
    };
  }

  get liveCount(): number {
    let total = 0;
    for (const kind of KIND_ORDER) total += (this.stores[kind] as KindStore).liveCount;
    return total;
  }

  allocate(kind: EntityKind, team: Team): EntityId {
    return (this.stores[kind] as KindStore).allocate(team);
  }

  release(id: EntityId): void {
    if (id === NO_ENTITY_ID) return;
    for (const kind of KIND_ORDER) {
      const store = this.stores[kind] as KindStore;
      if (store.isAlive(id)) {
        store.release(id);
        return;
      }
    }
  }

  isAlive(id: EntityId): boolean {
    if (id === NO_ENTITY_ID) return false;
    for (const kind of KIND_ORDER) {
      if ((this.stores[kind] as KindStore).isAlive(id)) return true;
    }
    return false;
  }

  get(id: EntityId): EntityState | undefined {
    if (id === NO_ENTITY_ID) return undefined;
    for (const kind of KIND_ORDER) {
      const state = (this.stores[kind] as KindStore).get(id);
      if (state) return state;
    }
    return undefined;
  }

  getDamage(id: EntityId): DamageState | undefined {
    return (this.stores.aircraft as KindStore).getDamage(id);
  }

  liveAt(denseIndex: number): EntityState {
    let remaining = denseIndex;
    for (const kind of KIND_ORDER) {
      const store = this.stores[kind] as KindStore;
      if (remaining < store.liveCount) return store.liveAt(remaining);
      remaining -= store.liveCount;
    }
    throw new Error(`EntityPool.liveAt: denseIndex ${denseIndex} out of range (liveCount=${this.liveCount})`);
  }

  aircraftLiveCount(): number {
    return (this.stores.aircraft as KindStore).liveCount;
  }

  aircraftLiveAt(index: number): EntityState {
    return (this.stores.aircraft as KindStore).liveAt(index);
  }
}

/** Richer construction entry point used by `World` internally (see `WorldEntityPool`). */
export function createEntityPoolInternal(capacity: EntityPoolCapacity): WorldEntityPool {
  return new EntityPoolImpl(capacity);
}

export const createEntityPool: CreateEntityPool = (capacity: EntityPoolCapacity) => createEntityPoolInternal(capacity);
