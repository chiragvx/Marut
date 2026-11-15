/**
 * src/core/airdrop.ts — container delivery (CDS) off a transport's ramp: A-22 cargo bags under G-12
 * cargo parachutes, released by gravity.
 *
 * The load: each bundle is an A-22 (a canvas bag with its webbing on a 48 x 48 in plywood skid board,
 * a layer of paper honeycomb between the two to soak up the landing; rigged ~1.22 m square and ~1.5 m
 * tall, up to 2,200 lb / ~1,000 kg) under a G-12 cargo parachute (64 ft / 19.5 m nominal, ~14 m
 * across inflated; rated 500-2,200 lb, ~28.5 ft/s / 8.7 m/s descent at 2,200 lb at sea level, faster
 * in thin air: ~10 m/s at Simikot's 3,000 m). Figures: FM 4-20.103 / TM 10-1670-298-20 class
 * numbers [E: the drag areas are fitted to them].
 *
 * The drop: the bundles sit in a row on the rollers, the aftmost a little forward of the ramp's sill.
 * At the release the crew cuts the restraint with the aircraft a few degrees nose up (CDS.minDeckRad
 * at least), and the stick rolls aft on its own weight: each bundle accelerates down the floor
 * (g sin deck - roller friction) and tips over the sill in turn, the first ~2 s after the release and
 * the rest ~0.5 s apart (they start a bag's length further forward each). While on the rollers a
 * bundle is an entity riding in the hold (drawn there, moving with the jet). Over the sill it falls
 * free; its static line pulls the canopy out ~1.4 s later (line stretch); the canopy streams along the airflow and
 * fills over ~2.5 s (drag growing as the fourth power of the fill), swinging the load under it as it slows.
 * Fully open ~4 s after the exit and ~60-80 m lower, so 150 m above the ground is a comfortable
 * drop; below ~55 m the loads hit before their canopies have slowed them and are wrecked.
 *
 * The landing: skid first at the canopy's sink rate; the honeycomb crushes and the load survives
 * (CDS.maxImpactMps). A load whose canopy never opened (released too low, or a streamer from a
 * release far too fast) hits hard enough to wreck it. Landed loads stay on the ground, upright (a
 * wrecked one askew), each canopy collapsed and draped downwind beside it: EntityFlag.OnGround
 * (+ TailOpen when the canopy was out). Each bundle is an Effect entity (store code 'cds-bundle');
 * nothing else in the sim sees it.
 *
 * Release speed: real CDS is flown at ~130-150 KIAS; the game's drop (Simikot Lifeline) is 180 kt
 * for handling, so the canopies take it; past CDS.roughIasMps they open unevenly (more scatter), past
 * CDS.failIasMps some fail.
 */
import type { AirdropLoad, EntityId, EntityState, HeightSampler, Vec3Like } from '../contracts/core';
import { EntityFlag, EntityKind, NO_ENTITY_ID, STORE_IDS } from '../contracts/core';
import type { AirdropDefinition } from '../contracts/aircraft';
import type { EntityPool, EventQueue } from '../contracts/sim';
import { createPrng, nextFloat01, nextRange, Quat, type PrngState } from '../math';
import { isaAtmosphereInto } from './atmosphere';

const KT = 0.514444;
const DEG = Math.PI / 180;

/** The A-22 bundle, its G-12 parachute and the gravity roll-out [E]. */
export const CDS = {
  /** A-22 rigged: 48 in (1.22 m) skid board, ~1.5 m tall; half its height, m (it lands when its skid reaches the ground). */
  sizeM: 1.22,
  halfHeightM: 0.75,
  /** Bundles stand this far apart on the rollers (a bag and a gap), m. */
  rollerPitchM: 1.35,
  /** The aftmost bundle's centre starts this far forward of the sill, m. */
  firstFromSillM: 2.0,
  /** The deck angle the stick rolls on: the aircraft's pitch, at least this (the crew raises the nose at the green light), at most that, rad. */
  minDeckRad: 6 * DEG,
  maxDeckRad: 12 * DEG,
  /** Roller friction (rolling resistance as a fraction of the weight). */
  rollerFriction: 0.02,
  /** Drag area of the falling container, m^2 (1.22 x 1.22 x 1.5 m, tumbling). */
  boxCdAM2: 1.7,
  /** Static line: the canopy leaves its bag this long after the exit, s. */
  deployDelaySec: 1.4,
  /** And takes this long to fill, s. */
  inflateSec: 2.6,
  /** Drawn fully open from this fill on (EntityFlag.TailOpen; before it CanopyFilling). */
  openDrawnAt: 0.6,
  /** G-12 drag area, m^2: ~8.5 m/s with 1,000 kg at sea level, ~10 m/s at 3,000 m. */
  canopyCdAM2: 222,
  /** A failed canopy (streamer) still drags this much, m^2. */
  streamerCdAM2: 12,
  /** Hitting the ground faster than this (vertically) wrecks the load (the honeycomb takes a normal landing), m/s. */
  maxImpactMps: 13,
  /** Above this release speed the canopies open unevenly, m/s IAS. */
  roughIasMps: 200 * KT,
  /** Above this they can fail, m/s IAS. */
  failIasMps: 240 * KT,
  /** Light reserve bundles, kg each (dropped once the rigged load is gone, MissionPlayerStart.airdrop.reserve). */
  reserveKg: 350,
  /** A bundle still falling after this long is removed. */
  maxFallSec: 180,
  /** Loads left lying on the ground at most (the oldest go first). */
  maxOnGround: 40,
} as const;

/** The release envelope a crew flies (the cue the mission and the HUD give). */
export const AIRDROP_ENVELOPE = {
  minAglM: 100,
  idealAglM: 150,
  maxAglM: 300,
  minIasMps: 130 * KT,
  idealIasMps: 180 * KT,
  maxIasMps: 200 * KT,
} as const;

/** How hard the stick rolls aft on a deck at `deckRad` (clamped to the CDS range), m/s^2. */
export function cdsRollAccel(deckRad: number, gravity = 9.80665): number {
  const d = Math.min(CDS.maxDeckRad, Math.max(CDS.minDeckRad, deckRad));
  return gravity * (Math.sin(d) - CDS.rollerFriction);
}

/** When bundle `index` (0 = aftmost, first out) tips over the sill after the release, s, and how fast it is rolling aft then, m/s. */
export function cdsRollOut(index: number, deckRad = CDS.minDeckRad, gravity = 9.80665): { sec: number; mps: number } {
  const a = cdsRollAccel(deckRad, gravity);
  const d = CDS.firstFromSillM + index * CDS.rollerPitchM;
  const sec = Math.sqrt((2 * d) / a);
  return { sec, mps: a * sec };
}

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
  /** Bundles of the current stick still on the rollers. */
  queued: number;
}

interface Bundle {
  id: EntityId;
  ownerId: EntityId;
  stickId: number;
  index: number;
  count: number;
  massKg: number;
  /** A light reserve bundle (not part of the rigged cargo mass). */
  reserve: boolean;
  /** On the rollers in the hold (riding with the aircraft) until it tips over the sill. */
  riding: boolean;
  /** Time since the release, while riding; the stick's roll-out acceleration. */
  rideSec: number;
  rollAccel: number;
  /** Distance of its centre forward of the sill at the release, m. */
  rollFromM: number;
  /** The release speed (IAS), for the opening. */
  releaseIasMps: number;
  /** Time since it left the ramp, s. */
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
 * Where a stick released now lands (no gusts, the nominal canopy, the minimum deck angle): the
 * centroid of `count` bundles rolling out of an aircraft at `pos` flying `vel` (cdsRollOut), over
 * ground at `groundY`, in `wind`. The mission's release cue (the CARP) and the drop's grade use it.
 * Also returns the fall time (from the release) and how hard the bundles land (vertical, m/s).
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
  // The stick's mean exit: when, and how fast aft.
  let lag = 0;
  let aft = 0;
  for (let i = 0; i < count; i++) {
    const r = cdsRollOut(i, CDS.minDeckRad, gravity);
    lag += r.sec / count;
    aft += r.mps / count;
  }
  // The ramp sill is ~21 m behind the aircraft's reference point (c17Definition airdrop.exitBodyM) and 3 m down; the jet flies on meanwhile.
  let px = pos.x + vel.x * lag - (vel.x / sp) * 21;
  let py = pos.y + vel.y * lag - 3 + CDS.halfHeightM;
  let pz = pos.z + vel.z * lag - (vel.z / sp) * 21;
  let vx = vel.x - (vel.x / sp) * aft;
  let vy = vel.y - 0.3;
  let vz = vel.z - (vel.z / sp) * aft;
  let t = 0;
  while (py - CDS.halfHeightM > groundY && t < CDS.maxFallSec) {
    t += dt;
    const open = t <= CDS.deployDelaySec ? 0 : Math.min(1, (t - CDS.deployDelaySec) / CDS.inflateSec);
    isaAtmosphereInto(py, predictAtm);
    const kd = (0.5 * predictAtm.airDensityKgM3 * (CDS.boxCdAM2 + CDS.canopyCdAM2 * open ** 4)) / massKg;
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
  return { x: px, z: pz, fallSec: t + lag, sinkMps: -vy };
}

function gaussian(p: PrngState): number {
  const u = Math.max(1e-9, nextFloat01(p));
  const v = nextFloat01(p);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class Airdrops {
  private readonly holds: Hold[] = [];
  private readonly falling: Bundle[] = [];
  /** Landed loads still lying on the ground (entity ids, oldest first). */
  private readonly grounded: EntityId[] = [];
  private readonly atm = { airDensityKgM3: 1.225, soundSpeedMps: 340.29 };
  private readonly a = { x: 0, y: 0, z: 0 };
  private readonly b = { x: 0, y: 0, z: 0 };
  private readonly code = STORE_IDS.indexOf('cds-bundle');

  clear(): void {
    this.holds.length = 0;
    this.falling.length = 0;
    this.grounded.length = 0;
  }

  /** Bundles in the hold rolling out or in the air. */
  get fallingCount(): number {
    return this.falling.length;
  }

  /** Loads lying on the ground. */
  get groundedCount(): number {
    return this.grounded.length;
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
   * stick: the restraint is cut and the bundles start rolling). `iasMps`/`aglM` describe the release.
   */
  input(ownerId: EntityId, pressed: boolean, state: Readonly<EntityState>, iasMps: number, aglM: number, env: Readonly<AirdropEnv>, events: EventQueue, pool: EntityPool): void {
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
    const stickId = h.sticks;
    // The deck angle: the aircraft's pitch (its nose's climb), clamped to the roll-out's range.
    Quat.rotate(state.rot, { x: 1, y: 0, z: 0 }, this.a);
    const accel = cdsRollAccel(Math.asin(Math.max(-1, Math.min(1, this.a.y))), env.gravityMps2);
    const headingRad = Math.atan2(state.vel.x, -state.vel.z);
    for (let i = 0; i < count; i++) {
      const prng = createPrng((env.seed ^ Math.imul(stickId, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0);
      const id = pool.allocate(EntityKind.Effect, state.team);
      const s = pool.get(id);
      if (id === NO_ENTITY_ID || !s) continue;
      h.queued += 1;
      this.falling.push({
        id,
        ownerId,
        stickId,
        index: i,
        count,
        massKg: reserve ? CDS.reserveKg : h.bundleKg,
        reserve,
        riding: true,
        rideSec: 0,
        rollAccel: accel,
        rollFromM: CDS.firstFromSillM + i * CDS.rollerPitchM,
        releaseIasMps: iasMps,
        ageSec: 0,
        deployAtSec: CDS.deployDelaySec * nextRange(prng, 0.85, 1.2),
        inflateSec: CDS.inflateSec * nextRange(prng, 0.85, 1.25),
        failed: false,
        headingRad,
        gustX: 0,
        gustZ: 0,
        gustSigma: Math.max(0.8, env.gustMps),
        prng,
      });
      this.ride(this.falling[this.falling.length - 1]!, s, state, h.def);
    }
    events.push({ type: 'airdropRelease', entityId: ownerId, stickId, count, pos: { x: state.pos.x, y: state.pos.y, z: state.pos.z }, iasMps, aglM, reserve });
  }

  /** The bundles on the rollers roll aft and tip over the sill in turn; every falling bundle flies one tick; landed ones stay. */
  step(dtSec: number, pool: EntityPool, sampler: HeightSampler, env: Readonly<AirdropEnv>, events: EventQueue): void {
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i]!;
      const s = pool.get(f.id);
      if (!s || !s.alive) {
        this.falling.splice(i, 1);
        if (f.riding) this.unqueue(f.ownerId);
        continue;
      }
      if (f.riding) {
        const owner = pool.get(f.ownerId);
        const h = this.holds.find((x) => x.ownerId === f.ownerId);
        if (!owner || !owner.alive || !h) {
          // The jet is lost with the load aboard.
          pool.release(f.id);
          this.falling.splice(i, 1);
          this.unqueue(f.ownerId);
          continue;
        }
        f.rideSec += dtSec;
        if (f.rollFromM - 0.5 * f.rollAccel * f.rideSec * f.rideSec > 0) this.ride(f, s, owner, h.def);
        else this.exit(f, s, owner, h);
        continue;
      }
      this.fly(f, s, dtSec, env);
      const ground = sampler.heightAt(s.pos.x, s.pos.z);
      if (s.pos.y - CDS.halfHeightM <= ground) {
        const impact = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
        const destroyed = f.failed || -s.vel.y > CDS.maxImpactMps;
        events.push({ type: 'airdropLanded', entityId: f.ownerId, stickId: f.stickId, index: f.index, count: f.count, pos: { x: s.pos.x, y: ground, z: s.pos.z }, impactMps: impact, destroyed });
        events.push({ type: 'storeImpact', pos: { x: s.pos.x, y: ground, z: s.pos.z }, massKg: f.massKg, fuelKg: 0, speedMps: impact, water: sampler.isWaterAt?.(s.pos.x, s.pos.z) ?? false });
        this.falling.splice(i, 1);
        this.settle(f, s, ground, destroyed, env);
        this.grounded.push(f.id);
        while (this.grounded.length > CDS.maxOnGround) pool.release(this.grounded.shift()!);
      } else if (f.ageSec > CDS.maxFallSec) {
        pool.release(f.id);
        this.falling.splice(i, 1);
      }
    }
  }

  private unqueue(ownerId: EntityId): void {
    const h = this.holds.find((x) => x.ownerId === ownerId);
    if (h) h.queued = Math.max(0, h.queued - 1);
  }

  /** A bundle on the rollers: on the floor, `rollFromM - a t^2 / 2` forward of the sill, moving with the jet. */
  private ride(f: Bundle, s: EntityState, owner: EntityState, def: AirdropDefinition): void {
    const d = Math.max(0, f.rollFromM - 0.5 * f.rollAccel * f.rideSec * f.rideSec);
    this.b.x = def.exitBodyM.x + d;
    this.b.y = def.exitBodyM.y + CDS.halfHeightM;
    this.b.z = def.exitBodyM.z;
    Quat.rotate(owner.rot, this.b, this.a);
    s.pos.x = owner.pos.x + this.a.x;
    s.pos.y = owner.pos.y + this.a.y;
    s.pos.z = owner.pos.z + this.a.z;
    this.b.x = -f.rollAccel * f.rideSec;
    this.b.y = 0;
    this.b.z = 0;
    Quat.rotate(owner.rot, this.b, this.a);
    s.vel.x = owner.vel.x + this.a.x;
    s.vel.y = owner.vel.y + this.a.y;
    s.vel.z = owner.vel.z + this.a.z;
    s.rot.x = owner.rot.x;
    s.rot.y = owner.rot.y;
    s.rot.z = owner.rot.z;
    s.rot.w = owner.rot.w;
    s.omega.x = 0;
    s.omega.y = 0;
    s.omega.z = 0;
    s.stores = this.code;
    s.flags = 0;
  }

  /** A bundle tips over the sill: free of the jet, with the jet's velocity and its own roll aft. */
  private exit(f: Bundle, s: EntityState, owner: EntityState, h: Hold): void {
    f.rideSec = Math.sqrt((2 * f.rollFromM) / f.rollAccel);
    this.ride(f, s, owner, h.def);
    f.riding = false;
    s.vel.y -= 0.3;
    h.queued = Math.max(0, h.queued - 1);
    if (!f.reserve && owner.cargoMassKg !== undefined) owner.cargoMassKg = Math.max(0, owner.cargoMassKg - f.massKg);
    // Too fast: the canopies open late and unevenly (a random push), and past the limit some fail.
    const rough = Math.max(0, f.releaseIasMps - CDS.roughIasMps);
    const failChance = f.releaseIasMps > CDS.failIasMps ? Math.min(0.8, (f.releaseIasMps - CDS.failIasMps) / 20) : 0;
    const kick = 0.3 * rough;
    s.vel.x += kick * gaussian(f.prng);
    s.vel.z += kick * gaussian(f.prng);
    f.deployAtSec += 0.02 * rough;
    f.inflateSec *= 1 + 0.03 * rough;
    f.failed = nextFloat01(f.prng) < failChance;
    f.headingRad = Math.atan2(owner.vel.x, -owner.vel.z);
    Quat.fromYawPitchRoll(f.headingRad, 0, 0, s.rot);
  }

  private fly(f: Bundle, s: EntityState, dt: number, env: Readonly<AirdropEnv>): void {
    f.ageSec += dt;
    // The bundle's own gust: a random walk relaxing to zero over ~4 s (Ornstein-Uhlenbeck).
    const tau = 4;
    const k = Math.sqrt((2 * dt) / tau) * f.gustSigma;
    f.gustX += (-f.gustX / tau) * dt + k * gaussian(f.prng);
    f.gustZ += (-f.gustZ / tau) * dt + k * gaussian(f.prng);
    const open = f.ageSec <= f.deployAtSec ? 0 : Math.min(1, (f.ageSec - f.deployAtSec) / f.inflateSec);
    const canopy = f.failed ? (open > 0 ? CDS.streamerCdAM2 : 0) : CDS.canopyCdAM2 * open ** 4;
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
    // Tipping off the sill and tumbling a little in free fall; once the canopy is out the load hangs
    // under it along the airflow (streaming behind at first, swinging under it as it slows).
    const tumble = -0.6 * Math.sin(f.ageSec * 3.1);
    let pitch = tumble;
    if (open > 0) {
      const along = rx * Math.sin(f.headingRad) - rz * Math.cos(f.headingRad);
      const flow = Math.max(-1.45, Math.min(1.45, Math.atan2(along, Math.max(0.1, -ry))));
      const w = Math.min(1, (f.ageSec - f.deployAtSec) / 0.4);
      pitch = tumble * (1 - w) + flow * w;
    }
    Quat.fromYawPitchRoll(f.headingRad, pitch, 0, s.rot);
    s.flags &= ~(EntityFlag.TailOpen | EntityFlag.CanopyFilling);
    if (open > 0 && !f.failed) s.flags |= open >= CDS.openDrawnAt ? EntityFlag.TailOpen : EntityFlag.CanopyFilling;
    else if (open > 0) s.flags |= EntityFlag.CanopyFilling;
  }

  /** On the ground: upright on its skid (a wrecked one crushed and askew), the canopy collapsed downwind of it. */
  private settle(f: Bundle, s: EntityState, ground: number, destroyed: boolean, env: Readonly<AirdropEnv>): void {
    // The canopy drapes downwind (the model lays it along the load's +x).
    const wx = env.windWorldMps.x + f.gustX;
    const wz = env.windWorldMps.z + f.gustZ;
    const dx = Math.hypot(wx, wz) > 0.5 ? wx : s.vel.x;
    const dz = Math.hypot(wx, wz) > 0.5 ? wz : s.vel.z;
    const yaw = Math.hypot(dx, dz) > 0.01 ? Math.atan2(dx, -dz) : f.headingRad;
    Quat.fromYawPitchRoll(yaw + nextRange(f.prng, -0.25, 0.25), destroyed ? nextRange(f.prng, -0.3, 0.3) : 0, destroyed ? nextRange(f.prng, 0.25, 0.5) : 0, s.rot);
    s.pos.y = ground + CDS.halfHeightM - (destroyed ? 0.3 : 0.08);
    s.vel.x = 0;
    s.vel.y = 0;
    s.vel.z = 0;
    const canopyOut = f.ageSec > f.deployAtSec;
    s.flags = EntityFlag.OnGround | (canopyOut ? EntityFlag.TailOpen : 0);
  }
}
