/**
 * src/ui/showcase.ts — the main menu's cinematic: slow camera passes over the two airbases, each
 * with a Tejas doing something worth watching. Bathinda at dusk: a Tejas on final approach, gear
 * down and landing light on, the camera beside the runway threshold following it in. INS Hansa at
 * sunrise: a Tejas rolling with afterburner, rotating and climbing out, gear coming up. Everything
 * is placed from the base's own runway, so it lines up with the scenery.
 *
 * Pure: `frame(t)` is a function of the time into the scene. src/main.ts loads each base's world,
 * plays the scene behind the menus and cross-fades between them.
 */
import type { AirportLayout, RunwayDef } from '../contracts/airport';
import type { ShowcaseAircraft, ShowcaseFrame } from '../contracts/render';
import { EntityFlag, STORE_IDS, STORE_SLOT_RADIX, packStoreSlot, type QuatLike, type Vec3Like } from '../contracts/core';
import { Quat } from '../math';

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
/** Height of the aircraft's origin above its wheels. */
const GEAR_HEIGHT_M = 1.05;

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
  const u = ease(clamp01(t / durationSec));
  // Beyond the buildings, on their side of the runway, drifting in over them towards the runway.
  const side = hub.right < 0 ? -1 : 1;
  const lateral = side * lerp(Math.max(150, Math.abs(hub.right)) + 700, 320, u);
  at(f, lerp(alongFrom, alongTo, u), lateral, lerp(320, 110, u), frame.camPos);
  // Looking at the buildings first, then at the jet.
  at(f, hub.along, hub.right, 0, look);
  const w = ease(clamp01((t - 3) / (durationSec * 0.45)));
  frame.lookAt.x = lerp(look.x, jet.pos.x, w);
  frame.lookAt.y = lerp(look.y, jet.pos.y, w);
  frame.lookAt.z = lerp(look.z, jet.pos.z, w);
  frame.fovDeg = lerp(44, 13, ease(clamp01((t - 4) / (durationSec * 0.6))));
}

function setRot(jet: ShowcaseAircraft, q: QuatLike): void {
  jet.rot.x = q.x;
  jet.rot.y = q.y;
  jet.rot.z = q.z;
  jet.rot.w = q.w;
}

/**
 * Bathinda at golden hour: a slow pass across the airbase, then onto a Tejas on a 3 deg final
 * approach (landing light on) as it touches down and rolls out.
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
      // Approach: 1.5 km out at 72 m/s; over the threshold at ~21 s, then the landing roll.
      let dist = 1500 - 72 * t;
      let speed = 72;
      let pitch = 4 * deg;
      if (dist < 0) {
        const tr = -dist / 72;
        speed = Math.max(20, 72 - 6 * tr);
        dist = -(72 * tr - 3 * tr * tr);
        pitch = Math.max(0, 4 * deg - tr * 2 * deg);
      }
      at(f, -dist, 0, GEAR_HEIGHT_M + Math.max(0, dist) * glide, jet.pos);
      setRot(jet, Quat.fromYawPitchRoll(f.heading, pitch, 0, q));
      jet.vel.x = f.dx * speed;
      jet.vel.y = dist > 0 ? -speed * glide : 0;
      jet.vel.z = f.dz * speed;
      baseCamera(f, hub, jet, t, durationSec, -700, 250, frame, look);
      return frame;
    },
  };
}

/**
 * INS Hansa in the morning: a slow pass across the air station, then onto a Tejas rolling on
 * afterburner as it lifts off and climbs away, gear coming up.
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
  const LIFTOFF_SEC = 12;
  return {
    durationSec,
    timeOfDayH: 8.3,
    frame(t) {
      // Held on the runway for 2 s, then the take-off roll from the threshold.
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
      baseCamera(f, hub, jet, t, durationSec, 0, 1500, frame, look);
      return frame;
    },
  };
}
