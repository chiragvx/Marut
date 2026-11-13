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

/** The base's smallest hangar a Tejas fits in with room round it (none: undefined). */
export function findHangarBay(layout: AirportLayout): HangarBayDef | undefined {
  const fits = (layout.structures ?? []).filter((s) => s.kind === 'hangar' && s.widthM >= 24 && s.lengthM >= 24 && s.heightM >= 8);
  fits.sort((a, b) => a.widthM * a.lengthM - b.widthM * b.lengthM);
  const s = fits[0];
  return s ? { id: s.id, x: s.worldX, z: s.worldZ, headingRad: s.headingRad, widthM: Math.min(s.widthM, 40), lengthM: Math.min(s.lengthM, 40), heightM: Math.min(s.heightM, 12) } : undefined;
}

/** The orbit: round the jet (yaw 0: straight ahead of its nose), up from level, and distance, m. */
export interface HangarOrbit {
  yaw: number;
  pitch: number;
  dist: number;
}

export const HANGAR_ORBIT_LIMITS = { pitchMin: -0.12, pitchMax: 1.05, distMin: 6, distMax: 18 } as const;

export function clampOrbit(o: HangarOrbit): HangarOrbit {
  o.pitch = Math.min(HANGAR_ORBIT_LIMITS.pitchMax, Math.max(HANGAR_ORBIT_LIMITS.pitchMin, o.pitch));
  o.dist = Math.min(HANGAR_ORBIT_LIMITS.distMax, Math.max(HANGAR_ORBIT_LIMITS.distMin, o.dist));
  return o;
}

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
  /** Where the jet sits across the screen (fraction of the width right of centre). */
  setOffsetX(x: number): void;
}

/** Idle (s) before the camera drifts round by itself, and how fast, rad/s. */
const IDLE_SEC = 5;
const DRIFT_RAD_S = 0.06;
/** The jet's origin above its wheels' contact with the floor, m (as showcase.ts parks it). */
const PARKED_ORIGIN_M = 1.6;
/** How far ahead of the bay's middle the jet stands, m (more room behind for the tail). */
const JET_FWD_M = 1.0;

export function createHangarScene(layout: AirportLayout, bay: HangarBayDef, def: AircraftDefinition, fit: LoadoutFit): HangarScene {
  const floorY = layout.elevationM + 0.04;
  const h = bay.headingRad;
  // Bay frame: right (cos h, sin h), forward to the doors (sin h, -cos h).
  const rx = Math.cos(h);
  const rz = Math.sin(h);
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const jet = makeAircraft();
  jet.throttle = 0;
  jet.groundY = floorY;
  jet.pos.x = bay.x + fx * JET_FWD_M;
  jet.pos.y = floorY + PARKED_ORIGIN_M;
  jet.pos.z = bay.z + fz * JET_FWD_M;
  const q: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
  Quat.fromYawPitchRoll(h, 0, 0, q);
  Object.assign(jet.rot, q);
  const setFit = (f: LoadoutFit): void => {
    const p = packFitStores(def, f);
    jet.stores = p.a;
    jet.storesB = p.b;
  };
  setFit(fit);

  // Front-left three-quarter view to start.
  const want: HangarOrbit = { yaw: -0.75, pitch: 0.2, dist: 12.5 };
  const cur: HangarOrbit = { ...want };
  let lastT = 0;
  let idle = 0;
  let offsetX = 0.2;
  // What the camera looks at: the jet's middle, a little over its origin (bay frame, floor-relative).
  const target = { x: 0, y: PARKED_ORIGIN_M + 0.3, z: JET_FWD_M };
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
      want.yaw += dYaw;
      want.pitch += dPitch;
      want.dist *= zoom;
      clampOrbit(want);
      idle = 0;
    },
    setOffsetX(x) {
      offsetX = x;
    },
    frame(t) {
      const dt = Math.min(0.1, Math.max(0, t - lastT));
      lastT = t;
      idle += dt;
      if (idle > IDLE_SEC) want.yaw += DRIFT_RAD_S * dt * Math.min(1, (idle - IDLE_SEC) / 2);
      const k = 1 - Math.exp(-dt * 8);
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
