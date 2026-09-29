/**
 * src/render/aircraftModels/tejasModel.ts — the HAL Tejas Mk1A, built in code to its published
 * geometry.
 *
 * Sources (see the commit for links): ADA's Tejas brochure (3-view, weapon stations), the Mk1A
 * 3-view line drawing on Wikimedia Commons (FoxtAl, CC BY 4.0; de-rotated, it matches the
 * published span and length to <1 %), photographs of LA-5021/LA-5033, and published figures:
 * - length 13.2 m (radome tip to nozzle; the nose probe adds ~0.2 m), span 8.2 m, height 4.4 m,
 *   wing area 38.4 m^2, wheelbase 4.34 m, main track 2.2 m.
 * - Tailless compound delta: leading edge swept 50 deg inboard of the crank and 62.5 deg outboard,
 *   trailing edge swept ~4 deg forward; two elevons and a three-section slat on each wing; a single
 *   52 deg fin with a one-piece rudder, an RWR fairing on its tip and the brake-chute canister at
 *   its base.
 * - Wing-shielded, fixed, bifurcated (Y-duct) intakes under the wing roots with boundary-layer
 *   splitter plates; GSh-23 in a blister under the starboard intake.
 * - Bubble canopy behind a framed windscreen; fixed in-flight refuelling probe ahead of it on the
 *   starboard side; ogival radome with a short pitot.
 * - Twin nose wheels retracting forwards; single main wheels retracting inwards into the belly.
 * - Two airbrakes on the upper rear fuselage beside the fin; chaff/flare dispensers on the rear
 *   fuselage (Mk1A self-protection suite); dorsal and ventral antennas.
 * - Stations 1/3/5 (port, inboard to outboard), 2/4/6 (starboard), 7 (centreline), L (under the
 *   port intake), at the spans in ADA's station diagram.
 *
 * Authoring frame: STATIONS `st` (m aft of the radome tip), heights `h` (m above the radome tip)
 * and `z` (m, + starboard), as measured off the drawings. They map to the body frame (x forward,
 * y up, z right; origin at the reference the flight model uses, the centre of gravity at the
 * fuselage centreline) by x = XREF - st, y = h + YREF. XREF puts the main wheels where
 * src/aircraft's main legs are; YREF puts the wheels on the ground at the aircraft's 4.4 m height.
 *
 * Each moving part is a separate geometry with a hinge (pivot + axis, body frame); a positive
 * angle follows src/physics's conventions (fcs.ts): elevon trailing edge down, rudder trailing edge
 * left. Parts are authored in their extended/neutral pose; gear parts carry their retraction.
 */
import * as THREE from 'three';
import { PART, box, cap, circle, cylinder, geom, grid, loft, merge, mirrorZ, naca, plate, range, sp, table, type Raw, type Section, type V3 } from './meshBuild';

export { PART } from './meshBuild';

// -----------------------------------------------------------------------------
// Frame
// -----------------------------------------------------------------------------

/** Body x of the radome tip; body y of the radome tip's height. */
export const XREF = 7.55;
export const YREF = -0.23;
/** The model is authored in the body frame (kept for the renderer's template). */
export const LAYOUT_TO_BODY_X = 0;
const X = (st: number): number => XREF - st;
const Y = (h: number): number => h + YREF;
const ST = (x: number): number => XREF - x;

/** Principal points, body frame. */
export const NOSE_TIP_X = X(0);
export const PITOT_TIP_X = X(-0.22);
export const NOZZLE_EXIT_X = X(13.2);
export const NOZZLE_AXIS_Y = Y(0.245);
/** Static wheel bottoms (the oleos squat ~8 cm from the legs' fully extended contact points). */
export const WHEEL_BOTTOM_Y = Y(-1.39);
export const SEMI_SPAN = 4.1;

// -----------------------------------------------------------------------------
// Sections
// -----------------------------------------------------------------------------

/** A cross-section with its own top and bottom exponents and an optional flat inner side. */
interface Sec {
  cy: number;
  cz: number;
  w: number;
  hT: number;
  hB: number;
  nT: number;
  nB: number;
}

/** Point on a section at angle t (0 = +z side, pi/2 = top). */
function secPoint(s: Sec, t: number): [number, number] {
  const c = Math.cos(t);
  const sn = Math.sin(t);
  const top = sn >= 0;
  const e = 2 / (top ? s.nT : s.nB);
  return [s.cy + (top ? s.hT : s.hB) * sp(sn, e), s.cz + s.w * sp(c, e)];
}

/** A closed loft through sections at body xs (ascending). */
function ringLoft(xs: readonly number[], sec: (x: number) => Sec, n: number, part: number, opts: { inward?: boolean; arc?: [number, number]; noz?: (x: number) => number } = {}): THREE.BufferGeometry {
  const secs = xs.map(sec);
  const arc = opts.arc;
  const raw: Raw = grid(
    n,
    xs.length - 1,
    (i, j) => {
      const t = arc ? arc[0] + ((arc[1] - arc[0]) * i) / n : (2 * Math.PI * i) / n;
      const [y, z] = secPoint(secs[j]!, t);
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

const asSection = (s: Sec): Section => ({ cy: s.cy, cz: s.cz, w: s.w, hT: s.hT, hB: s.hB, n: (s.nT + s.nB) / 2 });

/** Sorted station list with extra samples. */
const stations = (a: number, b: number, step: number): number[] => range(X(a), X(b), step).sort((p, q) => p - q);

// --- Radome (st 0 .. 1.96): drooping axis, a little wider than tall. Measured off the side and top views. ---
const RADOME_JOINT = 1.96;
const [rTop, rBot, rW] = table([
  [0.0, 0.0, 0.0, 0.0],
  [0.05, 0.03, -0.012, 0.03],
  [0.29, 0.12, -0.07, 0.12],
  [0.57, 0.225, -0.14, 0.212],
  [0.86, 0.33, -0.2, 0.285],
  [1.15, 0.41, -0.25, 0.345],
  [1.44, 0.48, -0.285, 0.405],
  [1.72, 0.545, -0.31, 0.45],
  [1.96, 0.574, -0.316, 0.48],
]) as [(st: number) => number, (st: number) => number, (st: number) => number];

function radomeSec(x: number): Sec {
  const st = Math.max(0, ST(x));
  const top = rTop(st);
  const bot = rBot(st);
  const cy = (top + bot) / 2;
  return { cy: Y(cy), cz: 0, w: Math.max(0.001, rW(st)), hT: Math.max(0.001, top - cy), hB: Math.max(0.001, top - cy), nT: 2, nB: 2 };
}

// --- Fuselage body (st 1.96 .. 12.95): top (deck under the canopy, spine behind it), bottom, centre height,
// half-width, top/bottom exponents. The spine's rounded-triangle top comes from nT < 2. ---
const [fTop, fBot, fCy, fW, fNT, fNB] = table([
  [1.96, 0.574, -0.316, 0.129, 0.48, 2.0, 2.0],
  [2.12, 0.61, -0.33, 0.14, 0.49, 2.1, 2.2],
  [2.6, 0.655, -0.34, 0.16, 0.505, 2.2, 2.4],
  [3.4, 0.715, -0.345, 0.19, 0.53, 2.2, 2.5],
  [4.1, 0.77, -0.35, 0.22, 0.545, 2.2, 2.5],
  [4.45, 0.9, -0.35, 0.28, 0.53, 2.1, 2.5],
  [4.9, 1.25, -0.36, 0.4, 0.5, 1.9, 2.4],
  [5.5, 1.22, -0.39, 0.43, 0.5, 1.85, 2.4],
  [6.0, 1.175, -0.41, 0.44, 0.52, 1.85, 2.4],
  [7.0, 1.12, -0.43, 0.45, 0.56, 1.85, 2.4],
  [8.0, 1.105, -0.45, 0.46, 0.61, 1.85, 2.4],
  [9.0, 1.105, -0.46, 0.46, 0.64, 1.85, 2.4],
  [10.0, 1.115, -0.45, 0.46, 0.66, 1.9, 2.4],
  [11.0, 1.105, -0.41, 0.45, 0.67, 1.9, 2.3],
  [11.6, 1.09, -0.34, 0.43, 0.66, 1.95, 2.2],
  [12.2, 1.04, -0.26, 0.38, 0.6, 2.0, 2.1],
  [12.6, 0.9, -0.2, 0.32, 0.53, 2.0, 2.0],
  [12.95, 0.71, -0.215, 0.245, 0.465, 2.0, 2.0],
]) as ((st: number) => number)[];

function bodySec(x: number): Sec {
  const st = Math.min(12.95, Math.max(RADOME_JOINT, ST(x)));
  const cy = fCy!(st);
  return { cy: Y(cy), cz: 0, w: fW!(st), hT: fTop!(st) - cy, hB: cy - fBot!(st), nT: fNT!(st), nB: fNB!(st) };
}

/** Fuselage surface height at |z| (top half), for placing things on it. */
function bodyTopY(x: number, z: number): number {
  const s = bodySec(x);
  const a = Math.min(1, Math.abs(z) / s.w);
  return s.cy + s.hT * Math.pow(Math.max(0, 1 - Math.pow(a, s.nT)), 1 / s.nT);
}
function bodyBottomY(x: number, z: number): number {
  const s = bodySec(x);
  const a = Math.min(1, Math.abs(z) / s.w);
  return s.cy - s.hB * Math.pow(Math.max(0, 1 - Math.pow(a, s.nB)), 1 / s.nB);
}

function buildFuselage(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  // Radome: fine near the tip.
  const rx: number[] = [];
  for (let k = 0; k <= 20; k++) rx.push(X(RADOME_JOINT * Math.pow(k / 20, 1.6)));
  rx.sort((a, b) => a - b);
  out.push(ringLoft(rx, radomeSec, 40, PART.radome));
  // Body.
  out.push(ringLoft(stations(RADOME_JOINT, 12.95, 0.12), bodySec, 48, PART.fuselage));
  // Pitot on the radome tip, with its small mast.
  out.push(cylinder([X(0.02), Y(0), 0], [PITOT_TIP_X, Y(0.004), 0], 0.012, PART.metal, 8));
  out.push(cylinder([X(-0.1), Y(0.002), 0], [PITOT_TIP_X, Y(0.004), 0], 0.018, PART.metal, 8));
  // Angle-of-attack vanes on both sides of the radome joint.
  for (const s of [-1, 1]) {
    const x = X(2.18);
    out.push(box([x, Y(0.36), s * 0.505], [0.05, 0.006, 0.03], PART.dark));
  }
  return out;
}

// -----------------------------------------------------------------------------
// Canopy
// -----------------------------------------------------------------------------

/** Canopy glass from the windscreen's foot (st 2.12) to where it fairs into the spine (st 4.9). */
const CANOPY_ST: [number, number] = [2.12, 4.9];
/** Windscreen arch: the frame between the windscreen and the canopy, leaning back at its foot. */
export const ARCH_ST = { top: 3.3, foot: 3.5 };
const [cSill, cTop, cHalfW] = table([
  [2.12, 0.612, 0.62, 0.06],
  [2.3, 0.63, 0.72, 0.24],
  [2.6, 0.655, 0.85, 0.33],
  [3.0, 0.69, 1.05, 0.39],
  [3.4, 0.72, 1.2, 0.415],
  [3.87, 0.755, 1.33, 0.42],
  [4.1, 0.77, 1.335, 0.418],
  [4.4, 0.785, 1.315, 0.405],
  [4.7, 0.795, 1.285, 0.37],
  [4.9, 0.8, 1.255, 0.3],
]) as [(st: number) => number, (st: number) => number, (st: number) => number];
const CANOPY_N = 2.3;

/**
 * The canopy's cross-section at body x (for the cockpit interior, which must fit inside it): the
 * sill (canopy rail) height, half-width at the sill, top height, and the superellipse exponent
 * (|z/halfW|^n + |(y-sill)/(top-sill)|^n = 1). Body frame.
 */
export function canopyProfile(x: number): { sillY: number; halfW: number; topY: number; n: number } {
  const st = Math.min(CANOPY_ST[1], Math.max(CANOPY_ST[0], ST(x)));
  return { sillY: Y(cSill(st)), halfW: cHalfW(st), topY: Y(cTop(st)), n: CANOPY_N };
}
/** Body x of the windscreen's foot and the canopy's rear end. */
export const CANOPY_FRONT_X = X(CANOPY_ST[0]);
export const CANOPY_REAR_X = X(CANOPY_ST[1]);

function buildCanopy(): THREE.BufferGeometry[] {
  const sec = (x: number): Section => {
    const p = canopyProfile(x);
    return { cy: p.sillY, cz: 0, w: p.halfW, hT: p.topY - p.sillY, hB: 0, n: CANOPY_N };
  };
  const out: THREE.BufferGeometry[] = [loft(stations(CANOPY_ST[0], CANOPY_ST[1], 0.07), sec, 40, PART.canopy, { arc: [0, Math.PI] })];
  // Windscreen arch: a frame swept round the section, leaning from its top (st 3.30) to its foot (3.50).
  const arch: V3[] = [];
  for (let k = 0; k <= 24; k++) {
    const t = (Math.PI * k) / 24;
    const f = Math.sin(t); // 0 at the sills, 1 at the top
    const st = ARCH_ST.foot + (ARCH_ST.top - ARCH_ST.foot) * f;
    const p = canopyProfile(X(st));
    const c = Math.cos(t);
    const e = 2 / CANOPY_N;
    arch.push([X(st), p.sillY + (p.topY - p.sillY + 0.012) * sp(Math.sin(t), e), (p.halfW + 0.012) * sp(c, e)]);
  }
  for (let k = 0; k + 1 < arch.length; k++) out.push(cylinder(arch[k]!, arch[k + 1]!, 0.028, PART.frame, 8));
  // Canopy sill rails along both sides.
  for (const s of [-1, 1]) {
    const pts = range(CANOPY_ST[0] + 0.15, CANOPY_ST[1] - 0.05, 0.2).map((st): V3 => {
      const p = canopyProfile(X(st));
      return [X(st), p.sillY + 0.005, s * (p.halfW + 0.006)];
    });
    for (let k = 0; k + 1 < pts.length; k++) out.push(cylinder(pts[k]!, pts[k + 1]!, 0.022, PART.frame, 6));
  }
  return out;
}

// -----------------------------------------------------------------------------
// Intakes
// -----------------------------------------------------------------------------

/** Intake lip station and the opening: inner wall, outer wall, top, bottom (front view). */
const INTAKE_LIP = 4.91;
const [iCz, iW, iTop, iBot] = table([
  [4.91, 0.765, 0.235, 0.3, -0.38],
  [5.5, 0.755, 0.24, 0.3, -0.405],
  [6.2, 0.735, 0.235, 0.3, -0.425],
  [7.0, 0.705, 0.225, 0.29, -0.44],
  [7.8, 0.66, 0.2, 0.28, -0.45],
  [8.6, 0.6, 0.16, 0.26, -0.455],
  [9.3, 0.55, 0.1, 0.22, -0.45],
]) as [(st: number) => number, (st: number) => number, (st: number) => number, (st: number) => number];

function intakeSec(x: number, k = 1): Sec {
  const st = Math.min(9.3, Math.max(INTAKE_LIP, ST(x)));
  const top = iTop(st);
  const bot = iBot(st);
  const cy = (top + bot) / 2;
  const h = ((top - bot) / 2) * k;
  return { cy: Y(cy), cz: iCz(st), w: iW(st) * k, hT: h, hB: h, nT: 2.6, nB: 2.6 };
}

function buildIntakeRight(): THREE.BufferGeometry[] {
  const n = 32;
  const out: THREE.BufferGeometry[] = [];
  const lipX = X(INTAKE_LIP);
  out.push(ringLoft(stations(INTAKE_LIP, 9.3, 0.15), (x) => intakeSec(x), n, PART.intake));
  // Duct: dark, a short way in, then closed (the Y-duct turns inboard towards the engine).
  const k = 0.84;
  out.push(ringLoft(stations(INTAKE_LIP, INTAKE_LIP + 0.9, 0.15), (x) => intakeSec(x, k), n, PART.dark, { inward: true }));
  out.push(cap(X(INTAKE_LIP + 0.9), asSection(intakeSec(X(INTAKE_LIP + 0.9), k)), n, PART.dark, [1, 0, 0]));
  // Lip: the rounded annulus between the cowl and the duct.
  const so = intakeSec(lipX);
  const si = intakeSec(lipX, k);
  const lip: Raw = grid(
    n,
    4,
    (i, j) => {
      const t = (2 * Math.PI * i) / n;
      const u = j / 4;
      const [yo, zo] = secPoint(so, t);
      const [yi, zi] = secPoint(si, t);
      return [lipX + 0.035 * Math.sin(Math.PI * u), yo + (yi - yo) * u, zo + (zi - zo) * u];
    },
    true
  );
  out.push(geom(lip, PART.intake, () => [1, 0, 0]));
  // Boundary-layer splitter plate between the intake and the fuselage, with its diverter posts.
  const sz = 0.505;
  const splitter: V3[] = [
    [X(4.62), Y(0.26), sz],
    [X(5.45), Y(0.28), sz],
    [X(5.45), Y(-0.36), sz],
    [X(4.72), Y(-0.34), sz],
  ];
  const sp0 = new THREE.Shape(splitter.map((p) => new THREE.Vector2(p[0], p[1])));
  const sg = new THREE.ExtrudeGeometry(sp0, { depth: 0.012, bevelEnabled: false });
  sg.translate(0, 0, sz - 0.006);
  out.push(fromThree(sg, PART.intake));
  for (const h of [-0.25, 0.0, 0.2]) out.push(box([X(5.3), Y(h), sz - 0.03], [0.1, 0.012, 0.03], PART.intake));
  return out;
}

/** Converts a plain three.js geometry to the model's attribute layout. */
function fromThree(g: THREE.BufferGeometry, part: number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  const pos = Array.from(ng.getAttribute('position').array as Float32Array);
  const idx = pos.map((_, i) => i).slice(0, pos.length / 3);
  const c = new THREE.Vector3();
  ng.computeBoundingBox();
  ng.boundingBox!.getCenter(c);
  g.dispose();
  return geom({ pos, idx }, part, (p) => [p[0] - c.x, p[1] - c.y, p[2] - c.z]);
}

// -----------------------------------------------------------------------------
// Wing
// -----------------------------------------------------------------------------

/** Where the wing leaves the fuselage side, the crank, and the sweeps. */
const WING_ROOT_Z = 0.5;
const CRANK_Z = 1.72;
const TAN_IN = Math.tan((50 * Math.PI) / 180);
const TAN_OUT = Math.tan((62.7 * Math.PI) / 180);
const LE_AT_062 = 4.6;
const LE_CRANK = LE_AT_062 + TAN_IN * (CRANK_Z - 0.62);
const TE_ROOT_ST = 11.61;
const TAN_TE = Math.tan((4 * Math.PI) / 180);
const ANHEDRAL = (3 * Math.PI) / 180;
/** Chord plane height at the root (h). */
const WING_H0 = 0.4;

/** Leading edge station at span |z| (the inner sweep line runs on to the centreline, as the reference area is). */
export function wingLEst(z: number): number {
  const a = Math.abs(z);
  return a <= CRANK_Z ? LE_AT_062 + TAN_IN * (a - 0.62) : LE_CRANK + TAN_OUT * (a - CRANK_Z);
}
/** Trailing edge station (swept forward). */
export function wingTEst(z: number): number {
  return TE_ROOT_ST - TAN_TE * (Math.abs(z) - WING_ROOT_Z);
}
/** Elevon hinge line: a constant station (top view). */
const ELEVON_HINGE_ST = 10.67;
const ELEVON_SPANS: [number, number][] = [
  [0.74, 1.92],
  [1.98, 3.98],
];
const SLAT_DEPTH = 0.37;
const SLAT_SPANS: [number, number][] = [
  [1.86, 2.56],
  [2.6, 3.26],
  [3.3, 3.96],
];

/** Reference wing area (both wings, through the fuselage), m^2. */
export function wingAreaM2(): number {
  let s = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) {
    const z = ((i + 0.5) / n) * SEMI_SPAN;
    s += wingTEst(z) - wingLEst(z);
  }
  return 2 * s * (SEMI_SPAN / n);
}

const wingT = (st: number, z: number): number => {
  const le = wingLEst(z);
  const c = wingTEst(z) - le;
  const a = Math.abs(z);
  const tc = 0.055 - 0.015 * Math.min(1, (a - WING_ROOT_Z) / (SEMI_SPAN - WING_ROOT_Z));
  return tc * c * naca((st - le) / c);
};
/** Chord plane height (body y) at span z. */
const wingPlaneY = (z: number): number => Y(WING_H0) - Math.tan(ANHEDRAL) * (Math.abs(z) - WING_ROOT_Z);
/** plate() works in (body x, span z), its front edge at the larger x. */
const wingMap = (x: number, z: number, t: number): V3 => [x, wingPlaneY(z) + t, z];
const wingHalfT = (x: number, z: number): number => wingT(ST(x), z);
/** Wing lower surface (body y) at a station and span. */
export function wingLowerY(st: number, z: number): number {
  return wingPlaneY(z) - wingT(st, z);
}

function buildWingRight(): { fixed: THREE.BufferGeometry; elevons: THREE.BufferGeometry[]; slats: THREE.BufferGeometry[] } {
  const breaks = [WING_ROOT_Z, ...ELEVON_SPANS.flat(), ...SLAT_SPANS.flat(), SEMI_SPAN].sort((a, b) => a - b);
  const fixed: THREE.BufferGeometry[] = [];
  const le = (z: number): number => X(wingLEst(z));
  const te = (z: number): number => X(wingTEst(z));
  const hinge = X(ELEVON_HINGE_ST);
  for (let k = 0; k + 1 < breaks.length; k++) {
    const a = breaks[k]!;
    const b = breaks[k + 1]!;
    if (b - a < 1e-3) continue;
    const m = (a + b) / 2;
    const slat = SLAT_SPANS.some(([p, q]) => m > p && m < q);
    const elev = ELEVON_SPANS.some(([p, q]) => m > p && m < q);
    const front = slat ? (z: number) => le(z) - SLAT_DEPTH : le;
    const back = elev ? () => hinge : te;
    fixed.push(plate(a, b, front, back, wingHalfT, wingMap, PART.wing, 18, slat));
  }
  // Cropped tip: a thin closing rib is part of plate(); add the wingtip fairing (nav/strobe lights sit on it).
  const elevons = ELEVON_SPANS.map(([a, b]) => plate(a, b, () => hinge - 0.01, te, wingHalfT, wingMap, PART.wing, 5, true));
  const slats = SLAT_SPANS.map(([a, b]) => plate(a, b, le, (z) => le(z) - SLAT_DEPTH + 0.01, wingHalfT, wingMap, PART.wing, 6, false));
  return { fixed: merge(fixed), elevons, slats };
}

// -----------------------------------------------------------------------------
// Fin, dorsal fillet, brake-chute canister, rear fuselage, nozzle
// -----------------------------------------------------------------------------

/** Fin planform in (station, height): leading and trailing edges as functions of height. */
const FIN_ROOT_H = 1.06;
const FIN_TIP_H = 2.86;
const finLEst = (h: number): number => 10.05 + 1.2745 * (h - 1.19);
const finTEst = (h: number): number => 12.8 + 0.1547 * (h - 1.045);
const rudderHingeSt = (h: number): number => 12.13 + 0.2517 * (h - 1.06);
const RUDDER_H: [number, number] = [1.1, 2.57];
const finT = (st: number, h: number): number => {
  const le = finLEst(h);
  const c = finTEst(h) - le;
  const tc = 0.05 - 0.012 * ((h - FIN_ROOT_H) / (FIN_TIP_H - FIN_ROOT_H));
  return tc * c * naca((st - le) / c);
};
const finMap = (x: number, h: number, t: number): V3 => [x, Y(h), t];
const finHalfT = (x: number, h: number): number => finT(ST(x), h);
const finLEx = (h: number): number => X(finLEst(h));
const finTEx = (h: number): number => X(finTEst(h));
const rudderHingeX = (h: number): number => X(rudderHingeSt(h));

function buildFin(): { fixed: THREE.BufferGeometry; rudder: THREE.BufferGeometry } {
  const fixed: THREE.BufferGeometry[] = [
    plate(FIN_ROOT_H, RUDDER_H[0], finLEx, finTEx, finHalfT, finMap, PART.fin, 18, false),
    plate(RUDDER_H[0], RUDDER_H[1], finLEx, rudderHingeX, finHalfT, finMap, PART.fin, 18, false),
    plate(RUDDER_H[1], FIN_TIP_H, finLEx, finTEx, finHalfT, finMap, PART.fin, 18, false),
  ];
  // Tip fairing: RWR antennas forward, the white tail light aft.
  const tipH = FIN_TIP_H + 0.04;
  fixed.push(
    loft(stations(11.9, 13.16, 0.06), (x) => {
      const st = ST(x);
      const u = (st - 11.9) / 1.26;
      const k = Math.sqrt(Math.min(1, u / 0.08 + 0.15)) * Math.min(1, (1 - u) / 0.05 + 0.5);
      return { cy: Y(tipH), cz: 0, w: 0.065 * k, hT: 0.1 * k, hB: 0.08 * k, n: 2.2 };
    }, 16, PART.fin)
  );
  fixed.push(loft(stations(11.9, 12.04, 0.035), (x) => {
    const u = (ST(x) - 11.9) / 0.14;
    return { cy: Y(tipH), cz: 0, w: 0.066 * Math.sqrt(Math.min(1, u + 0.12)), hT: 0.1 * Math.sqrt(Math.min(1, u + 0.12)), hB: 0.08 * Math.sqrt(Math.min(1, u + 0.12)), n: 2.2 };
  }, 16, PART.dark));
  const rudder = plate(RUDDER_H[0], RUDDER_H[1], (h) => rudderHingeX(h) - 0.01, finTEx, finHalfT, finMap, PART.fin, 5, true);
  return { fixed: merge(fixed), rudder };
}

/** Dorsal fillet from the spine up into the fin's leading edge (the hump ahead of the fin). */
function buildDorsalFillet(): THREE.BufferGeometry {
  return loft(stations(8.9, 10.9, 0.08), (x) => {
    const st = ST(x);
    const u = (st - 8.9) / 2.0;
    const top = st < 9.6 ? 1.1 + 0.15 * Math.sin((Math.PI / 2) * ((st - 8.9) / 0.7)) : Math.max(1.25, 1.19 + (st - 10.05) * 0.8);
    const w = 0.05 + 0.2 * Math.sin(Math.PI * Math.min(1, u * 1.15));
    return { cy: Y(1.02), cz: 0, w, hT: top - 1.02, hB: 0.05, n: 2.4 };
  }, 20, PART.fuselage);
}

const CHUTE = { st0: 12.2, st1: 13.1, h: 0.875, r: 0.155 };
function buildChuteCanister(): THREE.BufferGeometry[] {
  const sec = (x: number): Section => {
    const st = ST(x);
    const aft = Math.max(0, (st - (CHUTE.st1 - 0.12)) / 0.12);
    const fwd = Math.min(1, (st - CHUTE.st0) / 0.35);
    const r = CHUTE.r * Math.sqrt(Math.max(0.05, 1 - aft * aft)) * (0.75 + 0.25 * fwd);
    return circle(Y(CHUTE.h - 0.05 * (1 - fwd)), 0, r);
  };
  return [loft(stations(CHUTE.st0, CHUTE.st1, 0.05), sec, 20, PART.fuselage), cap(X(CHUTE.st1) + 0.001, circle(Y(CHUTE.h), 0, 0.05), 12, PART.dark, [-1, 0, 0])];
}

function buildNozzle(): THREE.BufferGeometry[] {
  const cy = NOZZLE_AXIS_Y;
  const out: THREE.BufferGeometry[] = [];
  const x0 = X(12.93);
  const xe = NOZZLE_EXIT_X;
  // Fixed shroud (the fuselage's aft ring), then the petals (aNoz 0 at the hinge .. 1 at the exit).
  out.push(loft(range(x0 - 0.02, x0 + 0.05, 0.035).sort((a, b) => a - b), (x) => circle(cy, 0, 0.465 - 0.02 * ((x0 + 0.05 - x) / 0.07)), 40, PART.metal));
  const petalR = (x: number): number => 0.448 - 0.038 * ((x0 - x) / (x0 - xe));
  out.push(loft(range(xe, x0, 0.04), (x) => circle(cy, 0, petalR(x)), 48, PART.metal, { noz: (x) => (x0 - x) / (x0 - xe) }));
  // Inside the petals and the turbine face deep inside.
  const xi = X(12.4);
  out.push(loft(range(xe, xi, 0.06), (x) => circle(cy, 0, 0.33 + 0.08 * ((xi - x) / (xi - xe))), 40, PART.engine, { inward: true, noz: (x) => Math.max(0, (x0 - x) / (x0 - xe)) }));
  out.push(cap(xi, circle(cy, 0, 0.33), 40, PART.engine, [-1, 0, 0]));
  return out;
}

// -----------------------------------------------------------------------------
// Airbrakes, probe, gun, antennas, dispensers, lights
// -----------------------------------------------------------------------------

/** Airbrake on the upper rear fuselage (one each side of the fin); returns geometry + hinge. */
function buildAirbrake(side: 1 | -1): { geometry: THREE.BufferGeometry; pivot: V3; axis: V3 } {
  const st0 = 10.95;
  const st1 = 11.95;
  // Between the spine and the wing root, on the fuselage's upper flank.
  const t0 = side > 0 ? 0.62 : Math.PI - 1.12;
  const t1 = side > 0 ? 1.12 : Math.PI - 0.62;
  const at = (st: number, t: number, off: number): V3 => {
    const s = bodySec(X(st));
    const [y, z] = secPoint(s, t);
    const d = new THREE.Vector3(0, y - s.cy, z).normalize();
    return [X(st), y + d.y * off, z + d.z * off];
  };
  const out: THREE.BufferGeometry[] = [];
  for (const [off, sg] of [[0.018, 1], [0.004, -1]] as const) {
    out.push(
      geom(grid(6, 8, (i, j) => at(st0 + ((st1 - st0) * i) / 6, t0 + ((t1 - t0) * j) / 8, off)), PART.fuselage, (p) => {
        const s = bodySec(p[0]);
        return [0, sg * (p[1] - s.cy), sg * p[2]];
      })
    );
  }
  const tm = (t0 + t1) / 2;
  // Hinged at the front edge; a positive angle lifts the aft edge away from the fuselage.
  const pivot = at(st0, tm, 0.01);
  const s0 = bodySec(X(st0));
  const n = new THREE.Vector3(0, pivot[1] - s0.cy, pivot[2]).normalize();
  const axis = new THREE.Vector3(-1, 0, 0).cross(n).normalize();
  return { geometry: merge(out), pivot, axis: [axis.x, axis.y, axis.z] };
}

/** Fixed in-flight refuelling probe on the starboard side, ahead of the windscreen (Mk1A). */
function buildProbe(): THREE.BufferGeometry {
  const root: V3 = [X(2.14), Y(0.56), 0.3];
  const elbow: V3 = [X(1.64), Y(1.1), 0.56];
  const tipBase: V3 = [X(1.06), Y(1.14), 0.575];
  const tip: V3 = [X(0.95), Y(1.145), 0.578];
  const out: THREE.BufferGeometry[] = [];
  // Faired base on the fuselage.
  out.push(loft(stations(2.0, 2.55, 0.05), (x) => {
    const u = (ST(x) - 2.0) / 0.55;
    return { cy: Y(0.52 + 0.04 * (1 - u)), cz: 0.3, w: 0.06 * Math.sin(Math.PI * Math.min(1, u * 1.2 + 0.1)), hT: 0.07 * Math.sin(Math.PI * Math.min(1, u * 1.2 + 0.1)), hB: 0.02, n: 2 };
  }, 12, PART.fuselage));
  const bend: V3[] = [];
  for (let k = 0; k <= 6; k++) {
    const u = k / 6;
    // A quadratic bend through the elbow.
    const a = (1 - u) * (1 - u);
    const b = 2 * u * (1 - u);
    const c = u * u;
    const p0 = [root[0] + (elbow[0] - root[0]) * 0.55, root[1] + (elbow[1] - root[1]) * 0.55, root[2] + (elbow[2] - root[2]) * 0.55];
    const p2 = [elbow[0] + (tipBase[0] - elbow[0]) * 0.35, elbow[1] + (tipBase[1] - elbow[1]) * 0.35, elbow[2] + (tipBase[2] - elbow[2]) * 0.35];
    bend.push([a * p0[0]! + b * elbow[0] + c * p2[0]!, a * p0[1]! + b * elbow[1] + c * p2[1]!, a * p0[2]! + b * elbow[2] + c * p2[2]!]);
  }
  out.push(cylinder(root, bend[0]!, 0.042, PART.fuselage, 10));
  for (let k = 0; k + 1 < bend.length; k++) out.push(cylinder(bend[k]!, bend[k + 1]!, 0.04, PART.fuselage, 10));
  out.push(cylinder(bend[bend.length - 1]!, tipBase, 0.036, PART.fuselage, 10));
  // Refuelling nozzle: a metal head.
  out.push(cylinder(tipBase, tip, 0.05, PART.metal, 12));
  out.push(cylinder(tip, [tip[0] + 0.05, tip[1], tip[2]], 0.03, PART.dark, 10));
  return merge(out);
}

/** GSh-23 blister under the starboard intake, with the muzzle trough at its front. */
function buildGun(): THREE.BufferGeometry[] {
  const cz = 0.78;
  const hc = -0.47;
  const sec = (x: number): Section => {
    const u = (ST(x) - 5.35) / 2.0;
    const k = Math.sin(Math.PI * Math.min(1, Math.max(0.02, u < 0.15 ? u / 0.3 : 0.5 + (u - 0.15) * 0.59)));
    return { cy: Y(hc + 0.03), cz, w: 0.1 * k, hT: 0.05, hB: 0.07 * k, n: 2.2 };
  };
  return [loft(stations(5.35, 7.35, 0.08), sec, 16, PART.fuselage), cylinder([X(5.45), Y(hc), cz], [X(5.3), Y(hc), cz], 0.03, PART.dark, 10)];
}

function blade(st: number, h: number, z: number, len: number, height: number, up: 1 | -1, part: number = PART.antenna): THREE.BufferGeometry {
  const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(len, 0), new THREE.Vector2(len * 0.78, height), new THREE.Vector2(len * 0.55, height)]);
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false });
  g.translate(-len / 2, 0, -0.006);
  if (up < 0) g.scale(1, -1, 1);
  g.scale(-1, 1, 1);
  g.translate(X(st), Y(h), z);
  return fromThree(g, part);
}

function buildAntennas(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  // Dorsal: a small blade behind the canopy, the big UHF/L-band blade, and a hump fairing.
  out.push(blade(7.12, bodyTopY(X(7.12), 0) - YREF - 0.005, 0, 0.16, 0.1, 1));
  out.push(blade(8.08, bodyTopY(X(8.08), 0) - YREF - 0.005, 0, 0.3, 0.2, 1));
  // Ventral blades under the centre fuselage.
  out.push(blade(6.3, bodyBottomY(X(6.3), 0) - YREF + 0.005, 0, 0.2, 0.13, -1));
  out.push(blade(10.6, bodyBottomY(X(10.6), 0) - YREF + 0.005, 0, 0.22, 0.14, -1));
  // Missile-approach warning sensor domes: nose flanks and tail (Mk1A self-protection).
  for (const s of [-1, 1]) {
    out.push(loft(stations(2.62, 2.78, 0.04), (x) => {
      const u = (ST(x) - 2.62) / 0.16;
      const r = 0.045 * Math.sqrt(Math.max(0.01, 1 - (2 * u - 1) * (2 * u - 1)));
      return { cy: Y(0.42), cz: s * (0.52 + r * 0.4), w: r, hT: r, hB: r, n: 2 };
    }, 12, PART.seeker));
  }
  return out;
}

/** Chaff/flare dispensers on the rear fuselage flanks: panels of round cartridge ports. */
function buildDispensers(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 4; c++) {
        const st = 12.15 + c * 0.075;
        const h = 0.62 + r * 0.075;
        const sec = bodySec(X(st));
        const a = (h - (sec.cy - YREF)) / sec.hT;
        const z = s * sec.w * Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(a)), sec.nT)), 1 / sec.nT);
        out.push(cylinder([X(st), Y(h), z - s * 0.01], [X(st), Y(h), z + s * 0.004], 0.024, PART.dark, 10));
      }
    }
  }
  return out;
}

const TIP_ST = (wingLEst(SEMI_SPAN) + wingTEst(SEMI_SPAN)) / 2;
const TIP_Y = wingPlaneY(SEMI_SPAN);

/**
 * Exterior light positions, body frame: navigation (red port, green starboard wingtips, white on
 * the fin-tip fairing), anti-collision strobes (wingtips, aft of the nav lights), the landing/taxi
 * light on the nose gear leg (extended pose) and where it points (ahead, 4 deg down).
 */
export const LIGHTS = {
  navLeft: [X(TIP_ST - 0.2), TIP_Y, -SEMI_SPAN - 0.02] as V3,
  navRight: [X(TIP_ST - 0.2), TIP_Y, SEMI_SPAN + 0.02] as V3,
  navTail: [X(13.17), Y(FIN_TIP_H + 0.04), 0] as V3,
  strobeLeft: [X(TIP_ST + 0.15), TIP_Y, -SEMI_SPAN - 0.02] as V3,
  strobeRight: [X(TIP_ST + 0.15), TIP_Y, SEMI_SPAN + 0.02] as V3,
  landing: [X(3.86), Y(-0.62), 0] as V3,
  landingDir: [Math.cos(0.07), -Math.sin(0.07), 0] as V3,
};

function buildNavLights(): THREE.BufferGeometry {
  const L = LIGHTS;
  return merge([
    box([L.navLeft[0], L.navLeft[1], L.navLeft[2] + 0.008], [0.07, 0.022, 0.012], PART.lightRed),
    box([L.navRight[0], L.navRight[1], L.navRight[2] - 0.008], [0.07, 0.022, 0.012], PART.lightGreen),
    box([L.navTail[0] + 0.005, L.navTail[1], 0], [0.012, 0.035, 0.035], PART.lightWhite),
    box([L.strobeLeft[0], L.strobeLeft[1], L.strobeLeft[2] + 0.008], [0.05, 0.018, 0.012], PART.lightStrobe),
    box([L.strobeRight[0], L.strobeRight[1], L.strobeRight[2] - 0.008], [0.05, 0.018, 0.012], PART.lightStrobe),
  ]);
}

/** Formation lights: electroluminescent strips on the nose flanks, the rear fuselage and the fin. */
function buildFormationLights(): THREE.BufferGeometry {
  const strips: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const nose = bodySec(X(3.05));
    strips.push(box([X(3.05), Y(0.18), s * (nose.w + 0.004)], [0.16, 0.018, 0.006], PART.lightFormation));
    const rear = 12.0;
    const rs = bodySec(X(rear));
    strips.push(box([X(rear), Y(0.45), s * (rs.w + 0.004)], [0.16, 0.018, 0.006], PART.lightFormation));
    strips.push(box([X(12.3), Y(2.3), s * 0.045], [0.16, 0.018, 0.006], PART.lightFormation));
  }
  return merge(strips);
}

// -----------------------------------------------------------------------------
// Pylons (stations)
// -----------------------------------------------------------------------------

/** Pylon depth below the wing's lower surface, m. */
const PYLON_DEPTH = 0.26;

/**
 * Pylons, body frame, with their store-attach points, in the order of src/aircraft's stations
 * (the snapshot's store slots follow it): outboard (5/6: close-combat missiles), middle (3/4: BVR
 * missiles), inboard (1/2: BVR or wet, drop tanks), centreline (7, wet) and the port intake station
 * (L, pods). Spans from ADA's weapon-station diagram. src/aircraft's station positions equal these
 * attach points (a test keeps them in step).
 */
export interface Pylon {
  stationId: string;
  x: number;
  z: number;
  len: number;
  attachY: number;
}

const WING_PYLONS = [
  { name: 'outer', z: 3.42, stc: 10.15, len: 1.25 },
  { name: 'mid', z: 2.66, stc: 9.45, len: 1.55 },
  { name: 'inner', z: 1.68, stc: 8.5, len: 1.85 },
];

const r2 = (v: number): number => Math.round(v * 100) / 100;

export const PYLONS: readonly Pylon[] = [
  ...WING_PYLONS.flatMap(({ name, z, stc, len }) => {
    const attachY = r2(wingLowerY(stc, z) - PYLON_DEPTH);
    return [
      { stationId: `wing-${name}-l`, x: r2(X(stc)), z: -z, len, attachY },
      { stationId: `wing-${name}-r`, x: r2(X(stc)), z, len, attachY },
    ];
  }),
  { stationId: 'centreline', x: r2(X(7.9)), z: 0, len: 1.6, attachY: r2(Y(-0.46 - 0.13)) },
];

/** Station L: under the port intake (targeting pods); no pylon of its own, a flush mount. */
export const INTAKE_STATION: V3 = [r2(X(6.3)), r2(Y(-0.43 - 0.08)), -0.74];

function buildPylons(): THREE.BufferGeometry {
  return merge(
    PYLONS.map((p) => {
      const stc = ST(p.x);
      const top = p.z === 0 ? bodyBottomY(p.x, 0) + 0.05 : wingLowerY(stc, Math.abs(p.z)) + 0.04;
      const cy = (top + p.attachY) / 2;
      const h = (top - p.attachY) / 2;
      const xs = range(p.x - p.len / 2, p.x + p.len / 2, 0.08).sort((a, b) => a - b);
      return loft(xs, (x) => {
        const u = (x - (p.x - p.len / 2)) / p.len;
        // Knife-edged: sharp at the front (x high) and tapering aft.
        return { cy, cz: p.z, w: 0.045 * Math.min(1, (1 - u) / 0.14 + 0.1, u / 0.3 + 0.25), hT: h, hB: h, n: 4 };
      }, 12, PART.pylon);
    })
  );
}

// -----------------------------------------------------------------------------
// Landing gear (extended pose), with doors
// -----------------------------------------------------------------------------

const NOSE_WHEEL_R = 0.19;
const MAIN_WHEEL_R = 0.3;
const NOSE_ST = 3.96;
const MAIN_ST = 8.3;
const MAIN_TRACK_Z = 1.1;

function wheel(c: V3, r: number, halfW: number): THREE.BufferGeometry {
  return merge([
    cylinder([c[0], c[1], c[2] - halfW], [c[0], c[1], c[2] + halfW], r, PART.tyre, 20),
    cylinder([c[0], c[1], c[2] - halfW - 0.008], [c[0], c[1], c[2] + halfW + 0.008], r * 0.58, PART.gear, 16),
    cylinder([c[0], c[1], c[2] - halfW - 0.02], [c[0], c[1], c[2] + halfW + 0.02], r * 0.18, PART.metal, 10),
  ]);
}

/** Nose gear pivot; the leg folds forwards (+x) into the bay under the cockpit. */
const NOSE_PIVOT: V3 = [X(3.92), Y(-0.12), 0];

function buildNoseGear(): THREE.BufferGeometry {
  const axle: V3 = [X(NOSE_ST), WHEEL_BOTTOM_Y + NOSE_WHEEL_R, 0];
  const oleoTop: V3 = [X(3.93), Y(-0.62), 0];
  return merge([
    cylinder(NOSE_PIVOT, oleoTop, 0.062, PART.gear, 12),
    cylinder(oleoTop, [axle[0], axle[1] + 0.1, 0], 0.045, PART.metal, 12),
    // Fork/axle beam and torque links.
    box([axle[0], axle[1] + 0.06, 0], [0.05, 0.07, 0.07], PART.gear),
    cylinder([axle[0], axle[1], -0.2], [axle[0], axle[1], 0.2], 0.022, PART.metal, 8),
    box([axle[0] - 0.07, axle[1] + 0.28, 0], [0.012, 0.1, 0.03], PART.gear),
    // Drag brace to the bay's aft wall.
    cylinder([X(3.94), Y(-0.55), 0], [X(4.35), Y(-0.2), 0], 0.025, PART.gear, 8),
    wheel([axle[0], axle[1], -0.13], NOSE_WHEEL_R, 0.06),
    wheel([axle[0], axle[1], 0.13], NOSE_WHEEL_R, 0.06),
    // Landing/taxi light bar on the leg.
    box([LIGHTS.landing[0] + 0.035, LIGHTS.landing[1], 0], [0.02, 0.03, 0.08], PART.lightLanding),
    box([LIGHTS.landing[0] + 0.015, LIGHTS.landing[1], 0], [0.02, 0.045, 0.1], PART.gear),
  ]);
}

/** Nose bay doors: two long doors either side of the bay, open (hanging) with the gear down. */
function buildNoseDoor(side: 1 | -1): { geometry: THREE.BufferGeometry; pivot: V3; axis: V3 } {
  const z = side * 0.16;
  const top = Y(-0.345);
  const g = box([X(3.35), top - 0.19, z], [0.58, 0.19, 0.008], PART.fuselage);
  // Closing swings the door's bottom edge inwards to lie flush.
  return { geometry: g, pivot: [X(3.35), top, z], axis: [side > 0 ? 1 : -1, 0, 0] };
}

/** Main leg pivot (starboard); the leg folds inwards (about the x axis) into the belly. */
const MAIN_PIVOT_R: V3 = [X(8.22), Y(-0.12), 0.74];

function buildMainGearRight(): THREE.BufferGeometry {
  const axleIn: V3 = [X(MAIN_ST), WHEEL_BOTTOM_Y + MAIN_WHEEL_R, 1.0];
  const oleo: V3 = [X(8.26), Y(-0.72), 0.92];
  return merge([
    cylinder(MAIN_PIVOT_R, oleo, 0.075, PART.gear, 12),
    cylinder(oleo, axleIn, 0.058, PART.metal, 12),
    cylinder([axleIn[0], axleIn[1], axleIn[2] - 0.03], [axleIn[0], axleIn[1], MAIN_TRACK_Z + 0.02], 0.045, PART.gear, 10),
    // Side brace from the leg up to the wing root, and the torque links.
    cylinder([X(8.25), Y(-0.55), 0.88], [X(8.1), Y(-0.05), 1.12], 0.028, PART.gear, 8),
    box([X(8.37), Y(-0.92), 0.97], [0.012, 0.09, 0.025], PART.gear),
    wheel([axleIn[0], axleIn[1], MAIN_TRACK_Z + 0.02], MAIN_WHEEL_R, 0.09),
    // Leg door: the big panel on the leg's outboard face that closes the bay (carries the number).
    geom(
      grid(1, 1, (i, j) => {
        const st = 7.72 + i * 1.08;
        const f = j; // 0 top .. 1 bottom
        return [X(st), Y(-0.14) + (Y(-0.78) - Y(-0.14)) * f, 0.805 + 0.165 * f];
      }),
      PART.door,
      () => [0, -0.2, 1]
    ),
    geom(
      grid(1, 1, (i, j) => {
        const st = 7.72 + i * 1.08;
        const f = j;
        return [X(st), Y(-0.14) + (Y(-0.78) - Y(-0.14)) * f, 0.79 + 0.165 * f];
      }),
      PART.door,
      () => [0, 0.2, -1]
    ),
  ]);
}

/** Inner main-bay door on the belly, hinged at the centreline, hanging open with the gear down. */
function buildMainBayDoor(side: 1 | -1): { geometry: THREE.BufferGeometry; pivot: V3; axis: V3 } {
  const hy = Y(-0.455);
  const z0 = side * 0.12;
  const g = geom(
    grid(1, 1, (i, j) => [X(7.75 + i * 1.0), hy - 0.42 * j * 0.95, z0 + side * 0.42 * j * 0.3]),
    PART.door,
    () => [0, 0, side]
  );
  const g2 = geom(
    grid(1, 1, (i, j) => [X(7.75 + i * 1.0), hy - 0.42 * j * 0.95, z0 - side * 0.008 + side * 0.42 * j * 0.3]),
    PART.door,
    () => [0, 0, -side]
  );
  return { geometry: merge([g, g2]), pivot: [X(8.25), hy, z0], axis: [side > 0 ? -1 : 1, 0, 0] };
}

// -----------------------------------------------------------------------------
// Afterburner flame
// -----------------------------------------------------------------------------

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
  /** Hinge point and unit axis, body frame. */
  pivot: V3;
  axis: V3;
  driver: PartDriver;
  /** Angle at full travel, rad: gear = retracted (at gearPos 0), slat = full droop, airbrake = fully open. */
  travelRad: number;
  /** Gear parts are hidden when fully retracted, except these (doors, which stay closed over the bays). */
  keepVisible?: boolean;
}

export interface AircraftModelTemplate {
  /** Model frame -> body frame translation along x (0: this model is authored in the body frame). */
  offsetX: number;
  body: THREE.BufferGeometry;
  parts: ArticulatedPart[];
  flame: THREE.BufferGeometry;
  /** Nozzle petal hinge axis height (the petals open radially about it) and the exit's x. */
  nozzleAxisY: number;
  nozzleExitX: number;
  /** Store stations with pylons, in store-slot order (see PYLONS). */
  pylons: readonly Pylon[];
  /** Exterior light positions (LIGHTS); `landing` is carried by the part named by `landingPart`. */
  lights: typeof LIGHTS;
  landingPart: string;
  /** Inside the canopy (body frame): with the camera here, the exterior canopy frame isn't drawn (the cockpit has its own). */
  canopyInterior: { min: V3; max: V3 };
  /** Markings and panel lines (a texture needs a DOM, so the renderer's owner attaches it). */
  livery?: import('../aircraftMaterial').AircraftLivery;
}

function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
const mirrorPart = (g: THREE.BufferGeometry): THREE.BufferGeometry => mirrorZ(g);

export function buildTejasModel(): AircraftModelTemplate {
  const wing = buildWingRight();
  const fin = buildFin();
  const intake = merge(buildIntakeRight());
  const gun = merge(buildGun());
  const body = merge([
    ...buildFuselage(),
    ...buildCanopy(),
    intake,
    mirrorZ(intake),
    gun,
    wing.fixed,
    mirrorZ(wing.fixed),
    fin.fixed,
    buildDorsalFillet(),
    ...buildChuteCanister(),
    ...buildNozzle(),
    buildPylons(),
    buildProbe(),
    ...buildAntennas(),
    ...buildDispensers(),
    buildNavLights(),
    buildFormationLights(),
  ]);

  const deg = Math.PI / 180;
  const parts: ArticulatedPart[] = [];
  // Elevons: hinge along the constant-station hinge line (+z axis on both sides: + = trailing edge down).
  ELEVON_SPANS.forEach(([a], k) => {
    const pivotR: V3 = [X(ELEVON_HINGE_ST), wingPlaneY(a), a];
    const axisR = unit([0, -Math.tan(ANHEDRAL), 1]);
    parts.push({ name: `elevonR${k}`, geometry: wing.elevons[k]!, pivot: pivotR, axis: axisR, driver: 'elevonR', travelRad: 0 });
    parts.push({ name: `elevonL${k}`, geometry: mirrorPart(wing.elevons[k]!), pivot: [pivotR[0], pivotR[1], -a], axis: [0, Math.tan(ANHEDRAL) * axisR[2], axisR[2]], driver: 'elevonL', travelRad: 0 });
  });
  // Slats droop the leading edge (a negative angle about the +z-pointing hinge along the slat's trailing edge).
  SLAT_SPANS.forEach(([a, b], k) => {
    const pa: V3 = [X(wingLEst(a) + SLAT_DEPTH), wingPlaneY(a), a];
    const pb: V3 = [X(wingLEst(b) + SLAT_DEPTH), wingPlaneY(b), b];
    const axisR = unit([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]);
    parts.push({ name: `slatR${k}`, geometry: wing.slats[k]!, pivot: pa, axis: axisR, driver: 'slat', travelRad: -18 * deg });
    parts.push({ name: `slatL${k}`, geometry: mirrorPart(wing.slats[k]!), pivot: [pa[0], pa[1], -a], axis: [-axisR[0], -axisR[1], axisR[2]], driver: 'slat', travelRad: -18 * deg });
  });
  // Rudder: an axis down the hinge line, so a positive angle swings the trailing edge left (-z).
  const rTop: V3 = [X(rudderHingeSt(RUDDER_H[1])), Y(RUDDER_H[1]), 0];
  const rBot: V3 = [X(rudderHingeSt(RUDDER_H[0])), Y(RUDDER_H[0]), 0];
  parts.push({ name: 'rudder', geometry: fin.rudder, pivot: rBot, axis: unit([rBot[0] - rTop[0], rBot[1] - rTop[1], 0]), driver: 'rudder', travelRad: 0 });
  const brakeR = buildAirbrake(1);
  const brakeL = buildAirbrake(-1);
  parts.push({ name: 'airbrakeR', geometry: brakeR.geometry, pivot: brakeR.pivot, axis: brakeR.axis, driver: 'airbrake', travelRad: 50 * deg });
  parts.push({ name: 'airbrakeL', geometry: brakeL.geometry, pivot: brakeL.pivot, axis: brakeL.axis, driver: 'airbrake', travelRad: 50 * deg });
  // Gear: nose folds forwards, mains fold inwards; doors close behind them.
  parts.push({ name: 'noseGear', geometry: buildNoseGear(), pivot: NOSE_PIVOT, axis: [0, 0, 1], driver: 'gear', travelRad: 88 * deg });
  const mainR = buildMainGearRight();
  parts.push({ name: 'mainGearR', geometry: mainR, pivot: MAIN_PIVOT_R, axis: [1, 0, 0], driver: 'gear', travelRad: 92 * deg });
  parts.push({ name: 'mainGearL', geometry: mirrorPart(mainR), pivot: [MAIN_PIVOT_R[0], MAIN_PIVOT_R[1], -MAIN_PIVOT_R[2]], axis: [-1, 0, 0], driver: 'gear', travelRad: 92 * deg });
  for (const side of [1, -1] as const) {
    const d = buildNoseDoor(side);
    parts.push({ name: `noseDoor${side > 0 ? 'R' : 'L'}`, geometry: d.geometry, pivot: d.pivot, axis: d.axis, driver: 'gear', travelRad: 88 * deg, keepVisible: true });
    const b = buildMainBayDoor(side);
    parts.push({ name: `mainBayDoor${side > 0 ? 'R' : 'L'}`, geometry: b.geometry, pivot: b.pivot, axis: b.axis, driver: 'gear', travelRad: 80 * deg, keepVisible: true });
  }
  return {
    offsetX: LAYOUT_TO_BODY_X,
    body,
    parts,
    flame: buildFlame(),
    nozzleAxisY: NOZZLE_AXIS_Y,
    nozzleExitX: NOZZLE_EXIT_X,
    pylons: PYLONS,
    lights: LIGHTS,
    landingPart: 'noseGear',
    canopyInterior: { min: [X(CANOPY_ST[1]), Y(0.55), -0.45], max: [X(CANOPY_ST[0]), Y(1.34), 0.45] },
  };
}
