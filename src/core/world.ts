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
  ServiceStateCode,
  MAX_SNAPSHOT_TRACKS,
  SNAPSHOT_TRACK_STRIDE,
  SnapshotTrack,
  SnapshotTrackFlag,
  TrackIdentityCode,
  RadarModeCode,
  EntityKind,
  GRAVITY_MPS2,
  MissionObjectiveKind,
  MissionOutcome,
  NO_ENTITY_ID,
  WarningBit,
  WeaponKindCode,
  LockStateCode,
  MAX_STORE_SLOTS,
  STORE_IDS,
  StoreRack,
  MAX_RWR_CONTACTS,
  SNAPSHOT_RWR_STRIDE,
  SnapshotRwr,
  packStoreSlot,
  packStoreSlots,
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
  TERRAIN_IMPACT_PENETRATION_M,
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
import { createEntityPoolInternal, unpackEntityId } from './entityPool';
import type { AirportLayout } from '../contracts/airport';
import type { WorldEntityPool } from './entityPool';
import { resetFcsTrimState } from '../physics';
import type { WorldCombatTickContext } from './combatContext';
import { isaAtmosphereInto } from './atmosphere';
import type { IsaAtmosphereResult } from './atmosphere';
import { createWindState, stepWind } from './wind';
import type { WindState } from './wind';
import { createEventQueue } from './eventQueue';
import { subSeed } from './seed';
import { writeSnapshot as writeSnapshotBuffer } from './snapshotWriter';
import { computeIlsDeviation, forwardWorldInto, rightWorldInto } from './hudTelemetry';
import type { CombatPortWithAirDefence, CombatPortWithContacts, CombatPortWithRearm, CombatPortWithStores } from './combatContext';
import { applyAutopilotAction, autopilotFlags, createAutopilotState, stepAutopilot, type AutopilotState } from './autopilot';
import { getAircraftDefinition, getLoadout, loadoutTanks, resolveLoadout, type TankLoad } from '../aircraft';
import { GroundTargetSet, addAirbaseStructures, placeGroundGroups } from '../ground';
import { SITE_TEMPLATES } from '../catalog';
import type { AdSiteSpec, AdUnitSpec } from '../combat';
import { GROUND_TYPE_IDS, GroundFlag, GroundObjectiveKind, TargetStateCode } from '../contracts/ground';
import type { LoadoutPreset } from '../contracts/aircraft';
import { FUEL_TANKS, WEAPONS } from '../catalog';
import type { AutopilotAction } from '../contracts/core';

const SIM_DT_SEC_LOCAL = 1 / 120; // avoid importing SIM_DT_SEC just to re-derive it; core.ts already fixes this at 1/120 (SIM_HZ)

/**
 * Vertical clearance added to `runway.elevationM` when spawning an aircraft ON a runway (gear
 * down — see spawnAircraftOnly's `startOnGround`), so the wheels rest AT the ground surface
 * (zero initial gear-leg penetration) rather than already deep inside it.
 *
 * Derivation, tied to tejasGeometry.ts's actual GearDefinition data (all three legs share
 * `posBodyM.y`, then -1.1, now -1.7): a spawn at `elevationM + 0.5` (the original, pre-this-fix value) put the
 * wheel-contact reference point at `elevationM + 0.5 - 1.1 = elevationM - 0.6`, i.e. 0.6m BELOW
 * `env.groundElevationM` (which equals `elevationM` inside the airport's flatten zone) — a
 * `penetrationM` of 0.6m against a max gear-leg travel of only 0.28-0.35m
 * (GearDefinition.maxCompressionM), so EVERY leg started already past its hard-stop threshold
 * on tick one. With GEAR_HARD_STOP_STIFFNESS_MULTIPLIER=20x and springNPerM up to 450000 N/m,
 * that computed out to roughly 6.5 MN of combined reaction force at spawn — around 70x the
 * airframe's own weight — violently launching and typically tumbling the aircraft (confirmed
 * live: AoA already -48 to -50deg within 0.5s of launch, no player input given). This bug was
 * DORMANT before gearPos was fixed to start at 1 for ground spawns (see spawnAircraftOnly's own
 * doc comment) — with gear starting retracted, computeGearLeg always short-circuited to zero
 * force, so this force path never actually fired until that earlier fix exposed it.
 *
 * `elevationM - posBodyM.y` (i.e. `elevationM + 1.7`) is the exact zero-penetration point; this
 * lets gravity settle the gear into its natural, well-damped static compression (well within
 * travel — a rough static estimate is on the order of 0.1m) over the first few ticks instead of
 * either freefalling from a large gap (this project's earlier, now-fixed "always retracted"
 * failure mode) or slamming straight into the hard stop (this one).
 *
 * NOT aircraft-generic (FlightModelPort exposes no way to query gear geometry from World, and
 * this project currently only ever spawns 'tejas-mk1') — revisit if/when a second aircraft type
 * with different gear geometry is added.
 */
const RUNWAY_SPAWN_CLEARANCE_M = 1.7;

/** The aircraft the player flies unless the mission names another (MissionPlayerStart.aircraftId). */
const PLAYER_DEFAULT_AIRCRAFT_ID = 'tejas-mk1a';

/** Ground service: empty-to-full refuelling time and full re-arming time, s (compressed from real life). */
const REFUEL_FULL_SEC = 40;
const REARM_SEC = 20;
/** Above this height (m, reference point above the ground) no airframe hard point can reach the ground: skip the per-point terrain samples. */
const AIRFRAME_CONTACT_CHECK_AGL_M = 7;
/** How close to a parking spot counts as "on the stand", m. */
const SERVICE_SPOT_RADIUS_M = 15;

/** Stands (parking spots) and aprons of the mission's friendly or neutral bases, where the player can be serviced. */
function buildServiceZones(mission: Mission): { spots: { x: number; z: number }[]; aprons: { x: number; z: number }[][] } {
  const spots: { x: number; z: number }[] = [];
  const aprons: { x: number; z: number }[][] = [];
  for (const a of (mission.world.airports ?? []) as readonly Partial<AirportLayout>[]) {
    if (a.side === 'hostile') continue;
    for (const p of a.parkingSpots ?? []) spots.push({ x: p.worldX, z: p.worldZ });
    for (const ap of a.aprons ?? []) if ((ap.kind ?? 'apron') === 'apron') aprons.push(ap.points.map((q) => ({ x: q.worldX, z: q.worldZ })));
  }
  return { spots, aprons };
}

/** A parking spot of one of the mission's airports (layouts as loaded by src/core/missions), or undefined. */
function findParkingSpot(mission: Mission, airportId: string, spotId: string): { x: number; z: number; headingRad: number; elevationM: number } | undefined {
  const airports = (mission.world.airports ?? []) as readonly Partial<AirportLayout>[];
  const a = airports.find((x) => x.id === airportId);
  const p = a?.parkingSpots?.find((x) => x.id === spotId);
  if (!a || !p || a.elevationM === undefined) return undefined;
  return { x: p.worldX, z: p.worldZ, headingRad: p.headingRad, elevationM: a.elevationM };
}

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
    alphaLimiterDisabled: false,
    jettisonTanks: false,
    pitchRateScale: 1,
    rollRateScale: 1,
    yawRateScale: 1,
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
  /** AI aircraft: the mission's fit for its flight (the player's comes from playerStart). Absent = the type's default. */
  loadout?: LoadoutPreset;
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
  /** Ground targets (units + airbase structures) and the ground-unit entities that mirror them. */
  private ground = new GroundTargetSet();
  private readonly groundUnits: { id: EntityId; key: number }[] = [];
  private airDefence: { sites: AdSiteSpec[]; units: AdUnitSpec[] } = { sites: [], units: [] };
  private windState: WindState = createWindState(0);
  private windWorldMpsScratch: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly combatCtx: WorldCombatTickContext;
  private readonly hudScratch: SnapshotHudView = {
    iasMps: 0, tasMps: 0, mach: 0, altMslM: 0, altAglM: 0, aoaRad: 0, betaRad: 0, gLoad: 0,
    headingRad: 0, pitchRad: 0, rollRad: 0, vspeedMps: 0, fuelKg: 0, thrustFrac: 0, gearPos: 0,
    weaponIdx: 0, selectedStore: 0, selectedCount: 0, gunRounds: 0, chaff: 0, flares: 0, agMode: 0, ccipX: 0, ccipY: 0, ccipZ: 0, spiX: 0, spiY: 0, spiZ: 0, spiValid: 0, agTimeSec: 0, agCrossM: 0, podFlags: 0, podX: 0, podY: 0, podZ: 0, podFovDeg: 0, podRangeM: 0, dlz: 0, targetId: NO_ENTITY_ID, targetRangeM: 0, closureMps: 0, lockState: 0,
    warningBits: 0, ilsLoc: 0, ilsGs: 0, pipperX: 0, pipperY: 0, pipperZ: 0, pipperValid: 0, tankFuelKg: -1,
    serviceState: 0, serviceFuelFrac: 0, serviceArmFrac: 0,
    radarMode: 0, radarMaxRangeM: 0, radarScanAzRad: 0, trackCount: 0, tracks: new Float64Array(MAX_SNAPSHOT_TRACKS * SNAPSHOT_TRACK_STRIDE),
    rwrCount: 0, rwr: new Float64Array(MAX_RWR_CONTACTS * SNAPSHOT_RWR_STRIDE),
  };
  private readonly ilsScratch = { loc: 0, gs: 0 };
  /** The player's autopilot, and the inputs it hands the flight model (the pilot's, with its overrides). */
  private ap: AutopilotState = createAutopilotState();
  private readonly apInputs: PilotInputs = defaultPilotInputs();
  private readonly trackOrderScratch: number[] = [];
  private readonly fwdScratch: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly rightScratch: Vec3Like = { x: 0, y: 0, z: 0 };
  // Step 9 (mission objective evaluation) runs every tick until the mission
  // ends — src/core's step loop is a 120 Hz hot path (00-architecture.md
  // section 2/13), so this is a reused, .length-reset array rather than a
  // fresh `string[]` literal on every stepOnce() call.
  private readonly completedObjectivesScratch: string[] = [];
  /** Ground service (refuel + re-arm) of the player on a friendly stand or apron. */
  private readonly service = { state: 0, fuelFrac: 0, armFrac: 0, active: false, prevHeld: false };
  private serviceZones: { spots: { x: number; z: number }[]; aprons: { x: number; z: number }[][] } = { spots: [], aprons: [] };

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
      getAircraftDefId(id: EntityId): string | undefined {
        return self.aircraft.get(id)?.aircraftDefId;
      },
      get ground(): GroundTargetSet {
        return self.ground;
      },
      get airDefence(): { sites: readonly AdSiteSpec[]; units: readonly AdUnitSpec[] } {
        return self.airDefence;
      },
      getLoadout(id: EntityId): LoadoutPreset | undefined {
        const rec = self.aircraft.get(id);
        if (!rec) return undefined;
        return id === self.playerEntityIdInternal ? self.playerLoadout(rec.aircraftDefId) : rec.loadout;
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
    this.ap = createAutopilotState();
    this.missionSeedInternal = mission.world.seed;
    this.windState = createWindState(subSeed(this.missionSeedInternal, 'wind'));
    this.serviceZones = buildServiceZones(mission);

    // Player.
    const ps = mission.playerStart;
    let playerPos: Vec3Like;
    let playerHeadingRad: number;
    let playerSpeedMps: number;
    let playerStartOnGround: boolean;
    const spot = ps.airportId !== undefined && ps.parkingSpotId !== undefined ? findParkingSpot(mission, ps.airportId, ps.parkingSpotId) : undefined;
    if (spot) {
      playerPos = { x: spot.x, y: spot.elevationM + RUNWAY_SPAWN_CLEARANCE_M, z: spot.z };
      playerHeadingRad = spot.headingRad;
      playerSpeedMps = 0;
      playerStartOnGround = true;
    } else if (ps.airportId !== undefined && ps.runwayId !== undefined) {
      const runway = this.deps.navDb.getRunway(ps.airportId, ps.runwayId);
      if (runway) {
        const fwd = forwardWorldInto(runway.headingRad, this.fwdScratch);
        playerPos = { x: runway.thresholdPos.x + fwd.x * 200, y: runway.elevationM + RUNWAY_SPAWN_CLEARANCE_M, z: runway.thresholdPos.z + fwd.z * 200 };
        playerHeadingRad = runway.headingRad;
        playerSpeedMps = ps.speedMps ?? 0;
        playerStartOnGround = true;
      } else {
        playerPos = ps.pos ?? { x: 0, y: 1000, z: 0 };
        playerHeadingRad = ps.headingRad ?? 0;
        playerSpeedMps = ps.speedMps ?? 0;
        playerStartOnGround = false;
      }
    } else {
      playerPos = ps.pos ?? { x: 0, y: 1000, z: 0 };
      playerHeadingRad = ps.headingRad ?? 0;
      playerSpeedMps = ps.speedMps ?? 0;
      playerStartOnGround = false;
    }
    // Spawns directly via spawnAircraftOnly (not the public spawnEntity path) solely to thread
    // playerStartOnGround through — see spawnAircraftOnly's doc comment for why a runway spawn
    // must start with gear down. Player-specific bookkeeping (IsPlayer flag, playerEntityIdInternal)
    // below mirrors exactly what spawnEntity's aircraft branch would otherwise have done.
    const playerId = this.spawnAircraftOnly(0, playerPos, playerHeadingRad, playerSpeedMps, ps.aircraftId ?? PLAYER_DEFAULT_AIRCRAFT_ID, playerStartOnGround, true);
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
        let startOnGround: boolean;
        if (flight.startAirportId !== undefined && flight.startRunwayId !== undefined) {
          const runway = this.deps.navDb.getRunway(flight.startAirportId, flight.startRunwayId);
          if (runway) {
            headingRad = runway.headingRad;
            speedMps = flight.startSpeedMps ?? 0;
            pos = { x: runway.thresholdPos.x, y: runway.elevationM + RUNWAY_SPAWN_CLEARANCE_M, z: runway.thresholdPos.z };
            startOnGround = true;
          } else {
            headingRad = flight.startHeadingRad ?? 0;
            speedMps = flight.startSpeedMps ?? 0;
            pos = flight.startPos ?? { x: 0, y: 1000, z: 0 };
            startOnGround = false;
          }
        } else {
          headingRad = flight.startHeadingRad ?? 0;
          speedMps = flight.startSpeedMps ?? 0;
          pos = flight.startPos ?? { x: 0, y: 1000, z: 0 };
          startOnGround = false;
        }
        if (j > 0) {
          const right = rightWorldInto(headingRad, this.rightScratch);
          pos = { x: pos.x + right.x * 40 * j, y: pos.y, z: pos.z + right.z * 40 * j };
        }
        const entityId = this.spawnAircraftOnly(flight.team, pos, headingRad, speedMps, flight.aircraftId, startOnGround);
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
          const def = getAircraftDefinition(flight.aircraftId);
          if (def && (flight.loadoutId || flight.loadout)) rec.loadout = resolveLoadout(def, flight.loadoutId, flight.loadout);
        }
      }
    }

    this.spawnGround(mission);
    this.missionEndedThisLoad = false;
  }

  /** Airbase structures become static targets; the mission's ground groups become ground-unit entities (and targets). */
  private spawnGround(mission: Mission): void {
    this.ground = new GroundTargetSet();
    this.groundUnits.length = 0;
    // Air-defence sites: the groups whose template carries a system (a fresh object per load).
    this.airDefence = { sites: [], units: [] };
    for (const g of mission.groundGroups ?? []) {
      const system = g.template ? SITE_TEMPLATES[g.template]?.airDefence : undefined;
      if (system) this.airDefence.sites.push({ id: g.id, team: g.team, system, emcon: g.emcon ?? 'active' });
    }
    for (const a of (mission.world.airports ?? []) as readonly Partial<AirportLayout>[]) addAirbaseStructures(this.ground, a);
    for (const u of placeGroundGroups(mission.groundGroups ?? [], this.deps.sampler)) {
      const id = this.pool.allocate(EntityKind.Ground, u.team);
      if (id === NO_ENTITY_ID) break;
      const state = this.pool.get(id)!;
      state.pos.x = u.x;
      state.pos.y = u.groundY;
      state.pos.z = u.z;
      Quat.fromYawPitchRoll(u.headingRad, 0, 0, state.rot);
      state.vel.x = 0;
      state.vel.y = 0;
      state.vel.z = 0;
      state.hp = 100;
      state.stores = Math.max(0, GROUND_TYPE_IDS.indexOf(u.type.id));
      state.flags = 0;
      const tg = this.ground.add({
        entityId: id,
        targetId: `unit:${u.groupId}:${u.index}`,
        typeId: u.type.id,
        groupId: u.groupId,
        team: u.team,
        armor: u.type.armor,
        toughness: u.type.toughness,
        burnSec: u.type.burnSec,
        pos: { x: u.x, y: u.groundY + u.type.halfExtentsM.y, z: u.z },
        headingRad: u.headingRad,
        half: { ...u.type.halfExtentsM },
      });
      this.groundUnits.push({ id, key: tg.key });
      if (this.airDefence.sites.some((s) => s.id === u.groupId)) this.airDefence.units.push({ entityId: id, siteId: u.groupId, typeId: u.type.id });
    }
  }

  /** Ground-unit entities follow their targets' damage (hit points, destroyed/burning/damaged flags). */
  private syncGroundUnits(): void {
    for (let i = 0; i < this.groundUnits.length; i++) {
      const u = this.groundUnits[i]!;
      const state = this.pool.get(u.id);
      const tg = this.ground.targets[u.key];
      if (!state || !tg) continue;
      state.hp = Math.round(tg.hp * 100);
      let f = state.flags & ~(GroundFlag.Destroyed | GroundFlag.Burning | GroundFlag.Damaged);
      if (tg.state === TargetStateCode.Destroyed) f |= GroundFlag.Destroyed;
      else if (tg.state === TargetStateCode.Damaged) f |= GroundFlag.Damaged;
      if (tg.burnLeftSec > 0) f |= GroundFlag.Burning;
      state.flags = f;
    }
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
    this.service.state = ServiceStateCode.None;
    this.service.active = false;
    this.service.prevHeld = false;
    this.service.fuelFrac = 0;
    this.service.armFrac = 0;
  }

  // ---- spawning ----

  /**
   * Allocates an aircraft entity + its World-owned bookkeeping records, WITHOUT attaching a Pilot.
   * Shared by spawnEntity (manual path) and loadMission's AI-flight loop (formation-aware path).
   *
   * `startOnGround` must be true for any spawn placed via a runway lookup (position is
   * `runway.elevationM + RUNWAY_SPAWN_CLEARANCE_M`, i.e. resting height, not airborne
   * clearance — see that constant's own doc comment for the exact derivation): gearPos
   * otherwise starts at the pool's zeroed default (fully retracted) and takes
   * GEAR_TRAVEL_RATE_PER_SEC's full ~2s to extend past GEAR_CONTACT_GEARPOS_THRESHOLD
   * (landingGear.ts), so a "parked on the runway" spawn would free-fall for two seconds before
   * any gear contact force could ever apply — producing an uncontrolled tumble (large computed AoA from
   * the resulting fall velocity) before the player or AI ever gets a tick of authority. Airborne
   * spawns (AI flights via startPos/startSpeedMps, or the player's non-runway pos fallback)
   * correctly want gear retracted at spawn, so they must NOT set this.
   */
  private spawnAircraftOnly(team: 0 | 1, pos: Vec3Like, headingRad: number, speedMps: number, aircraftDefId: string, startOnGround: boolean, withDropTanks = false): EntityId {
    if (!this.deps.flightModel.hasDefinition(aircraftDefId)) return NO_ENTITY_ID;
    const id = this.pool.allocate(EntityKind.Aircraft, team);
    if (id === NO_ENTITY_ID) return NO_ENTITY_ID;
    const state = this.pool.get(id);
    if (!state) return NO_ENTITY_ID;
    // src/physics/fcs.ts keeps its trim-integral/last-gLoad state in a
    // module-private, pool-index-keyed table (not part of EntityState/
    // DamageState — see 02-flight-model.md section 4.9/9) precisely so a
    // freshly (re)spawned aircraft never inherits a stale value left behind
    // by whichever previous occupant used this same pool slot — including,
    // critically, a previous occupant from a DIFFERENT World instance in the
    // same process (fcs.ts's arrays are module-level, not per-World). This
    // call was previously missing, which made a fresh World's physics
    // depend on unrelated earlier World instances' history in the same
    // process — a real, reproducible determinism bug (two fresh
    // SimWorldHandles built from the same seed/inputs diverging).
    resetFcsTrimState(unpackEntityId(id).index);
    state.pos.x = pos.x;
    state.pos.y = pos.y;
    state.pos.z = pos.z;
    Quat.fromYawPitchRoll(headingRad, 0, 0, state.rot);
    const fwd = forwardWorldInto(headingRad, this.fwdScratch);
    state.vel.x = fwd.x * speedMps;
    state.vel.y = fwd.y * speedMps;
    state.vel.z = fwd.z * speedMps;
    state.fuelKg = this.deps.flightModel.maxFuelKg(aircraftDefId);
    // Full drop tanks for the player only (the AI has no jettison logic, so it flies clean);
    // J / the jettisonTanks input drops them (src/physics).
    const tanks = withDropTanks ? this.playerTanks(aircraftDefId) : undefined;
    state.dropTankCount = tanks ? tanks.count : 0;
    state.dropTankFuelKg = tanks ? tanks.fuelKg : 0;
    state.dropTankShellKg = tanks ? tanks.shellKg : 0;
    state.dropTankDragAreaM2 = tanks ? tanks.dragAreaM2 : 0;
    // gearPos starts at the pool's zeroed default (fully retracted) EXCEPT
    // for a ground start (see this method's doc comment), where it must be
    // set to fully-down immediately so the very first physics tick already
    // finds ground contact at the spawn height instead of free-falling
    // through it while gear spends ~2s animating up from 0.
    // EntityFlag.GearDownCommanded is left at the pool's zeroed default in
    // both cases — PilotInputs.gearDown defaults to true (see
    // defaultPilotInputs()) and it is the flight model's own job
    // (FlightModelPort.step) to derive that flag from the input every tick,
    // not World's; it self-corrects on the first tick regardless.
    state.gearPos = startOnGround ? 1 : 0;

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
        // Populated by CombatPort.step (combatAdapter.ts) via updateSensors,
        // exposed back to World through the CombatPortWithContacts surface
        // (combatContext.ts) — see 10-core-worker.md section 4.1 step 2 and
        // section 9 item 6. Falls back to EMPTY_CONTACTS for any combat.step
        // fake/stub that only implements the pinned CombatPort interface
        // (e.g. this module's own unit tests).
        const combat = self.deps.combat as Partial<CombatPortWithContacts>;
        return combat.getContacts ? combat.getContacts(id) : EMPTY_CONTACTS;
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
      // Manual spawn path (no runway lookup available in SpawnSpec) — always airborne-default
      // (gear retracted), matching every current caller (debug/editor spawn commands).
      const id = this.spawnAircraftOnly(spec.team, spec.pos, spec.headingRad, speedMps, spec.aircraftDefId, false);
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
    // Optional fields must be copied too: this field-by-field copy silently dropped both, so the
    // Settings "AoA limiter" toggle never reached the sim and drop tanks could not be jettisoned.
    target.alphaLimiterDisabled = inputs.alphaLimiterDisabled ?? false;
    target.pitchRateScale = inputs.pitchRateScale ?? 1;
    target.rollRateScale = inputs.rollRateScale ?? 1;
    target.yawRateScale = inputs.yawRateScale ?? 1;
    target.jettisonTanks = inputs.jettisonTanks ?? false;
    target.lights = inputs.lights ?? 0;
    target.requestService = inputs.requestService ?? false;
    target.radarModeCycle = inputs.radarModeCycle ?? false;
    target.dispenseFlare = inputs.dispenseFlare ?? false;
    target.dispenseChaff = inputs.dispenseChaff ?? false;
    target.podSlewX = inputs.podSlewX ?? 0;
    target.podSlewY = inputs.podSlewY ?? 0;
    target.podZoom = inputs.podZoom ?? false;
    target.podTrack = inputs.podTrack ?? false;
    target.laser = inputs.laser ?? false;
    target.throttleActive = inputs.throttleActive ?? false;
  }

  commandAutopilot(action: AutopilotAction): void {
    const rec = this.aircraft.get(this.playerEntityIdInternal);
    if (!rec) return;
    applyAutopilotAction(this.ap, action, rec.telemetry, rec.inputs.throttle);
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

      // The player's autopilot flies with a copy of the pilot's inputs (theirs stay untouched, so a
      // stick input can be seen and disconnect it).
      let inputs = rec.inputs;
      if (state.id === this.playerEntityIdInternal && !pilot) {
        Object.assign(this.apInputs, rec.inputs);
        const lim = getAircraftDefinition(rec.aircraftDefId)?.fcsLimits;
        if (stepAutopilot(this.ap, rec.telemetry, rec.inputs, lim?.maxRollRateRadS ?? 5.236, lim?.maxGLoadPos ?? 8, lim?.maxGLoadNeg ?? -3, SIM_DT_SEC_LOCAL, this.apInputs)) {
          inputs = this.apInputs;
        }
      }
      this.deps.flightModel.step(rec.aircraftDefId, state, damage, inputs, rec.env, SIM_DT_SEC_LOCAL, state);
      this.deps.flightModel.computeTelemetry(rec.aircraftDefId, state, damage, rec.env, rec.telemetry);
    }

    // Step 4: warning-bit evaluation.
    for (let i = 0; i < aircraftCount; i++) {
      const state = this.pool.aircraftLiveAt(i);
      const rec = this.aircraft.get(state.id);
      if (!rec || !state.alive) continue;
      const t = rec.telemetry;
      let bits = 0;
      // No stall warning parked or taxiing: at a standstill the angle of attack is meaningless.
      if (t.stalled && !(state.flags & EntityFlag.OnGround) && t.iasMps > 25) bits |= WarningBit.Stall;
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
        // Terrain-impact fallback (see TERRAIN_IMPACT_PENETRATION_M's doc comment in
        // contracts/sim.ts for why this exists): ground contact is otherwise only checked at
        // the 3 gear legs, which go inert whenever gear is retracted, so without this an
        // aircraft can fly straight through solid ground with no consequence at all. Forcing
        // structurePct to 0 here reuses the existing crossing-detection immediately below
        // (crash event + alive=false), which is what actually halts the aircraft: a dead
        // entity's flight-model step is skipped from the next tick on, freezing pos/vel in
        // place instead of letting it keep falling.
        if (damage.structurePct > 0 && rec.telemetry.altAglM < TERRAIN_IMPACT_PENETRATION_M) {
          damage.structurePct = 0;
        }
        // The airframe itself touching the ground (belly, nose, tail, a wing tip...) is a crash:
        // only the wheels may carry the aircraft. Before this, nothing stopped a gear-up or
        // banked-over jet sinking metres into the ground (the fallback above only fires at
        // TERRAIN_IMPACT_PENETRATION_M below the centre of gravity).
        if (damage.structurePct > 0 && this.airframeTouchesGround(state, rec.aircraftDefId, rec.telemetry.altAglM)) {
          damage.structurePct = 0;
        }
        // Water is a surface to the sampler (so gear, AI and radar all see it) but never a
        // runway: any contact with it, gear or not, is a crash.
        if (damage.structurePct > 0 && onGroundNow && this.deps.sampler.isWaterAt?.(state.pos.x, state.pos.z)) {
          damage.structurePct = 0;
        }
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
    this.ground.step(SIM_DT_SEC_LOCAL);
    this.syncGroundUnits();

    // Step 7: ground service (refuel + re-arm) of the player.
    this.stepService(SIM_DT_SEC_LOCAL);

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

  /** Whether any of the aircraft's airframe hard points (AircraftDefinition.airframeContactPointsBodyM) is at or below the ground. */
  private airframeTouchesGround(state: EntityState, aircraftDefId: string, altAglM: number): boolean {
    const points = getAircraftDefinition(aircraftDefId)?.airframeContactPointsBodyM;
    // No point is further than ~6.5 m from the reference point: skip the terrain samples when clear.
    if (!points || altAglM > AIRFRAME_CONTACT_CHECK_AGL_M) return false;
    const p = this.contactScratch;
    for (const b of points) {
      Quat.rotate(state.rot, b, p);
      const x = state.pos.x + p.x;
      const z = state.pos.z + p.z;
      if (state.pos.y + p.y <= this.deps.sampler.heightAt(x, z)) return true;
    }
    return false;
  }
  private readonly contactScratch: Vec3Like = { x: 0, y: 0, z: 0 };

  /**
   * Refuel and re-arm the player while stopped (on its wheels, < 1 m/s, throttle idle) on a stand or
   * apron of a friendly or neutral base. The service key starts it; drop tanks are refitted, fuel
   * flows (internal first, then the tanks; empty to full in REFUEL_FULL_SEC) and the weapon
   * stations refill over REARM_SEC. Moving or opening the throttle stops it; what is loaded stays.
   */
  private stepService(dt: number): void {
    const sv = this.service;
    const id = this.playerEntityIdInternal;
    const state = id !== NO_ENTITY_ID ? this.pool.get(id) : undefined;
    const rec = state ? this.aircraft.get(id) : undefined;
    if (!state || !rec || !state.alive) {
      sv.state = ServiceStateCode.None;
      sv.active = false;
      return;
    }
    const held = rec.inputs.requestService ?? false;
    const pressed = held && !sv.prevHeld;
    sv.prevHeld = held;
    const speed = Math.hypot(state.vel.x, state.vel.y, state.vel.z);
    const stopped = (state.flags & EntityFlag.OnGround) !== 0 && speed < 1 && rec.inputs.throttle <= 0.05 && !rec.inputs.afterburner;
    if (!stopped || !this.inServiceZone(state.pos.x, state.pos.z)) {
      sv.state = ServiceStateCode.None;
      sv.active = false;
      return;
    }
    const maxInternal = this.deps.flightModel.maxFuelKg(rec.aircraftDefId);
    const tanks = this.playerTanks(rec.aircraftDefId);
    const full = maxInternal + tanks.fuelKg;
    const tankFuel = (state.dropTankCount ?? 0) > 0 ? (state.dropTankFuelKg ?? 0) : 0;
    const port = this.deps.combat as Partial<CombatPortWithRearm>;
    if (sv.active) {
      if ((state.dropTankCount ?? 0) < tanks.count) {
        state.dropTankCount = tanks.count;
        state.dropTankFuelKg = tankFuel;
        state.dropTankShellKg = tanks.shellKg;
        state.dropTankDragAreaM2 = tanks.dragAreaM2;
      }
      let add = (full / REFUEL_FULL_SEC) * dt;
      const toInternal = Math.min(add, Math.max(0, maxInternal - state.fuelKg));
      state.fuelKg += toInternal;
      add -= toInternal;
      if (add > 0 && tanks.count > 0) state.dropTankFuelKg = Math.min(tanks.fuelKg, (state.dropTankFuelKg ?? 0) + add);
      sv.armFrac = Math.min(1, sv.armFrac + dt / REARM_SEC);
      port.rearm?.(id, sv.armFrac);
      const now = state.fuelKg + (tanks.count > 0 ? (state.dropTankFuelKg ?? 0) : 0);
      sv.fuelFrac = full > 0 ? now / full : 1;
      if (now >= full - 0.5 && sv.armFrac >= 1) {
        sv.active = false;
        sv.state = ServiceStateCode.Complete;
      } else {
        sv.state = ServiceStateCode.Servicing;
      }
      return;
    }
    sv.fuelFrac = full > 0 ? (state.fuelKg + tankFuel) / full : 1;
    const armed = port.armedFrac ? port.armedFrac(id) : 1;
    const needs = sv.fuelFrac < 0.995 || armed < 1 || (state.dropTankCount ?? 0) < tanks.count;
    if (pressed && needs) {
      sv.active = true;
      sv.armFrac = armed;
      sv.state = ServiceStateCode.Servicing;
    } else if (sv.state !== ServiceStateCode.Complete) {
      sv.state = needs ? ServiceStateCode.Available : ServiceStateCode.None;
    }
  }

  private inServiceZone(x: number, z: number): boolean {
    const r2 = SERVICE_SPOT_RADIUS_M * SERVICE_SPOT_RADIUS_M;
    for (const s of this.serviceZones.spots) {
      const dx = s.x - x;
      const dz = s.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    for (const poly of this.serviceZones.aprons) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]!;
        const b = poly[j]!;
        if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
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
    const completed = this.completedObjectivesScratch;
    completed.length = 0;
    if (!playerState || !playerState.alive) {
      // Mission-ending outcome: a small, rare (at most once per mission,
      // never once-per-tick) copy is fine here — see 00-architecture.md's
      // own carve-out for SimEvent payload allocation — and avoids aliasing
      // a `[]`/scratch array that could later be mutated by a subsequent
      // loadMission/reset on this same World into an event a caller retained.
      return { outcome: MissionOutcome.Failure, objectivesCompleted: [] };
    }

    // Protect objectives fail the mission as soon as too much of the group is lost.
    for (const obj of mission.objectives) {
      if (obj.kind !== GroundObjectiveKind.ProtectGroup) continue;
      const c = this.ground.count((t) => t.groupId === obj.params.group && t.entityId >= 0);
      const keep = typeof obj.params.fraction === 'number' ? obj.params.fraction : 0.5;
      if (c.total > 0 && (c.total - c.destroyed) / c.total < keep) return { outcome: MissionOutcome.Failure, objectivesCompleted: [] };
    }
    for (const obj of mission.objectives) {
      if (this.isObjectiveComplete(obj, playerState)) completed.push(obj.id);
    }
    if (completed.length === mission.objectives.length && mission.objectives.length > 0) {
      return { outcome: MissionOutcome.Success, objectivesCompleted: completed.slice() };
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
      case GroundObjectiveKind.DestroyGroup: {
        const types = typeof obj.params.types === 'string' ? obj.params.types.split(',') : undefined;
        const c = this.ground.count((t) => t.groupId === obj.params.group && t.entityId >= 0 && (!types || types.includes(t.typeId)));
        const need = typeof obj.params.fraction === 'number' ? obj.params.fraction : 1;
        return c.total > 0 && c.destroyed >= Math.ceil(c.total * need - 1e-9);
      }
      case GroundObjectiveKind.DestroyStructures: {
        const prefix = `${String(obj.params.airportId)}:`;
        const group = obj.params.group;
        const c = this.ground.count((t) => t.entityId < 0 && t.targetId.startsWith(prefix) && (group === undefined || t.groupId === group));
        const need = typeof obj.params.fraction === 'number' ? obj.params.fraction : 1;
        return c.total > 0 && c.destroyed >= Math.ceil(c.total * need - 1e-9);
      }
      case GroundObjectiveKind.ProtectGroup:
        // Complete while held (failure is checked separately): it lets a strike end with success.
        return true;
      case GroundObjectiveKind.SuppressGroup: {
        const ad = this.deps.combat as Partial<CombatPortWithAirDefence>;
        const sec = typeof obj.params.seconds === 'number' ? obj.params.seconds : 60;
        return (ad.siteSuppressedSec?.(String(obj.params.group)) ?? 0) >= sec;
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
      hud.selectedStore = Math.max(0, STORE_IDS.indexOf(rec.combat.selectedStoreId ?? ''));
      hud.selectedCount = rec.combat.selectedStoreCount ?? 0;
      hud.gunRounds = rec.combat.ammoGun;
      hud.chaff = rec.combat.chaff ?? 0;
      hud.flares = rec.combat.flares ?? 0;
      const c = rec.combat;
      hud.agMode = c.agMode ?? 0;
      hud.ccipX = c.agImpactWorld?.x ?? 0;
      hud.ccipY = c.agImpactWorld?.y ?? 0;
      hud.ccipZ = c.agImpactWorld?.z ?? 0;
      hud.spiValid = c.spiValid ? 1 : 0;
      hud.spiX = c.spiWorld?.x ?? 0;
      hud.spiY = c.spiWorld?.y ?? 0;
      hud.spiZ = c.spiWorld?.z ?? 0;
      hud.agTimeSec = c.agTimeSec ?? 0;
      hud.agCrossM = c.agCrossTrackM ?? 0;
      hud.podFlags = c.podFlags ?? 0;
      hud.podX = c.podPoint?.x ?? 0;
      hud.podY = c.podPoint?.y ?? 0;
      hud.podZ = c.podPoint?.z ?? 0;
      hud.podFovDeg = c.podFovDeg ?? 0;
      hud.podRangeM = c.podRangeM ?? 0;
      hud.dlz = c.dlz ?? 0;
      hud.targetId = rec.combat.lockedTargetId ?? NO_ENTITY_ID;
      // Range/closure to the designated target, straight from the two entity states (previously
      // hardcoded to 0, so the HUD target box always read "0M +0").
      const target = hud.targetId !== NO_ENTITY_ID ? this.getEntityState(hud.targetId) : undefined;
      if (target && target.alive) {
        const dx = target.pos.x - state.pos.x;
        const dy = target.pos.y - state.pos.y;
        const dz = target.pos.z - state.pos.z;
        const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
        hud.targetRangeM = range;
        hud.closureMps =
          range > 1e-6
            ? -((target.vel.x - state.vel.x) * dx + (target.vel.y - state.vel.y) * dy + (target.vel.z - state.vel.z) * dz) / range
            : 0;
      } else {
        hud.targetRangeM = 0;
        hud.closureMps = 0;
      }
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
      hud.tankFuelKg = (state.dropTankCount ?? 0) > 0 ? (state.dropTankFuelKg ?? 0) : -1;
      hud.serviceState = this.service.state;
      hud.serviceFuelFrac = this.service.fuelFrac;
      hud.serviceArmFrac = this.service.armFrac;
      // The player's radar and its track list (nearest first).
      hud.radarMode = RadarModeCode[rec.combat.radarMode ?? 'rws'];
      hud.radarMaxRangeM = rec.combat.radarMaxRangeM ?? 0;
      hud.radarScanAzRad = rec.combat.radarScanAzRad ?? 0;
      hud.apFlags = autopilotFlags(this.ap, t);
      hud.apHdgRad = this.ap.hdgRad;
      hud.apAltM = this.ap.altM;
      hud.apVsMps = this.ap.vsMps;
      hud.apSpdMps = this.ap.spdMps;
      hud.apThrottle = this.ap.throttle;
      const contacts = (this.deps.combat as Partial<CombatPortWithContacts>).getContacts?.(playerId) ?? [];
      const order = this.trackOrderScratch;
      order.length = 0;
      for (let i = 0; i < contacts.length; i++) order.push(i);
      order.sort((a, b) => contacts[a]!.rangeM - contacts[b]!.rangeM);
      const n = Math.min(order.length, MAX_SNAPSHOT_TRACKS);
      for (let k = 0; k < n; k++) {
        const c = contacts[order[k]!]!;
        const o = k * SNAPSHOT_TRACK_STRIDE;
        const identity = c.identity ?? (c.identified ? (c.team === state.team ? 'friend' : 'hostile') : 'unknown');
        let flags = c.memory ? SnapshotTrackFlag.Memory : 0;
        if (c.id === rec.combat.lockedTargetId) flags |= SnapshotTrackFlag.Designated;
        if (c.id === rec.combat.lockedTargetId && rec.combat.lockState === 'locked') flags |= SnapshotTrackFlag.Locked;
        hud.tracks[o + SnapshotTrack.ID] = c.id;
        hud.tracks[o + SnapshotTrack.X] = c.pos.x;
        hud.tracks[o + SnapshotTrack.Y] = c.pos.y;
        hud.tracks[o + SnapshotTrack.Z] = c.pos.z;
        hud.tracks[o + SnapshotTrack.VX] = c.vel.x;
        hud.tracks[o + SnapshotTrack.VZ] = c.vel.z;
        hud.tracks[o + SnapshotTrack.IDENTITY] = TrackIdentityCode[identity];
        hud.tracks[o + SnapshotTrack.FLAGS] = flags;
      }
      hud.trackCount = n;
      // Radar-warning receiver contacts.
      const rwr = rec.combat.rwr ?? [];
      const nr = Math.min(rwr.length, MAX_RWR_CONTACTS);
      for (let k = 0; k < nr; k++) {
        const c = rwr[k]!;
        const o = k * SNAPSHOT_RWR_STRIDE;
        hud.rwr![o + SnapshotRwr.SYMBOL] = c.symbol;
        hud.rwr![o + SnapshotRwr.BEARING_RAD] = c.bearingRad;
        hud.rwr![o + SnapshotRwr.STATE] = c.state;
        hud.rwr![o + SnapshotRwr.RANGE_M] = c.rangeM;
      }
      hud.rwrCount = nr;
    }
    for (const [id, r] of this.aircraft) {
      const st = this.pool.get(id);
      if (st) {
        this.packStores(id, r.aircraftDefId, st, this.storesScratch);
        st.stores = this.storesScratch.a;
        st.storesB = this.storesScratch.b;
      }
    }
    writeSnapshotBuffer(this.pool, playerId, this.tickInternal, this.simTimeSecInternal, hud, out);
  }

  private playerLoadoutMemo: { mission: unknown; defId: string; loadout: LoadoutPreset | undefined; tanks: TankLoad } | undefined;

  /** The player's store fit from the mission: its custom fit, else its preset, else the aircraft's default. */
  private playerLoadout(defId: string): LoadoutPreset | undefined {
    return this.playerFit(defId).loadout;
  }

  /** The drop tanks in the player's fit, full. */
  private playerTanks(defId: string): TankLoad {
    return this.playerFit(defId).tanks;
  }

  private playerFit(defId: string): { loadout: LoadoutPreset | undefined; tanks: TankLoad } {
    const m = this.playerLoadoutMemo;
    if (m && m.mission === this.mission && m.defId === defId) return m;
    const def = getAircraftDefinition(defId);
    const ps = this.mission?.playerStart;
    const loadout = def ? resolveLoadout(def, ps?.loadoutId, ps?.loadout) : undefined;
    const memo = { mission: this.mission, defId, loadout, tanks: loadoutTanks(loadout) };
    this.playerLoadoutMemo = memo;
    return memo;
  }

  /**
   * An aircraft's carried stores for the snapshot (contracts/core.ts STORES layout): its loadout's
   * store on each station, with the missiles still on it (from combat) and the drop tanks only
   * while attached.
   */
  private readonly storesScratch = { a: 0, b: 0 };
  private readonly storeSlotsScratch: number[] = [];

  private packStores(id: EntityId, defId: string, state: EntityState, out: { a: number; b: number }): void {
    const slots = this.storeSlotsScratch;
    slots.length = 0;
    const def = getAircraftDefinition(defId);
    if (def?.stations) {
      const loadout = id === this.playerEntityIdInternal ? this.playerLoadout(defId) : (this.aircraft.get(id)?.loadout ?? getLoadout(def));
      const combat = this.deps.combat as Partial<CombatPortWithStores>;
      for (const st of def.stations) {
        if (st.id === 'gun') continue;
        if (slots.length >= MAX_STORE_SLOTS) break;
        const fit = loadout?.fit[st.id];
        const code = fit ? STORE_IDS.indexOf(fit.store) : -1;
        if (fit && code > 0) {
          const w = WEAPONS[fit.store];
          // Tanks while attached; pods (rounds per store) as pods; others as stores left.
          const count = FUEL_TANKS[fit.store] ? ((state.dropTankCount ?? 0) > 0 ? fit.count : 0) : w?.roundsPerStore ? fit.count : (combat.stationCount?.(id, st.id) ?? fit.count);
          const rack = fit.count < 2 ? StoreRack.Single : w && (w.kind === 'ir_missile' || w.kind === 'radar_missile') ? StoreRack.TwinRail : StoreRack.MultiRack;
          slots.push(packStoreSlot(code, count, rack));
        } else {
          slots.push(0);
        }
      }
    }
    packStoreSlots(slots, out);
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
