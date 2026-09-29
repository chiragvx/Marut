/**
 * src/render/aircraftModels/meshBuild.ts — geometry helpers for the procedural models (airframe,
 * stores): lofts through superellipse sections, lifting-surface plates with an airfoil thickness,
 * cylinders, boxes, merging and mirroring. Every geometry carries the aPart/aNoz attributes the
 * aircraft shader reads (aircraftMaterial.ts).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type V3 = [number, number, number];

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
  missile: 14,
  seeker: 15,
  bandYellow: 16,
  bandBrown: 17,
  missileRadome: 18,
  lightFormation: 19,
  lightStrobe: 20,
  lightLanding: 21,
  /** Radome (light grey dielectric), canopy/windscreen frame, antennas, gear doors. */
  radome: 22,
  frame: 23,
  antenna: 24,
  door: 25,
} as const;

/** Monotone cubic through (xs ascending, ys). */
export function spline(xs: readonly number[], ys: readonly number[]): (x: number) => number {
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
export function table(rows: readonly (readonly number[])[]): ((x: number) => number)[] {
  const xs = rows.map((r) => r[0]!);
  const out: ((x: number) => number)[] = [];
  for (let c = 1; c < rows[0]!.length; c++) out.push(spline(xs, rows.map((r) => r[c]!)));
  return out;
}

export interface Section {
  cy: number;
  cz: number;
  w: number;
  hT: number;
  hB: number;
  n: number;
}

export const sp = (v: number, e: number): number => Math.sign(v) * Math.pow(Math.abs(v), e);

/** Superellipse ring point at angle t (0 = +z side, pi/2 = top). */
export function ringPoint(s: Section, t: number): [number, number] {
  const c = Math.cos(t);
  const sn = Math.sin(t);
  const e = 2 / s.n;
  return [s.cy + (sn >= 0 ? s.hT : s.hB) * sp(sn, e), s.cz + s.w * sp(c, e)];
}

export interface Raw {
  pos: number[];
  idx: number[];
  noz?: number[];
}

/** (nu x nv) quad grid; u wraps around when `wrapU`. */
export function grid(nu: number, nv: number, f: (i: number, j: number) => V3, wrapU = false): Raw {
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
export function geom(raw: Raw, part: number, hint: (p: V3) => V3): THREE.BufferGeometry {
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
export function loft(xs: readonly number[], sec: (x: number) => Section, n: number, part: number, opts: { arc?: [number, number]; inward?: boolean; noz?: (x: number) => number } = {}): THREE.BufferGeometry {
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
export function cap(x: number, s: Section, n: number, part: number, dir: V3, noz = 0): THREE.BufferGeometry {
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
export const circle = (cy: number, cz: number, r: number): Section => ({ cy, cz, w: r, hT: r, hB: r, n: 2 });

/** Cylinder between two points. */
export function cylinder(a: V3, b: V3, r: number, part: number, n = 10): THREE.BufferGeometry {
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
export function box(c: V3, h: V3, part: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(h[0] * 2, h[1] * 2, h[2] * 2).toNonIndexed();
  g.translate(c[0], c[1], c[2]);
  const pos = Array.from(g.getAttribute('position').array);
  const idx = pos.map((_, i) => i).slice(0, pos.length / 3);
  return geom({ pos, idx }, part, (p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
}

export function merge(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(gs);
  if (!m) throw new Error('tejasTestModel: geometry merge failed');
  for (const g of gs) g.dispose();
  return m;
}

/** Mirror image across the x-y plane (right side -> left side). */
export function mirrorZ(g: THREE.BufferGeometry): THREE.BufferGeometry {
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

export const range = (a: number, b: number, step: number): number[] => {
  const n = Math.max(1, Math.ceil(Math.abs(b - a) / step));
  return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
};


/** NACA 4-digit half-thickness at chord fraction xi. */
export function naca(xi: number): number {
  const x = Math.min(1, Math.max(0, xi));
  return 5 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
}

/**
 * One chordwise strip of a lifting surface between span stations sa..sb, from front(s) to back(s)
 * (x), with half-thickness halfT(x, s); `map(x, s, t)` places it (t = signed thickness offset).
 * Closing faces on the cut edges (front if not the leading edge, back, both span ends).
 */
export function plate(
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
