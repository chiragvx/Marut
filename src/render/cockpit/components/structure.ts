/**
 * src/render/cockpit/components/structure.ts — the cockpit's shell: tub walls, floor, consoles,
 * rear bulkhead, footwell and glareshield coaming; and the canopy (glass, windscreen, rails, the
 * windscreen arch and the rear fairing), lofted from the aircraft's canopy cross-sections so the
 * inside matches the outside model.
 *
 * The shell is closed below the canopy rail: the exterior model is drawn in the world pass and
 * would otherwise show through gaps (from inside, its fuselage top passes through the cockpit).
 */

import * as THREE from 'three';
import { Batcher, type CockpitMaterials } from '../build';
import { createGlassMaterial, type GlassUniforms } from '../glass';
import type { CockpitComponent } from '../types';

/** Canopy cross-section at cockpit-frame x: superellipse from `sillY` up to `topY`, half-width `halfW` at the sill. */
export interface CanopySection {
  sillY: number;
  topY: number;
  halfW: number;
  n: number;
}

export interface ShellSpec {
  canopy(x: number): CanopySection;
  /** Canopy rail height (where the canopy meets the fuselage side), cockpit frame. */
  railY: number;
  floorY: number;
  /** Rear bulkhead and the front of the footwell, x. */
  rearX: number;
  frontX: number;
  /** Consoles: top height, inner edge |z|, fore/aft extent. */
  consoleTopY: number;
  consoleInnerZ: number;
  consoleFrontX: number;
  consoleRearX: number;
  /** Instrument panel: its front face x at the centreline and its top/bottom heights; knee clearance. */
  panelX: number;
  panelTopY: number;
  panelBottomY: number;
  /** Glareshield: forward end x and its height there. */
  coamingEndX: number;
  coamingEndY: number;
  /** Half-width of the coaming's rounded lip over the panel (between the panel's raised side parts). */
  coamingLipHalfWidth: number;
  /** Canopy: glass from `canopyRearX` to the arch at `archX`; windscreen from the arch to `windscreenEndX`; opaque fairing back to `fairingEndX`. */
  canopyRearX: number;
  archX: number;
  windscreenEndX: number;
  fairingEndX: number;
}

/** Half-width of the canopy at height y (0 above it). */
export function canopyHalfWidthAt(s: CanopySection, y: number): number {
  const h = (y - s.sillY) / (s.topY - s.sillY);
  if (h >= 1) return 0;
  if (h <= 0) return s.halfW;
  return s.halfW * Math.pow(1 - Math.pow(h, s.n), 1 / s.n);
}

/** Point on a canopy section at parameter a in [0, 1] (0 = left rail, 1 = right rail), from `fromY` upward. */
function sectionPoint(s: CanopySection, a: number, fromY: number, inset: number, out: THREE.Vector3): THREE.Vector3 {
  // Angle round the superellipse from the left base (phi0) over the top to the right base.
  const H = s.topY - s.sillY;
  const h0 = Math.max(0, Math.min(0.999, (fromY - s.sillY) / H));
  const phi0 = Math.asin(Math.pow(h0, s.n / 2));
  const phi = phi0 + (Math.PI - 2 * phi0) * a;
  const c = Math.cos(phi);
  const sn = Math.sin(phi);
  const z = -Math.sign(c) * Math.pow(Math.abs(c), 2 / s.n) * (s.halfW - inset);
  const y = s.sillY + Math.pow(Math.abs(sn), 2 / s.n) * (H - inset);
  return out.set(0, y, z);
}

/** A loft of canopy sections from x0 to x1, normals facing inwards (towards the pilot). */
function canopyLoft(spec: ShellSpec, x0: number, x1: number, nx: number, na: number, fromY: number, inset: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= nx; i++) {
    const x = x0 + ((x1 - x0) * i) / nx;
    const s = spec.canopy(x);
    for (let j = 0; j <= na; j++) {
      sectionPoint(s, j / na, fromY, inset, p);
      pos.push(x, p.y, p.z);
      uv.push(i / nx, j / na);
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < na; j++) {
      const a = i * (na + 1) + j;
      const b = a + na + 1;
      // Winding for inward-facing normals (seen from inside).
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A frame member following a canopy section at x (arch, bow), as a swept rectangle. */
function sectionMember(spec: ShellSpec, x: number, width: number, depth: number, fromY: number, na = 28): THREE.BufferGeometry {
  const s = spec.canopy(x);
  const pts: THREE.Vector3[] = [];
  const p = new THREE.Vector3();
  for (let j = 0; j <= na; j++) pts.push(sectionPoint(s, j / na, fromY, depth / 2 + 0.004, p).clone().setX(x));
  const curve = new THREE.CatmullRomCurve3(pts);
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, -depth / 2);
  shape.lineTo(width / 2, -depth / 2);
  shape.lineTo(width / 2, depth / 2);
  shape.lineTo(-width / 2, depth / 2);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { steps: na * 2, extrudePath: curve, bevelEnabled: false });
}

/** A quad from four corners (counter-clockwise as seen from the side it faces). */
function quad(a: number[], b: number[], c: number[], d: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  g.computeVertexNormals();
  return g;
}

const I = new THREE.Matrix4();

export function buildShell(spec: ShellSpec, mats: CockpitMaterials, batch: Batcher, glassU: GlassUniforms): CockpitComponent {
  const object = new THREE.Group();
  const { floorY: fy, railY: ry, rearX, frontX } = spec;
  const wallZ = (x: number): number => canopyHalfWidthAt(spec.canopy(Math.max(spec.canopyRearX, Math.min(spec.windscreenEndX - 0.3, x))), ry) - 0.012;

  // Side walls, as strips along x (following the canopy's width at the rail), floor to rail.
  const steps = 16;
  for (const side of [-1, 1]) {
    for (let i = 0; i < steps; i++) {
      const xa = rearX + ((frontX - rearX) * i) / steps;
      const xb = rearX + ((frontX - rearX) * (i + 1)) / steps;
      // The footwell narrows ahead of the panel.
      const na = xa > spec.panelX ? 1 - 0.35 * Math.min(1, (xa - spec.panelX) / (frontX - spec.panelX)) : 1;
      const nb = xb > spec.panelX ? 1 - 0.35 * Math.min(1, (xb - spec.panelX) / (frontX - spec.panelX)) : 1;
      const za = side * wallZ(xa) * na;
      const zb = side * wallZ(xb) * nb;
      const g = side < 0 ? quad([xa, fy, za], [xb, fy, zb], [xb, ry, zb], [xa, ry, za]) : quad([xb, fy, zb], [xa, fy, za], [xa, ry, za], [xb, ry, zb]);
      batch.add(g, mats.wall, I);
      // Floor strip, wall to wall (built once, from the left side's pass).
      if (side < 0) batch.add(quad([xa, fy, -za], [xb, fy, -zb], [xb, fy, zb], [xa, fy, za]), mats.wall, I);
    }
    // Canopy rail: a rounded bar along the top of the wall.
    const railPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const x = spec.canopyRearX + ((spec.archX + 0.02 - spec.canopyRearX) * i) / 10;
      railPts.push(new THREE.Vector3(x, ry + 0.012, side * (wallZ(x) - 0.006)));
    }
    batch.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPts), 20, 0.02, 8, false), mats.frame, I);
    // Rail inner lip (a flat ledge the canopy seals against).
    for (let i = 0; i < 10; i++) {
      const xa = spec.canopyRearX + ((spec.archX - spec.canopyRearX) * i) / 10;
      const xb = spec.canopyRearX + ((spec.archX - spec.canopyRearX) * (i + 1)) / 10;
      const za = side * wallZ(xa);
      const zb = side * wallZ(xb);
      const zi = side * 0.035;
      const g =
        side < 0
          ? quad([xb, ry, zb + zi], [xa, ry, za + zi], [xa, ry, za], [xb, ry, zb])
          : quad([xa, ry, za - zi], [xb, ry, zb - zi], [xb, ry, zb], [xa, ry, za]);
      batch.add(g, mats.console, I);
    }
  }

  const zf = wallZ(0);
  // Rear bulkhead (behind the seat), up to a little above the rail.
  const zr = wallZ(rearX) + 0.02;
  batch.add(quad([rearX, fy, -zr], [rearX, fy, zr], [rearX, ry + 0.06, zr], [rearX, ry + 0.06, -zr]), mats.wall, I);
  // Footwell front.
  batch.add(quad([frontX, fy, zf * 0.65], [frontX, fy - 0.0, -zf * 0.65], [frontX, spec.panelBottomY, -zf * 0.65], [frontX, spec.panelBottomY, zf * 0.65]), mats.wall, I);
  // Underside of the panel (the knee area ceiling): panel bottom back to the footwell front.
  const pb = spec.panelBottomY;
  batch.add(quad([spec.panelX, pb, -zf], [frontX, pb + 0.04, -zf * 0.65], [frontX, pb + 0.04, zf * 0.65], [spec.panelX, pb, zf]), mats.wall, I);

  // Consoles: a block each side, top at consoleTopY between the inner edge and the wall.
  for (const side of [-1, 1]) {
    const x0 = spec.consoleRearX;
    const x1 = spec.consoleFrontX;
    const zi = side * spec.consoleInnerZ;
    const zo0 = side * wallZ(x0);
    const zo1 = side * wallZ(x1);
    const ty = spec.consoleTopY;
    // Top (textured panels go on it; this is the frame between them).
    batch.add(side < 0 ? quad([x0, ty, zo0], [x1, ty, zo1], [x1, ty, zi], [x0, ty, zi]) : quad([x1, ty, zo1], [x0, ty, zo0], [x0, ty, zi], [x1, ty, zi]), mats.console, I);
    // Inner face down to the floor.
    batch.add(side < 0 ? quad([x0, fy, zi], [x1, fy, zi], [x1, ty, zi], [x0, ty, zi]) : quad([x1, fy, zi], [x0, fy, zi], [x0, ty, zi], [x1, ty, zi]), mats.console, I);
    // Front face.
    batch.add(side < 0 ? quad([x1, fy, zi], [x1, fy, zo1], [x1, ty, zo1], [x1, ty, zi]) : quad([x1, fy, zo1], [x1, fy, zi], [x1, ty, zi], [x1, ty, zo1]), mats.console, I);
  }

  // Panel sides: close the gap between the instrument panel and the walls, rail down to the knees.
  for (const side of [-1, 1]) {
    const z = side * wallZ(spec.panelX);
    const zi = side * (wallZ(spec.panelX) - 0.07);
    const a = [spec.panelX - 0.05, spec.consoleTopY, z];
    const b = [spec.panelX + 0.12, spec.consoleTopY, z];
    const c = [spec.panelX + 0.12, spec.panelTopY, zi];
    const d = [spec.panelX - 0.05, ry, z];
    batch.add(side < 0 ? quad(a, b, c, d) : quad(b, a, d, c), mats.wall, I);
  }

  // Glareshield coaming: from the panel top forward to the windscreen, as wide as the canopy there.
  const ncx = 8;
  for (let i = 0; i < ncx; i++) {
    const xa = spec.panelX - 0.02 + ((spec.coamingEndX - spec.panelX + 0.02) * i) / ncx;
    const xb = spec.panelX - 0.02 + ((spec.coamingEndX - spec.panelX + 0.02) * (i + 1)) / ncx;
    const ya = spec.panelTopY + ((spec.coamingEndY - spec.panelTopY) * (xa - spec.panelX)) / (spec.coamingEndX - spec.panelX);
    const yb = spec.panelTopY + ((spec.coamingEndY - spec.panelTopY) * (xb - spec.panelX)) / (spec.coamingEndX - spec.panelX);
    const za = Math.min(wallZ(spec.panelX), canopyHalfWidthAt(spec.canopy(xa), ya) + 0.01);
    const zb = Math.min(wallZ(spec.panelX), canopyHalfWidthAt(spec.canopy(xb), yb) + 0.01);
    batch.add(quad([xa, ya, za], [xb, yb, zb], [xb, yb, -zb], [xa, ya, -za]), mats.bezel, I);
    // Its sides down to the rail (hidden unless looking down the canopy side).
    for (const side of [-1, 1]) {
      const g = side < 0 ? quad([xa, ry, -za], [xb, ry, -zb], [xb, yb, -zb], [xa, ya, -za]) : quad([xb, ry, zb], [xa, ry, za], [xa, ya, za], [xb, yb, zb]);
      batch.add(g, mats.wall, I);
    }
  }
  // Coaming's rounded front lip over the panel.
  batch.add(new THREE.CylinderGeometry(0.012, 0.012, spec.coamingLipHalfWidth * 2, 12).rotateX(Math.PI / 2).translate(spec.panelX - 0.02, spec.panelTopY - 0.002, 0), mats.bezel, I);

  // --- Canopy. ---
  const glassMat = createGlassMaterial(glassU, { tint: 0xd8c890, base: 0.02, reflect: 0.3, wear: 1 });
  const glassGeom = canopyLoft(spec, spec.canopyRearX, spec.archX, 24, 40, ry, 0);
  const canopyGlass = new THREE.Mesh(glassGeom, glassMat);
  canopyGlass.renderOrder = 4;
  object.add(canopyGlass);
  const wsGeom = canopyLoft(spec, spec.archX, spec.windscreenEndX, 10, 30, spec.coamingEndY - 0.05, 0);
  const windscreen = new THREE.Mesh(wsGeom, createGlassMaterial(glassU, { tint: 0xd8c890, base: 0.03, reflect: 0.35, wear: 1.2 }));
  windscreen.renderOrder = 4;
  object.add(windscreen);
  // Arch (windscreen frame) and the canopy's rear bow.
  batch.add(sectionMember(spec, spec.archX, 0.045, 0.03, ry), mats.frame, I);
  batch.add(sectionMember(spec, spec.canopyRearX, 0.05, 0.035, ry), mats.frame, I);
  // Canopy side frame members along the rails (the canopy's own sill).
  // Rear fairing: opaque, dark, from the rear bow back.
  const fair = canopyLoft(spec, spec.fairingEndX, spec.canopyRearX, 6, 24, ry - 0.02, -0.005);
  batch.add(fair, mats.wall, I);
  const endS = spec.canopy(spec.fairingEndX);
  const endCap = new THREE.CircleGeometry(1, 20, 0, Math.PI);
  endCap.scale(endS.halfW, endS.topY - ry, 1);
  endCap.rotateY(Math.PI / 2);
  endCap.translate(spec.fairingEndX, ry, 0);
  batch.add(endCap, mats.wall, I);

  return { object };
}
