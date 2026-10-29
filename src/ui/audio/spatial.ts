/**
 * src/ui/audio/spatial.ts — 3D sound: each source placed where it is on the jet, heard from the
 * camera (the pilot's head in the cockpit, so turning to look round moves the sound).
 *
 * A source (`Emitter`) is a fixed point on the airframe (body frame: +X nose, +Y canopy, +Z right
 * wing). Every rendered frame its place is worked out relative to the listener (`toListener`, pure,
 * tested) and it goes through:
 *
 * - a delay of the sound's travel time from where the jet was when it made it (`travelSec`) —
 *   which also makes the Doppler shift of a jet going past, as the delay shortens and lengthens;
 * - air absorption: the further, the duller;
 * - an HRTF panner (direction, and the fall-off with distance), with a cone where the sound is
 *   louder one way (the intake's whine forward, the nozzle's roar aft);
 * - in the cockpit, a send to a small, hard, damped room (the canopy and cockpit walls: a short
 *   synthetic reverb), so it sounds inside a cockpit, not in a void.
 *
 * The voice warnings and warning tones are not placed: they are in the pilot's headset.
 */
import type { QuatLike, Vec3Like } from '../../contracts/core';

const SOUND_MPS = 343;
/** Longest delay (distance) a source is heard at, s. */
const MAX_DELAY_SEC = 12;

/** v rotated by unit quaternion q, into out. */
export function rotate(q: QuatLike, v: Vec3Like, out: Vec3Like): Vec3Like {
  const { x, y, z, w } = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  const vx = v.x, vy = v.y, vz = v.z;
  out.x = vx + w * tx + (y * tz - z * ty);
  out.y = vy + w * ty + (z * tx - x * tz);
  out.z = vz + w * tz + (x * ty - y * tx);
  return out;
}

/** v rotated by the inverse of unit quaternion q, into out. */
export function rotateInverse(q: QuatLike, v: Vec3Like, out: Vec3Like): Vec3Like {
  return rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v, out);
}

/** a x b (apply b, then a), into out. */
export function multiplyQuat(a: QuatLike, b: QuatLike, out: QuatLike): QuatLike {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

/** The listener: where the camera is and how it is turned (three.js convention: looking down -Z, +Y up). */
export interface Listener {
  pos: Vec3Like;
  rot: QuatLike;
}

/** The jet a source is on: its position and attitude (body to world). */
export interface Airframe {
  pos: Vec3Like;
  rot: QuatLike;
}

/**
 * A point on the airframe (body frame), and a direction on it, in the listener's frame (+X right,
 * +Y up, -Z ahead) — what a Web Audio panner wants with the listener left at the origin.
 */
export function toListener(listener: Listener, jet: Airframe, bodyPoint: Vec3Like, out: Vec3Like): Vec3Like {
  rotate(jet.rot, bodyPoint, out);
  out.x += jet.pos.x - listener.pos.x;
  out.y += jet.pos.y - listener.pos.y;
  out.z += jet.pos.z - listener.pos.z;
  return rotateInverse(listener.rot, out, out);
}
export function dirToListener(listener: Listener, jet: Airframe, bodyDir: Vec3Like, out: Vec3Like): Vec3Like {
  rotate(jet.rot, bodyDir, out);
  return rotateInverse(listener.rot, out, out);
}

/**
 * The travel time of the sound heard now, s: from where the source was when it made it. With the
 * source at `rel` (m, from the listener) moving at `vel` (m/s, relative to the listener), the
 * delay d solves |rel - vel d| = c d. (Using the distance now instead gives the wrong Doppler: a
 * moving listener's, f(1 + v/c), not a moving source's, f/(1 - v/c).) Faster than sound, the speed
 * is held just under it (the boom is not modelled).
 */
export function travelSec(rel: Vec3Like, vel: Vec3Like): number {
  let ux = vel.x, uy = vel.y, uz = vel.z;
  const u = Math.hypot(ux, uy, uz);
  const uMax = 0.95 * SOUND_MPS;
  if (u > uMax) {
    const k = uMax / u;
    ux *= k; uy *= k; uz *= k;
  }
  const a = SOUND_MPS * SOUND_MPS - (ux * ux + uy * uy + uz * uz);
  const b = rel.x * ux + rel.y * uy + rel.z * uz;
  const r2 = rel.x * rel.x + rel.y * rel.y + rel.z * rel.z;
  return (-b + Math.sqrt(b * b + a * r2)) / a;
}

/** Air absorption: the low-pass corner for a distance, Hz. */
export const absorptionHz = (distM: number): number => Math.min(20000, 22000 / (1 + distM / 250));

export interface EmitterOptions {
  /** The sound is louder this way (a body-frame direction), quieter elsewhere. */
  cone?: { dir: Vec3Like; innerDeg: number; outerDeg: number; outerGain: number };
}

export interface Emitter {
  /** Connect the sound here. */
  input: AudioNode;
  /** Where it is (body frame point on `jet`), heard from `listener`; `inside` sends it to the cockpit room. */
  place(listener: Listener, jet: Airframe, inside: boolean): void;
  /** Its body-frame point (changeable: e.g. a source that moves). */
  bodyPoint: Vec3Like;
}

/** The cockpit's room sound, shared by every emitter (its input; it plays into `dest`). */
export function createCockpitRoom(ac: BaseAudioContext, dest: AudioNode): AudioNode {
  // A short, damped impulse: early reflections off the canopy and panels in the first few
  // milliseconds, then a fast decay (RT60 ~0.15 s), darker as it goes.
  const sr = ac.sampleRate;
  const len = Math.floor(sr * 0.3);
  const ir = ac.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const damp = 0.15 + 0.85 * Math.exp(-t / 0.03); // darker as it decays
      lp += (Math.random() * 2 - 1 - lp) * damp;
      d[i] = lp * Math.exp(-t / 0.022);
    }
    for (const ms of [1.3, 2.1, 3.4, 4.6, 6.2]) {
      const i = Math.floor(((ms + c * 0.37) / 1000) * sr);
      d[i] = (d[i] ?? 0) + (Math.random() < 0.5 ? -0.6 : 0.6) * Math.exp(-ms / 8);
    }
  }
  const conv = ac.createConvolver();
  conv.buffer = ir;
  // Cockpit walls ring in the low mids.
  const body = ac.createBiquadFilter();
  body.type = 'peaking';
  body.frequency.value = 220;
  body.Q.value = 1;
  body.gain.value = 4;
  conv.connect(body).connect(dest);
  return conv;
}

export function createEmitter(ac: BaseAudioContext, dest: AudioNode, room: AudioNode | null, bodyPoint: Vec3Like, opts: EmitterOptions = {}): Emitter {
  const input = ac.createGain();
  const delay = ac.createDelay(MAX_DELAY_SEC);
  const air = ac.createBiquadFilter();
  air.type = 'lowpass';
  air.frequency.value = 20000;
  air.Q.value = 0.5;
  const pan = ac.createPanner();
  pan.panningModel = 'HRTF';
  pan.distanceModel = 'inverse';
  pan.refDistance = 20;
  pan.rolloffFactor = 1;
  pan.maxDistance = 10000;
  if (opts.cone) {
    pan.coneInnerAngle = opts.cone.innerDeg;
    pan.coneOuterAngle = opts.cone.outerDeg;
    pan.coneOuterGain = opts.cone.outerGain;
  }
  const send = ac.createGain();
  send.gain.value = 0;
  input.connect(delay).connect(air).connect(pan).connect(dest);
  if (room) pan.connect(send).connect(room);

  const rel = { x: 0, y: 0, z: 0 };
  const dir = { x: 0, y: 0, z: 0 };
  const world = { x: 0, y: 0, z: 0 };
  const prevWorld = { x: 0, y: 0, z: 0 };
  const vel = { x: 0, y: 0, z: 0 };
  let prevSec = -1;
  let lastDelay = -1;
  const em: Emitter = {
    input,
    bodyPoint: { ...bodyPoint },
    place(listener, jet, inside) {
      const t = ac.currentTime;
      // Where it is from the listener, in the world, and how fast that is changing.
      rotate(jet.rot, em.bodyPoint, world);
      world.x += jet.pos.x - listener.pos.x;
      world.y += jet.pos.y - listener.pos.y;
      world.z += jet.pos.z - listener.pos.z;
      const dt = t - prevSec;
      if (prevSec >= 0 && dt > 1e-3 && dt < 0.25) {
        const k = 1 - Math.exp(-dt / 0.08);
        vel.x += ((world.x - prevWorld.x) / dt - vel.x) * k;
        vel.y += ((world.y - prevWorld.y) / dt - vel.y) * k;
        vel.z += ((world.z - prevWorld.z) / dt - vel.z) * k;
      } else if (prevSec < 0 || dt >= 0.25) {
        vel.x = vel.y = vel.z = 0;
      }
      Object.assign(prevWorld, world);
      prevSec = t;
      rotateInverse(listener.rot, world, rel);
      const dist = Math.hypot(rel.x, rel.y, rel.z);
      // Inside, the sources are an arm's length to a few metres away: keep their level (the
      // engine's levels are set for the cockpit already) and only take their direction.
      pan.refDistance = inside ? 50 : 20;
      pan.positionX.setTargetAtTime(rel.x, t, 0.02);
      pan.positionY.setTargetAtTime(rel.y, t, 0.02);
      pan.positionZ.setTargetAtTime(rel.z, t, 0.02);
      if (opts.cone) {
        dirToListener(listener, jet, opts.cone.dir, dir);
        pan.orientationX.setTargetAtTime(dir.x, t, 0.02);
        pan.orientationY.setTargetAtTime(dir.y, t, 0.02);
        pan.orientationZ.setTargetAtTime(dir.z, t, 0.02);
        // Inside, there is no "in front of the intake": the cone would only mute it.
        pan.coneOuterGain = inside ? 1 : opts.cone.outerGain;
      }
      const d = Math.min(MAX_DELAY_SEC, travelSec(world, vel));
      // A jump (a new view) moves at once; a jet flying past glides (the Doppler shift).
      if (lastDelay < 0 || Math.abs(d - lastDelay) > 0.1) {
        delay.delayTime.cancelScheduledValues(t);
        delay.delayTime.setValueAtTime(d, t);
      } else {
        delay.delayTime.setTargetAtTime(d, t, 0.05);
      }
      lastDelay = d;
      air.frequency.setTargetAtTime(absorptionHz(dist), t, 0.1);
      send.gain.setTargetAtTime(inside ? 0.45 : 0, t, 0.05);
    },
  };
  return em;
}
