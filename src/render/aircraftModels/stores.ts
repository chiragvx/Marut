/**
 * src/render/aircraftModels/stores.ts — procedural models of the stores the Tejas carries, to
 * public dimensions and built from photographs of the real hardware:
 * - air-to-air missiles: ASRAAM (2.90 m, 166 mm, no mid-body wings, small tail fins), R-73 (2.93 m,
 *   170 mm, nose destabilisers, canards, tail wings), Derby (3.62 m, 160 mm), Astra Mk1 (3.57 m,
 *   178 mm, long mid-body strakes), Python-5, I-Derby ER and the hostile PL-5E II, AIM-9M (with its
 *   rollerons), SD-10A, AIM-120C-5 and PL-15E; each with its seeker (an IR dome in its collar, or a
 *   radome), the launch shoes it rides the rail on, and its motor's nozzle;
 * - bombs: the Mk 80-series low-drag shape (Mk 82, HSLD-250/450) with nose fuze, nose band,
 *   suspension lugs and conical fin assembly; the Mk 82 Snakeye with its four retarder blades
 *   (closed, and opened after release); the HSLD-250R with its ballute can; the Griffin LGB
 *   (Paveway-style seeker with its ring, canards, large tail wings); HAMMER (seeker nose, canards,
 *   rocket tail); SAAW (stowed wings on its back);
 * - pods: the B-8M1 rocket pod (20 x 80 mm tubes, rocket noses showing, nose and tail fairings)
 *   and the Litening targeting pod (sensor head with its window, pylon adapter, cooling scoop);
 * - the 1200 L wing tank and the 725 L centreline tank;
 * - single and twin-rail launchers: a slab-sided beam with its launch track, umbilical and
 *   snubber.
 *
 * Each store's geometry is centred on its own axis (x forward), so a missile in flight is drawn
 * about its entity position; `mount` hangs it from a rail or pylon whose attach point is the origin
 * (missiles slightly forward of the pylon, below the rail; tanks, bombs and pods straight under it).
 */
import * as THREE from 'three';
import { STORE_IDS } from '../../contracts/core';
import { PART, box, cap, circle, cylinder, geom, grid, loft, merge, plate, range, type Section, type V3 } from './meshBuild';

export interface StoreModel {
  kind: 'missile' | 'tank' | 'bomb' | 'pod';
  geometry: THREE.BufferGeometry;
  /** Store frame -> attach frame (origin at the rail top / pylon attach point). */
  mount: THREE.Matrix4;
  /** Retarded bombs: the open ballute and its risers, in the bomb's frame (drawn once its tail opens). */
  ballute?: THREE.BufferGeometry;
  /** Retarded bombs whose tail itself opens (Snakeye blades): drawn instead of `geometry` once it has. */
  bodyOpen?: THREE.BufferGeometry;
}

// ---------------------------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------------------------

/** Profile points: [x, radius]. */
type Prof = readonly (readonly [number, number])[];

/**
 * A surface of revolution about the x axis (offset to (cy, cz)) through the profile points, in
 * order. Faces point outward (inward with `inward`), or along `dir` for a flat face.
 */
function lathe(pts: Prof, part: number, n = 16, o: { cy?: number; cz?: number; dir?: V3; inward?: boolean } = {}): THREE.BufferGeometry {
  const cy = o.cy ?? 0;
  const cz = o.cz ?? 0;
  const raw = grid(
    n,
    pts.length - 1,
    (i, j) => {
      const t = (2 * Math.PI * i) / n;
      const [x, r] = pts[j]!;
      return [x, cy + r * Math.sin(t), cz + r * Math.cos(t)];
    },
    true
  );
  const sg = o.inward ? -1 : 1;
  return geom(raw, part, (p) => o.dir ?? [0, sg * (p[1] - cy), sg * (p[2] - cz)]);
}

/** A flat disc at c facing nrm. */
function disc(c: V3, nrm: V3, r: number, part: number, n = 16): THREE.BufferGeometry {
  const ax = new THREE.Vector3(nrm[0], nrm[1], nrm[2]).normalize();
  const u = Math.abs(ax.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3().crossVectors(ax, u).normalize();
  u.crossVectors(v, ax).normalize();
  const pos: number[] = [...c];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const ct = Math.cos(t) * r;
    const st = Math.sin(t) * r;
    pos.push(c[0] + u.x * ct + v.x * st, c[1] + u.y * ct + v.y * st, c[2] + u.z * ct + v.z * st);
    idx.push(0, 1 + i, 1 + ((i + 1) % n));
  }
  return geom({ pos, idx }, part, () => [ax.x, ax.y, ax.z]);
}

/** A body of revolution from a radius function of d (distance aft of the nose tip, 0..L), split into
 *  coloured segments [d0, d1, part]; returns the parts. Segments are sampled at `step`. */
function body(L: number, radius: (d: number) => number, segs: readonly (readonly [number, number, number])[], n = 18, step = 0.08): THREE.BufferGeometry[] {
  const X = (d: number): number => L / 2 - d;
  return segs
    .filter(([d0, d1]) => d1 > d0 + 1e-4)
    .map(([d0, d1, part]) => {
      const ds = d0 < 1e-6 ? Array.from({ length: 11 }, (_, i) => d1 * Math.pow(i / 10, 1.5)) : range(d0, d1, step);
      const xs = ds.map(X).reverse();
      return loft(xs, (x) => circle(0, 0, Math.max(1e-4, radius(L / 2 - x))), n, part);
    });
}

/**
 * Fins round the body: `count` of them starting at angle `phase` (0 = +z, pi/2 = top), on a body of
 * radius base(x); root leading edge at xLE (store frame), swept back by `sweep` at the tip.
 */
function finSet(phase: number, count: number, base: (x: number) => number, xLE: number, root: number, tip: number, span: number, sweep: number, halfT: number, part: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let k = 0; k < count; k++) {
    const phi = phase + (k * 2 * Math.PI) / count;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const map = (x: number, h: number, t: number): V3 => {
      const rr = base(x) + h;
      return [x, rr * s + t * c, rr * c - t * s];
    };
    const front = (h: number): number => xLE - sweep * (h / span);
    const back = (h: number): number => front(h) - (root + (tip - root) * (h / span));
    out.push(plate(-0.01, span, front, back, (_x, h) => halfT * (1 - 0.45 * Math.max(0, h) / span), map, part, 3, true));
  }
  return out;
}

/** Tangent-ogive radius at distance d back from the point of an ogive of length l and base radius r. */
function ogive(d: number, l: number, r: number): number {
  const rho = (r * r + l * l) / (2 * r);
  const x = l - Math.min(d, l);
  return Math.max(0, Math.sqrt(rho * rho - x * x) + r - rho);
}

/** Smooth 0..1 ramp. */
const smooth = (u: number): number => {
  const t = Math.min(1, Math.max(0, u));
  return t * t * (3 - 2 * t);
};

/** A motor nozzle / exhaust at the tail (x0, facing -x): an annulus round a dark recessed exit. */
function nozzle(x0: number, rOut: number, rExit: number, part: number): THREE.BufferGeometry[] {
  return [
    lathe([[x0, rExit], [x0, rOut]], part, 16, { dir: [-1, 0, 0] }),
    lathe([[x0, rExit], [x0 + 0.06, rExit * 0.75]], PART.dark, 16, { inward: true }),
    cap(x0 + 0.06, circle(0, 0, rExit * 0.75), 16, PART.dark, [-1, 0, 0]),
  ];
}

/** A suspension lug on top of a store (body top at y = top), at x: a closed loop, gunmetal. */
function lug(x: number, top: number, h = 0.035): THREE.BufferGeometry[] {
  return [
    box([x, top + h / 2, 0.011], [0.007, h / 2, 0.004], PART.gunmetal),
    box([x, top + h / 2, -0.011], [0.007, h / 2, 0.004], PART.gunmetal),
    box([x, top + h - 0.004, 0], [0.007, 0.004, 0.015], PART.gunmetal),
    box([x, top + 0.004, 0], [0.03, 0.004, 0.02], PART.gunmetal),
  ];
}

// ---------------------------------------------------------------------------------------------
// Missiles
// ---------------------------------------------------------------------------------------------

interface FinSet {
  /** Root leading edge, m aft of the nose tip. */
  at: number;
  rootChord: number;
  tipChord: number;
  /** Fin height above the body. */
  span: number;
  /** Tip leading edge aft of the root's. */
  sweep: number;
}

interface MissileSpec {
  len: number;
  dia: number;
  seeker: 'ir' | 'radar';
  /** Radome length (radar); IR domes are hemispheres. */
  noseLen: number;
  fins: FinSet[];
  /** Warhead and motor band starts, m aft of the nose tip (each 5 cm wide). */
  bands: [number, number];
  /** Rollerons in the tail fins' tips (Sidewinder family). */
  rollerons?: boolean;
  /** Surface-to-air: no launch shoes. */
  sam?: boolean;
}

const MISSILES: Record<string, MissileSpec> = {
  asraam: { len: 2.9, dia: 0.166, seeker: 'ir', noseLen: 0, fins: [{ at: 2.52, rootChord: 0.34, tipChord: 0.2, span: 0.12, sweep: 0.1 }], bands: [0.55, 1.2] },
  'r-73': {
    len: 2.93,
    dia: 0.17,
    seeker: 'ir',
    noseLen: 0,
    fins: [
      // Destabilisers just behind the dome, then the canards.
      { at: 0.1, rootChord: 0.07, tipChord: 0.02, span: 0.05, sweep: 0.05 },
      { at: 0.24, rootChord: 0.16, tipChord: 0.03, span: 0.1, sweep: 0.11 },
      { at: 2.45, rootChord: 0.42, tipChord: 0.22, span: 0.18, sweep: 0.16 },
    ],
    bands: [0.6, 1.3],
  },
  derby: {
    len: 3.62,
    dia: 0.16,
    seeker: 'radar',
    noseLen: 0.45,
    fins: [
      { at: 0.55, rootChord: 0.2, tipChord: 0.06, span: 0.1, sweep: 0.12 },
      { at: 3.14, rootChord: 0.42, tipChord: 0.24, span: 0.16, sweep: 0.13 },
    ],
    bands: [0.95, 1.8],
  },
  'astra-mk1': {
    len: 3.57,
    dia: 0.178,
    seeker: 'radar',
    noseLen: 0.5,
    fins: [
      { at: 1.0, rootChord: 1.25, tipChord: 1.12, span: 0.06, sweep: 0.08 },
      { at: 3.1, rootChord: 0.44, tipChord: 0.22, span: 0.17, sweep: 0.15 },
    ],
    bands: [0.9, 2.0],
  },
  // Newer and hostile missiles (public dimensions; fin layouts from photographs).
  'python-5': {
    len: 3.1,
    dia: 0.16,
    seeker: 'ir',
    noseLen: 0,
    fins: [
      { at: 0.22, rootChord: 0.14, tipChord: 0.04, span: 0.08, sweep: 0.1 },
      { at: 0.45, rootChord: 0.2, tipChord: 0.06, span: 0.11, sweep: 0.13 },
      { at: 2.6, rootChord: 0.46, tipChord: 0.24, span: 0.19, sweep: 0.17 },
    ],
    bands: [0.7, 1.4],
  },
  'derby-er': {
    len: 3.62,
    dia: 0.16,
    seeker: 'radar',
    noseLen: 0.45,
    fins: [
      { at: 0.55, rootChord: 0.2, tipChord: 0.06, span: 0.1, sweep: 0.12 },
      { at: 3.14, rootChord: 0.42, tipChord: 0.24, span: 0.16, sweep: 0.13 },
    ],
    bands: [0.95, 1.9],
  },
  'pl-5e': {
    len: 2.89,
    dia: 0.127,
    seeker: 'ir',
    noseLen: 0,
    fins: [
      { at: 0.28, rootChord: 0.2, tipChord: 0.05, span: 0.12, sweep: 0.14 },
      { at: 2.45, rootChord: 0.38, tipChord: 0.18, span: 0.2, sweep: 0.15 },
    ],
    bands: [0.55, 1.15],
  },
  'aim-9m': {
    len: 2.87,
    dia: 0.127,
    seeker: 'ir',
    noseLen: 0,
    fins: [
      { at: 0.3, rootChord: 0.24, tipChord: 0.02, span: 0.13, sweep: 0.21 },
      { at: 2.42, rootChord: 0.42, tipChord: 0.18, span: 0.2, sweep: 0.17 },
    ],
    bands: [0.6, 1.2],
    rollerons: true,
  },
  'sd-10a': {
    len: 3.85,
    dia: 0.203,
    seeker: 'radar',
    noseLen: 0.55,
    fins: [
      { at: 1.45, rootChord: 0.62, tipChord: 0.22, span: 0.2, sweep: 0.3 },
      { at: 3.35, rootChord: 0.45, tipChord: 0.22, span: 0.18, sweep: 0.15 },
    ],
    bands: [0.95, 2.1],
  },
  'aim-120c': {
    len: 3.66,
    dia: 0.178,
    seeker: 'radar',
    noseLen: 0.5,
    fins: [
      { at: 1.5, rootChord: 0.34, tipChord: 0.12, span: 0.13, sweep: 0.16 },
      { at: 3.2, rootChord: 0.4, tipChord: 0.2, span: 0.16, sweep: 0.14 },
    ],
    bands: [0.9, 1.9],
  },
  'rudram-1': {
    len: 5.5,
    dia: 0.33,
    seeker: 'radar',
    noseLen: 0.7,
    fins: [
      { at: 1.6, rootChord: 1.1, tipChord: 0.6, span: 0.16, sweep: 0.35 },
      { at: 4.9, rootChord: 0.55, tipChord: 0.3, span: 0.26, sweep: 0.2 },
    ],
    bands: [1.2, 2.6],
  },
  'mar-1': {
    len: 4.0,
    dia: 0.23,
    seeker: 'radar',
    noseLen: 0.5,
    fins: [
      { at: 1.3, rootChord: 0.7, tipChord: 0.35, span: 0.14, sweep: 0.3 },
      { at: 3.6, rootChord: 0.4, tipChord: 0.2, span: 0.2, sweep: 0.15 },
    ],
    bands: [1.0, 2.0],
  },
  // Surface-to-air missiles (in flight only).
  'akash-msl': {
    len: 5.78,
    dia: 0.35,
    seeker: 'radar',
    noseLen: 0.9,
    fins: [
      { at: 2.0, rootChord: 1.0, tipChord: 0.45, span: 0.22, sweep: 0.45 },
      { at: 5.2, rootChord: 0.5, tipChord: 0.25, span: 0.28, sweep: 0.2 },
    ],
    bands: [1.4, 2.8],
    sam: true,
  },
  'spyder-derby': {
    len: 3.62,
    dia: 0.16,
    seeker: 'radar',
    noseLen: 0.45,
    fins: [
      { at: 0.6, rootChord: 0.25, tipChord: 0.08, span: 0.1, sweep: 0.15 },
      { at: 3.2, rootChord: 0.35, tipChord: 0.2, span: 0.16, sweep: 0.12 },
    ],
    bands: [0.8, 1.5],
    sam: true,
  },
  'mrsam-msl': {
    len: 4.5,
    dia: 0.225,
    seeker: 'radar',
    noseLen: 0.6,
    fins: [
      { at: 1.6, rootChord: 0.6, tipChord: 0.25, span: 0.14, sweep: 0.3 },
      { at: 4.0, rootChord: 0.4, tipChord: 0.2, span: 0.2, sweep: 0.15 },
    ],
    bands: [1.1, 2.2],
    sam: true,
  },
  'ly-80-msl': {
    len: 5.2,
    dia: 0.34,
    seeker: 'radar',
    noseLen: 0.8,
    fins: [
      { at: 1.4, rootChord: 0.9, tipChord: 0.4, span: 0.25, sweep: 0.4 },
      { at: 4.5, rootChord: 0.6, tipChord: 0.3, span: 0.3, sweep: 0.25 },
    ],
    bands: [1.3, 2.4],
    sam: true,
  },
  'hq-9-msl': {
    len: 6.8,
    dia: 0.7,
    seeker: 'radar',
    noseLen: 1.3,
    fins: [{ at: 5.8, rootChord: 0.9, tipChord: 0.45, span: 0.45, sweep: 0.35 }],
    bands: [1.8, 3.0],
    sam: true,
  },
  'fm-90-msl': {
    len: 2.9,
    dia: 0.156,
    seeker: 'radar',
    noseLen: 0.35,
    fins: [
      { at: 0.4, rootChord: 0.18, tipChord: 0.05, span: 0.1, sweep: 0.12 },
      { at: 2.4, rootChord: 0.4, tipChord: 0.2, span: 0.2, sweep: 0.15 },
    ],
    bands: [0.7, 1.4],
    sam: true,
  },
  'anza-mk3': {
    len: 1.44,
    dia: 0.072,
    seeker: 'ir',
    noseLen: 0,
    fins: [
      { at: 0.15, rootChord: 0.06, tipChord: 0.02, span: 0.04, sweep: 0.04 },
      { at: 1.3, rootChord: 0.1, tipChord: 0.06, span: 0.06, sweep: 0.04 },
    ],
    bands: [0.3, 0.6],
    sam: true,
  },
  'pl-15e': {
    len: 3.99,
    dia: 0.203,
    seeker: 'radar',
    noseLen: 0.6,
    fins: [
      { at: 1.2, rootChord: 1.6, tipChord: 1.45, span: 0.05, sweep: 0.08 },
      { at: 3.62, rootChord: 0.32, tipChord: 0.2, span: 0.1, sweep: 0.1 },
    ],
    bands: [1.0, 2.2],
  },
};

/** Launch shoes' positions, missile frame (under the launcher's hangers, which sit at rail x 0.7 and -0.45; missiles mount 0.25 forward). */
const SHOE_X = [0.45, -0.7];

function buildMissile(m: MissileSpec): THREE.BufferGeometry {
  const r = m.dia / 2;
  const L = m.len;
  const X = (d: number): number => L / 2 - d;
  // Radius at distance d aft of the nose tip; boat-tail over the last 8 cm.
  const radius = (d: number): number => {
    let rr = r;
    if (m.seeker === 'ir' && d < r) rr = Math.sqrt(Math.max(0, r * r - (r - d) * (r - d)));
    else if (m.seeker === 'radar' && d < m.noseLen) rr = Math.max(0.006, ogive(d, m.noseLen, r));
    if (d > L - 0.08) rr *= 1 - 0.15 * ((d - (L - 0.08)) / 0.08);
    return rr;
  };
  // An IR dome sits in a narrow metal collar (the seeker's retaining ring).
  const noseEnd = m.seeker === 'ir' ? r : m.noseLen;
  const collar = m.seeker === 'ir' ? Math.min(0.03, r * 0.35) : 0;
  const parts = body(L, radius, [
    [0, noseEnd, m.seeker === 'ir' ? PART.seeker : PART.missileRadome],
    [noseEnd, noseEnd + collar, PART.gunmetal],
    [noseEnd + collar, m.bands[0], PART.missile],
    [m.bands[0], m.bands[0] + 0.05, PART.bandYellow],
    [m.bands[0] + 0.05, m.bands[1], PART.missile],
    [m.bands[1], m.bands[1] + 0.05, PART.bandBrown],
    [m.bands[1] + 0.05, L, PART.missile],
  ], 18, 0.1);
  // The motor's nozzle in the tail.
  const rEnd = radius(L);
  parts.push(...nozzle(X(L), rEnd, rEnd * 0.62, PART.missile));
  // Fins in an X, clear of the rail above.
  const tailFin = m.fins[m.fins.length - 1]!;
  for (const f of m.fins) {
    const halfT = Math.min(0.006, 0.02 * f.rootChord + 0.002);
    parts.push(...finSet(Math.PI / 4, 4, () => r, X(f.at), f.rootChord, f.tipChord, f.span, f.sweep, halfT, PART.missile));
  }
  if (m.rollerons) {
    // A rolleron (gyro wheel) in the trailing corner of each tail fin's tip, its axle across the fin.
    const wr = 0.034;
    for (let k = 0; k < 4; k++) {
      const phi = Math.PI / 4 + (k * Math.PI) / 2;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const h = tailFin.span - wr * 0.6;
      const xTE = X(tailFin.at) - tailFin.sweep * (h / tailFin.span) - (tailFin.rootChord + (tailFin.tipChord - tailFin.rootChord) * (h / tailFin.span));
      const cx = xTE + wr * 0.7;
      const rr = r + h;
      const cyy = rr * s;
      const czz = rr * c;
      // Axle normal to the fin: (y, z) = (c, -s).
      parts.push(cylinder([cx, cyy - 0.007 * c, czz + 0.007 * s], [cx, cyy + 0.007 * c, czz - 0.007 * s], wr, PART.metal, 14));
    }
  }
  if (!m.sam) {
    // Launch shoes on the missile's back: a stem and the flange the rail's lips hold.
    for (const sx of SHOE_X) {
      if (Math.abs(sx) > L / 2 - 0.12) continue;
      parts.push(box([sx, r + HANGER * 0.35, 0], [0.032, HANGER * 0.35, 0.005], PART.gunmetal));
      parts.push(box([sx, r + HANGER * 0.8, 0], [0.04, HANGER * 0.16, 0.012], PART.gunmetal));
      parts.push(box([sx, r + 0.002, 0], [0.045, 0.003, 0.018], PART.gunmetal));
    }
  }
  return merge(parts);
}

// ---------------------------------------------------------------------------------------------
// Bombs
// ---------------------------------------------------------------------------------------------

type BombTail = 'conical' | 'snakeye' | 'ballute' | 'lgb' | 'hammer' | 'saaw';

/** Bombs: overall length (with tail), body diameter, nose length, and the tail kit. */
interface BombSpec {
  len: number;
  dia: number;
  noseLen: number;
  tail: BombTail;
  retarded: boolean;
  /** Suspension lug spacing, m (14 in for 250 kg class, 30 in for 450 kg). */
  lugs: number;
}
const BOMBS: Record<string, BombSpec> = {
  'hsld-450': { len: 3.3, dia: 0.4, noseLen: 0.95, tail: 'conical', retarded: false, lugs: 0.762 },
  'hsld-250': { len: 2.7, dia: 0.32, noseLen: 0.8, tail: 'conical', retarded: false, lugs: 0.356 },
  'hsld-250r': { len: 2.8, dia: 0.32, noseLen: 0.8, tail: 'ballute', retarded: true, lugs: 0.356 },
  // Guided bombs: the Griffin kit on a 1000 lb body, the HAMMER's 250 kg body with its rocket tail.
  'griffin-lgb': { len: 4.3, dia: 0.36, noseLen: 1.1, tail: 'lgb', retarded: false, lugs: 0.762 },
  'hammer-250': { len: 3.1, dia: 0.32, noseLen: 0.8, tail: 'hammer', retarded: false, lugs: 0.356 },
  saaw: { len: 1.9, dia: 0.26, noseLen: 0.45, tail: 'saaw', retarded: false, lugs: 0.356 },
  'mk-82': { len: 2.21, dia: 0.273, noseLen: 0.7, tail: 'conical', retarded: false, lugs: 0.356 },
  'mk-82-se': { len: 2.21, dia: 0.273, noseLen: 0.7, tail: 'snakeye', retarded: true, lugs: 0.356 },
};

/** Twin bomb carrier: the two bombs' centres either side of the pylon. */
export const BOMB_RACK_Z = 0.23;

/**
 * Mk 80-series body (also the HSLD family): a long ogive with a nose fuze in its tip, a short
 * parallel middle, and a long taper aft to where the tail kit bolts on (at `bodyLen`).
 */
function mk80Radius(b: BombSpec, bodyLen: number): (d: number) => number {
  const r = b.dia / 2;
  const fuze = 0.075;
  const taper0 = bodyLen * 0.62;
  return (d: number): number => {
    if (d < fuze) {
      // The fuze: a blunt metal tip, then its collar.
      const u = d / fuze;
      return 0.018 + 0.02 * Math.sqrt(u);
    }
    if (d < b.noseLen) return Math.max(0.038, ogive(d, b.noseLen, r));
    if (d > taper0) return r * (1 - 0.56 * smooth((d - taper0) / (bodyLen - taper0)));
    return r;
  };
}

function bombBody(b: BombSpec, bodyLen: number, radius: (d: number) => number, paint: number, extraSegs: readonly (readonly [number, number, number])[] = []): THREE.BufferGeometry[] {
  const band0 = b.noseLen * 0.62;
  const segs: (readonly [number, number, number])[] = [
    [0, 0.075, PART.gunmetal],
    [0.075, band0, paint],
    [band0, band0 + 0.05, PART.bandYellow],
    [band0 + 0.05, bodyLen, paint],
    ...extraSegs,
  ];
  return body(b.len, radius, segs, 20, 0.08);
}

/** The bomb's suspension lugs and, between them, the arming-wire fitting. */
function bombLugs(b: BombSpec): THREE.BufferGeometry[] {
  const r = b.dia / 2;
  return [...lug(b.lugs / 2, r - 0.004), ...lug(-b.lugs / 2, r - 0.004), box([0, r + 0.004, 0], [0.025, 0.006, 0.012], PART.gunmetal)];
}

/** Low-drag bomb: Mk 82 / HSLD with the conical fin assembly. */
function buildConicalBomb(b: BombSpec): THREE.BufferGeometry {
  const r = b.dia / 2;
  const L = b.len;
  const bodyLen = L * 0.76;
  const bodyR = mk80Radius(b, bodyLen);
  const rJoin = bodyR(bodyLen);
  // The fin assembly's cone: on from the body's tail, narrowing to its flat end.
  const coneR = (d: number): number => rJoin - (rJoin - r * 0.3) * ((d - bodyLen) / (L - bodyLen));
  const radius = (d: number): number => (d <= bodyLen ? bodyR(d) : coneR(d));
  const X = (d: number): number => L / 2 - d;
  const parts = bombBody(b, bodyLen, radius, PART.bomb, [[bodyLen, L, PART.bomb]]);
  parts.push(lathe([[X(bodyLen) + 0.004, rJoin + 0.006], [X(bodyLen) - 0.02, rJoin + 0.006]], PART.gunmetal, 20)); // the tail's mounting band
  parts.push(cap(X(L), circle(0, 0, coneR(L)), 20, PART.bomb, [-1, 0, 0]));
  parts.push(disc([X(L) - 0.001, 0, 0], [-1, 0, 0], coneR(L) * 0.45, PART.gunmetal)); // tail fuze well
  // Four fins on the cone, their tips about level with the body.
  const finLE = X(bodyLen + 0.04);
  const root = L - bodyLen - 0.06;
  const baseR = (x: number): number => coneR(L / 2 - x);
  parts.push(...finSet(Math.PI / 4, 4, baseR, finLE, root, root * 0.72, r * 1.02 - rJoin * 0.9, root * 0.28, 0.0045, PART.bomb));
  parts.push(...bombLugs(b));
  return merge(parts);
}

/** Retarded bomb with a ballute: the HSLD-250R's cylindrical can at the tail, four small fins on it. */
function buildBalluteBomb(b: BombSpec): THREE.BufferGeometry {
  const r = b.dia / 2;
  const L = b.len;
  const bodyLen = L * 0.74;
  const bodyR = mk80Radius(b, bodyLen);
  const can = r * 0.82;
  const radius = (d: number): number => (d <= bodyLen ? bodyR(d) : d < bodyLen + 0.05 ? bodyR(bodyLen) + (can - bodyR(bodyLen)) * ((d - bodyLen) / 0.05) : can);
  const X = (d: number): number => L / 2 - d;
  const parts = bombBody(b, bodyLen, radius, PART.bomb, [[bodyLen, L, PART.bomb]]);
  // The can's rear: a lid (blown off when the ballute deploys), its seam and release bolts.
  parts.push(cap(X(L), circle(0, 0, can), 20, PART.bomb, [-1, 0, 0]));
  parts.push(lathe([[X(L) + 0.06, can + 0.003], [X(L) + 0.045, can + 0.003]], PART.gunmetal, 20));
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    parts.push(disc([X(L) - 0.001, can * 0.6 * Math.sin(a), can * 0.6 * Math.cos(a)], [-1, 0, 0], 0.012, PART.gunmetal, 8));
  }
  parts.push(...finSet(Math.PI / 4, 4, () => can, X(bodyLen + 0.12), 0.32, 0.24, r * 1.05 - can, 0.06, 0.004, PART.bomb));
  parts.push(...bombLugs(b));
  return merge(parts);
}

/**
 * Snakeye: a Mk 82 with the Mk 15 retarding tail, four large blades hinged at their trailing ends.
 * Closed they lie along the tail as a big cruciform; after release they spring open, forward edges
 * out, into an umbrella of drag (`open`).
 */
function buildSnakeye(b: BombSpec, open: boolean): THREE.BufferGeometry {
  const r = b.dia / 2;
  const L = b.len;
  const bodyLen = L * 0.7;
  const bodyR = mk80Radius(b, bodyLen);
  const rJoin = bodyR(bodyLen);
  const hub = r * 0.42;
  const radius = (d: number): number => (d <= bodyLen ? bodyR(d) : rJoin + (hub - rJoin) * smooth((d - bodyLen) / 0.1));
  const X = (d: number): number => L / 2 - d;
  const parts = bombBody(b, bodyLen, radius, PART.bomb, [[bodyLen, L - 0.02, PART.bomb]]);
  parts.push(cap(X(L - 0.02), circle(0, 0, hub), 20, PART.bomb, [-1, 0, 0]));
  // The blades: hinge at the tail, chord forward along the tail cone, span out past the body.
  const chord = 0.66;
  const span = r * 1.5 - hub;
  const hingeX = X(L - 0.04);
  const theta = open ? (68 * Math.PI) / 180 : 0;
  for (let k = 0; k < 4; k++) {
    const phi = Math.PI / 4 + (k * Math.PI) / 2;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    // u: forward from the hinge along the blade; h: outward from its root edge.
    const map = (u: number, h: number, t: number): V3 => {
      const fx = Math.cos(theta) * u - Math.sin(theta) * h;
      const out = hub + Math.sin(theta) * u + Math.cos(theta) * h;
      return [hingeX + fx, out * s + t * c, out * c - t * s];
    };
    // Tip chord shorter (the blade's outer corner is cut back at the front).
    const front = (h: number): number => chord - 0.12 * (h / span);
    const back = (): number => 0;
    parts.push(plate(0, span, front, back, () => 0.006, map, PART.bomb, 3, true));
    // The hinge fitting and the blade's stiffening rib.
    const hp = map(0.02, 0.01, 0);
    parts.push(box([hp[0], hp[1], hp[2]], [0.025, 0.012, 0.012], PART.gunmetal));
  }
  parts.push(...bombLugs(b));
  return merge(parts);
}

/**
 * Griffin LGB (a Paveway II-style kit on a 1000 lb body): the gimballed seeker under its glass, the
 * annular ring that steers it into the airflow, the control section with four canards, an adapter
 * onto the bomb body, and the airfoil group's four large wings at the tail.
 */
function buildLgb(b: BombSpec): THREE.BufferGeometry {
  const r = b.dia / 2;
  const L = b.len;
  const X = (d: number): number => L / 2 - d;
  const rs = 0.09;
  const rc = 0.13;
  const radius = (d: number): number => {
    if (d < rs) return Math.sqrt(Math.max(0, rs * rs - (rs - d) * (rs - d)));
    if (d < 0.32) return rs;
    if (d < 0.36) return rs + (rc - rs) * ((d - 0.32) / 0.04);
    if (d < 0.95) return rc;
    if (d < 1.25) return rc + (r - rc) * smooth((d - 0.95) / 0.3);
    if (d < 3.4) return r;
    if (d < 3.85) return r - (r - rc) * smooth((d - 3.4) / 0.45);
    return rc;
  };
  const parts = body(L, radius, [
    [0, rs, PART.seeker],
    [rs, 0.32, PART.gunmetal],
    [0.32, 1.38, PART.bomb],
    [1.38, 1.43, PART.bandYellow],
    [1.43, L, PART.bomb],
  ], 20, 0.08);
  parts.push(cap(X(L), circle(0, 0, rc), 20, PART.bomb, [-1, 0, 0]));
  // The seeker's ring (an annular wing) on four struts.
  const ringR = 0.16;
  const rx0 = X(0.13);
  const rx1 = X(0.29);
  parts.push(lathe([[rx0, ringR + 0.006], [rx1, ringR + 0.006]], PART.bomb, 24));
  parts.push(lathe([[rx0, ringR - 0.006], [rx1, ringR - 0.006]], PART.bomb, 24, { inward: true }));
  parts.push(lathe([[rx0, ringR - 0.006], [rx0, ringR + 0.006]], PART.bomb, 24, { dir: [1, 0, 0] }));
  parts.push(lathe([[rx1, ringR - 0.006], [rx1, ringR + 0.006]], PART.bomb, 24, { dir: [-1, 0, 0] }));
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const mid = (rs + ringR) / 2;
    parts.push(box([(rx0 + rx1) / 2, mid * Math.sin(a), mid * Math.cos(a)], [0.05, 0.004, 0.004], PART.gunmetal));
  }
  // Canards on the control section, and the tail wings.
  parts.push(...finSet(Math.PI / 4, 4, () => rc, X(0.42), 0.3, 0.2, 0.12, 0.08, 0.004, PART.bomb));
  parts.push(...finSet(Math.PI / 4, 4, () => rc, X(3.7), 0.55, 0.32, 0.27, 0.2, 0.005, PART.bomb));
  parts.push(...bombLugs(b));
  return merge(parts);
}

/** HAMMER: an IR seeker nose with canards on a 250 kg body, the range-extension kit's fins and rocket at the tail. */
function buildHammer(b: BombSpec): THREE.BufferGeometry {
  const r = b.dia / 2;
  const L = b.len;
  const X = (d: number): number => L / 2 - d;
  const rs = 0.065;
  const radius = (d: number): number => {
    if (d < rs) return Math.sqrt(Math.max(0, rs * rs - (rs - d) * (rs - d)));
    if (d < 0.8) return rs + (r - rs) * smooth((d - rs) / (0.8 - rs)) ** 0.7;
    if (d < 2.3) return r;
    if (d < 3.0) return r - (r - r * 0.72) * smooth((d - 2.3) / 0.7);
    return r * 0.72;
  };
  const parts = body(L, radius, [
    [0, rs, PART.seeker],
    [rs, rs + 0.025, PART.gunmetal],
    [rs + 0.025, 0.78, PART.podGrey],
    [0.78, 0.82, PART.gunmetal],
    [0.82, 1.0, PART.podGrey],
    [1.0, 1.05, PART.bandYellow],
    [1.05, 2.28, PART.podGrey],
    [2.28, 2.32, PART.gunmetal],
    [2.32, L, PART.podGrey],
  ], 20, 0.08);
  parts.push(...nozzle(X(L), r * 0.72, r * 0.42, PART.podGrey));
  parts.push(...finSet(Math.PI / 4, 4, (x) => radius(L / 2 - x), X(0.5), 0.2, 0.1, 0.08, 0.08, 0.004, PART.podGrey));
  parts.push(...finSet(Math.PI / 4, 4, (x) => radius(L / 2 - x), X(2.5), 0.42, 0.26, 0.16, 0.14, 0.005, PART.podGrey));
  parts.push(...bombLugs(b));
  return merge(parts);
}

/** SAAW: a slim glide body, its wings folded flat along its back, four small tail fins. */
function buildSaaw(b: BombSpec): THREE.BufferGeometry {
  const r = b.dia / 2;
  const L = b.len;
  const X = (d: number): number => L / 2 - d;
  const radius = (d: number): number => {
    // A rounded seeker tip on a blunt ogive.
    const tip = 0.04;
    if (d < tip) return Math.sqrt(Math.max(0, tip * tip - (tip - d) * (tip - d)));
    if (d < b.noseLen) return Math.max(tip, ogive(d, b.noseLen, r) * (0.75 + 0.25 * (d / b.noseLen)));
    if (d > L - 0.3) return r - r * 0.35 * smooth((d - (L - 0.3)) / 0.3);
    return r;
  };
  const parts = body(L, radius, [
    [0, 0.04, PART.seeker],
    [0.04, 0.4, PART.bomb],
    [0.4, 0.44, PART.bandYellow],
    [0.44, L, PART.bomb],
  ], 18, 0.08);
  parts.push(cap(X(L), circle(0, 0, radius(L)), 18, PART.bomb, [-1, 0, 0]));
  // Stowed wings: two flat panels stacked on the back, on their pivot.
  parts.push(box([X(0.95), r + 0.01, 0], [0.55, 0.008, 0.11], PART.bomb));
  parts.push(box([X(0.95), r + 0.026, 0], [0.53, 0.008, 0.105], PART.bomb));
  parts.push(cylinder([X(0.62), r - 0.01, 0], [X(0.62), r + 0.04, 0], 0.03, PART.gunmetal, 12));
  parts.push(...finSet(Math.PI / 4, 4, (x) => radius(L / 2 - x), X(L - 0.32), 0.25, 0.14, 0.09, 0.08, 0.004, PART.bomb));
  // (Its lugs are under the wing pack's pivot.)
  parts.push(...lug(b.lugs / 2, r + 0.03), ...lug(-b.lugs / 2, r + 0.03));
  return merge(parts);
}

function buildBomb(b: BombSpec, open = false): THREE.BufferGeometry {
  switch (b.tail) {
    case 'snakeye':
      return buildSnakeye(b, open);
    case 'ballute':
      return buildBalluteBomb(b);
    case 'lgb':
      return buildLgb(b);
    case 'hammer':
      return buildHammer(b);
    case 'saaw':
      return buildSaaw(b);
    default:
      return buildConicalBomb(b);
  }
}

/**
 * A retarded bomb's open ballute: risers fanning out from the tail to an inflated drag balloon
 * about 1.1 m across, its widest point a metre behind the tail (where the sim's ballute pulls).
 */
function buildBallute(b: BombSpec): THREE.BufferGeometry {
  const x0 = -b.len / 2;
  const R = 0.56;
  // Riser cone: tail to the balloon's front.
  const risers = loft([x0 - 0.6, x0], (x) => circle(0, 0, 0.03 + ((x0 - x) / 0.6) * 0.26), 12, PART.dark);
  // The balloon: rounded front, flattened back.
  const prof = (u: number): number => R * Math.sin(Math.PI * Math.pow(u, 0.8)) + 0.02;
  const xs = Array.from({ length: 11 }, (_, i) => x0 - 0.5 - 0.85 * (i / 10)).reverse();
  const balloon = loft(xs, (x) => circle(0, 0, prof((x0 - 0.5 - x) / 0.85)), 18, PART.bandBrown);
  return merge([risers, balloon, cap(x0 - 1.35, circle(0, 0, 0.02 + R * 0.05), 18, PART.bandBrown, [-1, 0, 0])]);
}

// ---------------------------------------------------------------------------------------------
// Pods
// ---------------------------------------------------------------------------------------------

/** Pods: B-8M1 rocket pod (20 x 80 mm, 2.75 m, 520 mm), Litening targeting pod (2.2 m, 406 mm). */
const PODS: Record<string, { len: number; dia: number }> = {
  b8m1: { len: 2.75, dia: 0.52 },
  litening: { len: 2.2, dia: 0.406 },
};

/** B-8M1 tube centres (y, z): one in the middle, six round it, thirteen in the outer ring. */
const B8_TUBES: readonly (readonly [number, number])[] = [
  [0, 0],
  ...Array.from({ length: 6 }, (_, i) => [0.095 * Math.sin((i * Math.PI) / 3 + Math.PI / 6), 0.095 * Math.cos((i * Math.PI) / 3 + Math.PI / 6)] as const),
  ...Array.from({ length: 13 }, (_, i) => [0.19 * Math.sin((i * 2 * Math.PI) / 13), 0.19 * Math.cos((i * 2 * Math.PI) / 13)] as const),
];

/**
 * B-8M1: a 20-tube pod for 80 mm S-8 rockets. A riveted cylindrical body with two strap bands and
 * its suspension lugs; at the front a rounded fairing ring round a flat face of tube mouths, each
 * with its metal rim and a rocket's nose a little way inside; at the back a short conical tail
 * fairing round the tubes' exits.
 */
function buildRocketPod(p: { len: number; dia: number }): THREE.BufferGeometry {
  const r = p.dia / 2;
  const L = p.len;
  const X = (d: number): number => L / 2 - d;
  const rFace = 0.238;
  const rTail = 0.236;
  const radius = (d: number): number => {
    if (d < 0.1) return rFace + (r - rFace) * Math.sqrt(Math.min(1, d / 0.1));
    if (d > L - 0.32) return r - (r - rTail) * smooth((d - (L - 0.32)) / 0.32);
    return r;
  };
  const parts = body(L, radius, [[0, 0.1, PART.bomb], [0.1, L, PART.bomb]], 28, 0.1);
  // Strap bands and rivet lines.
  for (const d of [0.55, 1.95]) parts.push(lathe([[X(d), r + 0.004], [X(d + 0.05), r + 0.004]], PART.gunmetal, 28));
  for (const d of [0.1, L - 0.32]) parts.push(lathe([[X(d) + 0.004, r + 0.0015], [X(d) - 0.004, r + 0.0015]], PART.gunmetal, 28));
  // Faces: front (facing +x) and rear (facing -x), each with the tube mouths.
  for (const [xf, sgn, rf] of [[X(0), 1, rFace], [X(L), -1, rTail]] as const) {
    parts.push(disc([xf, 0, 0], [sgn, 0, 0], rf, PART.gunmetal, 28));
    for (const [ty, tz] of B8_TUBES) {
      // Rim, the dark bore, and (at the front) the rocket's nose cone sitting just inside.
      parts.push(lathe([[xf + sgn * 0.003, 0.0395], [xf + sgn * 0.003, 0.0465]], PART.metal, 14, { cy: ty, cz: tz, dir: [sgn, 0, 0] }));
      parts.push(lathe([[xf, 0.0465], [xf + sgn * 0.003, 0.0465]], PART.metal, 14, { cy: ty, cz: tz }));
      parts.push(disc([xf + sgn * 0.0015, ty, tz], [sgn, 0, 0], 0.04, PART.dark, 14));
      if (sgn > 0) parts.push(lathe([[xf + 0.0015, 0.022], [xf + 0.009, 0.014], [xf + 0.016, 0.0]], PART.gunmetal, 10, { cy: ty, cz: tz }));
    }
  }
  // Suspension lugs (250 mm apart) and the electrical connector fairing between them.
  parts.push(...lug(0.125 + 0.1, r - 0.004, 0.04), ...lug(-0.125 + 0.1, r - 0.004, 0.04));
  parts.push(box([0.1, r + 0.006, 0.06], [0.04, 0.01, 0.02], PART.gunmetal));
  return merge(parts);
}

/**
 * Litening: a long grey cylinder. At the front the sensor head (it rolls to point its sensors),
 * rounded, with the large optical window in a bezel, a seam behind it; on top the pylon adapter and
 * its lugs; under the rear body the cooling air scoop; the tail tapers to a flat end with its vent.
 */
function buildTargetingPod(p: { len: number; dia: number }): THREE.BufferGeometry {
  const r = p.dia / 2;
  const L = p.len;
  const X = (d: number): number => L / 2 - d;
  const headA = 0.24;
  const radius = (d: number): number => {
    if (d < headA) {
      const u = 1 - d / headA;
      return r * 0.985 * Math.sqrt(Math.max(0, 1 - u * u));
    }
    if (d > L - 0.25) return r - r * 0.16 * smooth((d - (L - 0.25)) / 0.25);
    return d < 0.56 ? r * 0.985 : r;
  };
  const parts = body(L, radius, [
    [0, 0.555, PART.podGrey],
    [0.555, 0.565, PART.dark],
    [0.565, L, PART.podGrey],
  ], 28, 0.08);
  parts.push(cap(X(L), circle(0, 0, radius(L)), 28, PART.podGrey, [-1, 0, 0]));
  parts.push(disc([X(L) - 0.002, 0, 0], [-1, 0, 0], radius(L) * 0.3, PART.dark, 20));
  // The window: looking forward and down, in its bezel on the head's curve.
  const phi = (38 * Math.PI) / 180;
  const cx = X(headA);
  const a = headA;
  const bR = r * 0.985;
  const P: V3 = [cx + a * Math.cos(phi), -bR * Math.sin(phi), 0];
  const nrm = new THREE.Vector3(Math.cos(phi) / a, -Math.sin(phi) / bR, 0).normalize();
  const out = (k: number): V3 => [P[0] + nrm.x * k, P[1] + nrm.y * k, P[2] + nrm.z * k];
  // (A flat window on the round head: its housing stands proud at the centre, flush at the rim.)
  parts.push(cylinder(out(-0.012), out(0.017), 0.088, PART.gunmetal, 24));
  parts.push(disc(out(0.0175), [nrm.x, nrm.y, nrm.z], 0.074, PART.seeker, 24));
  // A second, smaller aperture beside it (the laser spot tracker).
  const phi2 = (12 * Math.PI) / 180;
  const P2: V3 = [cx + a * Math.cos(phi2), -bR * Math.sin(phi2) * 0.4, bR * Math.sin(phi2) * 0.9];
  const n2 = new THREE.Vector3(Math.cos(phi2) / a, -Math.sin(phi2) * 0.4 / bR, Math.sin(phi2) * 0.9 / bR).normalize();
  parts.push(cylinder([P2[0] - n2.x * 0.02, P2[1] - n2.y * 0.02, P2[2] - n2.z * 0.02], [P2[0] + n2.x * 0.008, P2[1] + n2.y * 0.008, P2[2] + n2.z * 0.008], 0.035, PART.gunmetal, 16));
  parts.push(disc([P2[0] + n2.x * 0.0085, P2[1] + n2.y * 0.0085, P2[2] + n2.z * 0.0085], [n2.x, n2.y, n2.z], 0.027, PART.seeker, 16));
  // Pylon adapter: a low saddle on top with two lugs; the cooling scoop under the rear body.
  parts.push(box([0.1, r + 0.012, 0], [0.42, 0.016, 0.07], PART.podGrey));
  parts.push(...lug(0.1 + 0.178, r + 0.02, 0.02), ...lug(0.1 - 0.178, r + 0.02, 0.02));
  parts.push(box([X(1.55), -r + 0.005, 0], [0.16, 0.03, 0.055], PART.podGrey));
  parts.push(box([X(1.55) + 0.161, -r + 0.003, 0], [0.002, 0.022, 0.045], PART.dark));
  // Panel joints: two thin bands round the body.
  for (const d of [1.0, 1.55]) parts.push(lathe([[X(d), r + 0.0012], [X(d + 0.01), r + 0.0012]], PART.dark, 28));
  return merge(parts);
}

// ---------------------------------------------------------------------------------------------
// Tanks
// ---------------------------------------------------------------------------------------------

/** Drop tanks: no published drawings; sized so the shape holds the rated volume (1200 L inboard:
 *  4.6 m x 0.68 m, the tail running past the wing's trailing edge as in photos; 725 L centreline). */
const TANKS: Record<string, { len: number; dia: number; noseLen: number; tailLen: number }> = {
  'tank-1200l': { len: 4.6, dia: 0.68, noseLen: 1.4, tailLen: 1.2 },
  'tank-725l': { len: 3.8, dia: 0.58, noseLen: 1.1, tailLen: 1.0 },
};

function buildTank(t: { len: number; dia: number; noseLen: number; tailLen: number }): THREE.BufferGeometry {
  const r = t.dia / 2;
  const L = t.len;
  // Ogive nose, parallel body, tapering tail cone to a small flat end.
  const radius = (d: number): number => {
    if (d < t.noseLen) return Math.max(0.02, ogive(d, t.noseLen, r));
    const e = d - (L - t.tailLen);
    if (e > 0) return r - (r - 0.1) * Math.pow(e / t.tailLen, 1.6);
    return r;
  };
  const xs = Array.from({ length: 41 }, (_, i) => -L / 2 + (L * i) / 40);
  const parts = [loft(xs, (x) => circle(0, 0, radius(L / 2 - x)), 28, PART.pylon), cap(-L / 2, circle(0, 0, radius(L)), 28, PART.pylon, [-1, 0, 0])];
  // Seams where the nose and tail sections join the centre section.
  for (const d of [t.noseLen, L - t.tailLen]) parts.push(lathe([[L / 2 - d + 0.006, radius(d) + 0.0015], [L / 2 - d - 0.006, radius(d) + 0.0015]], PART.gunmetal, 28));
  // Filler cap on top, the vent mast at the tail.
  parts.push(cylinder([0.75, r - 0.01, 0], [0.75, r + 0.006, 0], 0.04, PART.gunmetal, 16));
  parts.push(box([-L / 2 + 0.15, -0.1 + 0.03, 0], [0.06, 0.03, 0.006], PART.gunmetal));
  // The pylon's sway braces: a pair of posts either side of the lugs, fore and aft, bearing on the
  // tank's shoulders up to the pylon's base (the 3 cm gap of the mount).
  for (const sx of [-0.42, 0.42]) {
    for (const sz of [-1, 1]) parts.push(box([sx, r + 0.01, sz * 0.07], [0.022, 0.025, 0.012], PART.metal));
  }
  return merge(parts);
}

// ---------------------------------------------------------------------------------------------
// Launchers
// ---------------------------------------------------------------------------------------------

/** Launcher depth below its attach point (the pylon's base), m; missiles hang on short hangers
 *  just below it. As in photos of the Tejas's R-73 / ASRAAM / Derby stations: a slab-sided beam
 *  about two-thirds of the missile's length, as deep as the missile is thick. */
const RAIL_DEPTH = 0.13;
/** Gap between the launcher's underside and the missile's body (its launch shoes fill it). */
const HANGER = 0.014;
/** Twin launcher: a wide adapter beam under the pylon with a rail canted out from each lower edge.
 *  The rails are shallower than a single launcher; each rail's frame origin sits where a full-depth
 *  rail's top would be, so the missile mounts are shared. Missile centres end up ~0.2 m either side. */
const TWIN_ADAPTER_DEPTH = 0.1;
const TWIN_ADAPTER_HALF_W = 0.1;
const TWIN_RAIL_DEPTH = 0.1;
const TWIN_CANT = (35 * Math.PI) / 180;
/** The rail's top centre, tucked into the adapter's lower edge. */
const TWIN_ROOT_Y = -0.085;
const TWIN_ROOT_Z = 0.09;
const TWIN_RAIL_Y = TWIN_ROOT_Y + (RAIL_DEPTH - TWIN_RAIL_DEPTH) * Math.cos(TWIN_CANT);
const TWIN_RAIL_Z = TWIN_ROOT_Z - (RAIL_DEPTH - TWIN_RAIL_DEPTH) * Math.sin(TWIN_CANT);

/**
 * A launcher hanging from its attach point (the origin, at its top), as on the Tejas's wing stations:
 * a grey beam with flat flanks and rounded lower edges, a blunt rounded nose and a short taper
 * behind. Along its underside the launch track (a web and two lips the missile's shoes slide in),
 * the umbilical connector between the shoes, the forward detent and the aft snubber; access panels
 * on the flanks; the nose cap and the coolant / electronics bulge of an IR missile launcher.
 */
function buildRail(len = 2.3, depth = RAIL_DEPTH, halfW = 0.058, details = true): THREE.BufferGeometry {
  const x1 = 0.25 + len * 0.5;
  const x0 = x1 - len;
  const noseL = 0.16;
  const tailL = len * 0.1;
  const k = (x: number): number => {
    if (x > x1 - noseL) {
      const u = Math.min(0.97, (x - (x1 - noseL)) / noseL);
      return Math.max(0.25, Math.sqrt(1 - u * u));
    }
    if (x < x0 + tailL) return 0.5 + 0.5 * ((x - x0) / tailL);
    return 1;
  };
  const sec = (x: number): Section => {
    const d = depth * (0.35 + 0.65 * k(x));
    return { cy: -d / 2, cz: 0, w: halfW * k(x), hT: d / 2, hB: d / 2, n: 3.5 };
  };
  const xs = [...range(x0, x1 - noseL, 0.1), ...range(x1 - noseL + 0.016, x1, 0.016)];
  const parts = [loft(xs, sec, 24, PART.pylon), cap(x0, sec(x0), 24, PART.pylon, [-1, 0, 0]), cap(x1, sec(x1), 24, PART.pylon, [1, 0, 0])];
  const trackX0 = x0 + tailL + 0.03;
  const trackX1 = x1 - noseL - 0.02;
  const tc = (trackX0 + trackX1) / 2;
  const th = (trackX1 - trackX0) / 2;
  const yB = -depth;
  // The launch track: a web down from the beam and two lips; the shoes' flanges ride above the lips.
  parts.push(box([tc, yB - 0.0035, 0], [th, 0.0035, 0.007], PART.gunmetal));
  for (const sz of [-1, 1]) parts.push(box([tc, yB - 0.0085, sz * 0.0145], [th, 0.0015, 0.0055], PART.gunmetal));
  if (!details) return merge(parts);
  // Umbilical connector between the shoes, the detent just aft of the front shoe, the aft snubber.
  parts.push(box([0.2, yB - 0.006, 0.026], [0.045, 0.006, 0.012], PART.gunmetal));
  parts.push(box([0.55, yB - 0.004, 0], [0.02, 0.004, 0.022], PART.metal));
  parts.push(box([trackX0 + 0.04, yB - 0.006, 0], [0.03, 0.006, 0.022], PART.gunmetal));
  // Access panels on both flanks, and fasteners along the beam's top edge.
  for (const sz of [-1, 1]) {
    for (const [px, pw] of [[0.85, 0.16], [0.2, 0.22], [-0.45, 0.14]] as const) {
      if (px - pw < x0 + tailL || px + pw > x1 - noseL) continue;
      parts.push(box([px, -depth * 0.52, sz * (halfW + 0.0006)], [pw, depth * 0.28, 0.0008], PART.podGrey));
    }
    for (let x = x0 + tailL + 0.05; x < x1 - noseL - 0.02; x += 0.12) parts.push(box([x, -depth * 0.1, sz * (halfW + 0.0004)], [0.003, 0.003, 0.0005], PART.podGrey));
  }
  // Nose cap (dark, the umbilical's cover) and, behind it, the electronics bulge under the beam.
  parts.push(disc([x1 + 0.0005, -depth * 0.55, 0], [1, 0, 0], depth * 0.18, PART.gunmetal, 16));
  parts.push(box([x1 - noseL - 0.15, yB + 0.002, 0], [0.12, 0.012, halfW * 0.75], PART.pylon));
  return merge(parts);
}

/** The two rails' frames on a twin launcher: [left (-z), right (+z)], each canted outwards. */
export const TWIN_RAIL_FRAMES: readonly [THREE.Matrix4, THREE.Matrix4] = [-1, 1].map((side) =>
  new THREE.Matrix4().makeTranslation(0, TWIN_RAIL_Y, side * TWIN_RAIL_Z).multiply(new THREE.Matrix4().makeRotationX(-side * TWIN_CANT))
) as [THREE.Matrix4, THREE.Matrix4];

/** Twin launcher: the adapter beam and its two canted rails. */
function buildTwinRail(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [buildRail(2.0, TWIN_ADAPTER_DEPTH, TWIN_ADAPTER_HALF_W, false)];
  // The adapter's side plates and the bolts that hold the rails on.
  for (const sz of [-1, 1]) {
    parts.push(box([0.3, -TWIN_ADAPTER_DEPTH * 0.5, sz * (TWIN_ADAPTER_HALF_W + 0.0006)], [0.6, TWIN_ADAPTER_DEPTH * 0.3, 0.0008], PART.podGrey));
  }
  for (const f of TWIN_RAIL_FRAMES) {
    const rail = buildRail(2.1, TWIN_RAIL_DEPTH, 0.045).translate(0, TWIN_RAIL_DEPTH - RAIL_DEPTH, 0);
    rail.applyMatrix4(f);
    parts.push(rail);
  }
  return merge(parts);
}

export interface StoreModels {
  /** By store code (contracts/core.ts STORE_IDS); undefined = nothing to draw. */
  byCode: readonly (StoreModel | undefined)[];
  rail: THREE.BufferGeometry;
  twinRail: THREE.BufferGeometry;
}

export function buildStoreModels(): StoreModels {
  const byCode = STORE_IDS.map((id): StoreModel | undefined => {
    const m = MISSILES[id];
    if (m) return { kind: 'missile', geometry: buildMissile(m), mount: new THREE.Matrix4().makeTranslation(0.25, -(RAIL_DEPTH + HANGER + m.dia / 2), 0) };
    const t = TANKS[id];
    if (t) return { kind: 'tank', geometry: buildTank(t), mount: new THREE.Matrix4().makeTranslation(0, -(0.03 + t.dia / 2), 0) };
    const b = BOMBS[id];
    if (b) {
      const model: StoreModel = { kind: 'bomb', geometry: buildBomb(b), mount: new THREE.Matrix4().makeTranslation(0, -(0.05 + b.dia / 2), 0) };
      if (b.tail === 'snakeye') model.bodyOpen = buildBomb(b, true);
      else if (b.retarded) model.ballute = buildBallute(b);
      return model;
    }
    const p = PODS[id];
    if (p) return { kind: 'pod', geometry: id === 'litening' ? buildTargetingPod(p) : buildRocketPod(p), mount: new THREE.Matrix4().makeTranslation(0.1, -(0.04 + p.dia / 2), 0) };
    return undefined;
  });
  return { byCode, rail: buildRail(), twinRail: buildTwinRail() };
}

/** Length and diameter of a store by id (for tests). */
export function storeDimensions(id: string): { len: number; dia: number } | undefined {
  const s = MISSILES[id] ?? TANKS[id] ?? BOMBS[id] ?? PODS[id];
  return s ? { len: s.len, dia: s.dia } : undefined;
}
