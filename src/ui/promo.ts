/**
 * src/ui/promo.ts — the promotional B-roll: high-energy shots of the Tejas at work, played through
 * the menu cinematic's dev hold (?showcase=p<shot>,<t>) and rendered frame by frame, with no UI, by
 * tools/promo/capturePromo.mjs.
 *
 * Every shot runs on its own clock (ShowcaseFrame.timeSec) with a timeline of events (launches,
 * flares, hits, impacts) so the effects (src/render/weaponFx.ts) play the same on every render;
 * weapons in flight are flown here once, when the shot is built (a missile chasing its target with
 * a lead pursuit and a turn limit, a bomb on a ballistic arc), and sampled per frame.
 */
import type { AirportLayout, RunwayDef } from '../contracts/airport';
import type { ShowcaseAircraft, ShowcaseFrame, ShowcaseStore } from '../contracts/render';
import { EntityFlag, STORE_IDS, StoreRack, packStoreSlot, packStoreSlots, type QuatLike, type SimEvent, type Vec3Like, type WeaponKind } from '../contracts/core';
import { Quat } from '../math';
import { dispenserBody, ejectDirBody } from '../combat/countermeasures';
import { stations } from '../aircraft/tejasGeometry';
import { at, clamp01, deg, distance, ease, jetFov, lerp, makeAircraft, runwayFrame, setRot, takeoff, type RunwayFrame, type ShowcaseScene } from './showcase';
import { bell, bellRate, flyPath, follower, fromBasis, holdGamma, shake, smooth01, type Track } from './flightPath';
import { bodyShip, chaseShip, fromJet, gearUp, overFields, rollUp } from './reel';

const G = 9.81;
const code = (id: string): number => STORE_IDS.indexOf(id);
const v3 = (x = 0, y = 0, z = 0): Vec3Like => ({ x, y, z });
const station = (id: string): Vec3Like => stations.find((s) => s.id === id)!.posBodyM;

// ---------------------------------------------------------------------------------------------
// Loadouts.
// ---------------------------------------------------------------------------------------------

/** CAP: twin ASRAAM outboard (`asraamL/R` left on each), Astra on the middle pylons, wing tanks. */
function capFit(asraamL = 2, asraamR = 2, astraL = 1, astraR = 1): { a: number; b: number } {
  return packStoreSlots([
    packStoreSlot(code('asraam'), asraamL, StoreRack.TwinRail),
    packStoreSlot(code('asraam'), asraamR, StoreRack.TwinRail),
    packStoreSlot(code('astra-mk1'), astraL, StoreRack.Single),
    packStoreSlot(code('astra-mk1'), astraR, StoreRack.Single),
    packStoreSlot(code('tank-1200l'), 1, StoreRack.Single),
    packStoreSlot(code('tank-1200l'), 1, StoreRack.Single),
  ], { a: 0, b: 0 });
}

/** Strike: ASRAAM for self-defence, HSLD-250 pairs on the middle pylons, HSLD-450 inboard, centreline tank, Litening. */
function strikeFit(innerL = 1, innerR = 1): { a: number; b: number } {
  return packStoreSlots([
    packStoreSlot(code('asraam'), 1, StoreRack.Single),
    packStoreSlot(code('asraam'), 1, StoreRack.Single),
    packStoreSlot(code('hsld-250'), 2, StoreRack.MultiRack),
    packStoreSlot(code('hsld-250'), 2, StoreRack.MultiRack),
    packStoreSlot(code('hsld-450'), innerL, StoreRack.Single),
    packStoreSlot(code('hsld-450'), innerR, StoreRack.Single),
    packStoreSlot(code('tank-725l'), 1, StoreRack.Single),
    packStoreSlot(code('litening'), 1, StoreRack.Single),
  ], { a: 0, b: 0 });
}

function setStores(jet: ShowcaseAircraft, s: { a: number; b: number }): void {
  jet.stores = s.a;
  jet.storesB = s.b;
}

// ---------------------------------------------------------------------------------------------
// Weapons in flight.
// ---------------------------------------------------------------------------------------------

interface Flight {
  t0: number;
  /** When it ends (hit, impact, or out of time). */
  t1: number;
  hit: boolean;
  sample(t: number, pos: Vec3Like, vel: Vec3Like): void;
}

function recorded(t0: number, dt: number, pos: number[], vel: number[], hit: boolean): Flight {
  const n = pos.length / 3;
  return {
    t0,
    t1: t0 + (n - 1) * dt,
    hit,
    sample(t, p, v) {
      const x = Math.min(n - 1.0001, Math.max(0, (t - t0) / dt));
      const i = Math.floor(x);
      const f = x - i;
      for (const [arr, out] of [[pos, p], [vel, v]] as const) {
        out.x = lerp(arr[i * 3]!, arr[i * 3 + 3]!, f);
        out.y = lerp(arr[i * 3 + 1]!, arr[i * 3 + 4]!, f);
        out.z = lerp(arr[i * 3 + 2]!, arr[i * 3 + 5]!, f);
      }
    },
  };
}

/**
 * A missile off the rail at t0 (pos0/vel0, pointing along fwd0): it drops clear for a moment, its
 * motor accelerating it at `accel` for `burnSec`, then steers a lead pursuit on `target` (turn
 * limited to `turnG`) until it passes within `hitM`.
 */
function missileFlight(o: { t0: number; pos0: Vec3Like; vel0: Vec3Like; fwd0: Vec3Like; burnSec: number; accel: number; turnG: number; target?: Track; hitM?: number; loft?: number; maxSec?: number }): Flight {
  const dt = 1 / 240;
  const pos: number[] = [];
  const vel: number[] = [];
  const p = { ...o.pos0 };
  let speed = Math.hypot(o.vel0.x, o.vel0.y, o.vel0.z);
  const d = { ...o.fwd0 };
  const tp = makeAircraft();
  let hit = false;
  for (let t = o.t0; t < o.t0 + (o.maxSec ?? 12); t += dt) {
    const a = t - o.t0;
    pos.push(p.x, p.y, p.z);
    vel.push(d.x * speed, d.y * speed, d.z * speed);
    if (a > 0.05 && a < o.burnSec) speed += o.accel * dt;
    else speed -= (speed * speed * 0.00004 + 4) * dt;
    if (a < 0.18) {
      // Off the rail: carried by the jet's speed, sagging a touch.
      d.y -= 0.6 * dt;
    } else if (o.target) {
      o.target.sample(Math.min(t, o.target.durationSec), tp);
      const rx = tp.pos.x - p.x, ry = tp.pos.y - p.y, rz = tp.pos.z - p.z;
      const dist = Math.hypot(rx, ry, rz);
      if (dist < (o.hitM ?? 4)) {
        hit = true;
        break;
      }
      const tgo = dist / Math.max(100, speed);
      let ax = rx + tp.vel.x * tgo, ay = ry + tp.vel.y * tgo + (o.loft ?? 0) * dist * clamp01(1 - a / 3), az = rz + tp.vel.z * tgo;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al; ay /= al; az /= al;
      const cosA = Math.min(1, Math.max(-1, ax * d.x + ay * d.y + az * d.z));
      const ang = Math.acos(cosA);
      const maxTurn = ((o.turnG * G) / Math.max(50, speed)) * dt;
      const k = ang > 1e-6 ? Math.min(1, maxTurn / ang) : 1;
      d.x += (ax - d.x) * k; d.y += (ay - d.y) * k; d.z += (az - d.z) * k;
    } else d.y -= (G / Math.max(50, speed)) * dt * 0.3;
    const l = Math.hypot(d.x, d.y, d.z) || 1;
    d.x /= l; d.y /= l; d.z /= l;
    p.x += d.x * speed * dt; p.y += d.y * speed * dt; p.z += d.z * speed * dt;
  }
  return recorded(o.t0, dt, pos, vel, hit);
}

/** A free-fall bomb from t0 at pos0/vel0 until it reaches `groundY`. */
function bombFlight(t0: number, pos0: Vec3Like, vel0: Vec3Like, groundY: number): Flight {
  const dt = 1 / 240;
  const pos: number[] = [];
  const vel: number[] = [];
  const p = { ...pos0 };
  const v = { ...vel0 };
  for (let t = t0; t < t0 + 30; t += dt) {
    pos.push(p.x, p.y, p.z);
    vel.push(v.x, v.y, v.z);
    if (p.y <= groundY) break;
    const sp = Math.hypot(v.x, v.y, v.z);
    const k = 0.00006 * sp;
    v.x -= v.x * k * dt; v.y -= (G + v.y * k) * dt; v.z -= v.z * k * dt;
    p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
  }
  return recorded(t0, dt, pos, vel, true);
}

/** Attitude along a velocity (with a little release wobble for a bomb). */
function alongVel(vel: Vec3Like, out: QuatLike, wobbleRad = 0, t = 0): QuatLike {
  const l = Math.hypot(vel.x, vel.y, vel.z) || 1;
  const fx = v3(vel.x / l, vel.y / l, vel.z / l);
  const rz = v3(-fx.z, 0, fx.x);
  const rl = Math.hypot(rz.x, rz.z) || 1;
  rz.x /= rl; rz.z /= rl;
  const uy = v3(rz.y * fx.z - rz.z * fx.y, rz.z * fx.x - rz.x * fx.z, rz.x * fx.y - rz.y * fx.x);
  if (wobbleRad) {
    const a = wobbleRad * Math.sin(t * 9), b = wobbleRad * 0.7 * Math.sin(t * 7.3 + 1);
    fx.x += uy.x * a + rz.x * b; fx.y += uy.y * a + rz.y * b; fx.z += uy.z * a + rz.z * b;
  }
  return fromBasis(fx, uy, rz, out);
}

/** A store on `jet` at body point `b` (world), and the jet's velocity, at time t on `track`. */
function releasePoint(track: Track, t: number, b: Vec3Like): { pos: Vec3Like; vel: Vec3Like; fwd: Vec3Like } {
  const j = makeAircraft();
  track.sample(t, j);
  const pos = fromJet(j, b.x, b.y, b.z, v3());
  const fwd = Quat.rotate(j.rot, v3(1, 0, 0), v3());
  return { pos, vel: { ...j.vel }, fwd };
}

/** A pair of flares (or chaff) from `id` flying `track`, at t. */
function decoys(id: number, track: Track, t: number, kind: 'flare' | 'chaff' = 'flare'): { t: number; ev: SimEvent }[] {
  const j = makeAircraft();
  track.sample(t, j);
  const out: { t: number; ev: SimEvent }[] = [];
  for (const side of [-1, 1]) {
    const pos = Quat.rotate(j.rot, dispenserBody(side, v3()), v3());
    const e = Quat.rotate(j.rot, ejectDirBody(side, v3()), v3());
    out.push({ t: t + (side > 0 ? 0.06 : 0), ev: { type: 'countermeasure', entityId: id, kind, pos: { x: j.pos.x + pos.x, y: j.pos.y + pos.y, z: j.pos.z + pos.z }, vel: { x: j.vel.x + e.x * 25, y: j.vel.y + e.y * 25, z: j.vel.z + e.z * 25 } } });
  }
  return out;
}

const launchEv = (t: number, shooterId: number, missileId: number, weapon: WeaponKind): { t: number; ev: SimEvent } => ({ t, ev: { type: 'missileLaunch', shooterId, missileId, weapon } });

/** A store drawn in flight at t (or nothing outside its flight). */
function flying(f: Flight, id: number, storeCode: number, t: number, wobble = 0): ShowcaseStore | undefined {
  if (t < f.t0 || t > f.t1) return undefined;
  const pos = v3();
  const vel = v3();
  f.sample(t, pos, vel);
  return { id, code: storeCode, pos, vel, rot: alongVel(vel, { x: 0, y: 0, z: 0, w: 1 }, wobble * Math.exp(-(t - f.t0) / 1.5), t) };
}

function newFrame(fovDeg: number, aircraft: ShowcaseAircraft[]): ShowcaseFrame {
  return { camPos: v3(), lookAt: v3(), fovDeg, aircraft, events: [], stores: [], bullets: [] };
}

const ASRAAM = { burnSec: 2.6, accel: 260, turnG: 40 };
const ASTRA = { burnSec: 5.5, accel: 150, turnG: 30 };

// ---------------------------------------------------------------------------------------------
// The shots.
// ---------------------------------------------------------------------------------------------

/**
 * Fox Two: over the shoulder of a Tejas closing on a bandit in a turn; the inboard ASRAAM leaves the
 * left twin rail, its motor streaking smoke ahead; the bandit pumps flares and breaks; the missile
 * pulls lead, ignores the flares and hits: a fireball, and the wreck falls burning.
 */
export function foxTwoScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const D = 9;
  const h = f.heading + 60 * deg;
  const bandit = gearUp(makeAircraft(), 1);
  bandit.id = 900101;
  bandit.team = 1;
  setStores(bandit, capFit(1, 1, 0, 0));
  const banditTrack = flyPath({
    start: overFields(f, 6000, 3000, 850),
    headingRad: h,
    speed: 230,
    bankRad: -30 * deg,
    durationSec: D,
    afterburner: (t) => t > 2.0,
    roll: (t) => bellRate(t, 2.0, 2.6, -40 * deg),
    load: (t, s) => lerp(holdGamma(s, 0) + 0.3, 5, smooth01((t - 2.1) / 0.5)),
    seed: 31,
  });
  // The Tejas 550 m behind, a little low, in the same turn.
  const jet = gearUp(makeAircraft(), 1);
  const lead = (t: number): Vec3Like => {
    const b = makeAircraft();
    banditTrack.sample(Math.max(0, t), b);
    return b.pos;
  };
  const b0 = lead(0);
  const vh = v3(Math.sin(h), 0, -Math.cos(h));
  const track = flyPath({
    start: v3(b0.x - vh.x * 550, b0.y - 40, b0.z - vh.z * 550),
    headingRad: h + 5 * deg,
    gammaRad: 3 * deg,
    speed: 240,
    bankRad: -30 * deg,
    durationSec: D,
    afterburner: () => true,
    roll: (t) => bellRate(t, 2.6, 3.4, -15 * deg),
    load: (t, s) => lerp(holdGamma(s, 3 * deg) + 0.3, 3, smooth01((t - 2.8) / 0.6)),
    seed: 32,
  });
  // The inboard ASRAAM of the left twin rail at 1.4 s.
  const tL = 1.4;
  const st = station('wing-outer-l');
  const rp = releasePoint(track, tL, v3(st.x + 0.3, st.y - 0.32, st.z + 0.15));
  const msl = missileFlight({ t0: tL, pos0: rp.pos, vel0: rp.vel, fwd0: rp.fwd, ...ASRAAM, target: banditTrack, hitM: 5 });
  const tHit = msl.hit ? msl.t1 : D + 1;
  const hitPos = v3();
  const hitVel = v3();
  if (msl.hit) banditTrack.sample(tHit, Object.assign(makeAircraft(), { pos: hitPos, vel: hitVel }));
  const events: { t: number; ev: SimEvent }[] = [
    launchEv(tL, jet.id, 910001, 'ir_missile'),
    ...decoys(bandit.id, banditTrack, 1.9), ...decoys(bandit.id, banditTrack, 2.25), ...decoys(bandit.id, banditTrack, 2.6), ...decoys(bandit.id, banditTrack, 2.95),
  ];
  if (msl.hit) events.push({ t: tHit, ev: { type: 'explosion', pos: hitPos, radiusM: 16, vel: hitVel } });
  const ship = bodyShip(track, D, -24, 5, 11, 40, 3);
  const look = follower(D, 3, (t, o) => {
    track.sample(t, jet);
    // The bandit; after the hit, its wreck falling (carried on, slowing, dropping).
    const a = Math.max(0, t - tHit);
    const tgt = t < tHit ? lead(t) : v3(hitPos.x + hitVel.x * 0.8 * a * Math.exp(-a / 12), hitPos.y + hitVel.y * 0.5 * a - 4.9 * a * a * 0.6, hitPos.z + hitVel.z * 0.8 * a * Math.exp(-a / 12));
    const nose = fromJet(jet, 60, 0, 0, v3());
    o.x = lerp(nose.x, tgt.x, 0.75); o.y = lerp(nose.y, tgt.y, 0.75); o.z = lerp(nose.z, tgt.z, 0.75);
    return o;
  });
  const frame = newFrame(40, [jet, bandit]);
  frame.events = events;
  return {
    durationSec: D,
    timeOfDayH: 16.6,
    caption: { title: 'Fox two', place: 'Over Punjab' },
    frame(t) {
      frame.timeSec = t;
      track.sample(t, jet);
      setStores(jet, capFit(t < tL ? 2 : 1, 2));
      jet.afterburner = true;
      frame.aircraft = t < tHit ? [jet, bandit] : [jet];
      banditTrack.sample(Math.min(t, D), bandit);
      bandit.afterburner = t > 2.0;
      const m = flying(msl, 910001, code('asraam'), t);
      frame.stores = m ? [m] : [];
      shake(t, 0.08, 5, ship.pos(t, frame.camPos));
      look(t, frame.lookAt);
      track.sample(Math.max(0, t - 0.15), probeJet);
      rollUp(frame, probeJet.rot, 0.3);
      frame.fovDeg = 30;
      return frame;
    },
  };
}
const probeJet = makeAircraft();

/** Off the rail: a camera fixed on the left wingtip, behind the inboard ASRAAM: the motor lights and it is gone, its smoke filling the frame. */
export function offTheRailScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const D = 4;
  const jet = gearUp(makeAircraft(), 0.95);
  const track = flyPath({ start: overFields(f, -3000, 4000, 1200), headingRad: f.heading - 40 * deg, speed: 220, durationSec: D + 1, holdSpeed: true, load: (_t, s) => holdGamma(s, 2 * deg), turbulence: 0.6, seed: 41 });
  const tL = 1.0;
  const st = station('wing-outer-l');
  const rp = releasePoint(track, tL, v3(st.x + 0.3, st.y - 0.32, st.z + 0.15));
  // Away into empty sky, ahead and a touch up.
  const msl = missileFlight({ t0: tL, pos0: rp.pos, vel0: rp.vel, fwd0: rp.fwd, ...ASRAAM, maxSec: 6 });
  const frame = newFrame(46, [jet]);
  frame.events = [launchEv(tL, jet.id, 910002, 'ir_missile')];
  return {
    durationSec: D,
    timeOfDayH: 17.0,
    caption: { title: 'Off the rail', place: 'ASRAAM' },
    frame(t) {
      frame.timeSec = t;
      track.sample(t, jet);
      setStores(jet, capFit(t < tL ? 2 : 1, 2));
      const m = flying(msl, 910002, code('asraam'), t);
      frame.stores = m ? [m] : [];
      // Behind and outboard of the twin rail, a little above, looking along the missile.
      fromJet(jet, st.x - 4.2, st.y - 0.2, st.z - 1.0, frame.camPos);
      shake(t, 0.015 + 0.05 * bell(t, tL, tL + 0.8), 7, frame.camPos);
      fromJet(jet, st.x + 80, st.y - 1.2, st.z + 0.6, frame.lookAt);
      frame.fovDeg = 40;
      rollUp(frame, jet.rot, 1);
      return frame;
    },
  };
}

/** BVR: an Astra off the middle pylon, seen from abeam; it lofts away in a long climbing smoke arc. */
export function astraScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const D = 7;
  const jet = gearUp(makeAircraft(), 1);
  const track = flyPath({ start: overFields(f, 2000, -5000, 2500), headingRad: f.heading + 100 * deg, gammaRad: 4 * deg, speed: 250, durationSec: D + 1, holdSpeed: true, load: (_t, s) => holdGamma(s, 4 * deg), turbulence: 0.4, seed: 51 });
  const tL = 1.2;
  const st = station('wing-mid-r');
  const rp = releasePoint(track, tL, v3(st.x + 0.25, st.y - 0.35, st.z));
  // A notional target 25 km ahead: the missile lofts towards it.
  const far = makeAircraft();
  track.sample(0, far);
  const fwdH = Quat.rotate(far.rot, v3(1, 0, 0), v3());
  const tgt = flyPath({ start: v3(far.pos.x + fwdH.x * 25000, far.pos.y + 500, far.pos.z + fwdH.z * 25000), headingRad: f.heading + 280 * deg, speed: 250, durationSec: 20, holdSpeed: true, seed: 52 });
  const msl = missileFlight({ t0: tL, pos0: rp.pos, vel0: rp.vel, fwd0: rp.fwd, ...ASTRA, target: tgt, loft: 0.35, maxSec: 10, hitM: 1 });
  const frame = newFrame(36, [jet]);
  frame.events = [launchEv(tL, jet.id, 910003, 'radar_missile')];
  // The camera ship holds abeam on the right, a little behind and below, then lets the jet go.
  const ship = bodyShip(track, D, -8, -4, 26, 30, 2.5);
  return {
    durationSec: D,
    timeOfDayH: 16.2,
    caption: { title: 'Beyond visual range', place: 'Astra Mk1' },
    frame(t) {
      frame.timeSec = t;
      track.sample(t, jet);
      setStores(jet, capFit(2, 2, 1, t < tL ? 1 : 0));
      const m = flying(msl, 910003, code('astra-mk1'), t);
      frame.stores = m ? [m] : [];
      shake(t, 0.06, 11, ship.pos(t, frame.camPos));
      // On the jet, easing ahead of it so the smoke trail runs out across the frame.
      fromJet(jet, lerp(2, 18, smooth01((t - tL - 0.3) / 1.5)), 1, 0, frame.lookAt);
      frame.fovDeg = lerp(34, 55, smooth01((t - tL) / 2.5));
      return frame;
    },
  };
}

/** Guns: close in on the gun port, then the camera slides back; bursts into the sky ahead, tracers streaming, gun gas trailing. */
export function gunsScene(layout: AirportLayout, runway: RunwayDef, variant = 0): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const D = 5;
  const jet = gearUp(makeAircraft(), 0.95);
  setStores(jet, capFit());
  const track = flyPath({ start: overFields(f, 1000, 6000, 1800), headingRad: f.heading + 200 * deg, gammaRad: 3 * deg, speed: 210, bankRad: 20 * deg, durationSec: D + 1, holdSpeed: true, roll: (t) => bellRate(t, 0.4, 1.4, 15 * deg), load: (_t, s) => holdGamma(s, 3 * deg) + 0.6, turbulence: 0.9, seed: 61 });
  const gun = station('gun');
  // Bursts: 0.8-1.6 s, 2.2-2.8 s, 3.4-4.4 s at ~57 rounds/s.
  const rounds: { tf: number; p: Vec3Like; v: Vec3Like }[] = [];
  const events: { t: number; ev: SimEvent }[] = [];
  let k = 0;
  for (const [a, b] of [[0.8, 1.6], [2.2, 2.8], [3.4, 4.4]] as const) {
    for (let tf = a; tf < b; tf += 1 / 57) {
      const rp = releasePoint(track, tf, gun);
      const disp = () => (Math.sin(k * 12.9898) * 43758.5453 % 1) * 0.0016;
      const dir = v3(rp.fwd.x + disp(), rp.fwd.y + disp(), rp.fwd.z + disp());
      rounds.push({ tf, p: rp.pos, v: v3(rp.vel.x + dir.x * 690, rp.vel.y + dir.y * 690, rp.vel.z + dir.z * 690) });
      events.push({ t: tf, ev: { type: 'gunFire', shooterId: jet.id, pos: rp.pos, dir: rp.fwd, posBody: gun } });
      k++;
    }
  }
  const frame = newFrame(40, [jet]);
  frame.events = events;
  const bullets: { id: number; pos: Vec3Like; vel: Vec3Like }[] = [];
  return {
    durationSec: D,
    timeOfDayH: variant ? 18.5 : 16.8,
    caption: { title: 'Guns', place: 'GSh-23' },
    frame(t) {
      frame.timeSec = t;
      track.sample(t, jet);
      bullets.length = 0;
      rounds.forEach((r, i) => {
        const a = t - r.tf;
        if (a < 0 || a > 2.2) return;
        bullets.push({ id: 920000 + i, pos: v3(r.p.x + r.v.x * a, r.p.y + r.v.y * a - 0.5 * G * a * a, r.p.z + r.v.z * a), vel: v3(r.v.x, r.v.y - G * a, r.v.z) });
      });
      frame.bullets = bullets;
      // Ahead of and beside the gun, sliding back along the fuselage.
      const u = ease(clamp01(t / D));
      const side = Math.sign(gun.z) || 1;
      // Abeam on the gun side, a little ahead and low: the jet left of centre, the stream across the frame.
      fromJet(jet, lerp(7, 2, u), lerp(-2.5, -1.5, u), side * lerp(24, 20, u), frame.camPos);
      shake(t, 0.03, 13, frame.camPos);
      fromJet(jet, 12, 0, 0, frame.lookAt);
      rollUp(frame, jet.rot, 0.6);
      frame.fovDeg = 50;
      return frame;
    },
  };
}

/** Guns from behind: a chase as the Tejas hoses bursts; the tracer stream arcs away. */
export function gunsChaseScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const base = gunsScene(layout, runway, 1);
  const f = runwayFrame(layout, runway);
  void f;
  return {
    ...base,
    caption: { title: 'Guns', place: 'Night' },
    frame(t) {
      const fr = base.frame(t);
      const jet = fr.aircraft[0]!;
      fromJet(jet, -17, 2.6, -3.5, fr.camPos);
      shake(t, 0.05, 17, fr.camPos);
      fromJet(jet, 40, 0, 0, fr.lookAt);
      rollUp(fr, jet.rot, 0.8);
      fr.fovDeg = 42;
      return fr;
    },
  };
}

/**
 * Bombs away: a strike Tejas at 300 m and 220 m/s releases both HSLD-450s, breaks away left
 * pumping flares; the bombs fall 8 s onto the fields and explode. Camera 0: from beside and below
 * its path, picking the release; camera 1: chasing the bombs down to the impact.
 */
export function bombScene(layout: AirportLayout, runway: RunwayDef, cam = 0): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const D = 12;
  const jet = gearUp(makeAircraft(), 1);
  const ground = f.elev;
  const track = flyPath({
    start: overFields(f, -6000, -4000, 300),
    headingRad: f.heading + 25 * deg,
    speed: 220,
    durationSec: D + 1,
    afterburner: (t) => t > 2.4,
    roll: (t) => bellRate(t, 2.3, 2.9, -75 * deg),
    load: (t, s) => lerp(holdGamma(s, 0), 4.5, smooth01((t - 2.6) / 0.5)),
    holdSpeed: true,
    seed: 71,
  });
  const tRel = [1.5, 1.62];
  const inner = [station('wing-inner-l'), station('wing-inner-r')];
  const bombs = tRel.map((tr, i) => {
    const b = inner[i]!;
    const rp = releasePoint(track, tr, v3(b.x, b.y - 0.45, b.z));
    return bombFlight(tr, rp.pos, v3(rp.vel.x, rp.vel.y - 2.5, rp.vel.z), ground);
  });
  const events: { t: number; ev: SimEvent }[] = [];
  for (const b of bombs) {
    const p = v3();
    b.sample(b.t1, p, v3());
    p.y = ground;
    events.push({ t: b.t1, ev: { type: 'groundImpact', pos: p, explosiveKg: 200 } });
    events.push({ t: b.t1, ev: { type: 'explosion', pos: v3(p.x, p.y + 4, p.z), radiusM: 11 } });
  }
  for (let i = 0; i < 6; i++) events.push(...decoys(jet.id, track, 2.7 + i * 0.28));
  const frame = newFrame(40, [jet]);
  frame.events = events;
  jet.groundY = ground;
  // Camera 0: on a low hill beside the run, ahead of the release point.
  const rel = makeAircraft();
  track.sample(tRel[0]!, rel);
  const fwd = Quat.rotate(rel.rot, v3(1, 0, 0), v3());
  const right = v3(-fwd.z, 0, fwd.x);
  const cam0 = v3(rel.pos.x + fwd.x * 450 + right.x * 260, ground + 40, rel.pos.z + fwd.z * 450 + right.z * 260);
  const hit = v3();
  bombs[0]!.sample(bombs[0]!.t1, hit, v3());
  const cam1 = v3(hit.x - fwd.x * 120 - right.x * 360, ground + 12, hit.z - fwd.z * 120 - right.z * 360);
  return {
    durationSec: D,
    timeOfDayH: 17.3,
    caption: { title: 'Bombs away', place: 'HSLD-450' },
    frame(t) {
      frame.timeSec = t;
      track.sample(t, jet);
      setStores(jet, strikeFit(t < tRel[0]! ? 1 : 0, t < tRel[1]! ? 1 : 0));
      frame.stores = bombs.map((b, i) => flying(b, 911000 + i, code('hsld-450'), t, 0.04)).filter((s): s is ShowcaseStore => !!s);
      if (cam === 0) {
        Object.assign(frame.camPos, cam0);
        shake(t, 0.05, 19, frame.camPos);
        // On the jet, then down with the bombs.
        const bp = v3();
        bombs[0]!.sample(Math.max(t, tRel[0]!), bp, v3());
        const w = smooth01((t - 3.2) / 2.2);
        frame.lookAt.x = lerp(jet.pos.x, bp.x, w);
        frame.lookAt.y = lerp(jet.pos.y, bp.y, w);
        frame.lookAt.z = lerp(jet.pos.z, bp.z, w);
        frame.fovDeg = jetFov(distance(frame.camPos, frame.lookAt), lerp(0.55, 0.12, w), 6, 60);
      } else {
        Object.assign(frame.camPos, cam1);
        shake(t, 0.04 + 0.5 * bell(t, bombs[0]!.t1 + 0.9, bombs[0]!.t1 + 2.2), 19, frame.camPos);
        // The bombs falling in (held tight), then wide for the blast.
        const bp = v3();
        bombs[0]!.sample(Math.min(Math.max(t, tRel[0]!), bombs[0]!.t1), bp, v3());
        if (t < tRel[0]!) Object.assign(bp, jet.pos);
        const w = smooth01((t - bombs[0]!.t1 + 0.6) / 0.8);
        frame.lookAt.x = lerp(bp.x, hit.x, w);
        frame.lookAt.y = lerp(bp.y, ground + 30, w);
        frame.lookAt.z = lerp(bp.z, hit.z, w);
        frame.fovDeg = lerp(jetFov(distance(frame.camPos, bp), 0.5, 3, 40), 34, w);
      }
      return frame;
    },
  };
}

/** Flares: from behind and below, a Tejas breaks hard on afterburner pumping pair after pair of flares; the smoke arcs hang like wings. */
export function flareScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const D = 7;
  const jet = gearUp(makeAircraft(), 1);
  setStores(jet, capFit());
  const track = flyPath({
    start: overFields(f, 4000, 5000, 1400),
    headingRad: f.heading - 120 * deg,
    speed: 220,
    durationSec: D + 1,
    afterburner: (t) => t > 0.6,
    roll: (t) => bellRate(t, 0.5, 1.1, 70 * deg),
    load: (t, s) => lerp(holdGamma(s, 0), 6, smooth01((t - 0.9) / 0.5)),
    seed: 81,
  });
  const events: { t: number; ev: SimEvent }[] = [];
  for (let i = 0; i < 12; i++) events.push(...decoys(jet.id, track, 1.0 + i * 0.22));
  const frame = newFrame(50, [jet]);
  frame.events = events;
  const ship = chaseShip(track, D, 70, -18, -25, 1.6);
  return {
    durationSec: D,
    timeOfDayH: 17.6,
    caption: { title: 'Flares', place: 'Over Punjab' },
    frame(t) {
      frame.timeSec = t;
      track.sample(t, jet);
      jet.afterburner = t > 0.6;
      shake(t, 0.08, 23, ship.pos(t, frame.camPos));
      ship.look(t, frame.lookAt);
      frame.fovDeg = 46;
      return frame;
    },
  };
}

/** Afterburner: right behind the nozzle in a climbing turn, the flame's shock diamonds roaring at the lens. */
export function burnerScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const D = 5;
  const jet = gearUp(makeAircraft(), 1);
  setStores(jet, capFit());
  const track = flyPath({ start: overFields(f, -2000, -6000, 900), headingRad: f.heading + 160 * deg, gammaRad: 12 * deg, speed: 230, bankRad: 35 * deg, durationSec: D + 1, afterburner: () => true, load: (_t, s) => holdGamma(s, 15 * deg) + 1, holdSpeed: true, turbulence: 1, seed: 91 });
  const frame = newFrame(50, [jet]);
  return {
    durationSec: D,
    timeOfDayH: 18.2,
    caption: { title: 'Afterburner', place: 'GE F404' },
    frame(t) {
      frame.timeSec = t;
      track.sample(t, jet);
      jet.afterburner = true;
      jet.throttle = 1;
      const u = ease(clamp01(t / D));
      fromJet(jet, lerp(-11, -15, u), lerp(1.4, 0.8, u), lerp(2.6, -2.2, u), frame.camPos);
      shake(t, 0.05, 29, frame.camPos);
      fromJet(jet, -4.5, 0.1, 0, frame.lookAt);
      rollUp(frame, jet.rot, 1);
      frame.fovDeg = 52;
      return frame;
    },
  };
}

/** Weapons close up: a slow macro dolly along the right wing of a CAP-loaded Tejas, from the ASRAAMs on their twin rail in to the Astra and the tank. */
export function weaponsCloseScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const D = 8;
  const jet = gearUp(makeAircraft(), 0.85);
  setStores(jet, capFit());
  const track = flyPath({ start: overFields(f, 0, 7000, 1500), headingRad: f.heading + 70 * deg, speed: 190, durationSec: D + 1, holdSpeed: true, load: (_t, s) => holdGamma(s, 1 * deg), turbulence: 0.35, seed: 101 });
  const o = station('wing-outer-r');
  const m = station('wing-mid-r');
  const frame = newFrame(34, [jet]);
  return {
    durationSec: D,
    timeOfDayH: 17.4,
    caption: { title: 'Loaded', place: 'ASRAAM · Astra Mk1' },
    frame(t) {
      frame.timeSec = t;
      track.sample(t, jet);
      const u = ease(clamp01(t / D));
      // From ahead of the ASRAAMs' noses, below the wing, sliding inboard and aft past the Astra.
      fromJet(jet, lerp(o.x + 3.3, m.x + 1.6, u), lerp(-1.1, -1.5, u), lerp(o.z + 1.2, m.z - 0.9, u), frame.camPos);
      shake(t, 0.01, 31, frame.camPos);
      fromJet(jet, lerp(o.x - 0.2, m.x - 1.0, u), lerp(-0.55, -0.6, u), lerp(o.z - 0.1, m.z + 0.3, u), frame.lookAt);
      rollUp(frame, jet.rot, 1);
      frame.fovDeg = lerp(40, 46, u);
      return frame;
    },
  };
}

/** Strike fit close up: under the fuselage looking aft past the Litening pod at the bombs on their racks. */
export function strikeCloseScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const D = 7;
  const jet = gearUp(makeAircraft(), 0.9);
  setStores(jet, strikeFit());
  const track = flyPath({ start: overFields(f, -5000, 2000, 600), headingRad: f.heading - 160 * deg, speed: 200, durationSec: D + 1, holdSpeed: true, load: (_t, s) => holdGamma(s, 0), turbulence: 0.5, seed: 111 });
  const frame = newFrame(50, [jet]);
  return {
    durationSec: D,
    timeOfDayH: 16.9,
    caption: { title: 'Strike', place: 'HSLD · Litening' },
    frame(t) {
      frame.timeSec = t;
      track.sample(t, jet);
      const u = ease(clamp01(t / D));
      fromJet(jet, lerp(4.2, 0.5, u), lerp(-2.0, -2.3, u), lerp(-2.3, -3.6, u), frame.camPos);
      shake(t, 0.012, 37, frame.camPos);
      fromJet(jet, lerp(1.0, -1.6, u), -1.0, lerp(-0.9, -1.8, u), frame.lookAt);
      rollUp(frame, jet.rot, 1);
      frame.fovDeg = lerp(52, 58, u);
      return frame;
    },
  };
}

/** Transonic: a ground camera beside the fields; a Tejas at Mach 0.97 and 30 m, the vapour cone round it, whips past and pulls up. */
export function transonicScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const D = 4.5;
  const jet = gearUp(makeAircraft(), 1);
  setStores(jet, capFit());
  jet.afterburner = true;
  jet.groundY = f.elev;
  const camP = overFields(f, 3500, -2500, 2);
  const track0 = flyPath({
    start: v3(),
    headingRad: f.heading + 90 * deg,
    speed: 330,
    durationSec: D + 1,
    holdSpeed: true,
    afterburner: () => true,
    load: (t, s) => lerp(holdGamma(s, 0), 4, smooth01((t - 2.4) / 0.4)),
    turbulence: 1.4,
    seed: 121,
  });
  const p2 = makeAircraft();
  track0.sample(2, p2);
  const fw = Quat.rotate(p2.rot, v3(1, 0, 0), v3());
  // Through a point 30 m right of the camera, 30 m up, at t = 2.
  const track = track0.anchor(2, v3(camP.x - fw.z * 40, f.elev + 30, camP.z + fw.x * 40));
  const frame = newFrame(40, [jet]);
  const look = follower(D, 20, (t, o) => {
    track.sample(t, probeJet);
    return Object.assign(o, probeJet.pos);
  });
  return {
    durationSec: D,
    timeOfDayH: 17.1,
    caption: { title: 'Transonic', place: 'Low level' },
    frame(t) {
      frame.timeSec = t;
      track.sample(t, jet);
      Object.assign(frame.camPos, camP);
      shake(t, 0.03 + 0.15 * bell(t, 1.8, 2.8), 41, frame.camPos);
      look(t, frame.lookAt);
      frame.fovDeg = jetFov(distance(frame.camPos, jet.pos), 0.45, 12, 75);
      return frame;
    },
  };
}

/** Scramble: a low camera at the runway's edge, right behind the nozzle as the afterburner lights and the jet rolls away. */
export function scrambleScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const D = 9;
  const jet = makeAircraft();
  jet.afterburner = true;
  jet.throttle = 1;
  jet.groundY = f.elev;
  const q: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  const frame = newFrame(30, [jet]);
  return {
    durationSec: D,
    timeOfDayH: 17.5,
    caption: { title: 'Scramble', place: 'Bhisiana AFS' },
    frame(t) {
      frame.timeSec = t;
      // The take-off shot's clock from 1 s before the brakes come off.
      takeoff(f, jet, t + 0.6, q);
      jet.afterburner = t > 0.4;
      at(f, 34, 6, 0.7, frame.camPos);
      shake(t, 0.02 + 0.06 * bell(t, 0.5, 4), 43, frame.camPos);
      const tail = fromJet(jet, -5.5, 0.9, 0, v3());
      Object.assign(frame.lookAt, tail);
      // From behind it shows its height, not its length: keep it filling the frame as it goes.
      frame.fovDeg = jetFov(distance(frame.camPos, jet.pos), 2.4, 3, 50);
      return frame;
    },
  };
}

void setRot;
void deg;
void at;

/** The promo's shots, by index (?showcase=p<i>,<t>); tools/promo/capturePromo.mjs decides the cut. */
export const PROMO_SHOTS: readonly ((layout: AirportLayout, runway: RunwayDef) => ShowcaseScene)[] = [
  scrambleScene, // 0
  weaponsCloseScene, // 1
  strikeCloseScene, // 2
  foxTwoScene, // 3
  offTheRailScene, // 4
  astraScene, // 5
  gunsScene, // 6
  gunsChaseScene, // 7
  (l, r) => bombScene(l, r, 0), // 8
  (l, r) => bombScene(l, r, 1), // 9
  flareScene, // 10
  burnerScene, // 11
  transonicScene, // 12
];
export type { RunwayFrame };
