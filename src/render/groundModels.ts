/**
 * src/render/groundModels.ts — procedural models of the ground units (catalog/groundUnits.ts
 * GroundUnitType.model), built to their public dimensions from boxes and cylinders: 6x6 trucks
 * (cargo, fuel), a light vehicle, a generator trailer, a command van, a tracked APC, a main battle
 * tank, three SAM launchers (medium-range TEL with vertical canisters, long-range TEL with four
 * big canisters, short-range launcher with a box of four), three radars (search, engagement,
 * early-warning array), a towed twin 35 mm gun, a MANPADS team, a bunker and a target building.
 *
 * Frame: +x forward, +y up, +z right, origin on the ground at the vehicle's centre. Each vertex
 * carries aPart (GROUND_PART) and aPivot: antenna parts turn about their pivot (their mast) in the
 * shader while the radar transmits.
 */
import * as THREE from 'three';
import { box, cylinder, merge, type V3 } from './aircraftModels/meshBuild';

/** Surface codes of the ground-unit shader (groundUnits.ts). */
export const GROUND_PART = {
  body: 0,
  dark: 1,
  metal: 2,
  antenna: 3,
  canvas: 4,
  concrete: 5,
  canister: 6,
  glass: 7,
} as const;

const P = GROUND_PART;

/** Adds aPivot (all zero) to a piece; antennas get their pivot via `turning`. */
function piece(g: THREE.BufferGeometry, pivot: V3 = [0, 0, 0]): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = pivot[0];
    a[i * 3 + 1] = pivot[1];
    a[i * 3 + 2] = pivot[2];
  }
  g.setAttribute('aPivot', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('aNoz');
  return g;
}

const B = (c: V3, h: V3, part: number): THREE.BufferGeometry => piece(box(c, h, part));
const C = (a: V3, b: V3, r: number, part: number, n = 10): THREE.BufferGeometry => piece(cylinder(a, b, r, part, n));
/** A box that turns about `pivot` (antenna). */
const T = (c: V3, h: V3, pivot: V3): THREE.BufferGeometry => piece(box(c, h, P.antenna), pivot);

function wheels(xs: readonly number[], halfTrack: number, r: number, w = 0.3): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const x of xs) for (const s of [-1, 1]) out.push(C([x, r, s * halfTrack - w / 2], [x, r, s * halfTrack + w / 2], r, P.dark, 10));
  return out;
}

/** A 6x6 truck chassis with cab; `bed` builds what it carries. */
function truck(bed: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return merge([
    ...wheels([2.3, -1.2, -2.6], 1.05, 0.55),
    B([0, 1.05, 0], [3.7, 0.2, 1.1], P.dark), // chassis
    B([2.55, 1.9, 0], [0.85, 0.75, 1.2], P.body), // cab
    B([3.35, 2.1, 0], [0.06, 0.35, 1.0], P.glass), // windscreen
    ...bed,
  ]);
}

function tracked(len: number, halfW: number, hullH: number): THREE.BufferGeometry[] {
  return [
    B([0, 0.45, halfW - 0.3], [len / 2, 0.45, 0.3], P.dark),
    B([0, 0.45, -(halfW - 0.3)], [len / 2, 0.45, 0.3], P.dark),
    B([0, 0.55 + hullH / 2, 0], [len / 2 - 0.1, hullH / 2, halfW - 0.05], P.body),
  ];
}

const BUILDERS: Record<string, () => THREE.BufferGeometry> = {
  truck: () => truck([B([-1.0, 2.1, 0], [2.4, 0.9, 1.2], P.canvas), B([-1.0, 1.28, 0], [2.4, 0.08, 1.22], P.body)]),
  'fuel-truck': () => truck([C([1.3, 2.0, 0], [-3.4, 2.0, 0], 0.95, P.body, 14), B([-1.0, 1.2, 0], [2.4, 0.08, 1.0], P.dark)]),
  jeep: () =>
    merge([
      ...wheels([1.3, -1.3], 0.8, 0.4, 0.25),
      B([0, 0.95, 0], [2.0, 0.4, 0.85], P.body),
      B([-0.4, 1.6, 0], [1.1, 0.3, 0.8], P.canvas),
      B([0.75, 1.55, 0], [0.05, 0.25, 0.75], P.glass),
    ]),
  generator: () => merge([...wheels([-0.3], 0.85, 0.4, 0.2), B([0, 1.0, 0], [1.9, 0.55, 0.9], P.body), B([0, 1.62, 0], [1.5, 0.07, 0.8], P.metal), C([1.9, 0.7, 0], [2.6, 0.7, 0], 0.05, P.metal, 6)]),
  van: () =>
    merge([
      ...wheels([2.3, -1.2, -2.4], 1.0, 0.5),
      B([0, 0.95, 0], [3.5, 0.15, 1.05], P.dark),
      B([2.5, 1.8, 0], [0.8, 0.7, 1.15], P.body),
      B([-0.9, 2.0, 0], [2.5, 0.95, 1.2], P.body),
      C([-2.8, 2.95, 0.6], [-2.8, 5.5, 0.6], 0.04, P.metal, 5), // whip antenna mast
      B([3.3, 2.0, 0], [0.06, 0.32, 0.95], P.glass),
    ]),
  apc: () => merge([...tracked(6.8, 1.5, 1.4), B([0.6, 2.2, 0.2], [0.55, 0.25, 0.5], P.body), C([0.9, 2.3, 0.2], [2.4, 2.3, 0.2], 0.05, P.metal, 6)]),
  tank: () =>
    merge([
      ...tracked(7.0, 1.7, 1.0),
      B([-0.3, 1.95, 0], [1.6, 0.4, 1.25], P.body), // turret
      C([1.2, 1.95, 0], [6.0, 1.97, 0], 0.08, P.metal, 8), // 125 mm gun
      B([-1.2, 2.45, 0.5], [0.3, 0.1, 0.3], P.dark),
    ]),
  // Medium-range TEL: 6x6 with six vertical canisters (LY-80 carries them erect to fire).
  'tel-mr': () =>
    truck([
      B([-1.2, 1.3, 0], [2.6, 0.12, 1.2], P.dark),
      ...[0, 1, 2].flatMap((i) => [-0.45, 0.45].map((z) => C([-2.6 + i * 0.95, 1.4, z], [-2.6 + i * 0.95, 4.9, z], 0.34, P.canister, 10))),
    ]),
  // Long-range TEL: four large canisters on an elevated rack, raised ~45 deg aft-to-fore.
  'tel-lr': () =>
    merge([
      ...wheels([3.8, 2.3, -1.0, -2.5], 1.15, 0.6),
      B([0, 1.15, 0], [6.0, 0.22, 1.2], P.dark),
      B([4.7, 2.0, 0], [1.1, 0.85, 1.3], P.body),
      B([5.8, 2.2, 0], [0.06, 0.4, 1.1], P.glass),
      ...[[-0.45, -0.45], [-0.45, 0.45], [0.45, -0.45], [0.45, 0.45]].map(([dy, dz]) => C([-4.8, 2.0 + dy!, dz!], [0.6, 6.8 + dy!, dz!], 0.36, P.canister, 10)),
    ]),
  // Short-range launcher: tracked/wheeled base, a turret with a box of four missiles and a small radar.
  'tel-sr': () =>
    merge([
      ...wheels([2.3, 0.2, -2.1], 1.1, 0.55),
      B([0, 1.3, 0], [4.0, 0.5, 1.35], P.body),
      B([-0.8, 2.3, 0], [0.8, 0.5, 0.8], P.body),
      ...[-1, 1].flatMap((s) => [-0.25, 0.25].map((dy) => C([-2.2, 2.6 + dy, s * 1.1], [0.8, 2.9 + dy, s * 1.1], 0.14, P.canister, 8))),
      T([0, 0, 0], [0.12, 0.45, 0.6], [-0.8, 3.3, 0]).translate(-0.8, 3.3, 0),
    ]),
  // Search radar: truck with a big rotating array on a mast.
  'radar-search': () =>
    truck([
      B([-1.1, 1.8, 0], [2.3, 0.65, 1.2], P.body),
      C([-1.6, 2.45, 0], [-1.6, 4.4, 0], 0.18, P.metal, 8),
      T([0, 0, 0], [0.25, 1.1, 2.9], [-1.6, 5.4, 0]).translate(-1.6, 5.4, 0),
    ]),
  // Engagement (fire-control) radar: a smaller rotating dish-like face on a turret.
  'radar-track': () =>
    truck([
      B([-1.1, 1.8, 0], [2.3, 0.65, 1.2], P.body),
      B([-1.4, 2.7, 0], [0.6, 0.25, 0.6], P.metal),
      T([0, 0, 0], [0.2, 0.9, 1.1], [-1.4, 3.8, 0]).translate(-1.4, 3.8, 0),
    ]),
  // Early-warning radar: a tall lattice array on a trailer, turning slowly.
  'radar-ew': () =>
    merge([
      ...wheels([2.8, 1.6, -2.8], 1.4, 0.55),
      B([0, 1.2, 0], [5.0, 0.3, 1.6], P.dark),
      B([-2.8, 2.2, 0], [1.4, 0.8, 1.4], P.body),
      C([0.5, 1.5, 0], [0.5, 4.0, 0], 0.3, P.metal, 8),
      T([0, 0, 0], [0.3, 3.0, 4.5], [0.5, 7.0, 0]).translate(0.5, 7.0, 0),
    ]),
  // Towed twin 35 mm gun (GDF): a low carriage with outriggers and two long barrels raised.
  'aaa-twin': () =>
    merge([
      B([0, 0.55, 0], [1.8, 0.25, 0.9], P.body),
      B([0, 0.35, 0], [3.6, 0.08, 0.15], P.dark),
      B([0, 0.35, 0], [0.15, 0.08, 2.2], P.dark),
      B([0.2, 1.3, 0], [0.9, 0.5, 0.8], P.body),
      C([0.6, 1.55, -0.45], [3.6, 3.2, -0.45], 0.06, P.metal, 6),
      C([0.6, 1.55, 0.45], [3.6, 3.2, 0.45], 0.06, P.metal, 6),
    ]),
  // Two soldiers and a launcher tube.
  manpads: () =>
    merge([
      B([0, 0.85, -0.35], [0.2, 0.85, 0.22], P.canvas),
      B([0.4, 0.5, 0.45], [0.25, 0.5, 0.22], P.canvas),
      C([-0.4, 1.5, -0.35], [0.9, 1.7, -0.35], 0.045, P.dark, 6),
    ]),
  bunker: () => merge([B([0, 1.2, 0], [4.0, 1.2, 4.0], P.concrete), B([4.02, 1.0, 0], [0.05, 0.35, 1.5], P.dark), B([0, 2.55, 0], [3.2, 0.15, 3.2], P.concrete)]),
  building: () => merge([B([0, 3.0, 0], [6.0, 3.0, 5.0], P.concrete), B([0, 6.1, 0], [6.1, 0.1, 5.1], P.metal), B([6.02, 1.3, 1.5], [0.05, 1.3, 1.0], P.dark)]),
};

export interface GroundModels {
  byModel: ReadonlyMap<string, THREE.BufferGeometry>;
}

/** Builds every ground model once. */
export function buildGroundModels(): GroundModels {
  const byModel = new Map<string, THREE.BufferGeometry>();
  for (const [id, build] of Object.entries(BUILDERS)) byModel.set(id, build());
  return { byModel };
}
