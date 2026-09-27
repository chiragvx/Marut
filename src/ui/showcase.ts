/**
 * src/ui/showcase.ts — the main menu's cinematic: shots of Bhisiana (Bathinda) with a Tejas doing
 * something worth watching. Golden hour: a slow pass over the base onto a Tejas on final, touching
 * down a few hundred metres in. Late afternoon: a Tejas taxiing head-on, seen from the grass. Night:
 * an afterburner take-off tracked from beside the runway. (departureScene, INS Hansa, is kept for
 * when that base is tested.) Everything is placed from the base's own runway and taxiways.
 *
 * Pure: `frame(t)` is a function of the time into the scene. src/main.ts loads the base's world,
 * plays the scenes behind the menus and fades between them.
 */
import type { AirportLayout, RunwayDef } from '../contracts/airport';
import type { ShowcaseAircraft, ShowcaseFrame } from '../contracts/render';
import { EntityFlag, STORE_IDS, STORE_SLOT_RADIX, packStoreSlot, type QuatLike, type Vec3Like } from '../contracts/core';
import { Quat } from '../math';
import { buildAirfieldAids } from '../airport/airfieldAids';

export interface ShowcaseScene {
  /** How long the scene plays, s (fades included). */
  durationSec: number;
  timeOfDayH: number;
  frame(tSec: number): ShowcaseFrame;
}

/** The default CAP fit, packed for the snapshot's STORES field (slots: outer, middle, inner, centreline). */
export function capStores(): number {
  const code = (id: string): number => STORE_IDS.indexOf(id);
  const slots = [
    packStoreSlot(code('asraam'), 2, true),
    packStoreSlot(code('asraam'), 2, true),
    packStoreSlot(code('astra-mk1'), 1, false),
    packStoreSlot(code('astra-mk1'), 1, false),
    packStoreSlot(code('tank-1200l'), 1, false),
    packStoreSlot(code('tank-1200l'), 1, false),
  ];
  return slots.reduce((sum, s, k) => sum + s * Math.pow(STORE_SLOT_RADIX, k), 0);
}

interface RunwayFrame {
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

function runwayFrame(layout: AirportLayout, runway: RunwayDef): RunwayFrame {
  const h = runway.headingRad;
  return { tx: runway.thresholdWorldX, tz: runway.thresholdWorldZ, elev: layout.elevationM, heading: h, dx: Math.sin(h), dz: -Math.cos(h), rx: Math.cos(h), rz: Math.sin(h) };
}

/** A point `along` metres down the runway from the threshold, `right` metres to its right, `up` above the field. */
function at(f: RunwayFrame, along: number, right: number, up: number, out: Vec3Like): Vec3Like {
  out.x = f.tx + f.dx * along + f.rx * right;
  out.y = f.elev + up;
  out.z = f.tz + f.dz * along + f.rz * right;
  return out;
}


function makeAircraft(): ShowcaseAircraft {
  return { id: 900001, pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: 0, z: 0 }, gearPos: 1, throttle: 0.5, afterburner: false, flags: 0, stores: capStores() };
}

const deg = Math.PI / 180;
/** Where the subject sits across the screen (fraction of the width right of centre), clear of the menu on the left. */
const SUBJECT_OFFSET_X = 0.2;
/** Height of the aircraft's origin above its wheels (the gear legs' contact points, tejasGeometry.ts). */
const GEAR_HEIGHT_M = 1.1;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const ease = (t: number): number => t * t * (3 - 2 * t);

/** Where the base's buildings are, in runway coordinates: metres along from the threshold and to the right. */
interface Hub {
  along: number;
  right: number;
}

/** The middle of the base's shelters, hangars and parking (the reference point if it has none). */
function baseHub(layout: AirportLayout, f: RunwayFrame): Hub {
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

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

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

function setRot(jet: ShowcaseAircraft, q: QuatLike): void {
  jet.rot.x = q.x;
  jet.rot.y = q.y;
  jet.rot.z = q.z;
  jet.rot.w = q.w;
}

/**
 * The field of view that keeps an aircraft `fraction` of the view's height tall at `distM` (a long
 * lens that zooms out as it comes closer), within [minDeg, maxDeg].
 */
function jetFov(distM: number, fraction: number, minDeg: number, maxDeg: number): number {
  const fov = (2 * Math.atan(13.2 / (2 * fraction * Math.max(1, distM)))) / deg;
  return Math.min(maxDeg, Math.max(minDeg, fov));
}

function distance(a: Vec3Like, b: Vec3Like): number {
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
      at(f, TOUCHDOWN_M - dist, 0, GEAR_HEIGHT_M + height, jet.pos);
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
  const rotate = clamp01((t - (LIFTOFF_SEC - 1.5)) / 1.5);
  const pitch = Math.min(12 * deg, Math.max(Math.atan(climb) + 4 * deg * rotate, rotate * 8 * deg));
  at(f, along, 0, GEAR_HEIGHT_M + height, jet.pos);
  setRot(jet, Quat.fromYawPitchRoll(f.heading, pitch, 0, q));
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
    timeOfDayH: 17.0,
    frame(t) {
      // Rolling up to taxi speed over the first 3 s.
      const s = startS + speed * (t < 3 ? (t * t) / 6 : t - 1.5);
      const v = speed * Math.min(1, t / 3);
      jet.pos.x = L.ax + dx * s;
      jet.pos.y = f.elev + GEAR_HEIGHT_M;
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
