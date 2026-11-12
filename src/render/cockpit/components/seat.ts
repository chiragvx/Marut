/**
 * src/render/cockpit/components/seat.ts — an ejection seat (Martin-Baker Mk16 style, as fitted to
 * the Tejas), and a standby magnetic compass.
 *
 * The seat is what the pilot sees of it: the headbox and drogue container behind the head, the
 * guide rails and side beams, the cushions, the survival pack under the seat pan, and the
 * yellow-and-black seat firing handle on the front of the pan between the knees.
 */

import * as THREE from 'three';
import { box, decalGeometry, local, mul, rod } from '../build';
import type { CockpitKit } from '../index';
import type { CockpitComponent } from '../types';

const DEG = Math.PI / 180;
/** Headbox width, m (Mk16: narrower than the seat bucket). */
const HEADBOX_WIDTH_M = 0.38;

export interface SeatOptions {
  /** Seat reference point: the front of the seat pan's top, cockpit frame. */
  panFront: THREE.Vector3;
  /** Back angle from vertical, rad (Mk16 ~17 deg). */
  backAngle: number;
  width: number;
}

export function createSeat(kit: CockpitKit, o: SeatOptions): CockpitComponent {
  const object = new THREE.Group();
  const { mats, batch } = kit;
  const p = o.panFront;
  const w = o.width;
  // Frame: the seat is built in a local frame at the pan front, back leaning aft.
  const F = local(p.x, p.y, p.z);
  const back = (y: number, fwd = 0): THREE.Matrix4 => mul(F, mul(local(-0.44 - Math.tan(o.backAngle) * y + fwd, y, 0), new THREE.Matrix4().makeRotationZ(o.backAngle)));
  // Seat pan bucket and cushion.
  batch.add(box(0.46, 0.05, w), mats.console, mul(F, local(-0.23, -0.05, 0)));
  batch.add(box(0.44, 0.05, w - 0.05), mats.cushion, mul(F, local(-0.23, -0.005, 0)));
  // Survival pack under the pan, and the front of the pan.
  batch.add(box(0.06, 0.16, w - 0.04), mats.console, mul(F, local(-0.02, -0.14, 0)));
  // Side beams, rising up the back (to below the shoulders: the canopy narrows above them).
  for (const s of [-1, 1]) {
    batch.add(box(0.46, 0.2, 0.025), mats.console, mul(F, local(-0.23, 0.02, s * (w / 2 + 0.012))));
    batch.add(box(0.06, 0.8, 0.03), mats.darkMetal, mul(back(0.4), local(-0.03, 0, s * (w / 2 - 0.01))));
  }
  // Back cushion.
  batch.add(box(0.06, 0.62, w - 0.06), mats.cushion, back(0.38, 0.04));
  // Headbox and drogue container behind the head: a box with a low rounded top, narrower than the
  // seat, kept inside the canopy (it used to stand up through the glass behind the pilot).
  const hbW = Math.min(w - 0.06, HEADBOX_WIDTH_M);
  batch.add(box(0.13, 0.23, hbW), mats.console, back(0.745, -0.03));
  const dome = new THREE.Shape();
  dome.absellipse(0, 0, hbW / 2, 0.09, 0, Math.PI, false, 0);
  const domeGeom = new THREE.ExtrudeGeometry(dome, { depth: 0.13, bevelEnabled: false, curveSegments: 20 }).translate(0, 0, -0.065).rotateY(Math.PI / 2);
  batch.add(domeGeom, mats.console, back(0.86, -0.03));
  // Head pad.
  batch.add(box(0.05, 0.17, 0.16), mats.cushion, back(0.72, 0.07));
  // Headbox placard: "DANGER - EJECTION SEAT" triangle.
  const warn = kit.atlas.paint(90, 60, (pt) => {
    pt.fill('#141414');
    pt.stripes(0, 0, 90, 6, 4);
    pt.stripes(0, 54, 90, 6, 4);
    pt.text('DANGER', 45, 20, 9, { color: '#e02818', bold: true, glow: false });
    pt.text('EJECTION SEAT', 45, 34, 7, { color: '#e8e8e2', glow: false });
    pt.text('MARTIN-BAKER', 45, 46, 6, { color: '#bdbdb5', glow: false });
  });
  batch.add(decalGeometry(warn).rotateY(Math.PI / 2), mats.painted, mul(back(0.8, 0.036), local(0, 0, 0.13)));
  // Seat firing handle: a yellow/black loop on the front of the pan.
  const handle = new THREE.TorusGeometry(0.045, 0.009, 8, 20, Math.PI);
  handle.rotateY(Math.PI / 2);
  handle.rotateX(Math.PI);
  const stripeMat = kit.mats.yellow;
  batch.add(handle, stripeMat, mul(F, local(0.035, -0.03, 0)));
  for (let i = 0; i < 5; i++) {
    const a = ((i + 0.5) / 5) * Math.PI;
    batch.add(box(0.02, 0.0205, 0.009), mats.rubber, mul(F, local(0.035, -0.03 - Math.sin(a) * 0.045, Math.cos(a) * 0.045)));
  }
  // Leg restraint garters (lines to the floor).
  for (const s of [-1, 1]) batch.add(rod({ x: 0, y: 0, z: 0 }, { x: 0.3, y: -0.3, z: 0.05 * s }, 0.004), mats.webbing, mul(F, local(0, -0.08, s * 0.12)));
  void DEG;
  return { object };
}

/** A standby magnetic compass: a liquid-filled bowl whose card turns with the heading. */
export function createStandbyCompass(kit: CockpitKit, frame: THREE.Matrix4): CockpitComponent {
  const object = new THREE.Group();
  object.matrixAutoUpdate = false;
  object.matrix.copy(frame);
  kit.batch.add(new THREE.CylinderGeometry(0.028, 0.03, 0.05, 20).rotateX(Math.PI / 2).translate(0, 0, -0.025), kit.mats.bezel, frame);
  kit.batch.add(box(0.012, 0.03, 0.02).translate(0, 0.035, -0.03), kit.mats.bezel, frame);
  // Card: a drum with heading marks, read through the window.
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#101010';
  g.fillRect(0, 0, 512, 64);
  g.fillStyle = '#eee';
  g.strokeStyle = '#eee';
  g.textAlign = 'center';
  g.font = 'bold 22px Arial';
  for (let d = 0; d < 360; d += 5) {
    const x = (d / 360) * 512;
    g.fillRect(x, 0, 1.5, d % 10 === 0 ? 16 : 9);
    if (d % 30 === 0) g.fillText(d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d / 10), x, 44);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  const card = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.016, 32, 1, true),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
  );
  card.material.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <colorspace_fragment>', '');
  };
  card.position.z = -0.006;
  card.rotation.x = 0;
  object.add(card);
  // Lubber line.
  kit.batch.add(box(0.0012, 0.02, 0.001), kit.mats.red, mul(frame, local(0, 0, 0.0006)));
  return {
    object,
    update(ctx) {
      // The card shows the heading under the lubber line (at the front of the drum).
      tex.offset.x = ctx.av.headingDeg / 360 + 0.25;
    },
    dispose() {
      tex.dispose();
    },
  };
}
