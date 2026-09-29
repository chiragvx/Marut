/**
 * src/render/cockpit/components/flightControls.ts — centre stick, throttle and rudder pedals.
 *
 * All three follow the pilot's inputs as they move them (not the sim's delayed state), so the
 * stick answers the mouse or keyboard at once. HOTAS buttons that map to game actions are
 * clickable: weapon select, target designate, radar mode and autopilot disconnect on the stick;
 * the speed brake switch and radar range on the throttle.
 */

import * as THREE from 'three';
import { apEngaged } from '../avionics';
import { box, local, mul, rod } from '../build';
import type { CockpitKit } from '../index';
import type { CockpitComponent, CockpitControl } from '../types';

const DEG = Math.PI / 180;

/** A grip shape: a side profile (x fwd, y up) extruded across and rounded. */
function gripGeometry(profile: readonly (readonly [number, number])[], width: number, bevel: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(profile.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: width - 2 * bevel, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 4, curveSegments: 10 });
  g.translate(0, 0, -(width - 2 * bevel) / 2);
  g.computeVertexNormals();
  return g;
}

/** Rubber bellows boot (lathe with ribs), standing on y = 0. */
function boot(r0: number, r1: number, h: number, ribs: number): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const n = ribs * 2;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = r0 + (r1 - r0) * t;
    pts.push(new THREE.Vector2(r * (i % 2 ? 0.86 : 1), h * t));
  }
  return new THREE.LatheGeometry(pts, 24);
}

export interface StickOptions {
  /** Pivot at the floor (cockpit frame) and the grip's height above it. */
  pivot: THREE.Vector3;
  length: number;
  maxPitchRad: number;
  maxRollRad: number;
}

export function createStick(kit: CockpitKit, o: StickOptions): CockpitComponent {
  const object = new THREE.Group();
  object.position.copy(o.pivot);
  // Boot over the pivot (static).
  kit.batch.add(boot(0.075, 0.03, 0.13, 6), kit.mats.rubber, local(o.pivot.x, o.pivot.y, o.pivot.z));
  kit.batch.add(new THREE.CylinderGeometry(0.09, 0.095, 0.012, 24).translate(0, 0.006, 0), kit.mats.console, local(o.pivot.x, o.pivot.y, o.pivot.z));
  const moving = new THREE.Group();
  object.add(moving);
  // Shaft, slightly cranked aft at the top (towards the pilot's hand).
  const top = new THREE.Vector3(-0.02, o.length - 0.12, 0);
  moving.add(new THREE.Mesh(rod({ x: 0, y: 0.05, z: 0 }, top, 0.012, 0.011), kit.mats.darkMetal));
  // Grip: side profile, 0.14 m tall, leaning forward.
  const grip = new THREE.Group();
  grip.position.copy(top);
  grip.rotation.z = -12 * DEG;
  moving.add(grip);
  const profile: [number, number][] = [
    [-0.024, 0],
    [0.02, 0],
    [0.027, 0.028],
    [0.022, 0.07],
    [0.03, 0.105],
    [0.026, 0.128],
    [0.004, 0.142],
    [-0.022, 0.136],
    [-0.034, 0.112],
    [-0.03, 0.06],
    [-0.026, 0.02],
  ];
  grip.add(new THREE.Mesh(gripGeometry(profile, 0.046, 0.01), kit.mats.rubber));
  // Trigger (front) and its guard.
  const trigger = new THREE.Mesh(box(0.012, 0.03, 0.02).translate(0.034, 0.05, 0), kit.mats.darkMetal);
  grip.add(trigger);
  const controls: CockpitControl[] = [];
  const button = (x: number, y: number, z: number, r: number, mat: THREE.Material, label: string, press: CockpitControl['press'], labelFn?: CockpitControl['label']): void => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.008, 14).translate(0, 0.004, 0), mat);
    m.position.set(x, y, z);
    grip.add(m);
    controls.push({ target: m, label: labelFn ?? (() => label), press });
  };
  // Head: weapon release (red), trim hat, target designate, weapon select; AP disconnect paddle low on the front.
  button(0.012, 0.14, -0.008, 0.0065, kit.mats.red, 'Weapon release (fire with the launch key)', () => null);
  const hat = new THREE.Mesh(box(0.012, 0.006, 0.012).translate(0, 0.003, 0), kit.mats.darkMetal);
  hat.position.set(-0.008, 0.141, 0.008);
  grip.add(hat);
  button(0.027, 0.118, 0.012, 0.005, kit.mats.darkMetal, 'Target designate (cycle target)', () => ({ kind: 'cycleTarget' }));
  button(-0.018, 0.128, -0.018, 0.005, kit.mats.darkMetal, 'Weapon select (cycle weapon)', () => ({ kind: 'cycleWeapon' }));
  button(-0.032, 0.1, 0.0, 0.005, kit.mats.darkMetal, 'Radar mode: RWS / ACM', () => ({ kind: 'radarMode' }));
  const paddle = new THREE.Mesh(box(0.008, 0.024, 0.03).translate(0.034, 0.015, 0), kit.mats.metal);
  grip.add(paddle);
  controls.push({
    target: paddle,
    label: (c) => (apEngaged(c.av) ? 'Autopilot disconnect' : 'Autopilot disconnect (AP off)'),
    press: (c) => (apEngaged(c.av) ? { kind: 'autopilot', action: { type: 'toggleAp' } } : null),
  });

  let pitch = 0;
  let roll = 0;
  return {
    object,
    controls,
    update(ctx) {
      // A stick has a little mass and centring spring: follow the input quickly but not instantly.
      const k = Math.min(1, ctx.dtSec * 25);
      pitch += (ctx.controls.pitch - pitch) * k;
      roll += (ctx.controls.roll - roll) * k;
      moving.rotation.set(roll * o.maxRollRad, 0, pitch * o.maxPitchRad, 'ZXY');
      trigger.position.x = ctx.controls.trigger ? -0.004 : 0;
    },
  };
}

export interface ThrottleOptions {
  /** Pivot (below the console top) and lever length. */
  pivot: THREE.Vector3;
  length: number;
  /** Lever angles (rad, + = forward) at idle, military and full afterburner. */
  idleRad: number;
  milRad: number;
  abRad: number;
}

export function createThrottle(kit: CockpitKit, o: ThrottleOptions): CockpitComponent {
  const object = new THREE.Group();
  object.position.copy(o.pivot);
  const lever = new THREE.Group();
  object.add(lever);
  lever.add(new THREE.Mesh(box(0.012, o.length, 0.016).translate(0, o.length / 2, 0), kit.mats.darkMetal));
  // Grip: an upright handle leaning in towards the pilot's left hand, a thumb shelf on the inboard
  // side and a rounded cap (after the Tejas's HOTAS throttle).
  const grip = new THREE.Group();
  grip.position.set(0, o.length, 0);
  grip.rotation.set(0.18, 0, -6 * DEG);
  lever.add(grip);
  const body = new THREE.Mesh(gripGeometry([
    [-0.022, 0],
    [0.026, 0],
    [0.03, 0.035],
    [0.024, 0.075],
    [0.008, 0.088],
    [-0.018, 0.085],
    [-0.028, 0.05],
  ], 0.034, 0.009), kit.mats.rubber);
  grip.add(body);
  const shelf = new THREE.Mesh(gripGeometry([
    [-0.018, 0],
    [0.022, 0],
    [0.02, 0.012],
    [-0.016, 0.012],
  ], 0.03, 0.004), kit.mats.rubber);
  shelf.position.set(0, 0.052, 0.026);
  grip.add(shelf);
  const controls: CockpitControl[] = [];
  // Speed brake: a slide switch on the outboard face (thumb-forward = in, aft = out).
  const sb = new THREE.Mesh(box(0.014, 0.008, 0.006), kit.mats.keycap);
  sb.position.set(0.004, 0.066, 0.042);
  grip.add(sb);
  controls.push({ target: sb, label: (c) => `Speed brake: ${c.av.airbrake ? 'OUT' : 'IN'} (B)`, press: () => ({ kind: 'airbrake' }) });
  // Radar range: a small rocker on top.
  const rr = new THREE.Mesh(box(0.012, 0.005, 0.009), kit.mats.darkMetal);
  rr.position.set(0.006, 0.09, 0.0);
  grip.add(rr);
  controls.push({ target: rr, label: (c) => `Radar range: ${c.local.radarRangeKm} km (click: longer)`, press: (c) => {
    c.local.radarRangeKm = c.local.radarRangeKm >= 160 ? 10 : c.local.radarRangeKm * 2;
    return null;
  } });
  const cursor = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.005, 12), kit.mats.darkMetal);
  cursor.position.set(-0.012, 0.087, 0.006);
  grip.add(cursor);
  controls.push({ target: body, label: (c) => `Throttle: ${c.av.ab > 0.5 ? 'REHEAT' : `${Math.round(c.controls.throttle * 100)} %`}`, press: () => null });

  let angle = o.idleRad;
  return {
    object,
    controls,
    update(ctx) {
      const t = ctx.controls.throttle;
      const target = ctx.controls.afterburner && t >= 0.999 ? o.abRad : o.idleRad + (o.milRad - o.idleRad) * t;
      angle += (target - angle) * Math.min(1, ctx.dtSec * 18);
      // + angle = forward = rotation about -z.
      lever.rotation.z = -angle;
      sb.position.x = ctx.av.airbrake ? -0.004 : 0.008;
    },
  };
}

export interface PedalOptions {
  /** Centre between the pedals, half spacing, and fore/aft travel (m). */
  centre: THREE.Vector3;
  spacing: number;
  travel: number;
}

export function createPedals(kit: CockpitKit, o: PedalOptions): CockpitComponent {
  const object = new THREE.Group();
  object.position.copy(o.centre);
  const pedals: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const p = new THREE.Group();
    p.position.z = side * o.spacing;
    object.add(p);
    // Arm up to the hinge, and the pedal plate with a heel stop.
    const arm = new THREE.Mesh(box(0.02, 0.2, 0.02).translate(0.02, 0.1, 0), kit.mats.darkMetal);
    p.add(arm);
    const plate = new THREE.Group();
    const face = new THREE.Mesh(box(0.012, 0.13, 0.085), kit.mats.metal);
    plate.add(face);
    const ribs = new THREE.Mesh(box(0.004, 0.11, 0.07).translate(-0.007, 0, 0), kit.mats.rubber);
    plate.add(ribs);
    plate.position.set(-0.01, 0.02, 0);
    plate.rotation.z = 0.35;
    p.add(plate);
    pedals.push(p);
  }
  kit.batch.add(box(0.05, 0.03, o.spacing * 2 + 0.06), kit.mats.darkMetal, mul(local(o.centre.x + 0.03, o.centre.y + 0.2, o.centre.z), new THREE.Matrix4()));
  let yaw = 0;
  return {
    object,
    update(ctx) {
      yaw += (ctx.controls.yaw - yaw) * Math.min(1, ctx.dtSec * 20);
      // Right pedal forward for right yaw; toes tilt forward under braking.
      pedals[0]!.position.x = -yaw * o.travel;
      pedals[1]!.position.x = yaw * o.travel;
      for (const p of pedals) p.rotation.z = -ctx.controls.brakes * 0.2;
    },
  };
}
