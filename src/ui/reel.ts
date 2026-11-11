/**
 * src/ui/reel.ts — the landing page's hero reel: short, fast shots of the Tejas manoeuvring over
 * Bhisiana, cut together by tools/site/captureReel.mjs (which renders them frame by frame through
 * the menu cinematic's dev hold, ?showcase=r<shot>,<t>, and encodes the video).
 *
 * Each shot is a ShowcaseScene like the menu's (src/ui/showcase.ts); the manoeuvres are flown by
 * integrating body rates (roll, pitch) at a set speed, and the camera is placed either in the jet's
 * frame (it rolls with it, so the world turns) or level behind its flight path.
 */
import type { AirportLayout, RunwayDef } from '../contracts/airport';
import type { ShowcaseAircraft, ShowcaseFrame } from '../contracts/render';
import { EntityFlag, type QuatLike, type Vec3Like } from '../contracts/core';
import { Quat } from '../math';
import { airToAirScene, at, baseHub, clamp01, deg, distance, ease, jetFov, lerp, lowPassScene, makeAircraft, nightDepartureScene, runwayFrame, setRot, type RunwayFrame, type ShowcaseScene } from './showcase';

const X: Vec3Like = { x: 1, y: 0, z: 0 };
const Y: Vec3Like = { x: 0, y: 1, z: 0 };
const Z: Vec3Like = { x: 0, y: 0, z: 1 };
const tmp: Vec3Like = { x: 0, y: 0, z: 0 };
const tmpQ: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
// Body frame: x forward, y up, z right. The signs that make +roll right wing down and +pitch nose up.
const ROLL_SIGN = Quat.rotate(Quat.axisAngle(X, 0.1, tmpQ), Z, tmp).y < 0 ? 1 : -1;
const PITCH_SIGN = Quat.rotate(Quat.axisAngle(Z, 0.1, tmpQ), X, tmp).y > 0 ? 1 : -1;

interface Rates {
  /** Roll rate, rad/s (+ right wing down). */
  p: number;
  /** Pitch rate, rad/s (+ nose up, towards the canopy). */
  q: number;
}

/**
 * Flies a manoeuvre: from `pos` at heading/pitch/roll, `t` s at `speed` m/s along the nose with the
 * body rates `rates(t)`, integrated at 240 Hz. Writes the jet's position, attitude and velocity.
 */
function fly(jet: ShowcaseAircraft, start: Vec3Like, headingRad: number, pitchRad: number, rollRad: number, speed: number, rates: (t: number) => Rates, t: number): void {
  const q = Quat.fromYawPitchRoll(headingRad, pitchRad, rollRad, { x: 0, y: 0, z: 0, w: 1 });
  const pos = { ...start };
  const step: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  const fwd: Vec3Like = { x: 0, y: 0, z: 0 };
  const n = Math.ceil(Math.max(0, t) * 240);
  const dt = n > 0 ? t / n : 0;
  for (let i = 0; i < n; i++) {
    const r = rates((i + 0.5) * dt);
    Quat.rotate(q, X, fwd);
    pos.x += fwd.x * speed * dt;
    pos.y += fwd.y * speed * dt;
    pos.z += fwd.z * speed * dt;
    if (r.p !== 0) Quat.multiply(q, Quat.axisAngle(X, ROLL_SIGN * r.p * dt, step), q);
    if (r.q !== 0) Quat.multiply(q, Quat.axisAngle(Z, PITCH_SIGN * r.q * dt, step), q);
    Quat.normalize(q, q);
  }
  Object.assign(jet.pos, pos);
  setRot(jet, q);
  Quat.rotate(q, X, fwd);
  jet.vel.x = fwd.x * speed;
  jet.vel.y = fwd.y * speed;
  jet.vel.z = fwd.z * speed;
}

/** A point `b` (body frame: forward, up, right) from the jet, world. */
function fromJet(jet: ShowcaseAircraft, fwd: number, up: number, right: number, out: Vec3Like): Vec3Like {
  Quat.rotate(jet.rot, { x: fwd, y: up, z: right }, out);
  out.x += jet.pos.x;
  out.y += jet.pos.y;
  out.z += jet.pos.z;
  return out;
}

/**
 * A camera in the jet's frame: at (fwd, up, right) from it, looking at (lookFwd, 0, 0), its up the
 * jet's up blended with the world's by `lock` (1 = rolls with the jet).
 */
function bodyCamera(frame: ShowcaseFrame, jet: ShowcaseAircraft, fwd: number, up: number, right: number, lookFwd: number, lock: number): void {
  fromJet(jet, fwd, up, right, frame.camPos);
  fromJet(jet, lookFwd, 0, 0, frame.lookAt);
  const u = Quat.rotate(jet.rot, Y, frame.up ?? (frame.up = { x: 0, y: 1, z: 0 }));
  u.x *= lock;
  u.y = lerp(1, u.y, lock);
  u.z *= lock;
}

/** A level camera behind the flight path at `heading`: `back` m behind the jet, `up` above, `right` to its right. */
function chaseCamera(frame: ShowcaseFrame, jet: ShowcaseAircraft, headingRad: number, back: number, up: number, right: number): void {
  const dx = Math.sin(headingRad);
  const dz = -Math.cos(headingRad);
  frame.camPos.x = jet.pos.x - dx * back - dz * right;
  frame.camPos.y = jet.pos.y + up;
  frame.camPos.z = jet.pos.z - dz * back + dx * right;
  frame.lookAt.x = jet.pos.x + dx * 4;
  frame.lookAt.y = jet.pos.y;
  frame.lookAt.z = jet.pos.z + dz * 4;
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

/** Blast: from beside the runway, 1.5 m up, a Tejas at 10 m and 260 m/s down the centreline whips past at t = 2. */
export function blastScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const hub = baseHub(layout, f);
  const side = hub.right < 0 ? 1 : -1;
  const jet = gearUp(makeAircraft(), 1);
  jet.afterburner = true;
  jet.groundY = f.elev;
  const speed = 260;
  const camAlong = 1500;
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 40, aircraft: [jet] };
  const q: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  return {
    durationSec: 4,
    timeOfDayH: 17.1,
    caption: { title: 'Blast', place: 'Bhisiana AFS' },
    frame(t) {
      at(f, camAlong + speed * (t - 2), 0, 10, jet.pos);
      setRot(jet, Quat.fromYawPitchRoll(f.heading, 1.5 * deg, side * 12 * deg, q));
      jet.vel.x = f.dx * speed;
      jet.vel.y = 0;
      jet.vel.z = f.dz * speed;
      at(f, camAlong, side * 28, 1.5, frame.camPos);
      frame.lookAt.x = jet.pos.x;
      frame.lookAt.y = jet.pos.y;
      frame.lookAt.z = jet.pos.z;
      frame.fovDeg = jetFov(distance(frame.camPos, jet.pos), 0.4, 14, 75);
      return frame;
    },
  };
}

/** Roll: a level chase from behind and left while the Tejas flicks through a full aileron roll. */
export function rollScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const jet = gearUp(makeAircraft(), 0.9);
  const h = f.heading + 35 * deg;
  const start = overFields(f, -4000, 2500, 520);
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 42, offsetX: 0.12, aircraft: [jet] };
  // 0.5 s in, a full roll at up to 300 deg/s (eased in and out), 360 deg in ~1.6 s.
  const p = (t: number): number => {
    const u = clamp01((t - 0.5) / 1.6);
    return u <= 0 || u >= 1 ? 0 : 2 * Math.PI / 1.6 * (1 - Math.cos(2 * Math.PI * u));
  };
  return {
    durationSec: 3,
    timeOfDayH: 16.9,
    caption: { title: 'Roll', place: 'Over Punjab' },
    frame(t) {
      fly(jet, start, h, 3 * deg, 0, 210, (s) => ({ p: p(s), q: 0 }), t);
      chaseCamera(frame, jet, h, 26, 4.5, -8);
      return frame;
    },
  };
}

/** Break: over the shoulder, rolling with the jet, as it rolls hard left and pulls; the world wheels round. */
export function breakScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const jet = gearUp(makeAircraft(), 1);
  jet.afterburner = true;
  const h = f.heading - 70 * deg;
  const start = overFields(f, 3000, -3500, 700);
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 50, aircraft: [jet] };
  return {
    durationSec: 4,
    timeOfDayH: 17.35,
    caption: { title: 'Break', place: 'Over Punjab' },
    frame(t) {
      fly(jet, start, h, 0, 0, 190, (s) => ({ p: s > 0.3 && s < 0.75 ? -170 * deg : 0, q: s > 0.55 ? 24 * deg * clamp01((s - 0.55) / 0.3) : 0 }), t);
      // The camera eases from level into the jet's frame as it rolls, so the horizon tips and sweeps.
      bodyCamera(frame, jet, -15, 3.6, 3.2, 6, ease(clamp01((t - 0.2) / 0.8)));
      return frame;
    },
  };
}

/** Climb: a steep rolling climb on afterburner; the camera rides ahead of the nose looking back down, rolling with it, the ground turning below. */
export function verticalScene(layout: AirportLayout, runway: RunwayDef): ShowcaseScene {
  const f = runwayFrame(layout, runway);
  const jet = gearUp(makeAircraft(), 1);
  jet.afterburner = true;
  const h = f.heading + 120 * deg;
  const start = overFields(f, 1000, 3000, 250);
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 64, aircraft: [jet] };
  return {
    durationSec: 4,
    timeOfDayH: 17.0,
    caption: { title: 'Vertical', place: 'Over Bhisiana' },
    frame(t) {
      fly(jet, start, h, 50 * deg, 0, 190, () => ({ p: 110 * deg, q: 0 }), t);
      bodyCamera(frame, jet, 13, 3.2, 2.6, -16, 1);
      return frame;
    },
  };
}

/** Formation: a pair in echelon, seen from behind the leader; the wingman rolls away and breaks right. */
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
  const frame: ShowcaseFrame = { camPos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 }, fovDeg: 46, aircraft: [lead, wing] };
  return {
    durationSec: 4,
    timeOfDayH: 17.2,
    caption: { title: 'Pair', place: 'Over Punjab' },
    frame(t) {
      fly(lead, start, h, 2 * deg, 0, 200, () => ({ p: 0, q: 0 }), t);
      fly(wing, startWing, h, 2 * deg, 0, 200, (s) => ({ p: s > 0.9 && s < 1.35 ? 180 * deg : 0, q: s > 1.15 ? 26 * deg * clamp01((s - 1.15) / 0.3) : 0 }), t);
      wing.afterburner = t > 1.0;
      wing.throttle = wing.afterburner ? 1 : 0.85;
      chaseCamera(frame, lead, h, 30, 6, -9);
      // Look between the pair.
      frame.lookAt.x = lerp(frame.lookAt.x, wing.pos.x, 0.35);
      frame.lookAt.z = lerp(frame.lookAt.z, wing.pos.z, 0.35);
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
