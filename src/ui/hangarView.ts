/**
 * src/ui/hangarView.ts — the loadout view: the jet parked in a hangar at the base with what is on
 * its pylons, and a camera the player walks round it (drag to turn round it, scroll or pinch to
 * close in or stand back). Left alone for a few seconds, the camera drifts slowly round by itself.
 *
 * The hangar is one of the base's own maintenance hangars (`findHangarBay`: the smallest that takes
 * a Tejas with room to walk round it), drawn open inside (render/hangarBay.ts) in place of the
 * closed shed. The jet sits on its wheels in the middle, nose to the doors. The camera stays inside
 * the shed, above the floor and under the tie beams.
 *
 * Played as a menu cinematic (ShowcaseScene) that never ends; `frame(t)` eases the camera towards
 * where the player has put it.
 */
import type { AirportLayout } from '../contracts/airport';
import type { AircraftDefinition } from '../contracts/aircraft';
import type { ShowcaseFrame } from '../contracts/render';
import type { QuatLike } from '../contracts/core';
import { AIRCRAFT_MODEL_SHIFT, AircraftModel } from '../contracts/core';
import { Quat } from '../math';
import { packFitStores, type LoadoutFit } from '../aircraft/loadout';
import { makeAircraft, type ShowcaseScene } from './showcase';

export interface HangarBayDef {
  id: string;
  x: number;
  z: number;
  headingRad: number;
  widthM: number;
  lengthM: number;
  heightM: number;
}

/** A bigger aircraft's hangar: at least this floor, and the interior drawn at least this tall. */
export interface HangarFit {
  minWidthM: number;
  minLengthM: number;
  minHeightM: number;
}

/**
 * The C-17 (51.8 m span, 53 m long, fin 16.8 m): the smallest shed with ~10 m round it. Bhisiana's
 * HANGAR-3 (89 x 86 x 17.4 m) takes it; its interior is drawn 26 m tall so the tie beams and lamps clear the
 * fin (the shed itself is hidden while the view is open, so the extra height never shows outside).
 */
export const C17_HANGAR_FIT: HangarFit = { minWidthM: 70, minLengthM: 70, minHeightM: 26 };

/**
 * The base's hangar for the view: the smallest roomy one (about 36 x 32 m or more: space to stand
 * well back from the jet), else the smallest a Tejas fits in at all (none: undefined). With `fit`
 * (a bigger aircraft): the smallest hangar with that floor.
 */
export function findHangarBay(layout: AirportLayout, fit?: HangarFit): HangarBayDef | undefined {
  if (fit) {
    const big = (layout.structures ?? []).filter((s) => s.kind === 'hangar' && s.widthM >= fit.minWidthM && s.lengthM >= fit.minLengthM);
    big.sort((a, b) => a.widthM * a.lengthM - b.widthM * b.lengthM);
    const b = big[0];
    return b ? { id: b.id, x: b.worldX, z: b.worldZ, headingRad: b.headingRad, widthM: b.widthM, lengthM: b.lengthM, heightM: Math.max(b.heightM, fit.minHeightM) } : undefined;
  }
  const all = (layout.structures ?? []).filter((s) => s.kind === 'hangar' && s.widthM >= 24 && s.lengthM >= 24 && s.heightM >= 8);
  all.sort((a, b) => a.widthM * a.lengthM - b.widthM * b.lengthM);
  const s = all.find((x) => x.widthM >= 36 && x.lengthM >= 32 && x.widthM <= 60 && x.lengthM <= 60) ?? all[0];
  return s ? { id: s.id, x: s.worldX, z: s.worldZ, headingRad: s.headingRad, widthM: Math.min(s.widthM, 60), lengthM: Math.min(s.lengthM, 60), heightM: Math.min(s.heightM, 14) } : undefined;
}

/** The orbit: round the jet (yaw 0: straight ahead of its nose), up from level, and distance, m. */
export interface HangarOrbit {
  yaw: number;
  pitch: number;
  dist: number;
}

export interface OrbitLimits {
  pitchMin: number;
  pitchMax: number;
  distMin: number;
  distMax: number;
}

export const HANGAR_ORBIT_LIMITS: OrbitLimits = { pitchMin: -0.12, pitchMax: 1.05, distMin: 6, distMax: 24 };

export function clampOrbit(o: HangarOrbit, lim: OrbitLimits = HANGAR_ORBIT_LIMITS): HangarOrbit {
  o.pitch = Math.min(lim.pitchMax, Math.max(lim.pitchMin, o.pitch));
  o.dist = Math.min(lim.distMax, Math.max(lim.distMin, o.dist));
  return o;
}

/** What stands in the hangar and how the camera walks round it. */
export interface HangarSubject {
  /** EntityFlags for the model (contracts/core.ts AIRCRAFT_MODEL_SHIFT). */
  flags: number;
  /** Its origin above the floor, parked on its wheels, m. */
  parkedOriginM: number;
  /** The camera's aim above the origin, m. */
  targetAboveOriginM: number;
  /** How far ahead of the bay's middle it stands, m (more room behind for the tail). */
  fwdM: number;
  start: HangarOrbit;
  limits: OrbitLimits;
  /** Cargo ramp (0 closed .. 1 down), transports only. */
  ramp?: number;
  /** Whether it carries stores (drawn from the fit). */
  stores: boolean;
}

/** The Tejas (showcase.ts parks its origin 1.6 m above its wheels' contact). */
export const TEJAS_HANGAR_SUBJECT: HangarSubject = {
  flags: 0,
  parkedOriginM: 1.6,
  targetAboveOriginM: 0.3,
  fwdM: 1.0,
  start: { yaw: -0.75, pitch: 0.2, dist: 12.5 },
  limits: HANGAR_ORBIT_LIMITS,
  stores: true,
};

/**
 * The C-17: its CG 4.25 m over the floor on its gear (aircraft/c17Data.ts contacts 4.5 m down,
 * ~0.25 m static compression), the ramp down as if being loaded.
 */
export const C17_HANGAR_SUBJECT: HangarSubject = {
  flags: AircraftModel.C17 << AIRCRAFT_MODEL_SHIFT,
  parkedOriginM: 4.25,
  targetAboveOriginM: 0.8,
  fwdM: 2.0,
  start: { yaw: -0.8, pitch: 0.16, dist: 50 },
  limits: { pitchMin: -0.08, pitchMax: 0.95, distMin: 20, distMax: 72 },
  ramp: 1,
  stores: false,
};

/** Where the camera stands, in the bay's frame (x right, y up from the floor, z towards the doors from the middle): kept inside the shed. */
export function orbitCameraLocal(o: HangarOrbit, target: { x: number; y: number; z: number }, bay: { widthM: number; lengthM: number; heightM: number }): { x: number; y: number; z: number } {
  const cp = Math.cos(o.pitch);
  const p = {
    x: target.x + o.dist * cp * Math.sin(o.yaw),
    y: target.y + o.dist * Math.sin(o.pitch),
    z: target.z + o.dist * cp * Math.cos(o.yaw),
  };
  const mx = bay.widthM / 2 - 1.2;
  const mz = bay.lengthM / 2 - 1.0;
  p.x = Math.min(mx, Math.max(-mx, p.x));
  p.z = Math.min(mz, Math.max(-mz, p.z));
  p.y = Math.min(bay.heightM * 0.72 - 0.9, Math.max(0.5, p.y));
  return p;
}

export interface HangarScene extends ShowcaseScene {
  setFit(fit: LoadoutFit): void;
  /** Turn round the jet (rad) and up/down (rad); zoom: distance factor (< 1 closer). */
  orbitBy(dYaw: number, dPitch: number, zoom: number): void;
  /** The player has hold of the view (a finger or button down): no coasting until let go. */
  setDragging(on: boolean): void;
  /** Where the jet sits across the screen (fraction of the width right of centre). */
  setOffsetX(x: number): void;
}

/** How quickly the camera follows the input (1/s), and how fast a flicked turn dies away (1/s). */
const FOLLOW_RATE = 5;
const SPIN_DECAY = 2.5;
/** Idle (s) before the camera drifts round by itself, and how fast, rad/s. */
const IDLE_SEC = 5;
const DRIFT_RAD_S = 0.06;
export function createHangarScene(layout: AirportLayout, bay: HangarBayDef, def: AircraftDefinition, fit: LoadoutFit, subject: HangarSubject = TEJAS_HANGAR_SUBJECT): HangarScene {
  const PARKED_ORIGIN_M = subject.parkedOriginM;
  const JET_FWD_M = subject.fwdM;
  const lim = subject.limits;
  const floorY = layout.elevationM + 0.04;
  const h = bay.headingRad;
  // Bay frame: right (cos h, sin h), forward to the doors (sin h, -cos h).
  const rx = Math.cos(h);
  const rz = Math.sin(h);
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const jet = makeAircraft();
  jet.throttle = 0;
  jet.flags = subject.flags;
  if (subject.ramp !== undefined) jet.ramp = subject.ramp;
  jet.groundY = floorY;
  jet.pos.x = bay.x + fx * JET_FWD_M;
  jet.pos.y = floorY + PARKED_ORIGIN_M;
  jet.pos.z = bay.z + fz * JET_FWD_M;
  const q: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  Quat.fromYawPitchRoll(h, 0, 0, q);
  Object.assign(jet.rot, q);
  const setFit = (f: LoadoutFit): void => {
    if (!subject.stores) {
      jet.stores = 0;
      jet.storesB = 0;
      return;
    }
    const p = packFitStores(def, f);
    jet.stores = p.a;
    jet.storesB = p.b;
  };
  setFit(fit);

  // Front-left three-quarter view to start.
  const want: HangarOrbit = { ...subject.start };
  const cur: HangarOrbit = { ...want };
  let lastT = 0;
  let idle = 0;
  // Input since the last frame, and the turn rate it carries on with when let go (momentum).
  let pendYaw = 0;
  let pendPitch = 0;
  let spinYaw = 0;
  let spinPitch = 0;
  let dragging = false;
  let offsetX = 0.2;
  // What the camera looks at: the jet's middle, a little over its origin (bay frame, floor-relative).
  const target = { x: 0, y: PARKED_ORIGIN_M + subject.targetAboveOriginM, z: JET_FWD_M };
  const frame: ShowcaseFrame = {
    camPos: { x: 0, y: 0, z: 0 },
    lookAt: { x: 0, y: 0, z: 0 },
    fovDeg: 50,
    aircraft: [jet],
    hangar: { x: bay.x, y: floorY - 0.04, z: bay.z, headingRad: h, widthM: bay.widthM, lengthM: bay.lengthM, heightM: bay.heightM, hideTargetId: `${layout.id}:${bay.id}` },
  };
  const toWorld = (p: { x: number; y: number; z: number }, out: { x: number; y: number; z: number }): void => {
    out.x = bay.x + rx * p.x + fx * p.z;
    out.y = floorY + p.y;
    out.z = bay.z + rz * p.x + fz * p.z;
  };

  return {
    durationSec: Infinity,
    timeOfDayH: 11,
    caption: { title: 'Loadout', place: 'Hangar' },
    setFit,
    orbitBy(dYaw, dPitch, zoom) {
      pendYaw += dYaw;
      pendPitch += dPitch;
      want.yaw += dYaw;
      want.pitch += dPitch;
      want.dist *= zoom;
      clampOrbit(want, lim);
      idle = 0;
    },
    setDragging(on) {
      dragging = on;
    },
    setOffsetX(x) {
      offsetX = x;
    },
    frame(t) {
      const dt = Math.min(0.1, Math.max(0, t - lastT));
      lastT = t;
      idle += dt;
      if (dt > 0) {
        if (pendYaw !== 0 || pendPitch !== 0) {
          // Dragging: the turn rate, smoothed over a few frames.
          spinYaw += (pendYaw / dt - spinYaw) * 0.4;
          spinPitch += (pendPitch / dt - spinPitch) * 0.4;
        } else if (dragging) {
          // Held still: no turn to carry on with.
          spinYaw = spinPitch = 0;
        } else {
          // Let go: it carries on turning, slowing to a stop.
          want.yaw += spinYaw * dt;
          want.pitch += spinPitch * dt;
          clampOrbit(want, lim);
          const d = Math.exp(-dt * SPIN_DECAY);
          spinYaw *= d;
          spinPitch *= d;
        }
        pendYaw = pendPitch = 0;
      }
      if (idle > IDLE_SEC) want.yaw += DRIFT_RAD_S * dt * Math.min(1, (idle - IDLE_SEC) / 2);
      const k = 1 - Math.exp(-dt * FOLLOW_RATE);
      cur.yaw += (want.yaw - cur.yaw) * k;
      cur.pitch += (want.pitch - cur.pitch) * k;
      cur.dist += (want.dist - cur.dist) * k;
      // The orbit is round the jet's middle; the yaw from its nose (bay +z towards the doors).
      const local = orbitCameraLocal(cur, target, bay);
      toWorld(local, frame.camPos);
      toWorld(target, frame.lookAt);
      frame.offsetX = offsetX;
      frame.timeSec = t;
      return frame;
    },
  };
}
