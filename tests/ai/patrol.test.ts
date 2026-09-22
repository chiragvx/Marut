import { describe, it, expect } from 'vitest';
import type { PilotContext, PilotInputs } from '../../src/contracts/core';
import { createAiPilot } from '../../src/ai/pilotAi';

function makeOut(): PilotInputs {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0,
    afterburner: false,
    brakes: 0,
    gearDown: false,
    airbrake: false,
    trigger: false,
    launch: false,
    cycleWeapon: false,
    cycleTarget: false,
  };
}

// Mirrors src/core/missions/dogfight1v1.json's `bandit-1` AI flight: a solo
// AI with no patrolCenterWorld/patrolRadiusM set at all (06-ai.md section
// 5.7's own note: allowed unless every non-leader flight member has a
// formation slot). State mutates in place across `update()` calls exactly
// like the real sim worker's integration loop.
function baseCtx(tick: number, pos: { x: number; y: number; z: number }, headingRad: number): PilotContext {
  const simTimeSec = tick / 120;
  return {
    self: {
      id: 1,
      kind: 'aircraft',
      team: 1,
      pos,
      rot: { x: 0, y: 0, z: 0, w: 1 },
      vel: { x: 200 * Math.sin(headingRad), y: 0, z: -200 * Math.cos(headingRad) },
      omega: { x: 0, y: 0, z: 0 },
      alive: true,
      hp: 100,
      fuelKg: 2000,
      elevonL: 0,
      elevonR: 0,
      rudder: 0,
      gearPos: 0,
      throttle: 0.6,
      afterburnerOn: false,
      flags: 0,
    },
    selfDamage: {
      structurePct: 1,
      engineHealthPct: 1,
      controlSurfaces: { elevonL: 1, elevonR: 1, rudder: 1 },
      hydraulicsOk: true,
      fuelLeak: false,
      radarHealthPct: 1,
      gearHealthPct: 1,
    },
    telemetry: {
      iasMps: 200,
      tasMps: 200,
      mach: 0.6,
      altMslM: pos.y,
      altAglM: pos.y + 10000,
      alphaRad: 0.02,
      betaRad: 0,
      gLoad: 1,
      headingRad,
      pitchRad: 0,
      rollRad: 0,
      vspeedMps: 0,
      fuelKg: 2000,
      fuelFrac: 0.9,
      thrustFrac: 0.6,
      onGround: false,
      stalled: false,
    },
    contacts: [],
    combat: {
      selectedWeapon: 'gun',
      ammoGun: 200,
      missilesIr: 2,
      missilesRadar: 2,
      lockState: 'none',
      lockedTargetId: undefined,
      rwrWarning: false,
      missileInboundWarning: false,
      aimPointWorld: { x: 0, y: 0, z: 0 },
      aimPointValid: false,
    },
    // Flat terrain far below: never triggers terrainAvoidance's override, so
    // this test isolates the patrol-anchor behaviour.
    sampler: { seed: 1, heightAt: () => -10000, normalAt: (_x, _z, out) => ({ ...out, x: 0, y: 1, z: 0 }) },
    navDb: { getAirport: () => undefined, listAirports: () => [], nearestAirport: () => undefined, getRunway: () => undefined },
    windWorldMps: { x: 0, y: 0, z: 0 },
    simTimeSec,
  };
}

describe('AiPilot patrol anchor (no patrolCenterWorld set)', () => {
  it('freezes the patrol anchor at first Patrol entry instead of re-deriving it from the aircraft\'s own moving position every tick', () => {
    const pilot = createAiPilot({ aircraftDefId: 'tejas-mk1', team: 1, difficulty: 'veteran', seed: 42 });
    const out = makeOut();

    // Integrate a trivial kinematic model driven by the AI's own commanded
    // bank/pitch so we can observe whether the flight path actually
    // converges toward a fixed circle (fix) or diverges/dives (bug).
    let x = 8000;
    let y = 4500;
    let z = -6000;
    let headingRad = Math.PI;

    const altitudeSamples: number[] = [];
    for (let tick = 0; tick < 6000; tick++) {
      // 50 s
      const ctx = baseCtx(tick, { x, y, z }, headingRad);
      pilot.update(ctx, 1 / 120, out);

      // Very rough kinematic integration: heading turns proportional to
      // commanded roll, altitude responds to commanded pitch. This is only
      // meant to detect divergence, not to be flight-accurate.
      headingRad += out.roll * 0.01 * (1 / 120);
      y += out.pitch * 15 * (1 / 120);
      x += 200 * Math.sin(headingRad) * (1 / 120);
      z += -200 * Math.cos(headingRad) * (1 / 120);
      if (tick % 120 === 0) altitudeSamples.push(y);
    }

    expect(pilot.debug.tacticalState).toBe('patrol');

    // With the bug (center re-derived as ctx.self.pos every tick),
    // desiredAltitudeM = currentAltitude + 2000 every tick, permanently
    // saturating the altitude-hold loop's climb clamp: altitude runs away
    // upward without bound over 50s. With the fix, the anchor (and its
    // resulting desiredAltitudeM = anchorY + 2000) is captured once, so
    // altitude converges and stays bounded near anchorY + 2000 (4500+2000).
    const finalAltitude = altitudeSamples[altitudeSamples.length - 1]!;
    expect(Number.isFinite(finalAltitude)).toBe(true);
    expect(finalAltitude).toBeLessThan(9000); // well below the runaway the bug produced
    expect(finalAltitude).toBeGreaterThan(3000);

    // Desired altitude itself (debug state) must stay pinned near the frozen
    // anchor's target, not drift with the aircraft's own current altitude.
    expect(pilot.debug.desiredAltitudeM).toBeGreaterThan(6000);
    expect(pilot.debug.desiredAltitudeM).toBeLessThan(7000);
  });

  it('re-captures a fresh anchor only when Patrol is re-entered from a different state, not on every tick while still in Patrol', () => {
    const pilot = createAiPilot({ aircraftDefId: 'tejas-mk1', team: 1, difficulty: 'veteran', seed: 5 });
    const out = makeOut();

    const ctx1 = baseCtx(0, { x: 1000, y: 5000, z: 0 }, 0);
    pilot.update(ctx1, 1 / 120, out);
    const firstDesiredAlt = pilot.debug.desiredAltitudeM;

    // Aircraft physically moves a long way (as it would over many ticks),
    // but tacticalState stays 'patrol' throughout (no hostile contacts).
    const ctx2 = baseCtx(1, { x: 50000, y: 9000, z: 30000 }, 1.2);
    pilot.update(ctx2, 1 / 120, out);

    expect(pilot.debug.tacticalState).toBe('patrol');
    // The anchor (and thus the altitude-hold target) must NOT have jumped
    // to track the aircraft's new position — that would reproduce the bug.
    expect(pilot.debug.desiredAltitudeM).toBeCloseTo(firstDesiredAlt, 6);
  });
});
