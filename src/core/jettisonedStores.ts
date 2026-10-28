/**
 * src/core/jettisonedStores.ts — stores that leave an aircraft without being weapons (drop tanks
 * on jettison): each becomes an 'effect' entity flown as a rigid body (src/physics/storeBody.ts)
 * until it reaches the ground or water, where a 'storeImpact' event is raised for the renderer.
 *
 * Effect entities are invisible to the rest of the sim: radar, seekers and hit tests only look at
 * aircraft (and ground units), so a falling tank is never a contact, a target or a decoy.
 *
 * Release: the store starts at its own centre (below the pylon, where the renderer hangs it) with
 * the aircraft's velocity at that point (v + w x r), the ejector's push straight down off the rack
 * and a nose-down pitch kick, each varied a little per store (seeded, reproducible). From there
 * on everything comes from the store's own aerodynamics: a full tank is heavy and falls nose-down
 * with a slow wobble; an empty one is light and tumbles.
 */
import type { EntityId, EntityState, HeightSampler, Vec3Like } from '../contracts/core';
import { EntityKind, NO_ENTITY_ID, STORE_IDS } from '../contracts/core';
import type { EntityPool, EventQueue } from '../contracts/sim';
import type { StationDef } from '../contracts/aircraft';
import { FUEL_TANKS } from '../catalog';
import { createPrng, nextRange, Quat, Vec3 } from '../math';
import { stepStoreBody, type StoreBodyParams } from '../physics';
import { isaAtmosphereInto } from './atmosphere';

/** Ejector push off the rack, m/s (body down), and its nose-down pitch kick, rad/s. */
export const JETTISON_EJECT_MPS = 3;
export const JETTISON_PITCH_KICK_RAD_S = 0.8;
/** A store still falling after this long is removed (it has long since landed somewhere). */
const MAX_FALL_SEC = 120;
/** The render mount's gap between the pylon and the store's top, m (stores.ts tank mount). */
const PYLON_GAP_M = 0.03;

/**
 * A drop tank's aerodynamics: a streamlined finless body. Its potential lift acts ahead of the CG
 * (cpOffsetM 5 % of its length, mirrored when tail-first), so it is mildly unstable both ways and
 * crossflow drag and rate damping are what keep a tumble from running away.
 */
const TANK_AERO = { cdAxial: 0.12, cnAlpha: 2, cdCrossflow: 1.2, cpOffsetFrac: 0.05, cmq: 4, clp: 0.5 } as const;

interface Falling {
  id: EntityId;
  params: StoreBodyParams;
  fuelKg: number;
  ageSec: number;
}

export interface JettisonEnv {
  windWorldMps: Readonly<Vec3Like>;
  gravityMps2: number;
}

export class JettisonedStores {
  private readonly falling: Falling[] = [];
  private readonly atm = { airDensityKgM3: 1.225, soundSpeedMps: 340.29 };
  private readonly env = { densityKgM3: 1.225, windWorldMps: { x: 0, y: 0, z: 0 } as Vec3Like, gravityMps2: 9.80665 };
  private readonly rBody = { x: 0, y: 0, z: 0 };
  private readonly scratchA = { x: 0, y: 0, z: 0 };
  private readonly scratchB = { x: 0, y: 0, z: 0 };

  get count(): number {
    return this.falling.length;
  }

  clear(): void {
    this.falling.length = 0;
  }

  /**
   * Drops the tanks `aircraft` carried: one per tank station, the fuel left (`fuelKgTotal`) shared
   * equally. `seed` makes the per-store variation reproducible.
   */
  releaseTanks(pool: EntityPool, aircraft: Readonly<EntityState>, stations: readonly { station: StationDef; storeId: string }[], fuelKgTotal: number, seed: number): void {
    const tanks = stations.filter((s) => FUEL_TANKS[s.storeId]);
    if (tanks.length === 0) return;
    const prng = createPrng(seed);
    const fuelEach = Math.max(0, fuelKgTotal) / tanks.length;
    for (const { station, storeId } of tanks) {
      const t = FUEL_TANKS[storeId]!;
      const id = pool.allocate(EntityKind.Effect, aircraft.team);
      if (id === NO_ENTITY_ID) return;
      const s = pool.get(id);
      if (!s) return;
      const L = t.lengthM;
      const d = t.diameterM;
      // The tank's centre in the aircraft's body frame, and its velocity there (v + w x r).
      this.rBody.x = station.posBodyM.x;
      this.rBody.y = station.posBodyM.y - (PYLON_GAP_M + d / 2);
      this.rBody.z = station.posBodyM.z;
      Quat.rotate(aircraft.rot, this.rBody, this.scratchA);
      s.pos.x = aircraft.pos.x + this.scratchA.x;
      s.pos.y = aircraft.pos.y + this.scratchA.y;
      s.pos.z = aircraft.pos.z + this.scratchA.z;
      Vec3.cross(aircraft.omega, this.rBody, this.scratchB);
      this.scratchB.y -= JETTISON_EJECT_MPS * nextRange(prng, 0.85, 1.15);
      Quat.rotate(aircraft.rot, this.scratchB, this.scratchA);
      s.vel.x = aircraft.vel.x + this.scratchA.x;
      s.vel.y = aircraft.vel.y + this.scratchA.y;
      s.vel.z = aircraft.vel.z + this.scratchA.z;
      Quat.copy(s.rot, aircraft.rot);
      s.omega.x = aircraft.omega.x + nextRange(prng, -0.3, 0.3);
      s.omega.y = aircraft.omega.y + nextRange(prng, -0.15, 0.15);
      s.omega.z = aircraft.omega.z - JETTISON_PITCH_KICK_RAD_S * nextRange(prng, 0.8, 1.2);
      s.stores = Math.max(0, STORE_IDS.indexOf(storeId));
      s.fuelKg = fuelEach;
      this.falling.push({
        id,
        fuelKg: fuelEach,
        ageSec: 0,
        params: {
          massKg: t.emptyMassKg + fuelEach,
          lengthM: L,
          diameterM: d,
          cdAxial: TANK_AERO.cdAxial,
          cnAlpha: TANK_AERO.cnAlpha,
          cdCrossflow: TANK_AERO.cdCrossflow,
          cpOffsetM: TANK_AERO.cpOffsetFrac * L,
          cpFixed: false,
          crossflowArmM: 0,
          cmq: TANK_AERO.cmq,
          clp: TANK_AERO.clp,
        },
      });
    }
  }

  /** Flies every falling store one tick; lands (and removes) those that reach the surface. */
  step(dtSec: number, pool: EntityPool, sampler: HeightSampler, env: Readonly<JettisonEnv>, events: EventQueue): void {
    this.env.windWorldMps = env.windWorldMps;
    this.env.gravityMps2 = env.gravityMps2;
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i]!;
      const s = pool.get(f.id);
      if (!s || !s.alive) {
        this.falling.splice(i, 1);
        continue;
      }
      f.ageSec += dtSec;
      isaAtmosphereInto(s.pos.y, this.atm);
      this.env.densityKgM3 = this.atm.airDensityKgM3;
      stepStoreBody(s, f.params, this.env, dtSec);
      const surfaceY = sampler.heightAt(s.pos.x, s.pos.z);
      if (s.pos.y - f.params.diameterM / 2 <= surfaceY) {
        events.push({
          type: 'storeImpact',
          pos: { x: s.pos.x, y: surfaceY, z: s.pos.z },
          massKg: f.params.massKg,
          fuelKg: f.fuelKg,
          speedMps: Math.hypot(s.vel.x, s.vel.y, s.vel.z),
          water: sampler.isWaterAt?.(s.pos.x, s.pos.z) ?? false,
        });
        pool.release(f.id);
        this.falling.splice(i, 1);
      } else if (f.ageSec > MAX_FALL_SEC) {
        pool.release(f.id);
        this.falling.splice(i, 1);
      }
    }
  }
}
