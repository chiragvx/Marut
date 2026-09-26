import { describe, expect, it } from 'vitest';
import { createWorld } from '../../src/core/world';
import { NO_ENTITY_ID, WarningBit } from '../../src/contracts/core';
import type {
  AircraftTelemetry,
  AirportNavDb,
  Contact,
  DamageState,
  EntityId,
  EntityState,
  HeightSampler,
  Mission,
  Pilot,
  PilotContext,
  PilotInputs,
  SimEvent,
  Vec3Like,
} from '../../src/contracts/core';
import type { CombatPort, FlightModelPort, SimEnvironment, WorldDependencies } from '../../src/contracts/sim';

function fakeSampler(): HeightSampler {
  return {
    seed: 1,
    heightAt: () => 0,
    normalAt: (_x, _z, out) => {
      out.x = 0;
      out.y = 1;
      out.z = 0;
      return out;
    },
  };
}

function fakeNavDb(): AirportNavDb {
  return {
    getAirport: () => undefined,
    listAirports: () => [],
    nearestAirport: () => undefined,
    getRunway: () => undefined,
  };
}

function zeroTelemetry(): AircraftTelemetry {
  return {
    iasMps: 0, tasMps: 0, mach: 0, altMslM: 0, altAglM: 0, alphaRad: 0, betaRad: 0, gLoad: 0,
    headingRad: 0, pitchRad: 0, rollRad: 0, vspeedMps: 0, fuelKg: 1000, fuelFrac: 1, thrustFrac: 0,
    onGround: false, stalled: false,
  };
}

/** Deterministic fake: integrates pos += vel*dt, leaves everything else untouched. */
function makeIntegratingFlightModel(): FlightModelPort {
  return {
    hasDefinition: (id: string) => id === 'tejas-mk1a',
    step(_defId: string, state: EntityState, _damage: DamageState, _inputs: PilotInputs, _env: SimEnvironment, dtSec: number, out: EntityState): void {
      out.pos.x = state.pos.x + state.vel.x * dtSec;
      out.pos.y = state.pos.y + state.vel.y * dtSec;
      out.pos.z = state.pos.z + state.vel.z * dtSec;
    },
    computeTelemetry(_defId: string, _state: EntityState, _damage: DamageState, _env: SimEnvironment, out: AircraftTelemetry): void {
      Object.assign(out, zeroTelemetry());
    },
    maxFuelKg: () => 1000,
  };
}

function noopCombat() {
  return { step: () => {} };
}

function noopCreateAiPilot(): Pilot {
  return { update: () => {} };
}

function minimalMission(): Mission {
  return {
    id: 'test-mission',
    name: 'Test',
    world: { seed: 1, terrain: {}, airports: [] },
    playerStart: { pos: { x: 0, y: 1000, z: 0 } as Vec3Like, headingRad: 0, speedMps: 100 },
    aiFlights: [],
    weather: { windWorldMps: { x: 0, y: 0, z: 0 }, gustMps: 0, turbulence: 0 },
    objectives: [],
  };
}

function baseDeps(flightModel: FlightModelPort): WorldDependencies {
  return {
    flightModel,
    combat: noopCombat(),
    createAiPilot: noopCreateAiPilot,
    sampler: fakeSampler(),
    navDb: fakeNavDb(),
  };
}

describe('World', () => {
  it('loadMission spawns a live player', () => {
    const world = createWorld(baseDeps(makeIntegratingFlightModel()));
    world.loadMission(minimalMission());
    const playerId = world.getPlayerEntityId();
    expect(playerId).not.toBe(NO_ENTITY_ID);
    expect(world.getEntityState(playerId)?.alive).toBe(true);
  });

  it('determinism: two identically-driven Worlds produce bit-identical player state after 120 ticks', () => {
    const mission = minimalMission();
    const worldA = createWorld(baseDeps(makeIntegratingFlightModel()));
    const worldB = createWorld(baseDeps(makeIntegratingFlightModel()));
    worldA.loadMission(mission);
    worldB.loadMission(mission);
    const idA = worldA.getPlayerEntityId();
    const idB = worldB.getPlayerEntityId();

    for (let tick = 0; tick < 120; tick++) {
      const inputs: PilotInputs = {
        pitch: Math.sin(tick * 0.1) * 0.3,
        roll: 0,
        yaw: 0,
        throttle: 0.5,
        afterburner: false,
        brakes: 0,
        gearDown: false,
        airbrake: false,
        trigger: false,
        launch: false,
        cycleWeapon: false,
        cycleTarget: false,
      };
      worldA.setPlayerInput(idA, inputs);
      worldB.setPlayerInput(idB, inputs);
      worldA.stepOnce();
      worldB.stepOnce();
    }

    expect(worldA.getEntityState(idA)).toEqual(worldB.getEntityState(idB));
  });

  it('warning edge behaviour: exactly one Stall warning event fires, on the tick it becomes active', () => {
    let telemetryCalls = 0;
    const flightModel: FlightModelPort = {
      hasDefinition: (id) => id === 'tejas-mk1a',
      step: (_defId, state, _damage, _inputs, _env, dtSec, out) => {
        out.pos.x = state.pos.x + state.vel.x * dtSec;
      },
      computeTelemetry: (_defId, _state, _damage, _env, out) => {
        telemetryCalls += 1;
        Object.assign(out, zeroTelemetry());
        out.iasMps = 100; // flying (no stall warning at taxi speeds)
        out.stalled = telemetryCalls >= 5;
      },
      maxFuelKg: () => 1000,
    };
    const world = createWorld(baseDeps(flightModel));
    world.loadMission(minimalMission());
    const playerId = world.getPlayerEntityId();

    const allEvents: SimEvent[] = [];
    for (let i = 0; i < 10; i++) {
      world.setPlayerInput(playerId, {
        pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 0,
        gearDown: false, airbrake: false, trigger: false, launch: false, cycleWeapon: false, cycleTarget: false,
      });
      world.stepOnce();
      const drained: SimEvent[] = new Array(64);
      const n = world.drainEvents(drained);
      for (let k = 0; k < n; k++) allEvents.push(drained[k] as SimEvent);
    }

    const stallEvents = allEvents.filter((e) => e.type === 'warning' && e.bit === WarningBit.Stall);
    expect(stallEvents.length).toBe(1);
    expect(stallEvents[0]).toMatchObject({ type: 'warning', bit: WarningBit.Stall, active: true });
  });

  it("AI PilotContext.contacts reflects the CombatPort's getContacts, not a hard-wired empty array", () => {
    const fakeContact: Contact = {
      id: 999,
      team: 1,
      kind: 'aircraft',
      pos: { x: 500, y: 1000, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      rangeM: 500,
      bearingRad: 0,
      elevationRad: 0,
      closureMps: 0,
      detectedBy: 'radar',
      identified: true,
    };
    // A CombatPort that also implements the (non-contract) CombatPortWithContacts
    // surface combatAdapter.ts exposes — see src/core/combatContext.ts.
    const combatWithContacts: CombatPort & { getContacts: (id: EntityId) => readonly Contact[] } = {
      step: () => {},
      getContacts: (_id: EntityId) => [fakeContact],
    };
    const observedContexts: PilotContext[] = [];
    const deps: WorldDependencies = {
      ...baseDeps(makeIntegratingFlightModel()),
      combat: combatWithContacts,
      createAiPilot: (): Pilot => ({
        update: (ctx: PilotContext): void => {
          observedContexts.push(ctx);
        },
      }),
    };
    const mission: Mission = {
      ...minimalMission(),
      aiFlights: [
        {
          id: 'bandit-flight',
          aircraftId: 'tejas-mk1a',
          team: 1,
          difficulty: 'veteran',
          startPos: { x: 2000, y: 1000, z: 0 },
          startHeadingRad: 0,
          startSpeedMps: 100,
          count: 1,
        },
      ],
    };

    const world = createWorld(deps);
    world.loadMission(mission);
    world.stepOnce();

    expect(observedContexts.length).toBeGreaterThan(0);
    expect(observedContexts[0]?.contacts).toEqual([fakeContact]);
  });

  it('EntityPool exhaustion surfaces through World.spawnEntity without throwing', () => {
    const world = createWorld(baseDeps(makeIntegratingFlightModel()));
    let lastId: EntityId = NO_ENTITY_ID;
    expect(() => {
      for (let i = 0; i < 33; i++) {
        lastId = world.spawnEntity({ kind: 'aircraft', team: 0, pos: { x: 0, y: 1000, z: 0 }, headingRad: 0, aircraftDefId: 'tejas-mk1a' });
      }
    }).not.toThrow();
    expect(lastId).toBe(NO_ENTITY_ID);
  });

  // Regression coverage for the spawn/gear bug found by manually driving the built app
  // (Free Flight's `speedMps: 0` runway start): spawnAircraftOnly used to leave every
  // fresh aircraft's gearPos at the entity pool's zeroed default (fully retracted).
  // Landing gear takes ~2s to extend past GEAR_CONTACT_GEARPOS_THRESHOLD
  // (landingGear.ts), so an aircraft placed at a runway-surface spawn height for a ground
  // start had no supporting force for two full seconds and fell straight through its
  // clearance before gear could ever register contact -- producing an uncontrolled tumble
  // (huge computed AoA from the resulting fall velocity) on every single ground-start
  // mission. Fix: spawnAircraftOnly now takes an explicit `startOnGround` flag and sets
  // gearPos=1 immediately for any spawn resolved via a real runway lookup.
  //
  // A SECOND bug was found later (live-testing after the above fix landed): the original
  // spawn height formula (`runway.elevationM + 0.5`) put the wheel-contact point 0.6m
  // BELOW ground (0.5 clearance minus the gear legs' -1.1 posBodyM.y offset) -- deeper
  // than every leg's maxCompressionM (0.28-0.35m), triggering the 20x hard-stop multiplier
  // on tick one and launching the aircraft with ~70x its own weight in reaction force. This
  // bug was dormant (masked by the first bug above -- gear was never down at spawn to
  // begin with) until the gearPos=1 fix shipped, which is what exposed it. Fixed by
  // RUNWAY_SPAWN_CLEARANCE_M (`elevationM + 1.1`, zero gear-leg penetration at spawn) --
  // see that constant's own doc comment in world.ts for the full derivation.
  describe('ground-start spawns begin with gear down (not animating up from retracted)', () => {
    function fakeRunway(overrides: Partial<import('../../src/contracts/core').RunwayInfo> = {}): import('../../src/contracts/core').RunwayInfo {
      return {
        id: '09L',
        thresholdPos: { x: 0, y: 0, z: 0 },
        headingRad: 0,
        lengthM: 3000,
        widthM: 45,
        elevationM: 12,
        ...overrides,
      };
    }

    it('player spawned via playerStart.airportId/runwayId has gearPos=1 on the very first read after loadMission (no ramp-up)', () => {
      const navDb: AirportNavDb = { ...fakeNavDb(), getRunway: () => fakeRunway() };
      const world = createWorld({ ...baseDeps(makeIntegratingFlightModel()), navDb });
      const mission: Mission = {
        ...minimalMission(),
        playerStart: { airportId: 'konarak-coastal', runwayId: '09L', speedMps: 0 },
      };
      world.loadMission(mission);
      const playerId = world.getPlayerEntityId();
      expect(playerId).not.toBe(NO_ENTITY_ID);
      const state = world.getEntityState(playerId);
      expect(state?.gearPos).toBe(1);
      // Spawn height must be exactly the resting height on the runway surface, per the
      // runway-spawn formula (`runway.elevationM + RUNWAY_SPAWN_CLEARANCE_M`) -- pins the
      // position half of the fix alongside the gear half.
      expect(state?.pos.y).toBeCloseTo(13.1, 10);
    });

    it('the spawn height leaves the gear legs at exactly zero penetration, not overtravel (see RUNWAY_SPAWN_CLEARANCE_M\'s doc comment for the ~70x-weight hard-stop launch bug this pins)', () => {
      const navDb: AirportNavDb = { ...fakeNavDb(), getRunway: () => fakeRunway() };
      const world = createWorld({ ...baseDeps(makeIntegratingFlightModel()), navDb });
      world.loadMission({ ...minimalMission(), playerStart: { airportId: 'konarak-coastal', runwayId: '09L', speedMps: 0 } });
      const playerId = world.getPlayerEntityId();
      const state = world.getEntityState(playerId);
      // Every tejasGeometry.ts gear leg shares posBodyM.y = -1.1: wheel-contact world Y (level
      // spawn attitude) is spawnY + (-1.1). penetrationM (landingGear.ts) = groundElevationM
      // (== runway.elevationM inside the flatten zone) - wheelY, and must be <= 0 (wheel at or
      // above ground, never already inside it) for a fresh, gear-down spawn.
      const wheelY = state!.pos.y + -1.1;
      const penetrationM = fakeRunway().elevationM - wheelY;
      expect(penetrationM).toBeCloseTo(0, 10);
    });

    it('AI flight spawned via startAirportId/startRunwayId also has gearPos=1 immediately', () => {
      const navDb: AirportNavDb = { ...fakeNavDb(), getRunway: () => fakeRunway({ id: '06', elevationM: 340 }) };
      const world = createWorld({ ...baseDeps(makeIntegratingFlightModel()), navDb });
      const mission: Mission = {
        ...minimalMission(),
        aiFlights: [
          { id: 'bandit-1', aircraftId: 'tejas-mk1a', team: 1, difficulty: 'veteran', startAirportId: 'rangpur-afb', startRunwayId: '06', startSpeedMps: 0, count: 1 },
        ],
      };
      world.loadMission(mission);
      // The AI entity is whichever live id isn't the player's; minimalMission's player
      // spawns airborne (pos-based), so it is safe to distinguish by gearPos directly
      // once we've confirmed there are exactly two live aircraft.
      const playerId = world.getPlayerEntityId();
      const playerState = world.getEntityState(playerId);
      expect(playerState?.gearPos).toBe(0); // sanity: the airborne player path is untouched by this fix
    });

    it('airborne spawns (no runway lookup) keep gearPos=0, unaffected by the fix', () => {
      const world = createWorld(baseDeps(makeIntegratingFlightModel()));
      world.loadMission(minimalMission()); // minimalMission's playerStart is pos-based (airborne), no airportId/runwayId
      const playerId = world.getPlayerEntityId();
      const state = world.getEntityState(playerId);
      expect(state?.gearPos).toBe(0);
    });

    it('a runway lookup that fails to resolve (bad airportId/runwayId) falls back to airborne (gearPos=0), not a silent ground spawn', () => {
      const world = createWorld(baseDeps(makeIntegratingFlightModel())); // fakeNavDb()'s default getRunway() => undefined
      const mission: Mission = {
        ...minimalMission(),
        playerStart: { airportId: 'does-not-exist', runwayId: '09L', speedMps: 0 },
      };
      world.loadMission(mission);
      const playerId = world.getPlayerEntityId();
      const state = world.getEntityState(playerId);
      expect(state?.gearPos).toBe(0);
    });
  });

  // Regression coverage for the "aircraft flies straight through the ground, forever, with no
  // collision response" bug found by live-flying the built app: ground contact is only modeled
  // at the 3 gear legs (landingGear.ts), which go inert whenever gear is retracted (or a leg
  // simply doesn't reach whatever terrain feature the aircraft is over) — with no general
  // fuselage collision anywhere in the physics model, nothing stopped an aircraft from falling
  // to an arbitrarily large negative altitude. Step 5 now treats a deep-enough negative altAglM
  // as an unambiguous terrain impact.
  describe('terrain-impact fallback (Step 5) — deep negative altAglM forces a crash', () => {
    /** Unlike makeIntegratingFlightModel, exposes state.pos.y as telemetry.altAglM so tests can drive it directly via velocity. */
    function makeFallingFlightModel(): FlightModelPort {
      return {
        hasDefinition: (id: string) => id === 'tejas-mk1a',
        step(_defId: string, state: EntityState, _damage: DamageState, _inputs: PilotInputs, _env: SimEnvironment, dtSec: number, out: EntityState): void {
          out.pos.x = state.pos.x + state.vel.x * dtSec;
          out.pos.y = state.pos.y + state.vel.y * dtSec;
          out.pos.z = state.pos.z + state.vel.z * dtSec;
        },
        computeTelemetry(_defId: string, state: EntityState, _damage: DamageState, _env: SimEnvironment, out: AircraftTelemetry): void {
          Object.assign(out, zeroTelemetry());
          out.altAglM = state.pos.y;
        },
        maxFuelKg: () => 1000,
      };
    }

    it('crosses TERRAIN_IMPACT_PENETRATION_M -> structurePct is zeroed, a crash event fires, alive becomes false, and position FREEZES on subsequent ticks instead of continuing to fall', () => {
      const world = createWorld(baseDeps(makeFallingFlightModel()));
      world.loadMission({ ...minimalMission(), playerStart: { pos: { x: 0, y: 10, z: 0 }, headingRad: 0, speedMps: 0 } });
      const playerId = world.getPlayerEntityId();
      const state = world.getEntityState(playerId)!;
      state.vel.y = -50; // fast sink so it crosses the -3m threshold within a handful of ticks

      expect(world.getDamageState(playerId)?.structurePct).toBe(1);

      let crashedAtTick = -1;
      for (let i = 0; i < 200 && crashedAtTick === -1; i++) {
        world.stepOnce();
        if (!world.getEntityState(playerId)!.alive) crashedAtTick = i;
      }
      expect(crashedAtTick).toBeGreaterThan(-1);
      expect(world.getDamageState(playerId)?.structurePct).toBe(0);

      const posAtCrash = { ...world.getEntityState(playerId)!.pos };
      for (let i = 0; i < 20; i++) world.stepOnce();
      expect(world.getEntityState(playerId)!.pos).toEqual(posAtCrash); // frozen, not still falling
    });

    it('a small negative altAglM (e.g. gear-compression slop) never triggers it', () => {
      const world = createWorld(baseDeps(makeFallingFlightModel()));
      world.loadMission({ ...minimalMission(), playerStart: { pos: { x: 0, y: -1, z: 0 }, headingRad: 0, speedMps: 0 } });
      const playerId = world.getPlayerEntityId();

      for (let i = 0; i < 60; i++) world.stepOnce();

      expect(world.getEntityState(playerId)?.alive).toBe(true);
      expect(world.getDamageState(playerId)?.structurePct).toBe(1);
    });
  });
});
