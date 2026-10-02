/**
 * src/render/aircraftModels/stores.ts — procedural models of the stores the Tejas carries, to
 * public dimensions: ASRAAM (2.90 m, 166 mm, no mid-body wings, small tail fins), R-73 (2.93 m,
 * 170 mm, nose canards, tail wings), Derby (3.62 m, 160 mm, canards, tail fins), Astra Mk1 (3.57 m,
 * 178 mm, long mid-body strakes, tail fins), Python-5, I-Derby ER, and the hostile PL-5E II,
 * AIM-9M, SD-10A, AIM-120C-5 and PL-15E; the 1200 L wing tank and the 725 L centreline tank; plus
 * single and twin-rail launchers.
 *
 * Each store's geometry is centred on its own axis (x forward), so a missile in flight is drawn
 * about its entity position; `mount` hangs it from a rail or pylon whose attach point is the origin
 * (missiles slightly forward of the pylon, below the rail; tanks straight under the pylon).
 * Missiles: light grey with a yellow (warhead) and a brown (motor) band, IR seekers behind a dark
 * glass dome, radar seekers behind a grey radome.
 */
import * as THREE from 'three';
import { STORE_IDS } from '../../contracts/core';
import { PART, box, cap, circle, loft, merge, plate, range, type V3 } from './meshBuild';

export interface StoreModel {
  kind: 'missile' | 'tank' | 'bomb' | 'pod';
  geometry: THREE.BufferGeometry;
  /** Store frame -> attach frame (origin at the rail top / pylon attach point). */
  mount: THREE.Matrix4;
}

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
}

const MISSILES: Record<string, MissileSpec> = {
  asraam: { len: 2.9, dia: 0.166, seeker: 'ir', noseLen: 0, fins: [{ at: 2.52, rootChord: 0.34, tipChord: 0.2, span: 0.12, sweep: 0.1 }], bands: [0.55, 1.2] },
  'r-73': {
    len: 2.93,
    dia: 0.17,
    seeker: 'ir',
    noseLen: 0,
    fins: [
      { at: 0.2, rootChord: 0.16, tipChord: 0.03, span: 0.1, sweep: 0.11 },
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
  },
  'hq-9-msl': {
    len: 6.8,
    dia: 0.7,
    seeker: 'radar',
    noseLen: 1.3,
    fins: [{ at: 5.8, rootChord: 0.9, tipChord: 0.45, span: 0.45, sweep: 0.35 }],
    bands: [1.8, 3.0],
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

/** Free-fall bombs: body length/diameter, ogive nose length, and the tail (low-drag fins, or a retarded bomb's boxy ballute housing). */
interface BombSpec {
  len: number;
  dia: number;
  noseLen: number;
  retarded: boolean;
}
const BOMBS: Record<string, BombSpec> = {
  'hsld-450': { len: 3.3, dia: 0.4, noseLen: 0.9, retarded: false },
  'hsld-250': { len: 2.7, dia: 0.32, noseLen: 0.75, retarded: false },
  'hsld-250r': { len: 2.8, dia: 0.32, noseLen: 0.75, retarded: true },
  // Guided bombs: the Griffin kit on a 1000 lb body (long, with its seeker nose and canards read as
  // the ogive), the HAMMER's 250 kg body with its rocket tail.
  'griffin-lgb': { len: 4.3, dia: 0.36, noseLen: 1.1, retarded: false },
  'hammer-250': { len: 3.1, dia: 0.32, noseLen: 0.8, retarded: false },
  saaw: { len: 1.9, dia: 0.26, noseLen: 0.45, retarded: false },
  'mk-82': { len: 2.21, dia: 0.273, noseLen: 0.7, retarded: false },
  'mk-82-se': { len: 2.21, dia: 0.273, noseLen: 0.7, retarded: true },
};
/** Rocket pods: B-8M1 (20 x 80 mm), 2.75 m, 520 mm. */
const PODS: Record<string, { len: number; dia: number }> = {
  b8m1: { len: 2.75, dia: 0.52 },
  litening: { len: 2.2, dia: 0.406 },
};
/** Twin bomb carrier: the two bombs' centres either side of the pylon. */
export const BOMB_RACK_Z = 0.23;

const TANKS: Record<string, { len: number; dia: number; noseLen: number; tailLen: number }> = {
  'tank-1200l': { len: 4.0, dia: 0.72, noseLen: 1.3, tailLen: 1.1 },
  'tank-725l': { len: 3.8, dia: 0.52, noseLen: 1.1, tailLen: 1.0 },
};

/** Rail depth below its attach point, m; missiles hang just below it. */
const RAIL_DEPTH = 0.07;
/** Twin-rail launcher: rails either side of the pylon, canted outwards. */
const TWIN_RAIL_Z = 0.24;
const TWIN_RAIL_Y = -0.12;
const TWIN_CANT = (30 * Math.PI) / 180;

/** Tangent-ogive radius at distance d back from the point of an ogive of length l and base radius r. */
function ogive(d: number, l: number, r: number): number {
  const rho = (r * r + l * l) / (2 * r);
  const x = l - Math.min(d, l);
  return Math.max(0, Math.sqrt(rho * rho - x * x) + r - rho);
}

function buildMissile(m: MissileSpec): THREE.BufferGeometry {
  const r = m.dia / 2;
  const L = m.len;
  const X = (d: number): number => L / 2 - d;
  // Radius at distance d aft of the nose tip; slight boat-tail over the last 8 cm.
  const radius = (d: number): number => {
    let rr = r;
    if (m.seeker === 'ir' && d < r) rr = Math.sqrt(Math.max(0, r * r - (r - d) * (r - d)));
    else if (m.seeker === 'radar' && d < m.noseLen) rr = Math.max(0.012, ogive(d, m.noseLen, r));
    if (d > L - 0.08) rr *= 1 - 0.15 * ((d - (L - 0.08)) / 0.08);
    return rr;
  };
  const noseEnd = m.seeker === 'ir' ? r : m.noseLen;
  const segs: [number, number, number][] = [
    [0, noseEnd, m.seeker === 'ir' ? PART.seeker : PART.missileRadome],
    [noseEnd, m.bands[0], PART.missile],
    [m.bands[0], m.bands[0] + 0.05, PART.bandYellow],
    [m.bands[0] + 0.05, m.bands[1], PART.missile],
    [m.bands[1], m.bands[1] + 0.05, PART.bandBrown],
    [m.bands[1] + 0.05, L, PART.missile],
  ];
  const parts: THREE.BufferGeometry[] = segs.map(([d0, d1, part]) => {
    const ds = d0 === 0 ? Array.from({ length: 9 }, (_, i) => d1 * Math.pow(i / 8, 1.6)) : range(d0, d1, 0.1);
    const xs = ds.map(X).reverse();
    return loft(xs, (x) => circle(0, 0, radius(L / 2 - x)), 16, part);
  });
  parts.push(cap(X(L), circle(0, 0, radius(L)), 16, PART.dark, [-1, 0, 0]));
  for (const f of m.fins) {
    for (let k = 0; k < 4; k++) {
      // Cruciform in an X, clear of the rail above.
      const phi = Math.PI / 4 + (k * Math.PI) / 2;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const map = (x: number, h: number, t: number): V3 => [x, (r + h) * s + t * c, (r + h) * c - t * s];
      const front = (h: number): number => X(f.at) - f.sweep * (h / f.span);
      const back = (h: number): number => front(h) - (f.rootChord + (f.tipChord - f.rootChord) * (h / f.span));
      parts.push(plate(-0.01, f.span, front, back, () => 0.005, map, PART.missile, 2, true));
    }
  }
  return merge(parts);
}

/** Olive-drab bomb: ogive nose, parallel body with a yellow nose band, boat tail and cruciform fins (or a box tail). */
function buildBomb(b: BombSpec): THREE.BufferGeometry {
  const r = b.dia / 2;
  const L = b.len;
  const tail = 0.55 * L;
  const radius = (d: number): number => {
    if (d < b.noseLen) return Math.max(0.015, ogive(d, b.noseLen, r));
    if (d > tail) return r - (r * 0.45) * Math.pow((d - tail) / (L - tail), 1.3);
    return r;
  };
  const X = (d: number): number => L / 2 - d;
  const segs: [number, number, number][] = [
    [0, b.noseLen * 0.6, PART.bomb],
    [b.noseLen * 0.6, b.noseLen * 0.6 + 0.06, PART.bandYellow],
    [b.noseLen * 0.6 + 0.06, L, PART.bomb],
  ];
  const parts: THREE.BufferGeometry[] = segs.map(([d0, d1, part]) => {
    const ds = d0 === 0 ? Array.from({ length: 9 }, (_, i) => d1 * Math.pow(i / 8, 1.6)) : range(d0, d1, 0.1);
    return loft(ds.map(X).reverse(), (x) => circle(0, 0, radius(L / 2 - x)), 16, part);
  });
  parts.push(cap(X(L), circle(0, 0, radius(L)), 16, PART.dark, [-1, 0, 0]));
  if (b.retarded) {
    // The ballute housing: a square box round the tail.
    parts.push(box([X(L - 0.25), 0, 0], [0.25, r * 1.05, r * 1.05], PART.bomb));
  } else {
    for (let k = 0; k < 4; k++) {
      const phi = Math.PI / 4 + (k * Math.PI) / 2;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const map = (x: number, h: number, t: number): V3 => [x, (r * 0.6 + h) * s + t * c, (r * 0.6 + h) * c - t * s];
      const span = r * 0.9;
      const front = (h: number): number => X(L - 0.55) - 0.25 * (h / span);
      const back = (h: number): number => front(h) - (0.5 - 0.2 * (h / span));
      parts.push(plate(-0.01, span, front, back, () => 0.006, map, PART.bomb, 2, true));
    }
  }
  return merge(parts);
}

/** Rocket pod: a cylinder with a rounded nose, the tube mouths a dark disc at the front. */
function buildPod(p: { len: number; dia: number }): THREE.BufferGeometry {
  const r = p.dia / 2;
  const L = p.len;
  const radius = (d: number): number => (d < 0.2 ? r * (0.82 + 0.18 * Math.sqrt(d / 0.2)) : d > L - 0.15 ? r * (1 - 0.3 * ((d - (L - 0.15)) / 0.15)) : r);
  const xs = Array.from({ length: 21 }, (_, i) => -L / 2 + (L * i) / 20);
  return merge([
    loft(xs, (x) => circle(0, 0, radius(L / 2 - x)), 20, PART.pylon),
    cap(L / 2, circle(0, 0, r * 0.82), 20, PART.dark, [1, 0, 0]),
    cap(-L / 2, circle(0, 0, r * 0.7), 20, PART.dark, [-1, 0, 0]),
  ]);
}

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
  return merge([loft(xs, (x) => circle(0, 0, radius(L / 2 - x)), 24, PART.pylon), cap(-L / 2, circle(0, 0, radius(L)), 24, PART.pylon, [-1, 0, 0])]);
}

/** A launch rail hanging from its attach point (the origin), 1.8 m long. */
function buildRail(): THREE.BufferGeometry {
  return merge([box([0.15, -RAIL_DEPTH / 2, 0], [0.9, RAIL_DEPTH / 2, 0.04], PART.pylon), box([0.15, -RAIL_DEPTH + 0.008, 0], [0.88, 0.008, 0.055], PART.metal)]);
}

/** The two rails' frames on a twin launcher: [left (-z), right (+z)], each canted outwards. */
export const TWIN_RAIL_FRAMES: readonly [THREE.Matrix4, THREE.Matrix4] = [-1, 1].map((side) =>
  new THREE.Matrix4().makeTranslation(0, TWIN_RAIL_Y, side * TWIN_RAIL_Z).multiply(new THREE.Matrix4().makeRotationX(-side * TWIN_CANT))
) as [THREE.Matrix4, THREE.Matrix4];

/** Twin-rail launcher: an adapter under the pylon with a canted rail either side. */
function buildTwinRail(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [box([0.1, -0.05, 0], [0.7, 0.05, 0.07], PART.pylon)];
  for (const [k, side] of [
    [0, -1],
    [1, 1],
  ] as const) {
    parts.push(box([0.1, -0.085, side * TWIN_RAIL_Z * 0.5], [0.5, 0.025, TWIN_RAIL_Z * 0.5], PART.pylon));
    const rail = buildRail();
    rail.applyMatrix4(TWIN_RAIL_FRAMES[k]!);
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
    if (m) return { kind: 'missile', geometry: buildMissile(m), mount: new THREE.Matrix4().makeTranslation(0.25, -(RAIL_DEPTH + 0.005 + m.dia / 2), 0) };
    const t = TANKS[id];
    if (t) return { kind: 'tank', geometry: buildTank(t), mount: new THREE.Matrix4().makeTranslation(0, -(0.03 + t.dia / 2), 0) };
    const b = BOMBS[id];
    if (b) return { kind: 'bomb', geometry: buildBomb(b), mount: new THREE.Matrix4().makeTranslation(0, -(0.05 + b.dia / 2), 0) };
    const p = PODS[id];
    if (p) return { kind: 'pod', geometry: buildPod(p), mount: new THREE.Matrix4().makeTranslation(0.1, -(0.04 + p.dia / 2), 0) };
    return undefined;
  });
  return { byCode, rail: buildRail(), twinRail: buildTwinRail() };
}

/** Length and diameter of a store by id (for tests). */
export function storeDimensions(id: string): { len: number; dia: number } | undefined {
  const s = MISSILES[id] ?? TANKS[id] ?? BOMBS[id] ?? PODS[id];
  return s ? { len: s.len, dia: s.dia } : undefined;
}
