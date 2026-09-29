/**
 * src/render/cockpit/components/controls.ts — generic cockpit controls: push buttons (with lit
 * legends), toggle switches (optionally under a guard), rotary knobs and annunciator lamps.
 *
 * Each is built in a panel frame (x right, y up, +z out of the panel) at a local position, and
 * returns a CockpitComponent whose control is clickable (label = tooltip, press = what it does).
 * State is read from the cockpit context every frame (`get`), so a control always shows the true
 * state of what it controls, whoever changed it (key, click, autopilot).
 */

import * as THREE from 'three';
import type { CockpitAction } from '../../../contracts/render';
import { box, cylZ, decalGeometry, displayOutput, knob, local, mul, roundedSlab, type Painter } from '../build';
import type { CockpitKit } from '../index';
import type { CockpitComponent, CockpitContext } from '../types';

type Press = (ctx: CockpitContext) => CockpitAction | null;
type Label = (ctx: CockpitContext) => string;

/** Colours for lit legends and lamps (display colours). */
export const LAMP = {
  green: new THREE.Color(0.25, 1.0, 0.35),
  amber: new THREE.Color(1.0, 0.62, 0.08),
  red: new THREE.Color(1.0, 0.12, 0.06),
  white: new THREE.Color(0.95, 0.95, 0.9),
  cyan: new THREE.Color(0.3, 0.85, 1.0),
} as const;

/** A material showing an atlas region whose legend lights up (emissive) with a colour. */
function litFaceMaterial(kit: CockpitKit): THREE.MeshStandardMaterial {
  return displayOutput(
    new THREE.MeshStandardMaterial({ map: kit.atlas.colorTexture, emissiveMap: kit.atlas.glowTexture, emissive: 0x000000, roughness: 0.35, side: THREE.DoubleSide })
  );
}

export interface ButtonSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Legend lines on the cap. */
  legend: string[];
  /** Legend colour when lit, and how lit it is now (0..1); omit for an unlit button. */
  lit?: { color: THREE.Color; get: (ctx: CockpitContext) => number };
  /** Cap colour (CSS). */
  cap?: string;
  label: Label;
  press: Press;
  /** How far the cap stands out, m. */
  height?: number;
}

/** A square push button with a legend on its cap (lit when `lit` says so), pressed in when clicked. */
export function pushButton(kit: CockpitKit, frame: THREE.Matrix4, s: ButtonSpec): CockpitComponent {
  const object = new THREE.Group();
  object.matrixAutoUpdate = false;
  object.matrix.copy(frame);
  const h = s.height ?? 0.007;
  // Bezel ring (static).
  kit.batch.add(roundedSlab(s.w + 0.004, s.h + 0.004, 0.003, 0.002), kit.mats.bezel, mul(frame, local(s.x, s.y, 0.0015)));
  const cap = new THREE.Group();
  cap.position.set(s.x, s.y, 0);
  object.add(cap);
  const body = new THREE.Mesh(roundedSlab(s.w, s.h, h, 0.0015, 0.0008), kit.mats.bezel);
  body.position.z = h / 2;
  cap.add(body);
  const region = kit.atlas.paint(s.w * 1000, s.h * 1000, (p: Painter) => {
    p.fill(s.cap ?? '#1b1c1d');
    const n = s.legend.length;
    const size = Math.min(3.2, (s.h * 1000 * 0.62) / Math.max(1, n));
    s.legend.forEach((line, i) => p.text(line, p.wMm / 2, p.hMm / 2 + (i - (n - 1) / 2) * size * 1.15, size, { color: '#e8e8e2', bold: true }));
  });
  const mat = s.lit ? litFaceMaterial(kit) : kit.mats.painted;
  const face = new THREE.Mesh(decalGeometry(region), mat);
  face.position.z = h + 0.0002;
  cap.add(face);
  let pressedAt = -1;
  return {
    object,
    controls: [
      {
        target: cap,
        label: s.label,
        press(ctx) {
          pressedAt = ctx.timeSec;
          return s.press(ctx);
        },
      },
    ],
    update(ctx) {
      cap.position.z = pressedAt >= 0 && ctx.timeSec - pressedAt < 0.15 ? -h * 0.4 : 0;
      if (s.lit) {
        const k = s.lit.get(ctx);
        const day = 0.6 + 0.9 * (1 - ctx.f.night);
        mat.emissive.copy(s.lit.color).multiplyScalar(k * day);
        if (k <= 0.01) mat.emissive.copy(LAMP.white).multiplyScalar(ctx.f.night * ctx.local.panelLights * 0.35);
      }
    },
  };
}

export interface ToggleSpec {
  x: number;
  y: number;
  /** Number of positions (2 or 3) and the current one (0 = down .. n-1 = up). */
  positions: 2 | 3;
  get: (ctx: CockpitContext) => number;
  label: Label;
  press: Press;
  /** Bat colour. */
  guard?: 'red' | 'stripes';
  /** Lever thrown sideways (left/right) instead of up/down. */
  sideways?: boolean;
}

/** A toggle switch: a threaded bushing and a bat that throws to the switch's position. */
export function toggleSwitch(kit: CockpitKit, frame: THREE.Matrix4, s: ToggleSpec): CockpitComponent {
  const object = new THREE.Group();
  object.matrixAutoUpdate = false;
  object.matrix.copy(frame);
  kit.batch.add(cylZ(0.0065, 0.0065, 0.002, 16), kit.mats.metal, mul(frame, local(s.x, s.y, 0)));
  kit.batch.add(cylZ(0.0042, 0.0042, 0.006, 12), kit.mats.metal, mul(frame, local(s.x, s.y, 0.002)));
  const pivot = new THREE.Group();
  pivot.position.set(s.x, s.y, 0.008);
  object.add(pivot);
  const bat = new THREE.Mesh(new THREE.CylinderGeometry(0.0018, 0.0026, 0.02, 10).translate(0, 0.01, 0).rotateX(Math.PI / 2), kit.mats.metal);
  pivot.add(bat);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.0026, 10, 8).translate(0, 0, 0.02), kit.mats.metal);
  pivot.add(tip);
  // A generous invisible hit box so small switches are easy to click.
  const hit = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.022, 0.025), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.set(s.x, s.y, 0.012);
  object.add(hit);
  let guard: THREE.Object3D | null = null;
  if (s.guard) {
    const g = new THREE.Group();
    g.position.set(s.x, s.y - 0.012, 0.002);
    const mat = s.guard === 'red' ? kit.mats.red : kit.mats.yellow;
    const cover = new THREE.Mesh(box(0.02, 0.028, 0.002).translate(0, 0.014, 0.024), mat);
    const sideL = new THREE.Mesh(box(0.002, 0.028, 0.024).translate(-0.009, 0.014, 0.012), mat);
    const sideR = new THREE.Mesh(box(0.002, 0.028, 0.024).translate(0.009, 0.014, 0.012), mat);
    g.add(cover, sideL, sideR);
    object.add(g);
    guard = g;
  }
  let angle = 0;
  return {
    object,
    controls: [{ target: hit, label: s.label, press: s.press }],
    update(ctx) {
      const pos = s.get(ctx);
      const target = s.positions === 2 ? (pos > 0 ? 0.45 : -0.45) : (pos - 1) * 0.45;
      angle += (target - angle) * Math.min(1, ctx.dtSec * 30);
      if (s.sideways) pivot.rotation.set(0, angle, 0);
      else pivot.rotation.set(-angle, 0, 0);
      if (guard) guard.rotation.x = pos > 0 ? -1.9 : 0;
    },
  };
}

export interface KnobSpec {
  x: number;
  y: number;
  radius: number;
  /** Detent angles (rad, 0 = pointer up, + = clockwise) and the current detent. */
  detents: number[];
  get: (ctx: CockpitContext) => number;
  label: Label;
  press: Press;
}

/** A rotary knob with a pointer line; clicking steps it to the next detent. */
export function rotaryKnob(kit: CockpitKit, frame: THREE.Matrix4, s: KnobSpec): CockpitComponent {
  const object = new THREE.Group();
  object.matrixAutoUpdate = false;
  object.matrix.copy(frame);
  const k = new THREE.Group();
  k.position.set(s.x, s.y, 0);
  object.add(k);
  const body = new THREE.Mesh(knob(s.radius, s.radius * 1.2, 18), kit.mats.bezel);
  k.add(body);
  const pointer = new THREE.Mesh(box(s.radius * 0.18, s.radius * 0.9, 0.0008).translate(0, s.radius * 0.5, s.radius * 1.2 + 0.0004), displayOutput(new THREE.MeshBasicMaterial({ color: 0xe8e8e0 })));
  k.add(pointer);
  let angle = 0;
  return {
    object,
    controls: [{ target: k, label: s.label, press: s.press }],
    update(ctx) {
      const target = s.detents[Math.max(0, Math.min(s.detents.length - 1, s.get(ctx)))] ?? 0;
      angle += (target - angle) * Math.min(1, ctx.dtSec * 25);
      k.rotation.z = -angle;
    },
  };
}

export interface LampSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  legend: string[];
  color: THREE.Color;
  get: (ctx: CockpitContext) => number;
  /** Tooltip; without it the lamp isn't clickable. */
  label?: Label;
  press?: Press;
}

/**
 * An annunciator: a legend window, dark grey when off (the legend just readable), glowing in its
 * colour when on. Real annunciators are sunlight-readable: bright enough to read in direct sun.
 */
export function lamp(kit: CockpitKit, frame: THREE.Matrix4, s: LampSpec): CockpitComponent {
  const object = new THREE.Group();
  object.matrixAutoUpdate = false;
  object.matrix.copy(frame);
  kit.batch.add(roundedSlab(s.w + 0.003, s.h + 0.003, 0.004, 0.0015), kit.mats.bezel, mul(frame, local(s.x, s.y, 0.002)));
  const region = kit.atlas.paint(s.w * 1000, s.h * 1000, (p) => {
    p.fill('#141515');
    const n = s.legend.length;
    const size = Math.min(3.4, (s.h * 1000 * 0.6) / Math.max(1, n));
    s.legend.forEach((line, i) => p.text(line, p.wMm / 2, p.hMm / 2 + (i - (n - 1) / 2) * size * 1.15, size, { color: '#5a5a55', bold: true }));
  });
  const mat = litFaceMaterial(kit);
  mat.roughness = 0.2;
  const face = new THREE.Mesh(decalGeometry(region), mat);
  face.position.set(s.x, s.y, 0.0042);
  object.add(face);
  return {
    object,
    ...(s.label && s.press ? { controls: [{ target: face, label: s.label, press: s.press }] } : {}),
    update(ctx) {
      const k = s.get(ctx);
      mat.emissive.copy(s.color).multiplyScalar(k * (0.9 + 1.4 * (1 - ctx.f.night)));
    },
  };
}
