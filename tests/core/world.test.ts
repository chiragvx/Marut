import { describe, expect, it } from 'vitest';
import { createWorld } from '../../src/core/world';
import { NO_ENTITY_ID, WarningBit } from '../../src/contracts/core';
import type {
  AircraftTelemetry,
  AirportNavDb,
  DamageState,
  EntityId,
  EntityState,
  HeightSampler,
  Mission,
  Pilot,
  PilotInputs,
  SimEvent,
  Vec3Like,
} from '../../src/contracts/core';
import type { FlightModelPort, SimEnvironment, WorldDependencies } from '../../src/contracts/sim';

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
    hasDefinition: (id: string) => id === 'tejas-mk1',
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
      hasDefinition: (id) => id === 'tejas-mk1',
      step: (_defId, state, _damage, _inputs, _env, dtSec, out) => {
        out.pos.x = state.pos.x + state.vel.x * dtSec;
      },
      computeTelemetry: (_defId, _state, _damage, _env, out) => {
        telemetryCalls += 1;
        Object.assign(out, zeroTelemetry());
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

  it('EntityPool exhaustion surfaces through World.spawnEntity without throwing', () => {
    const world = createWorld(baseDeps(makeIntegratingFlightModel()));
    let lastId: EntityId = NO_ENTITY_ID;
    expect(() => {
      for (let i = 0; i < 33; i++) {
        lastId = world.spawnEntity({ kind: 'aircraft', team: 0, pos: { x: 0, y: 1000, z: 0 }, headingRad: 0, aircraftDefId: 'tejas-mk1' });
      }
    }).not.toThrow();
    expect(lastId).toBe(NO_ENTITY_ID);
  });
});
