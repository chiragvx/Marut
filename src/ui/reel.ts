/**
 * src/ui/reel.ts — the landing page's hero reel: short, fast shots of the Tejas manoeuvring over
 * Bhisiana, cut together by tools/site/captureReel.mjs (which renders them frame by frame through
 * the menu cinematic's dev hold, ?showcase=r<shot>,<t>, and encodes the video).
 *
 * Each shot is a ShowcaseScene like the menu's (src/ui/showcase.ts); the manoeuvres are flown by a
 * point-mass flight model (src/ui/flightPath.ts: roll rate and g, gravity, thrust, drag, angle of
 * attack), and the camera is a camera ship on a spring, either holding a point in the jet's frame
 * (rolling with it, so the world turns) or flying behind its path.
 */
import type { AirportLayout, RunwayDef } from '../contracts/airport';
import type { ShowcaseAircraft, ShowcaseFrame } from '../contracts/render';
import { EntityFlag, type QuatLike, type Vec3Like } from '../contracts/core';
import { Quat } from '../math';
import { airToAirScene, at, baseHub, clamp01, deg, distance, ease, jetFov, lerp, lowPassScene, makeAircraft, nightDepartureScene, runwayFrame, type RunwayFrame, type ShowcaseScene } from './showcase';
import { bell, bellRate, flyPath, follower, holdGamma, shake, smooth01, type Track } from './flightPath';

const Y: Vec3Like = { x: 0, y: 1, z: 0 };

/** A point (body frame: forward, up, right) from the jet, world. */
function fromJet(jet: ShowcaseAircraft, fwd: number, up: number, right: number, out: Vec3Like): Vec3Like {
  Quat.rotate(jet.rot, { x: fwd, y: up, z: right }, out);
  out.x += jet.pos.x;
  out.y += jet.pos.y;
  out.z += jet.pos.z;
  return out;
}

/** The camera's up vector rolled `lock` of the way to the jet's (1 = rolls with it). */
function rollUp(frame: ShowcaseFrame, jetRot: QuatLike, lock: number): void {
  const u = Quat.rotate(jetRot, Y, frame.up ?? (frame.up = { x: 0, y: 1, z: 0 }));
  u.x *= lock;
  u.y = lerp(1, u.y, lock);
  u.z *= lock;
}

function gearUp(jet: ShowcaseAircraft, throttle: number): ShowcaseAircraft {
  jet.gearPos = 0;
  jet.throttle = throttle;
  jet.flags = EntityFlag.Lights | EntityFlag.LightsStrobe;
  return jet;
}

/** A point over the fields some way off the base (runway coordinates), for the air shots. */
function overFields(f: RunwayFrame, along: number, right: number, up: number): Vec3Like {
  return at(f, along, right, up, { x: 0, y: 0, z: 0 });
}

/** Scratch aircraft for the camera followers (they sample a track off-frame). */
const probe = makeAircraft();

type Ship = { pos: (t: number, o: Vec3Like) => Vec3Like; look: (t: number, o: Vec3Like) => Vec3Like };

/**
 * A camera ship flying behind the jet's path: `back` m behind, `up` above and `right` to the side,
 * in the frame of its (smoothed) direction of flight, chasing that point on a spring.
 */
function chaseShip(track: Track, durationSec: number, back: number, up: number, right: number, omega: number): Ship {
  const dir = follower(durationSec, 2.5, (t, o) => {
    track.sample(t, probe);
    const v = Math.hypot(probe.vel.x, probe.vel.z) || 1;
    o.x = probe.vel.x / v;
    o.y = 0;
    o.z = probe.vel.z / v;
    return o;
  });
  const d = { x: 0, y: 0, z: 0 };
  const pos = follower(durationSec, omega, (t, o) => {
    track.sample(t, probe);
    dir(t, d);
    const l = Math.hypot(d.x, d.z) || 1;
    const dx = d.x / l;
    const dz = d.z / l;
    o.x = probe.pos.x - dx * back - dz * right;
    o.y = probe.pos.y + up;
    o.z = probe.pos.z - dz * back + dx * right;
    return o;
  });
  const look = follower(durationSec, omega * 2.2, (t, o) => {
    track.sample(t, probe);
    o.x = probe.pos.x + probe.vel.x * 0.02;
    o.y = probe.pos.y;
    o.z = probe.pos.z + probe.vel.z * 0.02;
    return o;
  });
  return { pos, look };
}

/** A camera ship holding a point in the jet's frame (fwd, up, right) on a spring, looking at `lookFwd` along its nose. */
function bodyShip(track: Track, durationSec: number, fwd: number, up: number, right: number, lookFwd: number, omega: number): Ship {
  const pos = follower(durationSec, omega, (t, o) => {
    track.sample(t, probe);
    return fromJet(probe, fwd, up, right, o);
  });
  const look = follower(durationSec, omega * 2, (t, o) => {
    track.sample(t, probe);
    return fromJet(probe, lookFwd, 0, 0, o);
  });
  return { pos, look };
}

/** Blast: from beside the runway, 1.5 m up, a Tejas at 10 m and 255 m/s rolls level, whips past at t = 2, then pulls up. */
export function blastScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const hub = baseHub(layout, f);
  const side = hub.right < 0 ? 1 : -1;
  const jet = gearUp(makeAircraft(), 1);
  jet.afterburner = true;
  jet.groundY = f.elev;
  const camAlong = 1500;
  const track = flyPath({
    start: { x: 0, y: 0, z: 0 },
    headingRad: f.heading,
    speed: 255,
    bankRad: side * 14 * deg,
    durationSec: 4.2,
    holdSpeed: true,
    // Rolls out of the bank before the pass, then a 4 g pull-up as it goes.
    roll: (t) => bellRate(t, 0.7, 1.7, -side * 16 * deg),
    load: (t, s) => lerp(holdGamma(s, 0), 4.2, smooth01((t - 2.25) / 0.45)),
    turbulence: 1.4,
    seed: 2,
  }).anchor(2, at(f, camAlong, 0, 10, { x: 0, y: 0, z: 0 }));
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 40, aircraft: [jet] };
  // The operator's pan: fast, but a hair behind.
  const look = follower(4.2, 22, (t, o) => {
    track.sample(t, probe);
    return Object.assign(o, probe.pos);
  });
  return {
    durationSec: 4,
    timeOfDayH: 17.1,
    caption: { title: 'Blast', place: 'Bhisiana AFS' },
    frame(t) {
      track.sample(t, jet);
      at(f, camAlong, side * 28, 1.5, frame.camPos);
      shake(t, 0.04, 3, frame.camPos);
      look(t, frame.lookAt);
      frame.fovDeg = jetFov(distance(frame.camPos, jet.pos), 0.4, 14, 75);
      return frame;
    },
  };
}

/** Roll: a chase from behind and left; the Tejas raises its nose a touch and flicks through a full aileron roll, unloaded, the path sagging over the top. */
export function rollScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const jet = gearUp(makeAircraft(), 0.9);
  const track = flyPath({
    start: overFields(f, -4000, 2500, 520),
    headingRad: f.heading + 35 * deg,
    gammaRad: 2 * deg,
    speed: 210,
    durationSec: 3.2,
    holdSpeed: true,
    roll: (t) => bellRate(t, 0.6, 2.2, 2 * Math.PI),
    // A pull to raise the nose, unloaded through the roll, then back to level flight.
    load: (t, s) => {
      if (t < 0.55) return 1 + 1.1 * bell(t, 0.05, 0.75);
      const inRoll = smooth01((t - 0.55) / 0.2) * (1 - smooth01((t - 2.1) / 0.25));
      return lerp(holdGamma(s, 1 * deg), 0.35, inRoll);
    },
    seed: 4,
  });
  const ship = chaseShip(track, 3.2, 26, 4.5, -8, 4);
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 42, offsetX: 0.12, aircraft: [jet] };
  return {
    durationSec: 3,
    timeOfDayH: 16.9,
    caption: { title: 'Roll', place: 'Over Punjab' },
    frame(t) {
      track.sample(t, jet);
      shake(t, 0.12, 9, ship.pos(t, frame.camPos));
      ship.look(t, frame.lookAt);
      return frame;
    },
  };
}

/** Break: over the shoulder, rolling with the jet, as it snaps into a hard left bank and pulls 7 g; the world wheels round. */
export function breakScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const jet = gearUp(makeAircraft(), 1);
  jet.afterburner = true;
  const track = flyPath({
    start: overFields(f, 3000, -3500, 700),
    headingRad: f.heading - 70 * deg,
    speed: 190,
    durationSec: 4.2,
    afterburner: () => true,
    roll: (t) => bellRate(t, 0.25, 0.85, -82 * deg),
    load: (t, s) => lerp(holdGamma(s, 0), 7, smooth01((t - 0.55) / 0.5)),
    seed: 6,
  });
  const ship = bodyShip(track, 4.2, -15, 3.6, 3.2, 6, 5);
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 50, aircraft: [jet] };
  return {
    durationSec: 4,
    timeOfDayH: 17.35,
    caption: { title: 'Break', place: 'Over Punjab' },
    frame(t) {
      track.sample(t, jet);
      shake(t, 0.1, 13, ship.pos(t, frame.camPos));
      ship.look(t, frame.lookAt);
      // The horizon follows the jet's roll a beat late, easing from level into the jet's frame.
      track.sample(Math.max(0, t - 0.12), probe);
      rollUp(frame, probe.rot, ease(clamp01((t - 0.2) / 0.8)));
      return frame;
    },
  };
}

/** Climb: pulled up steep on afterburner, rolling; the camera rides ahead of the nose looking back down, rolling with it, the ground turning below. */
export function verticalScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const jet = gearUp(makeAircraft(), 1);
  jet.afterburner = true;
  const track = flyPath({
    start: overFields(f, 1000, 3000, 250),
    headingRad: f.heading + 120 * deg,
    gammaRad: 46 * deg,
    speed: 215,
    durationSec: 4.2,
    afterburner: () => true,
    // Still pulling as it starts, easing the pull off into a straight rolling climb.
    roll: (t) => 125 * deg * smooth01((t - 0.15) / 0.6),
    load: (t, s) => lerp(3.2, s.lift.y, smooth01(t / 0.9)),
    seed: 8,
  });
  const ship = bodyShip(track, 4.2, 13, 3.2, 2.6, -16, 7);
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 64, aircraft: [jet] };
  return {
    durationSec: 4,
    timeOfDayH: 17.0,
    caption: { title: 'Vertical', place: 'Over Bhisiana' },
    frame(t) {
      track.sample(t, jet);
      ship.pos(t, frame.camPos);
      ship.look(t, frame.lookAt);
      rollUp(frame, jet.rot, 1);
      return frame;
    },
  };
}

/** Formation: a pair in echelon, seen from behind the leader; the wingman rolls away and breaks right on afterburner. */
export function formationScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const lead = gearUp(makeAircraft(), 0.85);
  const wing = gearUp(makeAircraft(), 0.85);
  wing.id = 900002;
  const h = f.heading + 180 * deg;
  const start = overFields(f, 4000, -1500, 600);
  // The wingman 30 m right of the leader and 12 m behind, a few metres lower.
  const dx = Math.sin(h);
  const dz = -Math.cos(h);
  const startWing = { x: start.x - dx * 12 - dz * 30, y: start.y - 3, z: start.z - dz * 12 + dx * 30 };
  const leadTrack = flyPath({ start, headingRad: h, gammaRad: 1 * deg, speed: 200, durationSec: 4.2, holdSpeed: true, load: (_t, s) => holdGamma(s, 1 * deg), seed: 10 });
  const wingTrack = flyPath({
    start: startWing,
    headingRad: h,
    gammaRad: 1 * deg,
    speed: 200,
    durationSec: 4.2,
    throttle: () => 0.5,
    afterburner: (t) => t > 1.0,
    roll: (t) => bellRate(t, 0.85, 1.45, 76 * deg),
    load: (t, s) => lerp(holdGamma(s, 1 * deg), 5.5, smooth01((t - 1.15) / 0.45)),
    seed: 12,
  });
  const ship = chaseShip(leadTrack, 4.2, 30, 6, -9, 3.5);
  // Look between the pair, the pan lagging the wingman.
  const between = follower(4.2, 3, (t, o) => {
    leadTrack.sample(t, probe);
    const lx = probe.pos.x, ly = probe.pos.y, lz = probe.pos.z;
    wingTrack.sample(t, probe);
    o.x = lerp(lx, probe.pos.x, 0.25);
    o.y = ly;
    o.z = lerp(lz, probe.pos.z, 0.25);
    return o;
  });
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 46, aircraft: [lead, wing] };
  return {
    durationSec: 4,
    timeOfDayH: 17.2,
    caption: { title: 'Pair', place: 'Over Punjab' },
    frame(t) {
      leadTrack.sample(t, lead);
      wingTrack.sample(t, wing);
      wing.afterburner = t > 1.0;
      wing.throttle = wing.afterburner ? 1 : 0.85;
      shake(t, 0.12, 21, ship.pos(t, frame.camPos));
      between(t, frame.lookAt);
      return frame;
    },
  };
}

/** A menu shot with its lens narrowed by `zoom`. */
function tighter(scene: ShowcaseScene, zoom: number, offsetX?: number): ShowcaseScene {
  return {
    ...scene,
    frame(t) {
      const fr = scene.frame(t);
      fr.fovDeg *= zoom;
      if (offsetX !== undefined) fr.offsetX = offsetX;
      return fr;
    },
  };
}

/** The reel's shots, by index (?showcase=r<i>,<t>); tools/site/captureReel.mjs decides the cut. */
export const REEL_SHOTS: readonly ((layout: AirportLayout, runway: RunwayDef) => ShowcaseScene)[] = [
  blastScene,
  rollScene,
  breakScene,
  verticalScene,
  formationScene,
  (l, r) => tighter(nightDepartureScene(l, r), 0.5, 0),
  (l, r) => tighter(lowPassScene(l, r), 0.75, 0.1),
  (l, r) => tighter(airToAirScene(l, r), 1, 0.12),
];
