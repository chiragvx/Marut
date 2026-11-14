/**
 * src/core/airdrop.ts — container delivery (CDS) off a transport's ramp: a release drops a stick of
 * bundles that leave the ramp one after another with the aircraft's velocity, fall free while the
 * static line pulls the canopy out of its bag, inflate, and come down under their parachutes,
 * drifting with the wind, until they reach the ground: an 'airdropLanded' event each (hit too hard:
 * destroyed). Each bundle is an Effect entity (store code 'cds-bundle'; EntityFlag.TailOpen once
 * its canopy is out) for the renderer; nothing else in the sim sees it.
 *
 * Simple physics [E], tuned to the published figures for the G-12 cargo parachute on an A-22
 * container (FM 4-20.103 class numbers): a 1 t load comes down at ~8.5 m/s at sea level, the canopy
 * is fully open ~5 s and ~75 m below the exit (the lines stretch, then it fills: drag grows as the cube
 * of the fill), so 150 m above the ground (500 ft) is a comfortable drop; below ~75 m the loads hit
 * before their canopies are open (fast enough to wreck them). The drift is the wind's (the
 * mission wind plus a gust per bundle). Release speed: 130-150 KIAS is normal; faster, the
 * canopies open unevenly (a random push, more scatter); past 200 KIAS some fail outright.
 */
import type { AirdropLoad, EntityId, EntityState, HeightSampler, Vec3Like } from '../contracts/core';
import { EntityFlag, EntityKind, NO_ENTITY_ID, STORE_IDS } from '../contracts/core';
import type { AirdropDefinition } from '../contracts/aircraft';
import type { EntityPool, EventQueue } from '../contracts/sim';
import { createPrng, nextFloat01, nextRange, Quat, type PrngState } from '../math';
import { isaAtmosphereInto } from './atmosphere';

const KT = 0.514444;

/** The CDS bundle and its parachute [E]. */
export const CDS = {
  /** Bundles leave the ramp this far apart (gravity roll-out down the rollers), s. */
  exitIntervalSec: 0.45,
  /** And this fast aft, relative to the aircraft, m/s. */
  exitAftMps: 4,
  /** Drag area of the falling container, m^2 (a 1.2 m cube, tumbling). */
  boxCdAM2: 1.6,
  /** Half its height, m (it lands when its bottom reaches the ground). */
  halfHeightM: 0.65,
  /** Static line: the canopy leaves its bag this long after the exit, s. */
  deployDelaySec: 1.6,
  /** And takes this long to fill, s. */
  inflateSec: 3.4,
  /** G-12D drag area, m^2: ~8.5 m/s with 1,000 kg at sea level. */
  canopyCdAM2: 222,
  /** A failed canopy (streamer) still drags this much, m^2. */
  streamerCdAM2: 12,
  /** Hitting the ground faster than this (vertically) wrecks the load, m/s. */
  maxImpactMps: 13,
  /** Above this release speed the canopies open unevenly, m/s IAS. */
  roughIasMps: 150 * KT,
  /** Above this they can fail, m/s IAS. */
  failIasMps: 200 * KT,
  /** Light reserve bundles, kg each (dropped once the rigged load is gone, MissionPlayerStart.airdrop.reserve). */
  reserveKg: 350,
  /** A bundle still falling after this long is removed. */
  maxFallSec: 180,
} as const;

/** The release envelope a crew flies (the cue the mission and the HUD give). */
export const AIRDROP_ENVELOPE = {
  minAglM: 100,
  idealAglM: 150,
  maxAglM: 300,
  minIasMps: 125 * KT,
  idealIasMps: 140 * KT,
  maxIasMps: 155 * KT,
} as const;

/** One aircraft's airdrop load. */
interface Hold {
  ownerId: EntityId;
  def: AirdropDefinition;
  bundlesLeft: number;
  bundleKg: number;
  stick: number;
  reserve: boolean;
  sticks: number;
  prevPressed: boolean;
  /** Bundles of the current stick still on the rollers, and when the next one goes. */
  queued: number;
  queuedIndex: number;
  queuedCount: number;
  queuedReserve: boolean;
  nextExitSec: number;
  stickId: number;
  /** The release conditions (they set the stick's scatter). */
  releaseIasMps: number;
}

interface Bundle {
  id: EntityId;
  ownerId: EntityId;
  stickId: number;
  index: number;
  count: number;
  massKg: number;
  ageSec: number;
  /** When its canopy leaves the bag and how long it takes to fill (varied per bundle). */
  deployAtSec: number;
  inflateSec: number;
  failed: boolean;
  headingRad: number;
  /** Its own gust (m/s, horizontal), a slow random walk. */
  gustX: number;
  gustZ: number;
  gustSigma: number;
  prng: PrngState;
}

export interface AirdropEnv {
  windWorldMps: Readonly<Vec3Like>;
  gravityMps2: number;
  /** The mission's gust magnitude, m/s (each bundle's own drift). */
  gustMps: number;
  simTimeSec: number;
  seed: number;
}

/** What the HUD shows for an aircraft's airdrop: bundles left and whether a release would drop now. */
export interface AirdropStatus {
  loaded: boolean;
  left: number;
  armed: boolean;
}

const predictAtm = { airDensityKgM3: 1.225, soundSpeedMps: 340.29 };

/**
 * Where a stick released now lands (no gusts, the nominal canopy): the centroid of `count` bundles
 * leaving `exitIntervalSec` apart from an aircraft at `pos` flying `vel`, over ground at `groundY`,
 * in `wind`. The mission's release cue (the CARP) and the drop's grade use it. Also returns the fall
 * time and how hard the bundles land (vertical, m/s).
 */
export function predictCdsDrop(
  pos: Readonly<Vec3Like>,
  vel: Readonly<Vec3Like>,
  groundY: number,
  wind: Readonly<Vec3Like>,
  count = 4,
  massKg = 1000,
  gravity = 9.80665
): { x: number; z: number; fallSec: number; sinkMps: number } {
  const dt = 0.05;
  const sp = Math.hypot(vel.x, vel.z) || 1;
  // The ramp sill is ~21 m behind the aircraft's reference point (c17Definition airdrop.exitBodyM) and 3 m down.
  let px = pos.x - (vel.x / sp) * 21;
  let py = pos.y - 3;
  let pz = pos.z - (vel.z / sp) * 21;
  let vx = vel.x - (vel.x / sp) * CDS.exitAftMps;
  let vy = vel.y - 0.5;
  let vz = vel.z - (vel.z / sp) * CDS.exitAftMps;
  let t = 0;
  while (py - CDS.halfHeightM > groundY && t < CDS.maxFallSec) {
    t += dt;
    const open = t <= CDS.deployDelaySec ? 0 : Math.min(1, (t - CDS.deployDelaySec) / CDS.inflateSec);
    isaAtmosphereInto(py, predictAtm);
    const kd = (0.5 * predictAtm.airDensityKgM3 * (CDS.boxCdAM2 + CDS.canopyCdAM2 * open * open * open)) / massKg;
    let rx = vx - wind.x;
    let ry = vy - wind.y;
    let rz = vz - wind.z;
    const damp = 1 / (1 + kd * Math.hypot(rx, ry, rz) * dt);
    rx *= damp;
    ry *= damp;
    rz *= damp;
    vx = rx + wind.x;
    vy = ry + wind.y - gravity * dt;
    vz = rz + wind.z;
    px += vx * dt;
    py += vy * dt;
    pz += vz * dt;
  }
  // The stick's middle bundle leaves (count - 1) / 2 intervals after the first.
  const lag = ((count - 1) / 2) * CDS.exitIntervalSec;
  return { x: px + vel.x * lag, z: pz + vel.z * lag, fallSec: t, sinkMps: -vy };
}

function gaussian(p: PrngState): number {
  const u = Math.max(1e-9, nextFloat01(p));
  const v = nextFloat01(p);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Airdrops {
  private readonly holds: Hold[] = [];
  private readonly falling: Bundle[] = [];
  private readonly atm = { airDensityKgM3: 1.225, soundSpeedMps: 340.29 };
  private readonly a = { x: 0, y: 0, z: 0 };
  private readonly b = { x: 0, y: 0, z: 0 };
  private readonly code = STORE_IDS.indexOf('cds-bundle');

  clear(): void {
    this.holds.length = 0;
    this.falling.length = 0;
  }

  get fallingCount(): number {
    return this.falling.length;
  }

  /** Rigs `load` in `ownerId`'s hold. */
  load(ownerId: EntityId, def: AirdropDefinition, load: AirdropLoad): void {
    this.holds.push({
      ownerId,
      def,
      bundlesLeft: Math.max(0, Math.floor(load.bundles)),
      bundleKg: Math.max(1, load.bundleKg),
      stick: Math.max(1, Math.floor(load.stick)),
      reserve: !!load.reserve,
      sticks: 0,
      prevPressed: false,
      queued: 0,
      queuedIndex: 0,
      queuedCount: 0,
      queuedReserve: false,
      nextExitSec: 0,
      stickId: 0,
      releaseIasMps: 0,
    });
  }

  status(ownerId: EntityId, state: Readonly<EntityState> | undefined, out: AirdropStatus): AirdropStatus {
    const h = this.holds.find((x) => x.ownerId === ownerId);
    out.loaded = !!h;
    out.left = h ? h.bundlesLeft + h.queued : 0;
    out.armed = !!h && !!state && (state.rampPos ?? 0) >= h.def.minRampPos && (h.bundlesLeft > 0 || h.queued > 0 || h.reserve);
    return out;
  }

  /**
   * The aircraft's release button this tick (level; a rising edge with the ramp open releases a
   * stick). `iasMps`/`aglM` describe the release (for the event and the scatter).
   */
  input(ownerId: EntityId, pressed: boolean, state: Readonly<EntityState>, iasMps: number, aglM: number, env: Readonly<AirdropEnv>, events: EventQueue): void {
    const h = this.holds.find((x) => x.ownerId === ownerId);
    if (!h) return;
    const edge = pressed && !h.prevPressed;
    h.prevPressed = pressed;
    if (!edge || !state.alive || h.queued > 0 || (state.rampPos ?? 0) < h.def.minRampPos) return;
    const reserve = h.bundlesLeft <= 0;
    if (reserve && !h.reserve) return;
    const count = reserve ? h.stick : Math.min(h.stick, h.bundlesLeft);
    if (!reserve) h.bundlesLeft -= count;
    h.sticks += 1;
    h.stickId = h.sticks;
    h.queued = count;
    h.queuedIndex = 0;
    h.queuedCount = count;
    h.queuedReserve = reserve;
    h.nextExitSec = env.simTimeSec;
    h.releaseIasMps = iasMps;
    events.push({ type: 'airdropRelease', entityId: ownerId, stickId: h.stickId, count, pos: { x: state.pos.x, y: state.pos.y, z: state.pos.z }, iasMps, aglM, reserve });
  }

  /** Bundles leave the ramps on their turn, and every falling bundle flies one tick. */
  step(dtSec: number, pool: EntityPool, sampler: HeightSampler, env: Readonly<AirdropEnv>, events: EventQueue): void {
    for (const h of this.holds) {
      while (h.queued > 0 && env.simTimeSec >= h.nextExitSec) {
        const owner = pool.get(h.ownerId);
        if (!owner || !owner.alive) {
          h.queued = 0;
          break;
        }
        this.exit(h, owner, pool, env);
        h.queued -= 1;
        h.queuedIndex += 1;
        h.nextExitSec += CDS.exitIntervalSec;
      }
    }
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i]!;
      const s = pool.get(f.id);
      if (!s || !s.alive) {
        this.falling.splice(i, 1);
        continue;
      }
      this.fly(f, s, dtSec, env);
      const ground = sampler.heightAt(s.pos.x, s.pos.z);
      if (s.pos.y - CDS.halfHeightM <= ground) {
        const impact = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
        events.push({
          type: 'airdropLanded',
          entityId: f.ownerId,
          stickId: f.stickId,
          index: f.index,
          count: f.count,
          pos: { x: s.pos.x, y: ground, z: s.pos.z },
          impactMps: impact,
          destroyed: f.failed || -s.vel.y > CDS.maxImpactMps,
        });
        events.push({ type: 'storeImpact', pos: { x: s.pos.x, y: ground, z: s.pos.z }, massKg: f.massKg, fuelKg: 0, speedMps: impact, water: sampler.isWaterAt?.(s.pos.x, s.pos.z) ?? false });
        pool.release(f.id);
        this.falling.splice(i, 1);
      } else if (f.ageSec > CDS.maxFallSec) {
        pool.release(f.id);
        this.falling.splice(i, 1);
      }
    }
  }

  /** One bundle leaves `owner`'s ramp. */
  private exit(h: Hold, owner: EntityState, pool: EntityPool, env: Readonly<AirdropEnv>): void {
    const id = pool.allocate(EntityKind.Effect, owner.team);
    if (id === NO_ENTITY_ID) return;
    const s = pool.get(id);
    if (!s) return;
    const prng = createPrng((env.seed ^ Math.imul(h.stickId, 0x9e3779b1) ^ Math.imul(h.queuedIndex + 1, 0x85ebca6b)) >>> 0);
    // The sill, and the aircraft's velocity there, plus the roll-out aft.
    Quat.rotate(owner.rot, h.def.exitBodyM, this.a);
    s.pos.x = owner.pos.x + this.a.x;
    s.pos.y = owner.pos.y + this.a.y;
    s.pos.z = owner.pos.z + this.a.z;
    this.b.x = -CDS.exitAftMps * nextRange(prng, 0.8, 1.2);
    this.b.y = -0.5;
    this.b.z = 0;
    Quat.rotate(owner.rot, this.b, this.a);
    s.vel.x = owner.vel.x + this.a.x;
    s.vel.y = owner.vel.y + this.a.y;
    s.vel.z = owner.vel.z + this.a.z;
    const headingRad = Math.atan2(owner.vel.x, -owner.vel.z);
    Quat.fromYawPitchRoll(headingRad, 0, 0, s.rot);
    s.omega.x = 0;
    s.omega.y = 0;
    s.omega.z = 0;
    s.stores = this.code;
    s.flags = 0;
    const massKg = h.queuedReserve ? CDS.reserveKg : h.bundleKg;
    if (!h.queuedReserve && owner.cargoMassKg !== undefined) owner.cargoMassKg = Math.max(0, owner.cargoMassKg - massKg);
    // Too fast: the canopies open late and unevenly (a random push), and past the limit some fail.
    const rough = Math.max(0, h.releaseIasMps - CDS.roughIasMps);
    const failChance = h.releaseIasMps > CDS.failIasMps ? Math.min(0.8, (h.releaseIasMps - CDS.failIasMps) / 20) : 0;
    const kick = 0.3 * rough;
    s.vel.x += kick * gaussian(prng);
    s.vel.z += kick * gaussian(prng);
    this.falling.push({
      id,
      ownerId: h.ownerId,
      stickId: h.stickId,
      index: h.queuedIndex,
      count: h.queuedCount,
      massKg,
      ageSec: 0,
      deployAtSec: CDS.deployDelaySec * nextRange(prng, 0.85, 1.2) + 0.02 * rough,
      inflateSec: CDS.inflateSec * nextRange(prng, 0.85, 1.25) * (1 + 0.03 * rough),
      failed: nextFloat01(prng) < failChance,
      headingRad,
      gustX: 0,
      gustZ: 0,
      gustSigma: Math.max(0.8, env.gustMps),
      prng,
    });
  }

  private fly(f: Bundle, s: EntityState, dt: number, env: Readonly<AirdropEnv>): void {
    f.ageSec += dt;
    // The bundle's own gust: a random walk relaxing to zero over ~4 s (Ornstein-Uhlenbeck).
    const tau = 4;
    const k = Math.sqrt((2 * dt) / tau) * f.gustSigma;
    f.gustX += (-f.gustX / tau) * dt + k * gaussian(f.prng);
    f.gustZ += (-f.gustZ / tau) * dt + k * gaussian(f.prng);
    const open = f.ageSec <= f.deployAtSec ? 0 : Math.min(1, (f.ageSec - f.deployAtSec) / f.inflateSec);
    const canopy = f.failed ? (open > 0 ? CDS.streamerCdAM2 : 0) : CDS.canopyCdAM2 * open * open * open;
    const cdA = CDS.boxCdAM2 + canopy;
    isaAtmosphereInto(s.pos.y, this.atm);
    const kd = (0.5 * this.atm.airDensityKgM3 * cdA) / f.massKg;
    // Air-relative velocity, its drag (implicit: stable however big the canopy), then gravity.
    const wx = env.windWorldMps.x + f.gustX;
    const wy = env.windWorldMps.y;
    const wz = env.windWorldMps.z + f.gustZ;
    let rx = s.vel.x - wx;
    let ry = s.vel.y - wy;
    let rz = s.vel.z - wz;
    const sp = Math.hypot(rx, ry, rz);
    const damp = 1 / (1 + kd * sp * dt);
    rx *= damp;
    ry *= damp;
    rz *= damp;
    s.vel.x = rx + wx;
    s.vel.y = ry + wy - env.gravityMps2 * dt;
    s.vel.z = rz + wz;
    s.pos.x += s.vel.x * dt;
    s.pos.y += s.vel.y * dt;
    s.pos.z += s.vel.z * dt;
    // Tumbling a little in free fall, upright under the canopy (drawn above it once it is out).
    const pitch = open > 0.25 ? 0 : -0.6 * Math.sin(f.ageSec * 3.1);
    Quat.fromYawPitchRoll(f.headingRad, pitch, 0, s.rot);
    if (open > 0.25 && !f.failed) s.flags |= EntityFlag.TailOpen;
    else s.flags &= ~EntityFlag.TailOpen;
  }
}
