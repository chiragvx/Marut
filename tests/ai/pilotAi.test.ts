import { describe, it, expect } from 'vitest';
import type { Contact, PilotContext, PilotInputs } from '../../src/contracts/core';
import { AiDifficultyProfiles } from '../../src/contracts/ai';
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

function baseCtx(tick: number, contacts: readonly Contact[], groundY: number): PilotContext {
  const simTimeSec = tick / 120;
  return {
    self: {
      id: 1,
      kind: 'aircraft',
      team: 0,
      pos: { x: 0, y: 3000, z: 0 },
      rot: { x: 0, y: 0, z: 0, w: 1 },
      vel: { x: 0, y: 0, z: -200 },
      omega: { x: 0, y: 0, z: 0 },
      alive: true,
      hp: 100,
      fuelKg: 1000,
      elevonL: 0,
      elevonR: 0,
      rudder: 0,
      gearPos: 0,
      throttle: 0.5,
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
      altMslM: 3000,
      altAglM: 3000 - groundY,
      alphaRad: 0,
      betaRad: 0,
      gLoad: 1,
      headingRad: Math.PI,
      pitchRad: 0,
      rollRad: 0,
      vspeedMps: 0,
      fuelKg: 1000,
      fuelFrac: 0.7,
      thrustFrac: 0.7,
      onGround: false,
      stalled: false,
    },
    contacts,
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
    sampler: { seed: 1, heightAt: () => groundY, normalAt: (_x, _z, out) => ({ ...out, x: 0, y: 1, z: 0 }) },
    navDb: { getAirport: () => undefined, listAirports: () => [], nearestAirport: () => undefined, getRunway: () => undefined },
    windWorldMps: { x: 0, y: 0, z: 0 },
    simTimeSec,
  };
}

describe('AiPilot determinism', () => {
  it('two identically-seeded pilots produce bit-identical PilotInputs and tacticalState over 500 ticks', () => {
    const pilotA = createAiPilot({ aircraftDefId: 'tejas', team: 0, difficulty: 'veteran', seed: 7 });
    const pilotB = createAiPilot({ aircraftDefId: 'tejas', team: 0, difficulty: 'veteran', seed: 7 });
    const outA = makeOut();
    const outB = makeOut();
    const statesA: string[] = [];
    const statesB: string[] = [];
    const inputsA: PilotInputs[] = [];
    const inputsB: PilotInputs[] = [];

    for (let tick = 0; tick < 500; tick++) {
      const t = tick / 120;
      const contact: Contact = {
        id: 5,
        team: 1,
        kind: 'aircraft',
        pos: { x: Math.sin(t * 0.3) * 1500, y: 3000, z: -8000 + t * 60 },
        vel: { x: 0, y: 0, z: 60 },
        rangeM: Math.max(100, 8000 - t * 60),
        bearingRad: 0.1,
        elevationRad: 0,
        closureMps: 60,
        detectedBy: 'radar',
        identified: true,
      };
      pilotA.update(baseCtx(tick, [contact], -10000), 1 / 120, outA);
      pilotB.update(baseCtx(tick, [contact], -10000), 1 / 120, outB);
      statesA.push(pilotA.debug.tacticalState);
      statesB.push(pilotB.debug.tacticalState);
      inputsA.push({ ...outA });
      inputsB.push({ ...outB });
    }

    expect(statesA).toEqual(statesB);
    expect(inputsA).toEqual(inputsB);
  });
});

describe('AiPilot reaction delay', () => {
  it('does not react to a newly-identified hostile until roughly reactionDelaySec has elapsed', () => {
    const pilot = createAiPilot({ aircraftDefId: 'tejas', team: 0, difficulty: 'veteran', seed: 3 });
    const out = makeOut();
    const appearTick = 200; // simTimeSec = 200/120 ~= 1.667s
    let firstAffectedTick: number | undefined;

    for (let tick = 0; tick < 400; tick++) {
      const contacts: Contact[] =
        tick >= appearTick
          ? [
              {
                id: 9,
                team: 1,
                kind: 'aircraft',
                pos: { x: 0, y: 3000, z: -3000 },
                vel: { x: 0, y: 0, z: 60 },
                rangeM: 3000,
                bearingRad: 0,
                elevationRad: 0,
                closureMps: 60,
                detectedBy: 'radar',
                identified: true,
              },
            ]
          : [];
      pilot.update(baseCtx(tick, contacts, -10000), 1 / 120, out);
      if (firstAffectedTick === undefined && pilot.debug.targetId === 9) {
        firstAffectedTick = tick;
      }
    }

    expect(firstAffectedTick).toBeDefined();
    const delaySec = (firstAffectedTick! - appearTick) / 120;
    const profile = AiDifficultyProfiles.veteran;
    expect(delaySec).toBeGreaterThanOrEqual(profile.reactionDelaySec - 0.01);
    expect(delaySec).toBeLessThanOrEqual(profile.reactionDelaySec + 3 * profile.reactionJitterStdSec + 0.05);
  });
});

describe('AiPilot terrain-avoidance precedence', () => {
  it('overrides the tactical goal whenever terrain clearance breaches the hard minimum', () => {
    const pilot = createAiPilot({ aircraftDefId: 'tejas', team: 0, difficulty: 'veteran', seed: 11 });
    const out = makeOut();
    // Ground 40m below self.pos.y (3000) -> clearance 40m < HARD_MIN_CLEARANCE_M(60).
    pilot.update(baseCtx(0, [], 3000 - 40), 1 / 120, out);
    expect(pilot.debug.desiredBankRad).toBe(0);
    expect(pilot.debug.desiredGLoad).toBe(AiDifficultyProfiles.veteran.maxCommandedGLoad);
  });
});

describe('AiPilot robustness', () => {
  it('never emits NaN/non-finite/undefined fields over 2000 varied ticks', () => {
    const pilot = createAiPilot({ aircraftDefId: 'tejas', team: 0, difficulty: 'ace', seed: 99 });
    const out = makeOut();

    for (let tick = 0; tick < 2000; tick++) {
      const t = tick / 120;
      const hasContact = Math.floor(t) % 3 === 0;
      const contacts: Contact[] = hasContact
        ? [
            {
              id: 7,
              team: 1,
              kind: 'aircraft',
              pos: { x: Math.sin(t) * 4000, y: 2000 + Math.cos(t * 0.5) * 1000, z: -6000 + Math.sin(t * 0.2) * 3000 },
              vel: { x: Math.cos(t) * 50, y: 0, z: 50 + Math.sin(t) * 20 },
              rangeM: 1000 + Math.abs(Math.sin(t)) * 8000,
              bearingRad: Math.sin(t * 0.7) * Math.PI,
              elevationRad: Math.cos(t * 0.3) * 0.3,
              closureMps: Math.sin(t * 0.4) * 150,
              detectedBy: 'radar',
              identified: true,
            },
          ]
        : [];
      const altitude = 2000 + Math.sin(t * 0.1) * 500;
      const ctx = baseCtx(tick, contacts, altitude - 3000 - Math.sin(t * 0.05) * 200);
      pilot.update(ctx, 1 / 120, out);

      for (const key of Object.keys(out) as (keyof PilotInputs)[]) {
        const value = out[key];
        if (typeof value === 'number') {
          expect(Number.isFinite(value)).toBe(true);
        } else if (value !== undefined) {
          expect(typeof value).toBe('boolean');
        }
      }
      expect(Number.isFinite(pilot.debug.desiredBankRad)).toBe(true);
      expect(Number.isFinite(pilot.debug.desiredGLoad)).toBe(true);
      expect(Number.isFinite(pilot.debug.desiredAltitudeM)).toBe(true);
      expect(Number.isFinite(pilot.debug.desiredSpeedMps)).toBe(true);
    }
  });
});
