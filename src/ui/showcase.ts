/**
 * src/ui/showcase.ts — the main menu's cinematic: shots of Bhisiana (Bathinda) with a Tejas doing
 * something worth watching. It opens on the jet itself: air-to-air, a camera ship holding station
 * off a fully loaded Tejas over the base and easing round it; then a low pass down the runway that
 * ends in an afterburner pull-up into the vertical. Golden hour: a slow pass over the base onto a Tejas on final, touching
 * down a few hundred metres in. Late afternoon: a Tejas taxiing head-on, seen from the grass. Night:
 * an afterburner take-off tracked from beside the runway. (departureScene, INS Hansa, is kept for
 * when that base is tested.) Everything is placed from the base's own runway and taxiways.
 *
 * Pure: `frame(t)` is a function of the time into the scene. src/main.ts loads the base's world,
 * plays the scenes behind the menus and fades between them.
 */
import type { AirportLayout, RunwayDef } from '../contracts/airport';
import type { ShowcaseAircraft, ShowcaseFrame } from '../contracts/render';
import { EntityFlag, STORE_IDS, StoreRack, packStoreSlot, packStoreSlots, type QuatLike, type Vec3Like } from '../contracts/core';
import { Quat } from '../math';
import { buildAirfieldAids } from '../airport/airfieldAids';

export interface ShowcaseScene {
  /** How long the scene plays, s (fades included). */
  durationSec: number;
  timeOfDayH: number;
  /** The shot's caption under the menu (lower third): what it is, and where. */
  caption: { title: string; place: string };
  frame(tSec: number): ShowcaseFrame;
}

/** The default CAP fit, packed for the snapshot's STORES / STORES_B fields (slots: outer, middle, inner, centreline). */
export function capStores(): { a: number; b: number } {
  const code = (id: string): number => STORE_IDS.indexOf(id);
  const slots = [
    packStoreSlot(code('asraam'), 2, StoreRack.TwinRail),
    packStoreSlot(code('asraam'), 2, StoreRack.TwinRail),
    packStoreSlot(code('astra-mk1'), 1, StoreRack.Single),
    packStoreSlot(code('astra-mk1'), 1, StoreRack.Single),
    packStoreSlot(code('tank-1200l'), 1, StoreRack.Single),
    packStoreSlot(code('tank-1200l'), 1, StoreRack.Single),
  ];
  return packStoreSlots(slots, { a: 0, b: 0 });
}

export interface RunwayFrame {
  /** Threshold, ground level. */
  tx: number;
  tz: number;
  elev: number;
  heading: number;
  /** Unit vectors along the runway and to its right, world x/z. */
  dx: number;
  dz: number;
  rx: number;
  rz: number;
}

export function runwayFrame(layout: AirportLayout, runway: RunwayDef): RunwayFrame {
  const h = runway.headingRad;
  return { tx: runway.thresholdWorldX, tz: runway.thresholdWorldZ, elev: layout.elevationM, heading: h, dx: Math.sin(h), dz: -Math.cos(h), rx: Math.cos(h), rz: Math.sin(h) };
}

/** A point `along` metres down the runway from the threshold, `right` metres to its right, `up` above the field. */
export function at(f: RunwayFrame, along: number, right: number, up: number, out: Vec3Like): Vec3Like {
  out.x = f.tx + f.dx * along + f.rx * right;
  out.y = f.elev + up;
  out.z = f.tz + f.dz * along + f.rz * right;
  return out;
}


export function makeAircraft(): ShowcaseAircraft {
  const stores = capStores();
  return { id: 900001, pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: 0, z: 0 }, gearPos: 1, throttle: 0.5, afterburner: false, flags: 0, stores: stores.a, storesB: stores.b };
}

export const deg = Math.PI / 180;
/** Where the subject sits across the screen (fraction of the width right of centre), clear of the menu on the left. */
const SUBJECT_OFFSET_X = 0.2;
/**
 * The main wheels' contact points below and behind the aircraft's origin (tejasGeometry.ts gear,
 * fully extended), and how far the loaded oleos sit compressed when it rests on them, m.
 */
const MAIN_WHEEL_DOWN_M = 1.7;
const MAIN_WHEEL_AFT_M = 0.75;
const OLEO_SAG_M = 0.1;
/** Height of the aircraft's origin above the ground, parked on its wheels. */
const GEAR_HEIGHT_M = MAIN_WHEEL_DOWN_M - OLEO_SAG_M;
/** The origin's height over the main wheels at a pitch (it pivots on them), oleos `sag` m compressed. */
export const onMainWheels = (pitchRad: number, sag = OLEO_SAG_M): number =>
  MAIN_WHEEL_AFT_M * Math.sin(pitchRad) + (MAIN_WHEEL_DOWN_M - sag) * Math.cos(pitchRad);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const ease = (t: number): number => t * t * (3 - 2 * t);

/** Where the base's buildings are, in runway coordinates: metres along from the threshold and to the right. */
export interface Hub {
  along: number;
  right: number;
}

/** The middle of the base's shelters, hangars and parking (the reference point if it has none). */
export function baseHub(layout: AirportLayout, f: RunwayFrame): Hub {
  const pts: { worldX: number; worldZ: number }[] = [...layout.parkingSpots, ...(layout.structures ?? [])];
  if (pts.length === 0) pts.push({ worldX: layout.referenceWorldX, worldZ: layout.referenceWorldZ });
  let along = 0;
  let right = 0;
  for (const q of pts) {
    along += (q.worldX - f.tx) * f.dx + (q.worldZ - f.tz) * f.dz;
    right += (q.worldX - f.tx) * f.rx + (q.worldZ - f.tz) * f.rz;
  }
  return { along: along / pts.length, right: right / pts.length };
}

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * The shared camera move: from the far side of the base's buildings, a slow high pass looking across
 * the base, then easing down while the view turns onto the jet and closes in (a long lens), so the
 * scene opens wide on the airbase and ends on the aircraft.
 */
function baseCamera(f: RunwayFrame, hub: Hub, jet: ShowcaseAircraft, t: number, durationSec: number, alongFrom: number, alongTo: number, frame: ShowcaseFrame, look: Vec3Like): void {
  // Climbs with a departing jet, so the view stays on it without tilting up into empty sky.
  const climb = Math.max(0, jet.pos.y - GEAR_HEIGHT_M - f.elev - 20) * 0.85;
  const u = ease(clamp01(t / durationSec));
  // Beyond the buildings, on their side of the runway, drifting in over them towards the runway.
  const side = hub.right < 0 ? -1 : 1;
  const lateral = side * lerp(Math.max(150, Math.abs(hub.right)) + 700, 320, u);
  at(f, lerp(alongFrom, alongTo, u), lateral, lerp(320, 110, u) + climb, frame.camPos);
  // Looking at the buildings first, then at the jet.
  at(f, hub.along, hub.right, 0, look);
  // A slow turn (~15 s) so the jet drifts into the frame rather than being swung to.
  const w = ease(clamp01((t - 2) / (durationSec * 0.6)));
  frame.lookAt.x = lerp(look.x, jet.pos.x, w);
  frame.lookAt.y = lerp(look.y, jet.pos.y, w);
  frame.lookAt.z = lerp(look.z, jet.pos.z, w);
  frame.fovDeg = lerp(44, 13, ease(clamp01((t - 6) / (durationSec * 0.6))));
}

export function setRot(jet: ShowcaseAircraft, q: QuatLike): void {
  jet.rot.x = q.x;
  jet.rot.y = q.y;
  jet.rot.z = q.z;
  jet.rot.w = q.w;
}

/**
 * The field of view that keeps an aircraft `fraction` of the view's height tall at `distM` (a long
 * lens that zooms out as it comes closer), within [minDeg, maxDeg].
 */
export function jetFov(distM: number, fraction: number, minDeg: number, maxDeg: number): number {
  const fov = (2 * Math.atan(13.2 / (2 * fraction * Math.max(1, distM)))) / deg;
  return Math.min(maxDeg, Math.max(minDeg, fov));
}

export function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Where the approach touches down: metres past the threshold (the aiming point is at 400 m). */
const TOUCHDOWN_M = 350;
/** The flare: the last this-many metres before touchdown round out of the 3 deg path. */
const FLARE_M = 150;

/**
 * Bathinda at golden hour: a slow pass across the airbase, then onto a Tejas on a 3 deg final
 * approach (landing light on) as it flares, touches down a few hundred metres in and rolls out.
 */
export function approachScene(layout: AirportLayout, runway: RunwayDef, durationSec = 26): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const hub = baseHub(layout, f);
  const jet = makeAircraft();
  jet.flags = EntityFlag.Lights | EntityFlag.LightsStrobe | EntityFlag.LightsLanding;
  jet.throttle = 0.55;
  jet.groundY = f.elev;
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 44, offsetX: SUBJECT_OFFSET_X, aircraft: [jet] };
  const glide = Math.tan(3 * deg);
  const q: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  const look: Vec3Like = { x: 0, y: 0, z: 0 };
  return {
    durationSec,
    caption: { title: 'Finals', place: 'Bhisiana AFS · Runway' },
    timeOfDayH: 17.25,
    frame(t) {
      // Approach: 1.5 km from touchdown at 72 m/s (down at ~21 s), then the landing roll.
      let dist = 1500 - 72 * t;
      let speed = 72;
      let height = 0;
      let sink = 0;
      let pitch = 4 * deg;
      if (dist > FLARE_M) {
        height = dist * glide;
        sink = speed * glide;
      } else if (dist > 0) {
        // Rounded out: a cubic from the glide path (same height and slope at FLARE_M) to a gentle
        // touchdown (a tenth of the glide slope), the nose coming up a few degrees.
        const s1 = dist / FLARE_M;
        height = FLARE_M * glide * (-0.9 * s1 * s1 * s1 + 1.8 * s1 * s1 + 0.1 * s1);
        sink = speed * glide * (-2.7 * s1 * s1 + 3.6 * s1 + 0.1);
        pitch = 4 * deg + 3 * deg * (1 - s1);
      } else {
        const tr = -dist / 72;
        speed = Math.max(20, 72 - 6 * tr);
        dist = -(72 * tr - 3 * tr * tr);
        pitch = Math.max(0, 7 * deg - tr * 2.5 * deg);
      }
      // Airborne the oleos hang fully extended; on the ground they settle under the weight.
      const sag = dist < 0 ? OLEO_SAG_M * clamp01(-dist / 60) : 0;
      at(f, TOUCHDOWN_M - dist, 0, onMainWheels(pitch, sag) + height, jet.pos);
      setRot(jet, Quat.fromYawPitchRoll(f.heading, pitch, 0, q));
      jet.vel.x = f.dx * speed;
      jet.vel.y = -sink;
      jet.vel.z = f.dz * speed;
      baseCamera(f, hub, jet, t, durationSec, -400, 650, frame, look);
      return frame;
    },
  };
}

const LIFTOFF_SEC = 12;

/**
 * A take-off from the threshold: held 2 s, then rolling on afterburner, lifting off at 12 s and
 * climbing out, gear up from 15 s. Sets the jet's pose, speed, gear and lights for time t.
 */
function takeoff(f: RunwayFrame, jet: ShowcaseAircraft, t: number, q: QuatLike): void {
  const tr = Math.max(0, t - 2);
  const v = 3 + 7.2 * tr;
  const along = 60 + 3 * tr + 3.6 * tr * tr;
  const air = Math.max(0, t - LIFTOFF_SEC);
  const height = air * air * 0.9 + air * 3;
  const climb = air > 0 ? (2 * 0.9 * air + 3) / v : 0;
  const rotate = ease(clamp01((t - (LIFTOFF_SEC - 1.6)) / 1.6));
  // The nose comes up smoothly, and keeps easing up towards the climb attitude (no corner at 12 deg).
  const want = Math.max(Math.atan(climb) + 4 * deg * rotate, rotate * 8 * deg);
  const pitch = 13 * deg * Math.tanh(want / (13 * deg));
  // On the roll a little runway texture through the oleos, fading as the wings take the weight.
  const rumble = (1 - rotate) * Math.min(1, tr / 2) * (air > 0 ? 0 : 1);
  const bump = rumble * 0.12 * deg * (Math.sin(t * 23.1) * 0.6 + Math.sin(t * 37.7 + 1.3) * 0.4);
  const sag = OLEO_SAG_M * (1 - rotate);
  at(f, along, 0, onMainWheels(pitch, sag) + height, jet.pos);
  setRot(jet, Quat.fromYawPitchRoll(f.heading, pitch + bump, rumble * 0.08 * deg * Math.sin(t * 17.3), q));
  jet.vel.x = f.dx * v;
  jet.vel.y = v * climb;
  jet.vel.z = f.dz * v;
  jet.gearPos = t < LIFTOFF_SEC + 3 ? 1 : Math.max(0, 1 - (t - LIFTOFF_SEC - 3) / 2);
  jet.flags = EntityFlag.Lights | EntityFlag.LightsStrobe | (jet.gearPos > 0.9 ? EntityFlag.LightsLanding : 0);
}

/**
 * INS Hansa in the morning: a slow pass across the air station, then onto a Tejas rolling on
 * afterburner as it lifts off and climbs away, gear coming up. Not in the menu's loop while the
 * base is untested.
 */
export function departureScene(layout: AirportLayout, runway: RunwayDef, durationSec = 26): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const hub = baseHub(layout, f);
  const jet = makeAircraft();
  jet.afterburner = true;
  jet.throttle = 1;
  jet.groundY = f.elev;
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 44, offsetX: SUBJECT_OFFSET_X, aircraft: [jet] };
  const q: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  const look: Vec3Like = { x: 0, y: 0, z: 0 };
  return {
    durationSec,
    caption: { title: 'Departure', place: 'INS Hansa · Goa' },
    timeOfDayH: 8.3,
    frame(t) {
      takeoff(f, jet, t, q);
      baseCamera(f, hub, jet, t, durationSec, 0, 1500, frame, look);
      return frame;
    },
  };
}

/**
 * Bathinda at nightfall (blue hour, runway and town lights on): from low beside the runway behind
 * the start of the roll, a long lens follows a Tejas away on afterburner, lifting off and climbing
 * into the dark with its flame and strobes.
 */
export function nightDepartureScene(layout: AirportLayout, runway: RunwayDef, durationSec = 26): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const hub = baseHub(layout, f);
  const jet = makeAircraft();
  jet.afterburner = true;
  jet.throttle = 1;
  jet.groundY = f.elev;
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 30, offsetX: SUBJECT_OFFSET_X, aircraft: [jet] };
  const q: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  // Behind the start of the roll (the jet lines up 60 m in), off to the side away from the
  // buildings: the whole take-off is seen from behind, into the afterburner.
  const side = hub.right < 0 ? 1 : -1;
  return {
    durationSec,
    caption: { title: 'Night launch', place: 'Bhisiana AFS · Bathinda' },
    timeOfDayH: 18.8,
    frame(t) {
      takeoff(f, jet, t, q);
      const u = clamp01(t / durationSec);
      at(f, lerp(-170, -130, u), side * 55, lerp(2.5, 4, u), frame.camPos);
      frame.lookAt.x = jet.pos.x;
      frame.lookAt.y = jet.pos.y + 0.5;
      frame.lookAt.z = jet.pos.z;
      // From behind the jet shows its height and span, not its length (see taxiScene).
      frame.fovDeg = jetFov(distance(frame.camPos, jet.pos), 0.6, 3, 50);
      return frame;
    },
  };
}

/**
 * Bathinda in the late afternoon, from the ground: a Tejas taxiing head-on down the base's longest
 * straight taxiway towards the runway, taxi light on, the camera low on the grass beside it.
 */
export function taxiScene(layout: AirportLayout, runway: RunwayDef, durationSec = 24): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  // The longest straight taxiway leg, driven towards the runway's threshold.
  let leg: { ax: number; az: number; bx: number; bz: number; len: number; hw: number } | undefined;
  for (const tw of layout.taxiways) {
    for (let i = 0; i + 1 < tw.points.length; i++) {
      const a = tw.points[i]!;
      const b = tw.points[i + 1]!;
      const len = Math.hypot(b.worldX - a.worldX, b.worldZ - a.worldZ);
      if (!leg || len > leg.len) leg = { ax: a.worldX, az: a.worldZ, bx: b.worldX, bz: b.worldZ, len, hw: tw.widthM / 2 };
    }
  }
  const L = leg ?? { ax: f.tx - f.dx * 400, az: f.tz - f.dz * 400, bx: f.tx, bz: f.tz, len: 400, hw: 10 };
  if (Math.hypot(L.ax - f.tx, L.az - f.tz) < Math.hypot(L.bx - f.tx, L.bz - f.tz)) {
    [L.ax, L.az, L.bx, L.bz] = [L.bx, L.bz, L.ax, L.az];
  }
  const dx = (L.bx - L.ax) / L.len;
  const dz = (L.bz - L.az) / L.len;
  const heading = Math.atan2(dx, -dz);
  const rx = Math.cos(heading);
  const rz = Math.sin(heading);
  // The camera beside the leg, on the side away from the runway if it can, where no sign, mast,
  // windsock or building stands between it and the jet's path.
  const toRunway = (f.tx - L.ax) * rx + (f.tz - L.az) * rz;
  const aids = buildAirfieldAids(layout);
  const obstacles: [number, number, number][] = [
    ...aids.signs.map((g): [number, number, number] => [g.x, g.z, 3]),
    ...aids.windsocks.map(([x, z]): [number, number, number] => [x, z, 3]),
    ...aids.floodlights.map(([x, z]): [number, number, number] => [x, z, 3]),
    ...(layout.structures ?? []).map((g): [number, number, number] => [g.worldX, g.worldZ, Math.max(g.widthM, g.lengthM) / 2 + 3]),
  ];
  const camLat = L.hw + 9;
  const clear = (camAt: number, sd: number): boolean =>
    obstacles.every(([x, z, r]) => {
      const a = (x - L.ax) * dx + (z - L.az) * dz;
      const lat = sd * ((x - L.ax) * rx + (z - L.az) * rz);
      return !(a > camAt - 300 && a < camAt + 5 && lat > -r && lat < camLat + r);
    });
  let side = toRunway > 0 ? -1 : 1;
  let camS = Math.min(L.len * 0.75, 700);
  search: for (let c = camS; c >= 330; c -= 20) {
    for (const sd of [side, -side]) {
      if (clear(c, sd)) {
        camS = c;
        side = sd;
        break search;
      }
    }
  }
  const speed = 8.5;
  const startS = camS - 45 - speed * (durationSec - 1.5);
  const jet = makeAircraft();
  jet.flags = EntityFlag.Lights | EntityFlag.LightsLanding;
  jet.throttle = 0.3;
  jet.groundY = f.elev;
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 20, offsetX: SUBJECT_OFFSET_X, aircraft: [jet] };
  const q: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  setRot(jet, Quat.fromYawPitchRoll(heading, 0, 0, q));
  return {
    durationSec,
    caption: { title: 'Taxi', place: 'Bhisiana AFS · Bathinda' },
    timeOfDayH: 17.0,
    frame(t) {
      // Rolling up to taxi speed over the first 3 s.
      const s = startS + speed * (t < 3 ? (t * t) / 6 : t - 1.5);
      const v = speed * Math.min(1, t / 3);
      jet.pos.x = L.ax + dx * s;
      // The oleos working over the taxiway's slab joints (a damped nod every ~5 m) and its camber.
      const slab = s / 5;
      const nod = Math.exp(-3 * (slab - Math.floor(slab))) * Math.sin((slab - Math.floor(slab)) * 14);
      const ride = (v / speed) * (0.22 * deg * nod + 0.08 * deg * Math.sin(t * 1.7));
      jet.pos.y = f.elev + onMainWheels(ride) + 0.012 * (v / speed) * nod;
      setRot(jet, Quat.fromYawPitchRoll(heading, ride, (v / speed) * 0.15 * deg * Math.sin(t * 1.1 + 0.4), q));
      jet.pos.z = L.az + dz * s;
      jet.vel.x = dx * v;
      jet.vel.y = 0;
      jet.vel.z = dz * v;
      const u = clamp01(t / durationSec);
      const lat = side * lerp(camLat, camLat - 3, ease(u));
      frame.camPos.x = L.ax + dx * camS + rx * lat;
      frame.camPos.y = f.elev + lerp(1.3, 2.0, ease(u));
      frame.camPos.z = L.az + dz * camS + rz * lat;
      frame.lookAt.x = jet.pos.x;
      frame.lookAt.y = jet.pos.y + 0.6;
      frame.lookAt.z = jet.pos.z;
      // Head-on the jet shows its 4.4 m height, not its length: 0.8 of 13.2 m keeps it ~1/4 of the view.
      frame.fovDeg = jetFov(distance(frame.camPos, jet.pos), 0.8, 3.5, 55);
      return frame;
    },
  };
}

/**
 * Air-to-air over Bhisiana in the late afternoon: a camera ship holds station off a Tejas carrying
 * the full CAP fit, 450 m above the base, and eases round it from ahead of the wing to its rear
 * quarter while the jet rocks gently through a few degrees of bank.
 */
export function airToAirScene(layout: AirportLayout, runway: RunwayDef, durationSec = 22): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const hub = baseHub(layout, f);
  const jet = makeAircraft();
  jet.gearPos = 0;
  jet.throttle = 0.78;
  jet.flags = EntityFlag.Lights | EntityFlag.LightsStrobe;
  const speed = 150;
  // The camera on the side away from the buildings: they pass beneath, beyond the jet.
  const side = hub.right < 0 ? 1 : -1;
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 32, offsetX: 0.15, aircraft: [jet] };
  const q: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  return {
    durationSec,
    timeOfDayH: 16.9,
    caption: { title: 'Air-to-air', place: 'Tejas Mk1A · over Bhisiana AFS' },
    frame(t) {
      const along = -1800 + speed * t;
      const lat = hub.right * 0.6;
      const height = 450 + 6 * Math.sin(t * 0.35);
      at(f, along, lat, height, jet.pos);
      const roll = 7 * deg * Math.sin(t * 0.42) - 3 * deg;
      setRot(jet, Quat.fromYawPitchRoll(f.heading, 2.5 * deg, roll, q));
      jet.vel.x = f.dx * speed;
      jet.vel.y = 0;
      jet.vel.z = f.dz * speed;
      // Round from 35 deg off the nose to 150 deg (the rear quarter), drifting a little wider and lower.
      const u = ease(clamp01(t / durationSec));
      const th = lerp(35, 150, u) * deg;
      const r = lerp(25, 27, u);
      const fwd = Math.cos(th) * r;
      const lateral = side * Math.sin(th) * r;
      frame.camPos.x = jet.pos.x + f.dx * fwd + f.rx * lateral;
      frame.camPos.y = jet.pos.y + lerp(4, 1.5, u);
      frame.camPos.z = jet.pos.z + f.dz * fwd + f.rz * lateral;
      frame.lookAt.x = jet.pos.x + f.dx * lerp(1.0, -1.0, u);
      frame.lookAt.y = jet.pos.y;
      frame.lookAt.z = jet.pos.z + f.dz * lerp(1.0, -1.0, u);
      frame.fovDeg = lerp(34, 38, u);
      return frame;
    },
  };
}

/** The low pass's height above the runway, m. */
export const PASS_HEIGHT_M = 25;

/**
 * A low pass down Bhisiana's runway: from beside the runway, a few metres up, a long lens picks up
 * a Tejas at 25 m and 230 m/s, swings with it as it goes by, then watches it pull up on
 * afterburner into the vertical and climb away.
 */
export function lowPassScene(layout: AirportLayout, runway: RunwayDef, durationSec = 15): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const hub = baseHub(layout, f);
  const jet = makeAircraft();
  jet.gearPos = 0;
  jet.flags = EntityFlag.Lights | EntityFlag.LightsStrobe;
  jet.groundY = f.elev;
  const speed = 230;
  const passAt = 6.5;
  const pullAt = passAt + 1.4;
  const camAlong = 1200;
  // Away from the buildings, ~85 m off the centreline, 12 m up: level with the pass, over the trees.
  const side = hub.right < 0 ? 1 : -1;
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 20, offsetX: SUBJECT_OFFSET_X, aircraft: [jet] };
  const q: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  /** Along-runway distance and height after `tp` s of the pull-up (flight path up at 40 deg/s to 80 deg). */
  // The g comes on over half a second (not a kink), and eases off as the climb nears 80 deg; the
  // nose rides above the flight path by an angle of attack that follows the pull.
  const rate = (tp: number, gamma: number): number => 40 * deg * ease(clamp01(tp / 0.5)) * clamp01((80 * deg - gamma) / (18 * deg));
  const pull = (tp: number): { s: number; h: number; gamma: number; alpha: number } => {
    let s = 0;
    let h = 0;
    let g = 0;
    const n = Math.max(1, Math.ceil(tp / 0.01));
    const dt = tp / n;
    for (let i = 0; i < n; i++) {
      g += rate((i + 0.5) * dt, g) * dt;
      s += Math.cos(g) * speed * dt;
      h += Math.sin(g) * speed * dt;
    }
    return { s, h, gamma: g, alpha: 7 * deg * (rate(tp, g) / (40 * deg)) };
  };
  return {
    durationSec,
    timeOfDayH: 16.4,
    caption: { title: 'Low pass', place: 'Bhisiana AFS · Runway' },
    frame(t) {
      const tp = Math.max(0, t - pullAt);
      const p = pull(tp);
      const along = camAlong + speed * (Math.min(t, pullAt) - passAt) + p.s;
      at(f, along, 0, PASS_HEIGHT_M + p.h, jet.pos);
      // Light chop on the way in, a few tenths of a degree.
      const chop = 1 - clamp01(tp / 1.5);
      const wob = (a: number, b: number): number => Math.sin(t * a + b) * 0.6 + Math.sin(t * a * 2.3 + b * 1.7) * 0.4;
      setRot(jet, Quat.fromYawPitchRoll(f.heading + chop * 0.15 * deg * wob(0.9, 2), p.gamma + 2 * deg + p.alpha + chop * 0.25 * deg * wob(1.3, 5), chop * 0.8 * deg * wob(1.1, 1), q));
      jet.vel.x = f.dx * speed * Math.cos(p.gamma);
      jet.vel.y = speed * Math.sin(p.gamma);
      jet.vel.z = f.dz * speed * Math.cos(p.gamma);
      jet.afterburner = t > pullAt - 0.6;
      jet.throttle = jet.afterburner ? 1 : 0.85;
      at(f, camAlong, side * 85, 12, frame.camPos);
      frame.lookAt.x = jet.pos.x;
      frame.lookAt.y = jet.pos.y;
      frame.lookAt.z = jet.pos.z;
      frame.fovDeg = jetFov(distance(frame.camPos, jet.pos), 0.7, 2.1, 55);
      // Centred while it whips past (the pan is fast), back right of centre as it climbs away.
      const near = clamp01(1 - Math.abs(t - passAt) / 2.5);
      frame.offsetX = SUBJECT_OFFSET_X * (1 - near);
      return frame;
    },
  };
}
