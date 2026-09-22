/**
 * src/core/world.ts — implements `World`/`CreateWorld` (contracts/sim.ts
 * section 8). Owns all entity state, the per-tick step order, warning-bit
 * evaluation, wind/atmosphere construction, touchdown/crash detection,
 * mission loading and player/AI bookkeeping. See 10-core-worker.md section
 * 4.1-4.9 for the full algorithm this file follows.
 */

import { Quat } from '../math';
import {
  EntityFlag,
  EntityKind,
  GRAVITY_MPS2,
  MissionObjectiveKind,
  MissionOutcome,
  NO_ENTITY_ID,
  WarningBit,
  WeaponKindCode,
  LockStateCode,
} from '../contracts/core';
import type {
  AiDifficulty,
  AircraftTelemetry,
  CombatStatus,
  DamageState,
  EntityId,
  EntityState,
  Mission,
  MissionObjective,
  Pilot,
  PilotContext,
  PilotInputs,
  RunwayInfo,
  SimEvent,
  Vec3Like,
} from '../contracts/core';
import {
  DEFAULT_ENTITY_POOL_CAPACITY,
  EVENT_QUEUE_CAPACITY,
  WARNING_GEAR_UNSAFE_AGL_M,
  WARNING_GEAR_UNSAFE_SINK_MPS,
  WARNING_LOW_FUEL_FRAC,
  WARNING_OVER_G_NEG,
  WARNING_OVER_G_POS,
  WARNING_TERRAIN_PULLUP_AGL_M,
  WARNING_TERRAIN_PULLUP_SINK_MPS,
} from '../contracts/sim';
import type {
  AiFormationSlotLike,
  AiPilotSpawnParamsLike,
  CreateWorld,
  EntityPoolCapacity,
  SimEnvironment,
  SnapshotHudView,
  SpawnSpec,
  World,
  WorldDependencies,
} from '../contracts/sim';
import { createEntityPoolInternal } from './entityPool';
import type { WorldEntityPool } from './entityPool';
import type { WorldCombatTickContext } from './combatContext';
import { isaAtmosphereInto } from './atmosphere';
import type { IsaAtmosphereResult } from './atmosphere';
import { createWindState, stepWind } from './wind';
import type { WindState } from './wind';
import { createEventQueue } from './eventQueue';
import { subSeed } from './seed';
import { writeSnapshot as writeSnapshotBuffer } from './snapshotWriter';
import { computeIlsDeviation, forwardWorldInto, rightWorldInto } from './hudTelemetry';

const SIM_DT_SEC_LOCAL = 1 / 120; // avoid importing SIM_DT_SEC just to re-derive it; core.ts already fixes this at 1/120 (SIM_HZ)

function defaultPilotInputs(): PilotInputs {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0,
    afterburner: false,
    brakes: 0,
    gearDown: true,
    airbrake: false,
    trigger: false,
    launch: false,
    cycleWeapon: false,
    cycleTarget: false,
    nwsEnabled: false,
  };
}

function zeroTelemetry(): AircraftTelemetry {
  return {
    iasMps: 0,
    tasMps: 0,
    mach: 0,
    altMslM: 0,
    altAglM: 0,
    alphaRad: 0,
    betaRad: 0,
    gLoad: 0,
    headingRad: 0,
    pitchRad: 0,
    rollRad: 0,
    vspeedMps: 0,
    fuelKg: 0,
    fuelFrac: 0,
    thrustFrac: 0,
    onGround: false,
    stalled: false,
  };
}

function defaultCombatStatus(): CombatStatus {
  return {
    selectedWeapon: 'gun',
    ammoGun: 0,
    missilesIr: 0,
    missilesRadar: 0,
    lockState: 'none',
    lockedTargetId: undefined,
    rwrWarning: false,
    missileInboundWarning: false,
    aimPointWorld: { x: 0, y: 0, z: 0 },
    aimPointValid: false,
  };
}

function zeroEnvironment(): SimEnvironment {
  return {
    airDensityKgM3: 1.225,
    soundSpeedMps: 340.29,
    windWorldMps: { x: 0, y: 0, z: 0 },
    gravityMps2: GRAVITY_MPS2,
    groundElevationM: 0,
    groundNormalWorld: { x: 0, y: 1, z: 0 },
  };
}

/** Per-aircraft bookkeeping World keeps alongside the pool's own EntityState/DamageState. */
interface AircraftRecord {
  aircraftDefId: string;
  inputs: PilotInputs;
  telemetry: AircraftTelemetry;
  combat: CombatStatus;
  env: SimEnvironment;
  atmosphereScratch: IsaAtmosphereResult;
  activeWarningBits: number;
  wasOnGround: boolean;
  wasStructureAlive: boolean;
  pilotCtx: PilotContext | undefined; // only AI aircraft get a reused PilotContext
}

const EMPTY_CONTACTS: readonly [] = [];

class WorldImpl implements World {
  private readonly deps: WorldDependencies;
  private readonly poolCapacity: EntityPoolCapacity;
  private pool: WorldEntityPool;
  private readonly aircraft = new Map<EntityId, AircraftRecord>();
  private readonly pilots = new Map<EntityId, Pilot>();
  private readonly eventQueue = createEventQueue(EVENT_QUEUE_CAPACITY);

  private tickInternal = 0;
  private simTimeSecInternal = 0;
  private pausedInternal = false;
  private missionSeedInternal = 0;
  private mission: Mission | undefined;
  private playerEntityIdInternal: EntityId = NO_ENTITY_ID;
  private missionEndedThisLoad = false;
  private hostileAircraftIds = new Set<EntityId>();
  private windState: WindState = createWindState(0);
  private windWorldMpsScratch: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly combatCtx: WorldCombatTickContext;
  private readonly hudScratch: SnapshotHudView = {
    iasMps: 0, tasMps: 0, mach: 0, altMslM: 0, altAglM: 0, aoaRad: 0, betaRad: 0, gLoad: 0,
    headingRad: 0, pitchRad: 0, rollRad: 0, vspeedMps: 0, fuelKg: 0, thrustFrac: 0, gearPos: 0,
    weaponIdx: 0, targetId: NO_ENTITY_ID, targetRangeM: 0, closureMps: 0, lockState: 0,
    warningBits: 0, ilsLoc: 0, ilsGs: 0, pipperX: 0, pipperY: 0, pipperZ: 0, pipperValid: 0,
  };
  private readonly ilsScratch = { loc: 0, gs: 0 };
  private readonly fwdScratch: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly rightScratch: Vec3Like = { x: 0, y: 0, z: 0 };

  constructor(deps: WorldDependencies) {
    this.deps = deps;
    this.poolCapacity = deps.entityPoolCapacity ?? DEFAULT_ENTITY_POOL_CAPACITY;
    this.pool = createEntityPoolInternal(this.poolCapacity);
    const self = this;
    this.combatCtx = {
      get liveCount() {
        return self.pool.liveCount;
      },
      liveAt(denseIndex: number): EntityState {
        return self.pool.liveAt(denseIndex);
      },
      getDamage(id: EntityId): DamageState | undefined {
        return self.pool.getDamage(id);
      },
      getCombatStatus(id: EntityId): CombatStatus | undefined {
        return self.aircraft.get(id)?.combat;
      },
      spawn(spec: SpawnSpec): EntityId {
        return self.spawnEntity(spec);
      },
      despawn(id: EntityId): void {
        self.despawnEntity(id);
      },
      get sampler() {
        return self.deps.sampler;
      },
      get simTimeSec() {
        return self.simTimeSecInternal;
      },
      get missionSeed() {
        return self.missionSeedInternal;
      },
      getInputs(id: EntityId): PilotInputs | undefined {
        return self.aircraft.get(id)?.inputs;
      },
      getAltAglM(id: EntityId): number {
        return self.aircraft.get(id)?.telemetry.altAglM ?? 0;
      },
    };
  }

  // ---- readonly getters ----
  get tick(): number {
    return this.tickInternal;
  }
  get simTimeSec(): number {
    return this.simTimeSecInternal;
  }
  get paused(): boolean {
    return this.pausedInternal;
  }
  get missionSeed(): number {
    return this.missionSeedInternal;
  }

  // ---- mission loading ----

  loadMission(mission: Mission): void {
    this.internalReset();
    this.mission = mission;
    this.missionSeedInternal = mission.world.seed;
    this.windState = createWindState(subSeed(this.missionSeedInternal, 'wind'));

    // Player.
    const ps = mission.playerStart;
    let playerPos: Vec3Like;
    let playerHeadingRad: number;
    let playerSpeedMps: number;
    if (ps.airportId !== undefined && ps.runwayId !== undefined) {
      const runway = this.deps.navDb.getRunway(ps.airportId, ps.runwayId);
      if (runway) {
        const fwd = forwardWorldInto(runway.headingRad, this.fwdScratch);
        playerPos = { x: runway.thresholdPos.x + fwd.x * 200, y: runway.elevationM + 0.5, z: runway.thresholdPos.z + fwd.z * 200 };
        playerHeadingRad = runway.headingRad;
        playerSpeedMps = ps.speedMps ?? 0;
      } else {
        playerPos = ps.pos ?? { x: 0, y: 1000, z: 0 };
        playerHeadingRad = ps.headingRad ?? 0;
        playerSpeedMps = ps.speedMps ?? 0;
      }
    } else {
      playerPos = ps.pos ?? { x: 0, y: 1000, z: 0 };
      playerHeadingRad = ps.headingRad ?? 0;
      playerSpeedMps = ps.speedMps ?? 0;
    }
    const playerId = this.spawnEntity({
      kind: EntityKind.Aircraft,
      team: 0,
      pos: playerPos,
      headingRad: playerHeadingRad,
      speedMps: playerSpeedMps,
      aircraftDefId: 'tejas-mk1',
    });
    if (playerId !== NO_ENTITY_ID) {
      const state = this.pool.get(playerId);
      if (state) state.flags |= EntityFlag.IsPlayer;
      this.playerEntityIdInternal = playerId;
    }

    // AI flights.
    for (const flight of mission.aiFlights) {
      let flightLeaderId: EntityId = NO_ENTITY_ID;
      for (let j = 0; j < flight.count; j++) {
        let pos: Vec3Like;
        let headingRad: number;
        let speedMps: number;
        if (flight.startAirportId !== undefined && flight.startRunwayId !== undefined) {
          const runway = this.deps.navDb.getRunway(flight.startAirportId, flight.startRunwayId);
          if (runway) {
            headingRad = runway.headingRad;
            speedMps = flight.startSpeedMps ?? 0;
            pos = { x: runway.thresholdPos.x, y: runway.elevationM + 0.5, z: runway.thresholdPos.z };
          } else {
            headingRad = flight.startHeadingRad ?? 0;
            speedMps = flight.startSpeedMps ?? 0;
            pos = flight.startPos ?? { x: 0, y: 1000, z: 0 };
          }
        } else {
          headingRad = flight.startHeadingRad ?? 0;
          speedMps = flight.startSpeedMps ?? 0;
          pos = flight.startPos ?? { x: 0, y: 1000, z: 0 };
        }
        if (j > 0) {
          const right = rightWorldInto(headingRad, this.rightScratch);
          pos = { x: pos.x + right.x * 40 * j, y: pos.y, z: pos.z + right.z * 40 * j };
        }
        const entityId = this.spawnAircraftOnly(flight.team, pos, headingRad, speedMps, flight.aircraftId);
        if (entityId === NO_ENTITY_ID) continue;
        if (j === 0) flightLeaderId = entityId;
        if (flight.team !== 0) this.hostileAircraftIds.add(entityId);

        const formation: AiFormationSlotLike | undefined =
          flight.count > 1
            ? { role: j === 0 ? 'leader' : 'wingman', leaderId: j === 0 ? NO_ENTITY_ID : flightLeaderId, slotRightM: 150, slotBackM: 100 * j, slotUpM: -20 }
            : undefined;
        const params: AiPilotSpawnParamsLike = {
          aircraftDefId: flight.aircraftId,
          team: flight.team,
          difficulty: flight.difficulty,
          seed: subSeed(this.missionSeedInternal, 'ai:' + flight.id + ':' + j),
          homeAirportId: flight.homeAirportId,
          homeRunwayId: flight.homeRunwayId,
          patrolCenterWorld: flight.patrolCenterWorld,
          patrolRadiusM: flight.patrolRadiusM,
          formation,
        };
        const pilot = this.deps.createAiPilot(params);
        this.pilots.set(entityId, pilot);
        const rec = this.aircraft.get(entityId);
        if (rec) {
          rec.pilotCtx = this.buildPilotContext(entityId, rec);
        }
      }
    }

    this.missionEndedThisLoad = false;
  }

  reset(): void {
    if (this.mission) this.loadMission(this.mission);
    else this.internalReset();
  }

  private internalReset(): void {
    this.pool = createEntityPoolInternal(this.poolCapacity);
    this.aircraft.clear();
    this.pilots.clear();
    this.eventQueue.clear();
    this.tickInternal = 0;
    this.simTimeSecInternal = 0;
    this.playerEntityIdInternal = NO_ENTITY_ID;
    this.hostileAircraftIds.clear();
    this.missionEndedThisLoad = false;
  }

  // ---- spawning ----

  /** Allocates an aircraft entity + its World-owned bookkeeping records, WITHOUT attaching a Pilot. Shared by spawnEntity (manual path) and loadMission's AI-flight loop (formation-aware path). */
  private spawnAircraftOnly(team: 0 | 1, pos: Vec3Like, headingRad: number, speedMps: number, aircraftDefId: string): EntityId {
    if (!this.deps.flightModel.hasDefinition(aircraftDefId)) return NO_ENTITY_ID;
    const id = this.pool.allocate(EntityKind.Aircraft, team);
    if (id === NO_ENTITY_ID) return NO_ENTITY_ID;
    const state = this.pool.get(id);
    if (!state) return NO_ENTITY_ID;
    state.pos.x = pos.x;
    state.pos.y = pos.y;
    state.pos.z = pos.z;
    Quat.fromYawPitchRoll(headingRad, 0, 0, state.rot);
    const fwd = forwardWorldInto(headingRad, this.fwdScratch);
    state.vel.x = fwd.x * speedMps;
    state.vel.y = fwd.y * speedMps;
    state.vel.z = fwd.z * speedMps;
    state.fuelKg = this.deps.flightModel.maxFuelKg(aircraftDefId);
    // gearPos/EntityFlag.GearDownCommanded are left at the pool's zeroed
    // defaults here — PilotInputs.gearDown defaults to true (see
    // defaultPilotInputs()) and it is the flight model's own job
    // (FlightModelPort.step) to drive gearPos/OnGround/GearDownCommanded
    // from that input over subsequent ticks, not World's.

    const rec: AircraftRecord = {
      aircraftDefId,
      inputs: defaultPilotInputs(),
      telemetry: zeroTelemetry(),
      combat: defaultCombatStatus(),
      env: zeroEnvironment(),
      atmosphereScratch: { airDensityKgM3: 1.225, soundSpeedMps: 340.29 },
      activeWarningBits: 0,
      wasOnGround: false,
      wasStructureAlive: true,
      pilotCtx: undefined,
    };
    this.aircraft.set(id, rec);
    return id;
  }

  private buildPilotContext(id: EntityId, rec: AircraftRecord): PilotContext {
    const state = this.pool.get(id) as EntityState;
    const damage = this.pool.getDamage(id) as DamageState;
    const self = this;
    return {
      self: state,
      selfDamage: damage,
      telemetry: rec.telemetry,
      get contacts() {
        return EMPTY_CONTACTS;
      },
      combat: rec.combat,
      sampler: self.deps.sampler,
      navDb: self.deps.navDb,
      windWorldMps: self.windWorldMpsScratch,
      get simTimeSec() {
        return self.simTimeSecInternal;
      },
    };
  }

  spawnEntity(spec: SpawnSpec): EntityId {
    if (spec.kind === EntityKind.Aircraft) {
      if (!spec.aircraftDefId) return NO_ENTITY_ID;
      const speedMps = spec.speedMps ?? 0;
      const id = this.spawnAircraftOnly(spec.team, spec.pos, spec.headingRad, speedMps, spec.aircraftDefId);
      if (id === NO_ENTITY_ID) return NO_ENTITY_ID;
      const rec = this.aircraft.get(id);
      if (spec.difficulty && rec) {
        const params: AiPilotSpawnParamsLike = {
          aircraftDefId: spec.aircraftDefId,
          team: spec.team,
          difficulty: spec.difficulty,
          seed: subSeed(this.missionSeedInternal, 'ai:manual:' + id),
        };
        const pilot = this.deps.createAiPilot(params);
        this.pilots.set(id, pilot);
        rec.pilotCtx = this.buildPilotContext(id, rec);
      }
      return id;
    }

    const id = this.pool.allocate(spec.kind, spec.team);
    if (id === NO_ENTITY_ID) return NO_ENTITY_ID;
    const state = this.pool.get(id);
    if (!state) return NO_ENTITY_ID;
    state.pos.x = spec.pos.x;
    state.pos.y = spec.pos.y;
    state.pos.z = spec.pos.z;
    Quat.fromYawPitchRoll(spec.headingRad, 0, 0, state.rot);
    const speedMps = spec.speedMps ?? 0;
    const fwd = forwardWorldInto(spec.headingRad, this.fwdScratch);
    state.vel.x = fwd.x * speedMps;
    state.vel.y = fwd.y * speedMps;
    state.vel.z = fwd.z * speedMps;
    return id;
  }

  despawnEntity(id: EntityId): void {
    this.pool.release(id);
    this.pilots.delete(id);
    this.aircraft.delete(id);
  }

  // ---- input / difficulty / pause ----

  setPlayerInput(entityId: EntityId, inputs: PilotInputs): void {
    const rec = this.aircraft.get(entityId);
    if (!rec) return;
    const target = rec.inputs;
    target.pitch = inputs.pitch;
    target.roll = inputs.roll;
    target.yaw = inputs.yaw;
    target.throttle = inputs.throttle;
    target.afterburner = inputs.afterburner;
    target.brakes = inputs.brakes;
    target.gearDown = inputs.gearDown;
    target.airbrake = inputs.airbrake;
    target.trigger = inputs.trigger;
    target.launch = inputs.launch;
    target.cycleWeapon = inputs.cycleWeapon;
    target.cycleTarget = inputs.cycleTarget;
    target.nwsEnabled = inputs.nwsEnabled ?? false;
  }

  setDifficulty(entityId: EntityId, difficulty: AiDifficulty): void {
    const rec = this.aircraft.get(entityId);
    if (!rec || !this.pilots.has(entityId)) return;
    const params: AiPilotSpawnParamsLike = {
      aircraftDefId: rec.aircraftDefId,
      team: (this.pool.get(entityId)?.team ?? 0) as 0 | 1,
      difficulty,
      seed: subSeed(this.missionSeedInternal, 'ai:redifficulty:' + entityId),
    };
    const pilot = this.deps.createAiPilot(params);
    this.pilots.set(entityId, pilot);
  }

  setPaused(paused: boolean): void {
    this.pausedInternal = paused;
  }

  // ---- getters ----

  getPlayerEntityId(): EntityId {
    return this.playerEntityIdInternal;
  }
  getEntityState(id: EntityId): EntityState | undefined {
    return this.pool.get(id);
  }
  getDamageState(id: EntityId): DamageState | undefined {
    return this.pool.getDamage(id);
  }
  getTelemetry(id: EntityId): AircraftTelemetry | undefined {
    return this.aircraft.get(id)?.telemetry;
  }
  getCombatStatus(id: EntityId): CombatStatus | undefined {
    return this.aircraft.get(id)?.combat;
  }

  // ---- the per-tick step ----

  stepOnce(): void {
    if (this.pausedInternal) return;

    // Step 3 precursor: wind is computed once per tick (shared by every aircraft's env).
    stepWind(this.windState, this.currentWeather(), this.windWorldMpsScratch);

    // Steps 2-3: pilots (AI) then flight model, per live aircraft.
    const aircraftCount = this.pool.aircraftLiveCount();
    for (let i = 0; i < aircraftCount; i++) {
      const state = this.pool.aircraftLiveAt(i);
      const rec = this.aircraft.get(state.id);
      if (!rec) continue;
      if (!state.alive) continue;

      // Step 2: AI pilot decides this tick's inputs from LAST tick's telemetry.
      const pilot = this.pilots.get(state.id);
      if (pilot && rec.pilotCtx) {
        pilot.update(rec.pilotCtx, SIM_DT_SEC_LOCAL, rec.inputs);
      }

      // Step 3: flight model.
      const damage = this.pool.getDamage(state.id);
      if (!damage) continue;
      isaAtmosphereInto(state.pos.y, rec.atmosphereScratch);
      rec.env.airDensityKgM3 = rec.atmosphereScratch.airDensityKgM3;
      rec.env.soundSpeedMps = rec.atmosphereScratch.soundSpeedMps;
      rec.env.windWorldMps.x = this.windWorldMpsScratch.x;
      rec.env.windWorldMps.y = this.windWorldMpsScratch.y;
      rec.env.windWorldMps.z = this.windWorldMpsScratch.z;
      rec.env.gravityMps2 = GRAVITY_MPS2;
      rec.env.groundElevationM = this.deps.sampler.heightAt(state.pos.x, state.pos.z);
      this.deps.sampler.normalAt(state.pos.x, state.pos.z, rec.env.groundNormalWorld);

      this.deps.flightModel.step(rec.aircraftDefId, state, damage, rec.inputs, rec.env, SIM_DT_SEC_LOCAL, state);
      this.deps.flightModel.computeTelemetry(rec.aircraftDefId, state, damage, rec.env, rec.telemetry);
    }

    // Step 4: warning-bit evaluation.
    for (let i = 0; i < aircraftCount; i++) {
      const state = this.pool.aircraftLiveAt(i);
      const rec = this.aircraft.get(state.id);
      if (!rec || !state.alive) continue;
      const t = rec.telemetry;
      let bits = 0;
      if (t.stalled) bits |= WarningBit.Stall;
      if (t.fuelFrac < WARNING_LOW_FUEL_FRAC) bits |= WarningBit.LowFuel;
      if (t.gLoad > WARNING_OVER_G_POS || t.gLoad < WARNING_OVER_G_NEG) bits |= WarningBit.OverG;
      if (t.altAglM < WARNING_TERRAIN_PULLUP_AGL_M && t.vspeedMps < -WARNING_TERRAIN_PULLUP_SINK_MPS) bits |= WarningBit.TerrainPullUp;
      if (
        t.altAglM < WARNING_GEAR_UNSAFE_AGL_M &&
        t.vspeedMps < -WARNING_GEAR_UNSAFE_SINK_MPS &&
        state.gearPos < 0.99 &&
        !(state.flags & EntityFlag.GearDownCommanded)
      ) {
        bits |= WarningBit.GearUnsafe;
      }
      const prevBits = rec.activeWarningBits;
      if (bits !== prevBits) {
        this.pushWarningEdge(state.id, prevBits, bits, WarningBit.Stall);
        this.pushWarningEdge(state.id, prevBits, bits, WarningBit.LowFuel);
        this.pushWarningEdge(state.id, prevBits, bits, WarningBit.OverG);
        this.pushWarningEdge(state.id, prevBits, bits, WarningBit.TerrainPullUp);
        this.pushWarningEdge(state.id, prevBits, bits, WarningBit.GearUnsafe);
      }
      rec.activeWarningBits = bits;
    }

    // Step 5: touchdown/crash detection.
    for (let i = 0; i < aircraftCount; i++) {
      const state = this.pool.aircraftLiveAt(i);
      const rec = this.aircraft.get(state.id);
      if (!rec || !state.alive) continue;
      const onGroundNow = (state.flags & EntityFlag.OnGround) !== 0;
      if (!rec.wasOnGround && onGroundNow) {
        this.eventQueue.push({
          type: 'touchdown',
          entityId: state.id,
          vspeedMps: Math.abs(rec.telemetry.vspeedMps),
          pos: { x: state.pos.x, y: state.pos.y, z: state.pos.z },
        });
      }
      rec.wasOnGround = onGroundNow;

      const damage = this.pool.getDamage(state.id);
      if (damage) {
        const isStructureAliveNow = damage.structurePct > 0;
        if (rec.wasStructureAlive && !isStructureAliveNow) {
          this.eventQueue.push({ type: 'crash', entityId: state.id, pos: { x: state.pos.x, y: state.pos.y, z: state.pos.z } });
          state.alive = false;
          state.hp = 0;
        }
        rec.wasStructureAlive = isStructureAliveNow;
      }
    }

    // Step 6: weapons/missiles/collisions/damage.
    this.deps.combat.step(SIM_DT_SEC_LOCAL, this.combatCtx, this.eventQueue);

    // Step 8: bookkeeping.
    this.tickInternal += 1;
    this.simTimeSecInternal = this.tickInternal * SIM_DT_SEC_LOCAL;

    // Step 9: mission objective evaluation.
    if (!this.missionEndedThisLoad && this.mission) {
      const result = this.evaluateObjectives(this.mission);
      if (result) {
        this.eventQueue.push({
          type: 'missionEnded',
          outcome: result.outcome,
          objectivesCompleted: result.objectivesCompleted,
          objectivesTotal: this.mission.objectives.length,
        });
        this.missionEndedThisLoad = true;
      }
    }
  }

  private pushWarningEdge(entityId: EntityId, prevBits: number, bits: number, bit: number): void {
    const wasActive = (prevBits & bit) !== 0;
    const isActive = (bits & bit) !== 0;
    if (wasActive !== isActive) {
      this.eventQueue.push({ type: 'warning', entityId, bit, active: isActive });
    }
  }

  private currentWeather() {
    return (
      this.mission?.weather ?? {
        windWorldMps: { x: 0, y: 0, z: 0 },
        gustMps: 0,
        turbulence: 0,
      }
    );
  }

  // ---- mission objective evaluation (10-core-worker.md section 4.1b) ----

  private evaluateObjectives(mission: Mission): { outcome: MissionOutcome; objectivesCompleted: string[] } | undefined {
    const playerState = this.getEntityState(this.playerEntityIdInternal);
    if (!playerState || !playerState.alive) {
      return { outcome: MissionOutcome.Failure, objectivesCompleted: [] };
    }

    const completed: string[] = [];
    for (const obj of mission.objectives) {
      if (this.isObjectiveComplete(obj, playerState)) completed.push(obj.id);
    }
    if (completed.length === mission.objectives.length && mission.objectives.length > 0) {
      return { outcome: MissionOutcome.Success, objectivesCompleted: completed };
    }
    return undefined;
  }

  private isObjectiveComplete(obj: MissionObjective, playerState: EntityState): boolean {
    switch (obj.kind) {
      case MissionObjectiveKind.DestroyAllHostiles: {
        for (const hostileId of this.hostileAircraftIds) {
          const s = this.pool.get(hostileId);
          if (s && s.alive) return false;
        }
        return true;
      }
      case MissionObjectiveKind.Land: {
        const airportId = obj.params.airportId;
        const runwayId = obj.params.runwayId;
        if (typeof airportId !== 'string' || typeof runwayId !== 'string') return false;
        const playerTelemetry = this.getTelemetry(this.playerEntityIdInternal);
        if (!playerTelemetry) return false;
        if (!(playerState.flags & EntityFlag.OnGround)) return false;
        if (playerTelemetry.iasMps >= 5) return false;
        return this.playerIsNearRunway(airportId, runwayId, playerState);
      }
      case MissionObjectiveKind.ReachWaypoint: {
        const wx = obj.params.waypointX;
        const wy = obj.params.waypointY;
        const wz = obj.params.waypointZ;
        if (typeof wx !== 'number' || typeof wy !== 'number' || typeof wz !== 'number') return false;
        const radiusM = typeof obj.params.radiusM === 'number' ? obj.params.radiusM : 200;
        const dx = playerState.pos.x - wx;
        const dy = playerState.pos.y - wy;
        const dz = playerState.pos.z - wz;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radiusM;
      }
      case MissionObjectiveKind.SurviveTime: {
        const seconds = obj.params.seconds;
        if (typeof seconds !== 'number') return false;
        return this.simTimeSecInternal >= seconds;
      }
      default:
        return false;
    }
  }

  private playerIsNearRunway(airportId: string, runwayId: string, playerState: EntityState): boolean {
    const runway: RunwayInfo | undefined = this.deps.navDb.getRunway(airportId, runwayId);
    if (!runway) return false;
    const dx = playerState.pos.x - runway.thresholdPos.x;
    const dz = playerState.pos.z - runway.thresholdPos.z;
    const distM = Math.sqrt(dx * dx + dz * dz);
    return distM <= runway.lengthM;
  }

  // ---- snapshot / events ----

  writeSnapshot(out: Float64Array): void {
    const playerId = this.playerEntityIdInternal;
    const rec = playerId !== NO_ENTITY_ID ? this.aircraft.get(playerId) : undefined;
    const state = playerId !== NO_ENTITY_ID ? this.pool.get(playerId) : undefined;
    const hud = this.hudScratch;
    if (rec && state) {
      const t = rec.telemetry;
      hud.iasMps = t.iasMps;
      hud.tasMps = t.tasMps;
      hud.mach = t.mach;
      hud.altMslM = t.altMslM;
      hud.altAglM = t.altAglM;
      hud.aoaRad = t.alphaRad;
      hud.betaRad = t.betaRad;
      hud.gLoad = t.gLoad;
      // headingRad/pitchRad/rollRad are filled by FlightModelPort.computeTelemetry
      // (flightModelAdapter.ts / module 02) using the SAME extraction formula
      // this file's own hudTelemetry.ts restates for testing (10-core-worker.md
      // section 4.8) — World reads them straight from telemetry rather than
      // recomputing, so there is exactly one place that does the trig.
      hud.headingRad = t.headingRad;
      hud.pitchRad = t.pitchRad;
      hud.rollRad = t.rollRad;
      hud.vspeedMps = t.vspeedMps;
      hud.fuelKg = t.fuelKg;
      hud.thrustFrac = t.thrustFrac;
      hud.gearPos = state.gearPos;
      hud.weaponIdx = WeaponKindCode[rec.combat.selectedWeapon];
      hud.targetId = rec.combat.lockedTargetId ?? NO_ENTITY_ID;
      hud.targetRangeM = 0;
      hud.closureMps = 0;
      hud.lockState = LockStateCode[rec.combat.lockState];
      hud.warningBits = rec.activeWarningBits;
      const ils = this.findNearestIls(state.pos);
      if (ils) {
        computeIlsDeviation(state.pos, ils, this.ilsScratch);
        hud.ilsLoc = this.ilsScratch.loc;
        hud.ilsGs = this.ilsScratch.gs;
      } else {
        hud.ilsLoc = 0;
        hud.ilsGs = 0;
      }
      hud.pipperX = rec.combat.aimPointWorld.x;
      hud.pipperY = rec.combat.aimPointWorld.y;
      hud.pipperZ = rec.combat.aimPointWorld.z;
      hud.pipperValid = rec.combat.aimPointValid ? 1 : 0;
    }
    writeSnapshotBuffer(this.pool, playerId, this.tickInternal, this.simTimeSecInternal, hud, out);
  }

  private findNearestIls(playerPos: Vec3Like) {
    let best: { ils: NonNullable<RunwayInfo['ils']>; distSq: number } | undefined;
    for (const airport of this.deps.navDb.listAirports()) {
      for (const runway of airport.runways) {
        if (!runway.ils) continue;
        const dx = playerPos.x - runway.thresholdPos.x;
        const dz = playerPos.z - runway.thresholdPos.z;
        const distSq = dx * dx + dz * dz;
        if (distSq > 40000 * 40000) continue;
        if (!best || distSq < best.distSq) best = { ils: runway.ils, distSq };
      }
    }
    return best?.ils;
  }

  drainEvents(out: SimEvent[]): number {
    return this.eventQueue.drainInto(out);
  }
}

export const createWorld: CreateWorld = (deps: WorldDependencies) => new WorldImpl(deps);
