/**
 * src/render/airbaseAssets.ts — the generic, low-poly airbase structures, one unit-sized model per
 * StructureKind (contracts/airport.ts). Each is 1 x 1 x 1: x across (-0.5..0.5), y up (0..1),
 * z from the front (-0.5, where the doors are) to the back (+0.5); instances scale it to the
 * structure's widthM x heightM x lengthM and turn it to face headingRad.
 *
 * Every vertex carries a part code (aPart) that picks its material in the structure shader:
 */
import * as THREE from 'three';

export const Part = {
  Concrete: 0,
  Door: 1,
  Earth: 2,
  Wall: 3,
  Glass: 4,
  Tank: 5,
  Antenna: 6,
  Roof: 7,
  /** Windsock fabric: orange and white bands. */
  Sock: 8,
} as const;

interface Builder {
  p: number[];
  n: number[];
  part: number[];
}

function tri(g: Builder, a: number[], b: number[], c: number[], part: number, na?: number[], nb?: number[], nc?: number[]): void {
  const ux = b[0]! - a[0]!;
  const uy = b[1]! - a[1]!;
  const uz = b[2]! - a[2]!;
  const vx = c[0]! - a[0]!;
  const vy = c[1]! - a[1]!;
  const vz = c[2]! - a[2]!;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  g.p.push(...a, ...b, ...c);
  g.n.push(...(na ?? [nx, ny, nz]), ...(nb ?? [nx, ny, nz]), ...(nc ?? [nx, ny, nz]));
  g.part.push(part, part, part);
}

/** Quad a-b-c-d, counter-clockwise seen from outside. */
function quad(g: Builder, a: number[], b: number[], c: number[], d: number[], part: number): void {
  tri(g, a, b, c, part);
  tri(g, a, c, d, part);
}

/** Axis-aligned box; parts per face: [front(-z), back(+z), left(-x), right(+x), top, bottom-less]. */
function box(g: Builder, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, parts: number | [number, number, number, number, number]): void {
  const [pf, pb, pl, pr, pt] = typeof parts === 'number' ? [parts, parts, parts, parts, parts] : parts;
  quad(g, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], pf); // front, facing -z
  quad(g, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], pb); // back
  quad(g, [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], pl); // left
  quad(g, [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], pr); // right
  quad(g, [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], pt); // top
}

/** Vertical cylinder (open bottom), optional flat top. */
function cylinder(g: Builder, r: number, y0: number, y1: number, segs: number, part: number, top: boolean): void {
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const p0 = [Math.cos(a0) * r, 0, Math.sin(a0) * r];
    const p1 = [Math.cos(a1) * r, 0, Math.sin(a1) * r];
    const n0 = [Math.cos(a0), 0, Math.sin(a0)];
    const n1 = [Math.cos(a1), 0, Math.sin(a1)];
    const A = [p0[0]!, y0, p0[2]!];
    const B = [p1[0]!, y0, p1[2]!];
    const C = [p1[0]!, y1, p1[2]!];
    const D = [p0[0]!, y1, p0[2]!];
    tri(g, A, C, B, part, n0, n1, n1);
    tri(g, A, D, C, part, n0, n0, n1);
    if (top) tri(g, [0, y1, 0], C, D, part, [0, 1, 0], [0, 1, 0], [0, 1, 0]);
  }
}

function cone(g: Builder, r: number, y0: number, y1: number, segs: number, part: number): void {
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    tri(g, [0, y1, 0], [Math.cos(a1) * r, y0, Math.sin(a1) * r], [Math.cos(a0) * r, y0, Math.sin(a0) * r], part);
  }
}

/**
 * An arched vault along z from z0 (front) to z1 (back): half width hw, springing at y0, crown at
 * y0 + rise (elliptical), smooth normals; closed at the front with frontPart and the back with backPart.
 */
function vault(g: Builder, hw: number, y0: number, rise: number, z0: number, z1: number, segs: number, part: number, frontPart: number, backPart: number): void {
  const pts: [number, number, number, number][] = [];
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * Math.PI;
    const x = -hw * Math.cos(t);
    const y = rise * Math.sin(t);
    const nx = x / (hw * hw);
    const ny = y / (rise * rise);
    const l = Math.hypot(nx, ny) || 1;
    pts.push([x, y0 + y, nx / l, ny / l]);
  }
  for (let i = 0; i < segs; i++) {
    const [xa, ya, nxa, nya] = pts[i]!;
    const [xb, yb, nxb, nyb] = pts[i + 1]!;
    const na = [nxa, nya, 0];
    const nb = [nxb, nyb, 0];
    tri(g, [xa, ya, z0], [xa, ya, z1], [xb, yb, z1], part, na, na, nb);
    tri(g, [xa, ya, z0], [xb, yb, z1], [xb, yb, z0], part, na, nb, nb);
    // End caps as fans from the middle of the base (a negative part leaves that end open).
    if (frontPart >= 0) tri(g, [0, y0, z0], [xb, yb, z0], [xa, ya, z0], frontPart, [0, 0, -1], [0, 0, -1], [0, 0, -1]);
    if (backPart >= 0) tri(g, [0, y0, z1], [xa, ya, z1], [xb, yb, z1], backPart, [0, 0, 1], [0, 0, 1], [0, 0, 1]);
  }
}

/** The flat ring between two concentric arches (outer hw/rise, inner scaled by k), front z0 to z1: a portal frame. */
function vaultRing(g: Builder, hw: number, innerHw: number, y0: number, rise: number, k: number, z0: number, z1: number, segs: number, part: number): void {
  const at = (h: number, r: number, t: number): [number, number] => [-h * Math.cos(t), y0 + r * Math.sin(t)];
  for (let i = 0; i < segs; i++) {
    const t0 = (i / segs) * Math.PI;
    const t1 = ((i + 1) / segs) * Math.PI;
    const [ox0, oy0] = at(hw, rise, t0);
    const [ox1, oy1] = at(hw, rise, t1);
    const [ix0, iy0] = at(innerHw, rise * k, t0);
    const [ix1, iy1] = at(innerHw, rise * k, t1);
    // Front face.
    quad(g, [ox1, oy1, z0], [ox0, oy0, z0], [ix0, iy0, z0], [ix1, iy1, z0], part);
    // Soffit of the opening.
    quad(g, [ix0, iy0, z0], [ix0, iy0, z1], [ix1, iy1, z1], [ix1, iy1, z0], part);
  }
}

/** A horizontal cylinder along z (x radius r, centre height cy), capped at both ends. */
function hcyl(g: Builder, cx: number, cy: number, r: number, z0: number, z1: number, segs: number, part: number): void {
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const p0 = [cx + Math.cos(a0) * r, cy + Math.sin(a0) * r];
    const p1 = [cx + Math.cos(a1) * r, cy + Math.sin(a1) * r];
    const n0 = [Math.cos(a0), Math.sin(a0), 0];
    const n1 = [Math.cos(a1), Math.sin(a1), 0];
    tri(g, [p0[0]!, p0[1]!, z0], [p1[0]!, p1[1]!, z1], [p1[0]!, p1[1]!, z0], part, n0, n1, n1);
    tri(g, [p0[0]!, p0[1]!, z0], [p0[0]!, p0[1]!, z1], [p1[0]!, p1[1]!, z1], part, n0, n0, n1);
    tri(g, [cx, cy, z0], [p0[0]!, p0[1]!, z0], [p1[0]!, p1[1]!, z0], part, [0, 0, -1], [0, 0, -1], [0, 0, -1]);
    tri(g, [cx, cy, z1], [p1[0]!, p1[1]!, z1], [p0[0]!, p0[1]!, z1], part, [0, 0, 1], [0, 0, 1], [0, 0, 1]);
  }
}

function geometry(g: Builder): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(g.p, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(g.n, 3));
  out.setAttribute('aPart', new THREE.Float32BufferAttribute(g.part, 1));
  return out;
}

const make = (f: (g: Builder) => void): THREE.BufferGeometry => {
  const g: Builder = { p: [], n: [], part: [] };
  f(g);
  return geometry(g);
};

/** One model per StructureKind value (contracts/airport.ts). */
export function makeAirbaseAssets(): Record<string, THREE.BufferGeometry> {
  return {
    // Hardened aircraft shelter: a concrete vault, the blast door filling the front arch, a
    // concrete apron lip in front of the door.
    shelter: make((g) => {
      // The vault, open at the front (doors open), closed at the back.
      vault(g, 0.5, 0, 1, -0.47, 0.5, 12, Part.Concrete, -1, Part.Concrete);
      // A thick concrete portal ring around the opening.
      vaultRing(g, 0.5, 0.44, 0, 1, 0.9, -0.5, -0.47, 12, Part.Concrete);
      // The two steel door leaves, slid open to either side on their tracks.
      box(g, -1.0, -0.5, 0, 0.72, -0.53, -0.49, Part.Door);
      box(g, 0.5, 1.0, 0, 0.72, -0.53, -0.49, Part.Door);
    }),
    // Maintenance hangar: walls, a full-width door in the front, a shallow barrel roof.
    hangar: make((g) => {
      box(g, -0.5, 0.5, 0, 0.72, -0.5, 0.5, [Part.Door, Part.Concrete, Part.Concrete, Part.Concrete, Part.Roof]);
      vault(g, 0.5, 0.72, 0.28, -0.5, 0.5, 10, Part.Roof, Part.Concrete, Part.Concrete);
    }),
    // Flat-roofed block (windows drawn by the shader on Wall faces).
    building: make((g) => {
      box(g, -0.5, 0.5, 0, 1, -0.5, 0.5, [Part.Wall, Part.Wall, Part.Wall, Part.Wall, Part.Roof]);
      // Parapet-ish rooftop plant room.
      box(g, -0.15, 0.15, 1, 1.12, 0.1, 0.35, Part.Concrete);
    }),
    // Control tower: shaft, glazed cab overhanging it, roof.
    control_tower: make((g) => {
      box(g, -0.3, 0.3, 0, 0.78, -0.3, 0.3, Part.Wall);
      box(g, -0.5, 0.5, 0.78, 0.95, -0.5, 0.5, [Part.Glass, Part.Glass, Part.Glass, Part.Glass, Part.Roof]);
      box(g, -0.55, 0.55, 0.95, 1.0, -0.55, 0.55, Part.Roof);
    }),
    // Vertical fuel tank: cylinder and a shallow cone roof.
    fuel_tank: make((g) => {
      cylinder(g, 0.5, 0, 0.88, 18, Part.Tank, false);
      cone(g, 0.5, 0.88, 1.0, 18, Part.Tank);
    }),
    // Earth bund around a fuel depot: four earth walls.
    fuel_bund: make((g) => {
      const t = 0.045;
      box(g, -0.5, 0.5, 0, 1, -0.5, -0.5 + t, Part.Earth);
      box(g, -0.5, 0.5, 0, 1, 0.5 - t, 0.5, Part.Earth);
      box(g, -0.5, -0.5 + t, 0, 1, -0.5 + t, 0.5 - t, Part.Earth);
      box(g, 0.5 - t, 0.5, 0, 1, -0.5 + t, 0.5 - t, Part.Earth);
    }),
    // Earth-covered munitions igloo with a concrete headwall and door.
    magazine: make((g) => {
      vault(g, 0.5, 0, 1, -0.45, 0.5, 10, Part.Earth, Part.Concrete, Part.Earth);
      box(g, -0.62, 0.62, 0, 1.1, -0.52, -0.45, Part.Concrete);
      quad(g, [0.22, 0, -0.521], [-0.22, 0, -0.521], [-0.22, 0.6, -0.521], [0.22, 0.6, -0.521], Part.Door);
    }),
    // Water tower: four legs and a tank.
    water_tower: make((g) => {
      for (const [x, z] of [[-0.32, -0.32], [0.32, -0.32], [-0.32, 0.32], [0.32, 0.32]] as const) box(g, x - 0.04, x + 0.04, 0, 0.66, z - 0.04, z + 0.04, Part.Concrete);
      const off: Builder = { p: [], n: [], part: [] };
      cylinder(off, 0.5, 0.66, 0.95, 16, Part.Tank, false);
      cone(off, 0.5, 0.95, 1.0, 16, Part.Tank);
      g.p.push(...off.p);
      g.n.push(...off.n);
      g.part.push(...off.part);
    }),
    // Fuel bowser (service vehicle): chassis and wheels, cab with a windscreen at the front, tank.
    fuel_truck: make((g) => {
      box(g, -0.5, 0.5, 0.12, 0.3, -0.5, 0.5, Part.Door);
      for (const z of [-0.36, 0.12, 0.36]) {
        box(g, -0.52, -0.36, 0, 0.2, z - 0.07, z + 0.07, Part.Door);
        box(g, 0.36, 0.52, 0, 0.2, z - 0.07, z + 0.07, Part.Door);
      }
      box(g, -0.5, 0.5, 0.3, 0.95, -0.5, -0.24, [Part.Concrete, Part.Concrete, Part.Concrete, Part.Concrete, Part.Roof]);
      quad(g, [0.44, 0.62, -0.501], [-0.44, 0.62, -0.501], [-0.44, 0.9, -0.501], [0.44, 0.9, -0.501], Part.Glass);
      hcyl(g, 0, 0.62, 0.46, -0.2, 0.48, 12, Part.Concrete);
    }),
    // Weapons loading trolley with two missiles on it.
    weapons_cart: make((g) => {
      box(g, -0.5, 0.5, 0.25, 0.4, -0.5, 0.5, Part.Door);
      for (const z of [-0.35, 0.35]) {
        box(g, -0.55, -0.4, 0, 0.26, z - 0.1, z + 0.1, Part.Door);
        box(g, 0.4, 0.55, 0, 0.26, z - 0.1, z + 0.1, Part.Door);
      }
      hcyl(g, -0.22, 0.6, 0.1, -0.48, 0.48, 8, Part.Tank);
      hcyl(g, 0.22, 0.6, 0.1, -0.48, 0.48, 8, Part.Tank);
    }),
    // Windsock: a pole at the back, the sock streaming forward (downwind: the instance faces where
    // the wind blows to), tapering and drooping a little.
    windsock: make((g) => {
      box(g, -0.025, 0.025, 0, 1, 0.45, 0.5, Part.Concrete);
      const segs = 10;
      const n = 5;
      for (let k = 0; k < n; k++) {
        const z0 = 0.47 - (k / n) * 0.9;
        const z1 = 0.47 - ((k + 1) / n) * 0.9;
        const r0 = 0.09 - (k / n) * 0.045;
        const r1 = 0.09 - ((k + 1) / n) * 0.045;
        const y0 = 0.93 - (k / n) * (k / n) * 0.08;
        const y1 = 0.93 - ((k + 1) / n) * ((k + 1) / n) * 0.08;
        for (let i = 0; i < segs; i++) {
          const a0 = (i / segs) * Math.PI * 2;
          const a1 = ((i + 1) / segs) * Math.PI * 2;
          const P = (r: number, y: number, z: number, a: number): number[] => [Math.cos(a) * r, y + Math.sin(a) * r, z];
          const N = (a: number): number[] => [Math.cos(a), Math.sin(a), 0];
          tri(g, P(r0, y0, z0, a0), P(r1, y1, z1, a1), P(r1, y1, z1, a0), Part.Sock, N(a0), N(a1), N(a0));
          tri(g, P(r0, y0, z0, a0), P(r0, y0, z0, a1), P(r1, y1, z1, a1), Part.Sock, N(a0), N(a1), N(a1));
        }
      }
    }),
    // Floodlight mast: a pole with a lamp head.
    light_mast: make((g) => {
      box(g, -0.05, 0.05, 0, 0.95, -0.05, 0.05, Part.Concrete);
      box(g, -0.4, 0.4, 0.95, 1.0, -0.12, 0.12, Part.Tank);
    }),
    // Surveillance radar: a lattice-ish mast, a platform and a rotating antenna (Part.Antenna).
    radar: make((g) => {
      box(g, -0.09, 0.09, 0, 0.74, -0.09, 0.09, Part.Concrete);
      box(g, -0.22, 0.22, 0.74, 0.78, -0.22, 0.22, Part.Concrete);
      box(g, -0.5, 0.5, 0.8, 1.0, -0.03, 0.03, Part.Antenna);
      box(g, -0.03, 0.03, 0.78, 0.8, -0.03, 0.03, Part.Antenna);
    }),
  };
}
