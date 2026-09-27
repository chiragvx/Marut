/**
 * src/render/aircraftModels/tejasTestModel.ts — a procedural Tejas Mk1A for development, built in
 * code from public dimensions until a finished art asset exists.
 *
 * Public figures it is built to (tests/render/tejasTestModel.test.ts checks them): length 13.2 m
 * (pitot to nozzle), span 8.2 m, height 4.4 m (ground to fin tip, gear down), wing area 38.4 m^2.
 * Compound delta with a 62.5 deg inner and 50 deg outer leading edge, no tailplane or canards; two
 * elevons and leading-edge slats on each wing; swept fin with rudder; side intakes under the wing
 * roots; bubble canopy with a gold-tinted glass; two dorsal airbrakes; F404 nozzle; fixed refuelling
 * probe on the right of the nose; six wing pylons and a centreline pylon; tricycle gear.
 * Approximations (no public drawings): cross-sections, canopy shape, gear legs and their retraction
 * directions (nose gear aft, main gear forward).
 *
 * The airframe is authored in a "layout" frame (body axes: x forward, y up, z right) and placed in
 * the body frame at `LAYOUT_TO_BODY_X`, which puts the wheels where src/aircraft's gear legs touch
 * the ground (nose x = 4.3, mains x = -0.2) and the wheel bottoms ~8 cm above the legs' fully
 * extended contact points, the static squat of the oleos under the aircraft's weight.
 *
 * Each moving part is a separate geometry with a hinge (pivot + axis, layout frame); a positive
 * angle follows src/physics's surface conventions (fcs.ts): elevon trailing edge down, rudder
 * trailing edge left (nose-left). The model is plain data (geometries + hinges); meshAircraftRenderer.ts
 * builds the scene objects, so an imported glTF can later be mapped to the same template.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type V3 = [number, number, number];

/** Surface codes (vertex attribute aPart), read by aircraftMaterial.ts. */
export const PART = {
  fuselage: 0,
  canopy: 1,
  intake: 2,
  wing: 3,
  fin: 4,
  dark: 5,
  metal: 6,
  engine: 7,
  gear: 8,
  tyre: 9,
  lightRed: 10,
  lightGreen: 11,
  lightWhite: 12,
  pylon: 13,
} as const;

/** Layout x + this = body x. */
export const LAYOUT_TO_BODY_X = 0.7;

// --- Principal dimensions, layout frame, m. ---
export const NOSE_TIP_X = 6.2;
export const PITOT_TIP_X = 6.6;
export const NOZZLE_EXIT_X = -6.62;
export const NOZZLE_AXIS_Y = 0.35;
export const WING_Y = 0.42;
export const SEMI_SPAN = 4.1;
export const FIN_TIP_Y = 3.25;
/** Wheel bottoms (static squat); src/aircraft's legs touch at -1.1 fully extended. */
export const WHEEL_BOTTOM_Y = -1.02;

const CRANK_Z = 2.2;
const TAN_IN = Math.tan((62.5 * Math.PI) / 180);
const TAN_OUT = Math.tan((50 * Math.PI) / 180);
const LE_ROOT_X = 2.85;

/** Wing leading edge x at span |z| (the inner sweep line extended to the centreline, as the reference area is). */
export function wingLE(z: number): number {
  const a = Math.abs(z);
  return a <= CRANK_Z ? LE_ROOT_X - TAN_IN * a : LE_ROOT_X - TAN_IN * CRANK_Z - TAN_OUT * (a - CRANK_Z);
}
/** Wing trailing edge x (slightly forward-swept, unbroken). */
export function wingTE(z: number): number {
  return -5.7 + 0.122 * Math.abs(z);
}
/** Elevon hinge line. */
function elevonHinge(z: number): number {
  return wingTE(z) + 0.75 - 0.1 * (Math.abs(z) / SEMI_SPAN);
}
const SLAT_CHORD = 0.32;
const SLAT_Z: [number, number] = [2.25, 4.0];
const ELEVON_SPANS: [number, number][] = [
  [0.72, 2.3],
  [2.38, 3.98],
];

/** Reference wing area (both wings, through the fuselage), m^2. */
export function wingAreaM2(): number {
  let s = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) {
    const z = ((i + 0.5) / n) * SEMI_SPAN;
    s += wingLE(z) - wingTE(z);
  }
  return 2 * s * (SEMI_SPAN / n);
}

// Fin planform (x-y plane): root buried in the spine, 51 deg leading edge.
const FIN_ROOT_Y = 0.8;
const finLE = (y: number): number => -2.2 - 1.245 * (y - 0.85);
const finTE = (y: number): number => -6.1 - 0.0204 * (y - 0.85);
const rudderHinge = (y: number): number => finTE(y) + 0.55;
const RUDDER_Y: [number, number] = [1.0, 3.05];

/** Pylon depth below the wing's lower surface, m. */
const PYLON_DEPTH = 0.28;

// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// Geometry helpers
// -----------------------------------------------------------------------------

/** Monotone cubic through (xs ascending, ys). */
function spline(xs: readonly number[], ys: readonly number[]): (x: number) => number {
  const n = xs.length;
  const d: number[] = [];
  for (let k = 0; k < n - 1; k++) d.push((ys[k + 1]! - ys[k]!) / (xs[k + 1]! - xs[k]!));
  const m: number[] = [];
  for (let k = 0; k < n; k++) {
    if (k === 0) m.push(d[0]!);
    else if (k === n - 1) m.push(d[n - 2]!);
    else m.push(d[k - 1]! * d[k]! <= 0 ? 0 : (d[k - 1]! + d[k]!) / 2);
  }
  return (x) => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let k = 0;
    while (x > xs[k + 1]!) k++;
    const h = xs[k + 1]! - xs[k]!;
    const t = (x - xs[k]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[k]! + (t3 - 2 * t2 + t) * h * m[k]! + (-2 * t3 + 3 * t2) * ys[k + 1]! + (t3 - t2) * h * m[k + 1]!;
  };
}

/** Columns of a table (first column x ascending) as splines of x. */
function table(rows: readonly (readonly number[])[]): ((x: number) => number)[] {
  const xs = rows.map((r) => r[0]!);
  const out: ((x: number) => number)[] = [];
  for (let c = 1; c < rows[0]!.length; c++) out.push(spline(xs, rows.map((r) => r[c]!)));
  return out;
}

interface Section {
  cy: number;
  cz: number;
  w: number;
  hT: number;
  hB: number;
  n: number;
}

const sp = (v: number, e: number): number => Math.sign(v) * Math.pow(Math.abs(v), e);

/** Superellipse ring point at angle t (0 = +z side, pi/2 = top). */
function ringPoint(s: Section, t: number): [number, number] {
  const c = Math.cos(t);
  const sn = Math.sin(t);
  const e = 2 / s.n;
  return [s.cy + (sn >= 0 ? s.hT : s.hB) * sp(sn, e), s.cz + s.w * sp(c, e)];
}

interface Raw {
  pos: number[];
  idx: number[];
  noz?: number[];
}

/** (nu x nv) quad grid; u wraps around when `wrapU`. */
function grid(nu: number, nv: number, f: (i: number, j: number) => V3, wrapU = false): Raw {
  const cols = wrapU ? nu : nu + 1;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i < cols; i++) pos.push(...f(i, j));
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const i1 = wrapU ? (i + 1) % nu : i + 1;
      const a = j * cols + i;
      const b = j * cols + i1;
      const c = (j + 1) * cols + i1;
      const d = (j + 1) * cols + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  return { pos, idx };
}

/**
 * A BufferGeometry from raw triangles, wound so its faces point along `hint` (the outward
 * direction at a point) on balance, with smooth normals and the aPart/aNoz attributes.
 */
function geom(raw: Raw, part: number, hint: (p: V3) => V3): THREE.BufferGeometry {
  const { pos, idx } = raw;
  let s = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3;
    const b = idx[t + 1]! * 3;
    const c = idx[t + 2]! * 3;
    const ux = pos[b]! - pos[a]!;
    const uy = pos[b + 1]! - pos[a + 1]!;
    const uz = pos[b + 2]! - pos[a + 2]!;
    const vx = pos[c]! - pos[a]!;
    const vy = pos[c + 1]! - pos[a + 1]!;
    const vz = pos[c + 2]! - pos[a + 2]!;
    const h = hint([(pos[a]! + pos[b]! + pos[c]!) / 3, (pos[a + 1]! + pos[b + 1]! + pos[c + 1]!) / 3, (pos[a + 2]! + pos[b + 2]! + pos[c + 2]!) / 3]);
    s += (uy * vz - uz * vy) * h[0] + (uz * vx - ux * vz) * h[1] + (ux * vy - uy * vx) * h[2];
  }
  if (s < 0) {
    for (let t = 0; t < idx.length; t += 3) {
      const tmp = idx[t + 1]!;
      idx[t + 1] = idx[t + 2]!;
      idx[t + 2] = tmp;
    }
  }
  const g = new THREE.BufferGeometry();
  const n = pos.length / 3;
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Array<number>(n).fill(part), 1));
  g.setAttribute('aNoz', new THREE.Float32BufferAttribute(raw.noz ?? new Array<number>(n).fill(0), 1));
  return g;
}

/** Lofted surface through sections at xs; full ring, or an arc [t0, t1]. */
function loft(xs: readonly number[], sec: (x: number) => Section, n: number, part: number, opts: { arc?: [number, number]; inward?: boolean; noz?: (x: number) => number } = {}): THREE.BufferGeometry {
  const secs = xs.map(sec);
  const arc = opts.arc;
  const raw = grid(
    n,
    xs.length - 1,
    (i, j) => {
      const t = arc ? arc[0] + ((arc[1] - arc[0]) * i) / n : (2 * Math.PI * i) / n;
      const [y, z] = ringPoint(secs[j]!, t);
      return [xs[j]!, y, z];
    },
    !arc
  );
  if (opts.noz) {
    const cols = arc ? n + 1 : n;
    raw.noz = [];
    for (let j = 0; j < xs.length; j++) for (let i = 0; i < cols; i++) raw.noz.push(opts.noz(xs[j]!));
  }
  const sign = opts.inward ? -1 : 1;
  return geom(raw, part, (p) => {
    const s = sec(p[0]);
    return [0, sign * (p[1] - s.cy), sign * (p[2] - s.cz)];
  });
}

/** Flat fan closing a ring (section at x), facing `dir`. */
function cap(x: number, s: Section, n: number, part: number, dir: V3, noz = 0): THREE.BufferGeometry {
  const pos: number[] = [x, s.cy, s.cz];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const [y, z] = ringPoint(s, (2 * Math.PI * i) / n);
    pos.push(x, y, z);
    idx.push(0, 1 + i, 1 + ((i + 1) % n));
  }
  const raw: Raw = { pos, idx, noz: new Array<number>(n + 1).fill(noz) };
  raw.noz![0] = 0;
  return geom(raw, part, () => dir);
}

/** Circular section helper. */
const circle = (cy: number, cz: number, r: number): Section => ({ cy, cz, w: r, hT: r, hB: r, n: 2 });

/** Cylinder between two points. */
function cylinder(a: V3, b: V3, r: number, part: number, n = 10): THREE.BufferGeometry {
  const ax = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = ax.length();
  ax.normalize();
  const u = new THREE.Vector3(0, 1, 0);
  if (Math.abs(ax.dot(u)) > 0.9) u.set(1, 0, 0);
  const v = new THREE.Vector3().crossVectors(ax, u).normalize();
  u.crossVectors(v, ax).normalize();
  const pt = (i: number, j: number): V3 => {
    const t = (2 * Math.PI * i) / n;
    const c = Math.cos(t) * r;
    const s = Math.sin(t) * r;
    const k = j * len;
    return [a[0] + ax.x * k + u.x * c + v.x * s, a[1] + ax.y * k + u.y * c + v.y * s, a[2] + ax.z * k + u.z * c + v.z * s];
  };
  const side = geom(grid(n, 1, pt, true), part, (p) => {
    const d = new THREE.Vector3(p[0] - a[0], p[1] - a[1], p[2] - a[2]);
    d.addScaledVector(ax, -d.dot(ax));
    return [d.x, d.y, d.z];
  });
  const ends = [0, 1].map((j) => {
    const pos: number[] = [a[0] + ax.x * len * j, a[1] + ax.y * len * j, a[2] + ax.z * len * j];
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      pos.push(...pt(i, j));
      idx.push(0, 1 + i, 1 + ((i + 1) % n));
    }
    const dir: V3 = j === 0 ? [-ax.x, -ax.y, -ax.z] : [ax.x, ax.y, ax.z];
    return geom({ pos, idx }, part, () => dir);
  });
  return merge([side, ...ends]);
}

/** Axis-aligned box. */
function box(c: V3, h: V3, part: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(h[0] * 2, h[1] * 2, h[2] * 2).toNonIndexed();
  g.translate(c[0], c[1], c[2]);
  const pos = Array.from(g.getAttribute('position').array);
  const idx = pos.map((_, i) => i).slice(0, pos.length / 3);
  return geom({ pos, idx }, part, (p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
}

function merge(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(gs);
  if (!m) throw new Error('tejasTestModel: geometry merge failed');
  for (const g of gs) g.dispose();
  return m;
}

/** Mirror image across the x-y plane (right side -> left side). */
function mirrorZ(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const m = g.clone();
  const p = m.getAttribute('position') as THREE.BufferAttribute;
  const n = m.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    p.setZ(i, -p.getZ(i));
    n.setZ(i, -n.getZ(i));
  }
  const idx = m.getIndex()!;
  for (let t = 0; t < idx.count; t += 3) {
    const b = idx.getX(t + 1);
    idx.setX(t + 1, idx.getX(t + 2));
    idx.setX(t + 2, b);
  }
  return m;
}

const range = (a: number, b: number, step: number): number[] => {
  const n = Math.max(1, Math.ceil(Math.abs(b - a) / step));
  return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
};

// -----------------------------------------------------------------------------
// Airframe
// -----------------------------------------------------------------------------

// Fuselage cross-sections aft of the radome: x, centre y, half-width, top and bottom half-heights,
// superellipse exponent (2 = ellipse, higher = boxier).
const [fCy, fW, fHT, fHB, fN] = table([
  [-5.9, 0.35, 0.47, 0.47, 0.47, 2.0],
  [-5.2, 0.35, 0.52, 0.5, 0.5, 2.2],
  [-4.4, 0.35, 0.57, 0.53, 0.56, 2.4],
  [-3.4, 0.35, 0.61, 0.57, 0.6, 2.7],
  [-2.2, 0.35, 0.63, 0.59, 0.63, 2.9],
  [-1.0, 0.36, 0.63, 0.58, 0.65, 3.0],
  [0.2, 0.37, 0.62, 0.55, 0.65, 3.0],
  [1.0, 0.38, 0.6, 0.53, 0.63, 2.9],
  [1.6, 0.38, 0.58, 0.52, 0.61, 2.8],
  [2.2, 0.38, 0.56, 0.52, 0.58, 2.6],
  [2.8, 0.37, 0.53, 0.51, 0.55, 2.4],
  [3.4, 0.35, 0.5, 0.49, 0.51, 2.2],
  [4.0, 0.33, 0.465, 0.465, 0.47, 2.0],
]) as [(x: number) => number, (x: number) => number, (x: number) => number, (x: number) => number, (x: number) => number];

const RADOME_BASE_X = 4.0;
const RADOME_R = 0.465;
const RADOME_L = NOSE_TIP_X - RADOME_BASE_X;
const OGIVE_RHO = (RADOME_R * RADOME_R + RADOME_L * RADOME_L) / (2 * RADOME_R);

/** Fuselage section at x: tangent-ogive radome ahead of RADOME_BASE_X. */
export function fuselageSection(x: number): Section {
  if (x >= RADOME_BASE_X) {
    const d = Math.min(x - RADOME_BASE_X, RADOME_L);
    const r = Math.max(0, Math.sqrt(OGIVE_RHO * OGIVE_RHO - d * d) + RADOME_R - OGIVE_RHO);
    return { cy: 0.33 - 0.012 * d, cz: 0, w: r, hT: r, hB: r * 1.01, n: 2 };
  }
  return { cy: fCy(x), cz: 0, w: fW(x), hT: fHT(x), hB: fHB(x), n: fN(x) };
}

/** Height of the fuselage's upper surface at (x, |z|), or the centre height beyond its width. */
function fuselageTopY(x: number, z: number): number {
  const s = fuselageSection(x);
  const a = Math.min(1, Math.abs(z) / s.w);
  return s.cy + s.hT * Math.pow(Math.max(0, 1 - Math.pow(a, s.n)), 1 / s.n);
}

function buildFuselage(): THREE.BufferGeometry[] {
  const xs: number[] = [];
  for (let k = 0; k <= 16; k++) xs.push(NOSE_TIP_X - RADOME_L * Math.pow(k / 16, 1.5));
  for (const x of range(RADOME_BASE_X, -5.9, 0.18).slice(1)) xs.push(x);
  xs.reverse();
  const out = [loft(xs, fuselageSection, 40, PART.fuselage)];
  // Pitot boom.
  out.push(cylinder([NOSE_TIP_X - 0.08, 0.305, 0], [PITOT_TIP_X, 0.305, 0], 0.018, PART.metal, 8));
  // Nozzle: fixed shroud, then the petals (aNoz 0 at the hinge .. 1 at the exit), the inside of
  // the petals, and the turbine face deep inside.
  const cy = NOZZLE_AXIS_Y;
  out.push(loft(range(-6.2, -5.9, 0.1), (x) => circle(cy, 0, 0.455 + (0.47 - 0.455) * ((x + 6.2) / 0.3)), 40, PART.metal));
  const petalLen = -6.2 - NOZZLE_EXIT_X;
  const petalR = (x: number): number => 0.455 - 0.055 * ((-6.2 - x) / petalLen);
  out.push(loft(range(NOZZLE_EXIT_X, -6.2, 0.07), (x) => circle(cy, 0, petalR(x)), 40, PART.metal, { noz: (x) => (-6.2 - x) / petalLen }));
  out.push(loft(range(NOZZLE_EXIT_X, -6.3, 0.08), (x) => circle(cy, 0, 0.33 + 0.065 * ((-6.3 - x) / (-6.3 - NOZZLE_EXIT_X))), 40, PART.engine, { inward: true, noz: (x) => (-6.3 - x) / (-6.3 - NOZZLE_EXIT_X) }));
  out.push(cap(-6.3, circle(cy, 0, 0.33), 40, PART.engine, [-1, 0, 0]));
  return out;
}

// Canopy and dorsal spine: upper half-sections sitting on the fuselage (x, top y, half-width).
const [cTop, cW] = table([
  [-3.4, 0.93, 0.12],
  [-2.6, 0.98, 0.2],
  [-1.6, 1.0, 0.22],
  [-0.6, 1.02, 0.24],
  [0.2, 1.08, 0.3],
  [0.7, 1.18, 0.36],
  [1.1, 1.3, 0.4],
  [1.5, 1.4, 0.42],
  [1.9, 1.44, 0.43],
  [2.3, 1.44, 0.43],
  [2.7, 1.38, 0.42],
  [3.1, 1.22, 0.38],
  [3.4, 1.03, 0.28],
  [3.62, 0.86, 0.1],
]) as [(x: number) => number, (x: number) => number];

function canopySection(x: number): Section {
  const sill = fuselageTopY(x, 0) - 0.16;
  return { cy: sill, cz: 0, w: cW(x), hT: cTop(x) - sill, hB: 0, n: 2.3 };
}

function buildCanopy(): THREE.BufferGeometry {
  return loft(range(-3.4, 3.62, 0.09), canopySection, 24, PART.canopy, { arc: [0, Math.PI] });
}

// Right intake (mirrored for the left): x, centre y, centre z, half-width, half-height.
const [iCy, iCz, iW, iH] = table([
  [-1.6, 0.16, 0.62, 0.1, 0.22],
  [-1.0, 0.12, 0.66, 0.16, 0.28],
  [-0.2, 0.08, 0.71, 0.21, 0.33],
  [0.6, 0.05, 0.75, 0.24, 0.36],
  [1.3, 0.03, 0.78, 0.25, 0.38],
  [1.8, 0.02, 0.79, 0.245, 0.38],
]) as [(x: number) => number, (x: number) => number, (x: number) => number, (x: number) => number];
const INTAKE_LIP_X = 1.8;
const intakeSection = (x: number, k = 1): Section => ({ cy: iCy(x), cz: iCz(x), w: iW(x) * k, hT: iH(x) * k, hB: iH(x) * k, n: 2.4 });

function buildIntakeRight(): THREE.BufferGeometry {
  const n = 28;
  const outer = loft(range(-1.6, INTAKE_LIP_X, 0.1), (x) => intakeSection(x), n, PART.intake);
  const k = 0.88;
  const duct = loft(range(1.5, INTAKE_LIP_X, 0.1), (x) => intakeSection(x, k), n, PART.dark, { inward: true });
  const back = cap(1.5, intakeSection(1.5, k), n, PART.dark, [1, 0, 0]);
  // Lip: the annulus between the outer skin and the duct.
  const so = intakeSection(INTAKE_LIP_X);
  const si = intakeSection(INTAKE_LIP_X, k);
  const lip = geom(
    grid(
      n,
      1,
      (i, j) => {
        const [y, z] = ringPoint(j === 0 ? so : si, (2 * Math.PI * i) / n);
        return [INTAKE_LIP_X + 0.02 * (1 - j), y, z];
      },
      true
    ),
    PART.intake,
    () => [1, 0, 0]
  );
  return merge([outer, duct, back, lip]);
}

/** NACA 4-digit half-thickness at chord fraction xi. */
function naca(xi: number): number {
  const x = Math.min(1, Math.max(0, xi));
  return 5 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
}

/**
 * One chordwise strip of a lifting surface between span stations sa..sb, from front(s) to back(s)
 * (x), with half-thickness halfT(x, s); `map(x, s, t)` places it (t = signed thickness offset).
 * Closing faces on the cut edges (front if not the leading edge, back, both span ends).
 */
function plate(
  sa: number,
  sb: number,
  front: (s: number) => number,
  back: (s: number) => number,
  halfT: (x: number, s: number) => number,
  map: (x: number, s: number, t: number) => V3,
  part: number,
  nx: number,
  closeFront: boolean
): THREE.BufferGeometry {
  const ns = Math.max(1, Math.ceil((sb - sa) / 0.25));
  const S = (j: number): number => sa + ((sb - sa) * j) / ns;
  const X = (i: number, s: number): number => front(s) + (back(s) - front(s)) * (closeFront ? i / nx : (1 - Math.cos((Math.PI * i) / nx)) / 2);
  const dir = (a: V3, b: V3): V3 => [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const up = dir(map(0, 0, 0), map(0, 0, 1));
  const fwd = dir(map(0, 0, 0), map(1, 0, 0));
  const out: THREE.BufferGeometry[] = [];
  for (const sgn of [1, -1]) {
    out.push(geom(grid(nx, ns, (i, j) => { const s = S(j); const x = X(i, s); return map(x, s, sgn * halfT(x, s)); }), part, () => [up[0] * sgn, up[1] * sgn, up[2] * sgn]));
  }
  const edge = (xOf: (s: number) => number, d: V3): THREE.BufferGeometry =>
    geom(grid(1, ns, (i, j) => { const s = S(j); const x = xOf(s); return map(x, s, (i === 0 ? 1 : -1) * halfT(x, s)); }), part, () => d);
  if (closeFront) out.push(edge(front, fwd));
  out.push(edge(back, [-fwd[0], -fwd[1], -fwd[2]]));
  for (const [s, sg] of [[sa, -1], [sb, 1]] as const) {
    const d = dir(map(0, s, 0), map(0, s + sg, 0));
    out.push(geom(grid(nx, 1, (i, j) => { const x = X(i, s); return map(x, s, (j === 0 ? 1 : -1) * halfT(x, s)); }), part, () => d));
  }
  return merge(out);
}

const wingHalfT = (x: number, z: number): number => {
  const le = wingLE(z);
  const c = le - wingTE(z);
  const tc = 0.05 - 0.01 * (Math.abs(z) / SEMI_SPAN);
  return tc * c * naca((le - x) / c);
};
const wingMap = (x: number, z: number, t: number): V3 => [x, WING_Y + t, z];

/**
 * Pylon store-attach points, layout frame: the Tejas's three pylons under each wing (tank, BVR,
 * close-combat, inboard to outboard) and the centreline one. src/aircraft's stations are these +
 * LAYOUT_TO_BODY_X (tests/render/tejasTestModel.test.ts checks it).
 */
export const PYLONS: readonly { x: number; z: number; len: number; attachY: number }[] = [
  ...[
    { x: -2.5, z: 1.8, len: 1.9 },
    { x: -3.3, z: 2.5, len: 1.6 },
    { x: -3.9, z: 3.3, len: 1.4 },
  ].flatMap((p) => {
    const attachY = Math.round((WING_Y - wingHalfT(p.x, p.z) - PYLON_DEPTH) * 100) / 100;
    return [{ ...p, z: -p.z, attachY }, { ...p, attachY }];
  }),
  { x: -0.4, z: 0, len: 1.7, attachY: -0.42 },
];

function buildWingRight(): { fixed: THREE.BufferGeometry; elevon: THREE.BufferGeometry; slat: THREE.BufferGeometry } {
  const breaks = [0.3, 0.72, SLAT_Z[0], 2.3, 2.38, 3.98, SLAT_Z[1], SEMI_SPAN];
  const fixed: THREE.BufferGeometry[] = [];
  for (let k = 0; k + 1 < breaks.length; k++) {
    const a = breaks[k]!;
    const b = breaks[k + 1]!;
    const m = (a + b) / 2;
    const slat = m > SLAT_Z[0] && m < SLAT_Z[1];
    const elev = ELEVON_SPANS.some(([p, q]) => m > p && m < q);
    const front = slat ? (z: number) => wingLE(z) - SLAT_CHORD : wingLE;
    const back = elev ? elevonHinge : wingTE;
    fixed.push(plate(a, b, front, back, wingHalfT, wingMap, PART.wing, 16, slat));
  }
  const elevon = merge(ELEVON_SPANS.map(([a, b]) => plate(a, b, elevonHinge, wingTE, wingHalfT, wingMap, PART.wing, 4, true)));
  const slat = plate(SLAT_Z[0], SLAT_Z[1], wingLE, (z) => wingLE(z) - SLAT_CHORD, wingHalfT, wingMap, PART.wing, 5, false);
  return { fixed: merge(fixed), elevon, slat };
}

const finHalfT = (x: number, y: number): number => {
  const le = finLE(y);
  const c = le - finTE(y);
  const tc = 0.05 - 0.01 * ((y - FIN_ROOT_Y) / (FIN_TIP_Y - FIN_ROOT_Y));
  return tc * c * naca((le - x) / c);
};
const finMap = (x: number, y: number, t: number): V3 => [x, y, t];

function buildFin(): { fixed: THREE.BufferGeometry; rudder: THREE.BufferGeometry } {
  const fixed = merge([
    plate(FIN_ROOT_Y, RUDDER_Y[0], finLE, finTE, finHalfT, finMap, PART.fin, 16, false),
    plate(RUDDER_Y[0], RUDDER_Y[1], finLE, rudderHinge, finHalfT, finMap, PART.fin, 16, false),
    plate(RUDDER_Y[1], FIN_TIP_Y, finLE, finTE, finHalfT, finMap, PART.fin, 16, false),
    // Antenna fairing on the fin tip, and the brake-chute housing at the fin root.
    loft(range(-6.3, -5.0, 0.1), (x) => circle(FIN_TIP_Y, 0, 0.055 * Math.sqrt(Math.min(1, (-5.0 - x) / 0.35, (x + 6.3) / 0.12 + 0.3))), 10, PART.fin),
    loft(range(-6.42, -5.2, 0.08), (x) => circle(0.98, 0, 0.14 * Math.sqrt(Math.min(1, (-5.2 - x) / 0.35))), 16, PART.fin),
    cap(-6.42, circle(0.98, 0, 0.14), 16, PART.dark, [-1, 0, 0]),
  ]);
  const rudder = plate(RUDDER_Y[0], RUDDER_Y[1], rudderHinge, finTE, finHalfT, finMap, PART.fin, 4, true);
  return { fixed, rudder };
}

function buildPylons(): THREE.BufferGeometry {
  return merge(
    PYLONS.map((p) => {
      const top = p.z === 0 ? fuselageSection(p.x).cy - fuselageSection(p.x).hB + 0.12 : WING_Y;
      const cy = (top + p.attachY) / 2;
      const h = (top - p.attachY) / 2;
      const xs = range(p.x - p.len / 2, p.x + p.len / 2, 0.1);
      return loft(xs, (x) => {
        const u = (x - (p.x - p.len / 2)) / p.len;
        return { cy, cz: p.z, w: 0.05 * Math.min(1, u / 0.12 + 0.2, (1 - u) / 0.3 + 0.2), hT: h, hB: h, n: 4 };
      }, 12, PART.pylon);
    })
  );
}

/** Fixed in-flight refuelling probe on the right of the nose (Mk1A). */
function buildProbe(): THREE.BufferGeometry {
  const pts: V3[] = range(2.2, 4.3, 0.15).map((x) => {
    const z = 0.46 - (x - 2.2) * 0.06;
    return [x, fuselageTopY(x, z) + 0.07 * Math.min(1, (x - 2.2) / 0.5 + 0.2), z];
  });
  const tip: V3 = [4.75, pts[pts.length - 1]![1] - 0.02, pts[pts.length - 1]![2] - 0.03];
  const out: THREE.BufferGeometry[] = [];
  for (let k = 0; k + 1 < pts.length; k++) out.push(cylinder(pts[k]!, pts[k + 1]!, 0.05, PART.fuselage, 10));
  out.push(cylinder(pts[pts.length - 1]!, tip, 0.045, PART.fuselage, 10));
  out.push(cylinder(tip, [tip[0] + 0.1, tip[1], tip[2]], 0.062, PART.metal, 10));
  return merge(out);
}

function buildNavLights(): THREE.BufferGeometry {
  const tipX = (wingLE(SEMI_SPAN) + wingTE(SEMI_SPAN)) / 2;
  return merge([
    box([tipX, WING_Y, -SEMI_SPAN - 0.01], [0.07, 0.025, 0.012], PART.lightRed),
    box([tipX, WING_Y, SEMI_SPAN + 0.01], [0.07, 0.025, 0.012], PART.lightGreen),
    box([-6.43, 0.98, 0], [0.012, 0.05, 0.05], PART.lightWhite),
  ]);
}

/** Right airbrake panel on the upper rear fuselage; returns geometry + hinge. */
function buildAirbrake(side: 1 | -1): { geometry: THREE.BufferGeometry; pivot: V3; axis: V3 } {
  const x0 = -4.9;
  const x1 = -3.75;
  const t0 = side > 0 ? 0.35 : Math.PI - 1.05;
  const t1 = side > 0 ? 1.05 : Math.PI - 0.35;
  const at = (x: number, t: number, off: number): V3 => {
    const s = fuselageSection(x);
    const [y, z] = ringPoint(s, t);
    const d = new THREE.Vector3(0, y - s.cy, z).normalize();
    return [x, y + d.y * off, z + d.z * off];
  };
  const out: THREE.BufferGeometry[] = [];
  for (const [off, sg] of [[0.02, 1], [0.005, -1]] as const) {
    out.push(
      geom(grid(6, 8, (i, j) => at(x0 + ((x1 - x0) * i) / 6, t0 + ((t1 - t0) * j) / 8, off)), PART.fuselage, (p) => {
        const s = fuselageSection(p[0]);
        return [0, sg * (p[1] - s.cy), sg * p[2]];
      })
    );
  }
  const tm = (t0 + t1) / 2;
  const pivot = at(x1, tm, 0.012);
  // Axis = aft x outward normal, so a positive angle lifts the aft edge away from the fuselage.
  const n = new THREE.Vector3(0, pivot[1] - fuselageSection(x1).cy, pivot[2]).normalize();
  const axis = new THREE.Vector3(-1, 0, 0).cross(n).normalize();
  return { geometry: merge(out), pivot, axis: [axis.x, axis.y, axis.z] };
}

// Landing gear, extended pose (layout frame).
const NOSE_PIVOT: V3 = [3.72, -0.1, 0];
const NOSE_WHEEL_R = 0.22;
const MAIN_WHEEL_R = 0.3;

function wheel(c: V3, r: number, halfW: number): THREE.BufferGeometry {
  return merge([cylinder([c[0], c[1], c[2] - halfW], [c[0], c[1], c[2] + halfW], r, PART.tyre, 16), cylinder([c[0], c[1], c[2] - halfW - 0.01], [c[0], c[1], c[2] + halfW + 0.01], r * 0.55, PART.gear, 12)]);
}

function buildNoseGear(): THREE.BufferGeometry {
  const axle: V3 = [3.6, WHEEL_BOTTOM_Y + NOSE_WHEEL_R, 0];
  return merge([
    cylinder(NOSE_PIVOT, [3.64, -0.6, 0], 0.055, PART.gear),
    cylinder([3.64, -0.6, 0], [3.61, axle[1] + 0.12, 0], 0.042, PART.metal),
    box([3.605, axle[1] + 0.06, -0.1], [0.05, 0.1, 0.012], PART.gear),
    box([3.605, axle[1] + 0.06, 0.1], [0.05, 0.1, 0.012], PART.gear),
    box([3.605, axle[1] + 0.17, 0], [0.05, 0.012, 0.11], PART.gear),
    wheel(axle, NOSE_WHEEL_R, 0.075),
    box([3.7, -0.4, 0], [0.02, 0.035, 0.05], PART.lightWhite),
  ]);
}

const MAIN_PIVOT_R: V3 = [-0.82, 0.28, 0.9];
function buildMainGearRight(): THREE.BufferGeometry {
  const axle: V3 = [-0.9, WHEEL_BOTTOM_Y + MAIN_WHEEL_R, 1.12];
  return merge([
    cylinder(MAIN_PIVOT_R, [-0.87, -0.5, 1.0], 0.07, PART.gear),
    cylinder([-0.87, -0.5, 1.0], [-0.9, axle[1], 1.0], 0.055, PART.metal),
    cylinder([-0.9, axle[1], 0.98], [-0.9, axle[1], 1.03], 0.06, PART.gear),
    // Drag brace from the leg to the wing root.
    cylinder([-0.86, -0.25, 0.98], [-0.2, 0.26, 0.85], 0.03, PART.gear, 8),
    wheel(axle, MAIN_WHEEL_R, 0.09),
  ]);
}

/** Afterburner flame: a cone behind the nozzle; attribute aU = 0 at the nozzle .. 1 at the tip. */
function buildFlame(): THREE.BufferGeometry {
  const len = 3.8;
  const n = 24;
  const rows = 12;
  const u: number[] = [];
  const raw = grid(
    n,
    rows,
    (i, j) => {
      const k = j / rows;
      const r = 0.36 * (1 - k) + 0.05 * k;
      const t = (2 * Math.PI * i) / n;
      u.push(k);
      return [NOZZLE_EXIT_X + 0.05 - len * k, NOZZLE_AXIS_Y + r * Math.sin(t), r * Math.cos(t)];
    },
    true
  );
  const g = geom(raw, PART.engine, (p) => [0, p[1] - NOZZLE_AXIS_Y, p[2]]);
  g.setAttribute('aU', new THREE.Float32BufferAttribute(u, 1));
  return g;
}

// -----------------------------------------------------------------------------
// Template
// -----------------------------------------------------------------------------

/** How a moving part is driven (see meshAircraftRenderer.ts). */
export type PartDriver = 'elevonL' | 'elevonR' | 'rudder' | 'gear' | 'slat' | 'airbrake';

export interface ArticulatedPart {
  name: string;
  geometry: THREE.BufferGeometry;
  /** Hinge point and unit axis, layout frame. */
  pivot: V3;
  axis: V3;
  driver: PartDriver;
  /** Angle at full travel, rad: gear = retracted (at gearPos 0), slat = full droop, airbrake = fully open. */
  travelRad: number;
}

export interface AircraftModelTemplate {
  /** Layout -> body frame translation along x. */
  offsetX: number;
  body: THREE.BufferGeometry;
  parts: ArticulatedPart[];
  flame: THREE.BufferGeometry;
  /** Nozzle petal hinge axis height (the petals open radially about it). */
  nozzleAxisY: number;
}

function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function buildTejasTestModel(): AircraftModelTemplate {
  const wing = buildWingRight();
  const fin = buildFin();
  const intake = buildIntakeRight();
  const body = merge([
    ...buildFuselage(),
    buildCanopy(),
    intake,
    mirrorZ(intake),
    wing.fixed,
    mirrorZ(wing.fixed),
    fin.fixed,
    buildPylons(),
    buildProbe(),
    buildNavLights(),
  ]);

  const [ea, eb] = [ELEVON_SPANS[0]![0], ELEVON_SPANS[1]![1]];
  const elevonAxisR = unit([elevonHinge(eb) - elevonHinge(ea), 0, eb - ea]);
  const elevonPivotR: V3 = [elevonHinge(ea), WING_Y, ea];
  const slatAxisR = unit([wingLE(SLAT_Z[1]) - wingLE(SLAT_Z[0]), 0, SLAT_Z[1] - SLAT_Z[0]]);
  const slatPivotR: V3 = [wingLE(SLAT_Z[0]) - SLAT_CHORD, WING_Y, SLAT_Z[0]];
  // Pointing down the hinge line, so a positive angle swings the trailing edge left (-z).
  const rudderAxis = unit([rudderHinge(RUDDER_Y[0]) - rudderHinge(RUDDER_Y[1]), RUDDER_Y[0] - RUDDER_Y[1], 0]);
  const brakeR = buildAirbrake(1);
  const brakeL = buildAirbrake(-1);
  const mainR = buildMainGearRight();
  const deg = Math.PI / 180;

  const parts: ArticulatedPart[] = [
    // Mirrored hinges keep +z-pointing axes, so a positive angle is trailing edge down on both sides.
    { name: 'elevonR', geometry: wing.elevon, pivot: elevonPivotR, axis: elevonAxisR, driver: 'elevonR', travelRad: 0 },
    { name: 'elevonL', geometry: mirrorZ(wing.elevon), pivot: [elevonPivotR[0], WING_Y, -ea], axis: [-elevonAxisR[0], 0, elevonAxisR[2]], driver: 'elevonL', travelRad: 0 },
    // Slats droop leading edge down for a negative angle about the +z-pointing hinge.
    { name: 'slatR', geometry: wing.slat, pivot: slatPivotR, axis: slatAxisR, driver: 'slat', travelRad: -20 * deg },
    { name: 'slatL', geometry: mirrorZ(wing.slat), pivot: [slatPivotR[0], WING_Y, -SLAT_Z[0]], axis: [-slatAxisR[0], 0, slatAxisR[2]], driver: 'slat', travelRad: -20 * deg },
    { name: 'rudder', geometry: fin.rudder, pivot: [rudderHinge(RUDDER_Y[0]), RUDDER_Y[0], 0], axis: rudderAxis, driver: 'rudder', travelRad: 0 },
    { name: 'airbrakeR', geometry: brakeR.geometry, pivot: brakeR.pivot, axis: brakeR.axis, driver: 'airbrake', travelRad: 50 * deg },
    { name: 'airbrakeL', geometry: brakeL.geometry, pivot: brakeL.pivot, axis: brakeL.axis, driver: 'airbrake', travelRad: 50 * deg },
    // Nose gear folds aft, main gear forward into the wing roots.
    { name: 'noseGear', geometry: buildNoseGear(), pivot: NOSE_PIVOT, axis: [0, 0, 1], driver: 'gear', travelRad: -95 * deg },
    { name: 'mainGearR', geometry: mainR, pivot: MAIN_PIVOT_R, axis: [0, 0, 1], driver: 'gear', travelRad: 88 * deg },
    { name: 'mainGearL', geometry: mirrorZ(mainR), pivot: [MAIN_PIVOT_R[0], MAIN_PIVOT_R[1], -MAIN_PIVOT_R[2]], axis: [0, 0, 1], driver: 'gear', travelRad: 88 * deg },
  ];
  return { offsetX: LAYOUT_TO_BODY_X, body, parts, flame: buildFlame(), nozzleAxisY: NOZZLE_AXIS_Y };
}
