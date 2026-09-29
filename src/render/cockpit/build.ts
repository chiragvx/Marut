/**
 * src/render/cockpit/build.ts — the toolkit components are built with.
 *
 * - Materials: physically based (three's MeshStandardMaterial, so the cockpit gets real sun shadows
 *   and specular glints), patched to write display-referred colour like the rest of the app's
 *   shaders (postGrade.ts expects display values).
 * - PanelAtlas: every panel legend, placard and stencil is painted once at load into one canvas
 *   atlas (plus a half-resolution "backlight" layer: the legends that glow at night), so all the
 *   painted faces share one material and batch into one draw call.
 * - Batcher: static geometry is merged per material at the end (a few dozen draw calls for the
 *   whole cockpit); moving parts stay separate meshes.
 * - Geometry helpers and `facing()` placement (a component's local frame: x right, y up, +z out of
 *   the panel towards the pilot).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Any {x, y, z}. */
type Vec3 = { x: number; y: number; z: number };

// -----------------------------------------------------------------------------
// Materials.
// -----------------------------------------------------------------------------

/** Makes a three.js lit material write display-referred colour (sRGB-encoded), like the world's shaders. */
export function displayOutput<M extends THREE.Material>(mat: M): M {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <colorspace_fragment>', 'gl_FragColor = sRGBTransferOETF( gl_FragColor );');
  };
  mat.customProgramCacheKey = () => 'cockpit-display-out';
  return mat;
}

export interface CockpitMaterials {
  /** Light grey instrument panels (the Tejas's are light grey). */
  panel: THREE.MeshStandardMaterial;
  /** Painted faces from the atlas (legends, placards). */
  painted: THREE.MeshStandardMaterial;
  /** Black display bezels, housings. */
  bezel: THREE.MeshStandardMaterial;
  /** Dark cockpit tub walls and floor. */
  wall: THREE.MeshStandardMaterial;
  /** Dark grey consoles and structure. */
  console: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  /** Bare, darker metal (rails, hinges). */
  darkMetal: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  /** Seat cushions and pads. */
  cushion: THREE.MeshStandardMaterial;
  /** Harness webbing. */
  webbing: THREE.MeshStandardMaterial;
  yellow: THREE.MeshStandardMaterial;
  red: THREE.MeshStandardMaterial;
  /** Painted canopy frame (inside). */
  frame: THREE.MeshStandardMaterial;
  /** Keycaps (grey-white). */
  keycap: THREE.MeshStandardMaterial;
  /** Every material above, for per-frame environment/night tweaks. */
  all: THREE.MeshStandardMaterial[];
}

export function createMaterials(atlas: PanelAtlas): CockpitMaterials {
  const all: THREE.MeshStandardMaterial[] = [];
  const mk = (hex: number, roughness: number, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial => {
    // Double-sided: the shell is built from hand-made quads, and from inside every face must show.
    const m = displayOutput(new THREE.MeshStandardMaterial({ color: hex, roughness, metalness, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide, ...extra }));
    all.push(m);
    return m;
  };
  return {
    panel: mk(0x8c9193, 0.72),
    painted: mk(0xffffff, 0.7, 0, { map: atlas.colorTexture, emissiveMap: atlas.glowTexture, emissive: 0x000000 }),
    bezel: mk(0x141516, 0.55),
    wall: mk(0x34363a, 0.9),
    console: mk(0x2f3133, 0.8),
    metal: mk(0x8a8e92, 0.42, 0.75),
    darkMetal: mk(0x4a4d50, 0.5, 0.7),
    rubber: mk(0x0d0d0e, 0.88),
    cushion: mk(0x3b3f33, 0.95),
    webbing: mk(0x4d4f3b, 0.9),
    yellow: mk(0xd8b020, 0.6),
    red: mk(0xb01c18, 0.55),
    frame: mk(0x5c6064, 0.65),
    keycap: mk(0xb9bcbc, 0.6),
    all,
  };
}

// -----------------------------------------------------------------------------
// Painted panel faces: one atlas.
// -----------------------------------------------------------------------------

/** A painted rectangle in the atlas. u/v are texture coordinates of its corners (v up). */
export interface AtlasRegion {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Size in mm. */
  wMm: number;
  hMm: number;
}

export const LEGEND_FONT = '"Arial Narrow", "Roboto Condensed", Arial, sans-serif';

/** Drawing on a panel face, in mm from its top left. `glow` also paints the night backlight layer. */
export interface Painter {
  readonly wMm: number;
  readonly hMm: number;
  fill(color: string): void;
  rect(x: number, y: number, w: number, h: number, color: string): void;
  strokeRect(x: number, y: number, w: number, h: number, color: string, lineMm?: number, glow?: boolean): void;
  line(x0: number, y0: number, x1: number, y1: number, color: string, lineMm?: number, glow?: boolean): void;
  circle(x: number, y: number, r: number, color: string, fill?: boolean, lineMm?: number, glow?: boolean): void;
  text(s: string, x: number, y: number, sizeMm: number, opts?: { color?: string; align?: CanvasTextAlign; glow?: boolean; bold?: boolean; rotate?: number }): void;
  /** Yellow/black hazard stripes. */
  stripes(x: number, y: number, w: number, h: number, bandMm?: number): void;
  /** Countersunk screw heads (DZUS fasteners) at the four corners, inset `insetMm`. */
  fasteners(insetMm: number): void;
  /** Subtle wear and grime so flat faces don't look synthetic. */
  wear(amount: number): void;
}

export class PanelAtlas {
  readonly width = 4096;
  readonly height = 2048;
  readonly glowScale = 0.5;
  readonly color: HTMLCanvasElement;
  readonly glow: HTMLCanvasElement;
  readonly colorTexture: THREE.CanvasTexture;
  readonly glowTexture: THREE.CanvasTexture;
  private cx: CanvasRenderingContext2D;
  private gx: CanvasRenderingContext2D;
  /** Shelf packing, first fit: each shelf has a height and how far along it is used. */
  private shelves: { y: number; h: number; x: number }[] = [];
  private nextY = 0;
  /** Texture pixels per mm, by default (big plain panels ask for less). */
  readonly pxPerMm = 3;

  constructor() {
    this.color = document.createElement('canvas');
    this.color.width = this.width;
    this.color.height = this.height;
    this.glow = document.createElement('canvas');
    this.glow.width = this.width * this.glowScale;
    this.glow.height = this.height * this.glowScale;
    this.cx = this.color.getContext('2d')!;
    this.gx = this.glow.getContext('2d')!;
    this.cx.fillStyle = '#8c9193';
    this.cx.fillRect(0, 0, this.width, this.height);
    this.gx.fillStyle = '#000';
    this.gx.fillRect(0, 0, this.glow.width, this.glow.height);
    this.colorTexture = new THREE.CanvasTexture(this.color);
    this.colorTexture.colorSpace = THREE.SRGBColorSpace;
    this.colorTexture.anisotropy = 8;
    this.glowTexture = new THREE.CanvasTexture(this.glow);
    this.glowTexture.colorSpace = THREE.SRGBColorSpace;
  }

  /** Paints a panel face wMm x hMm and returns where it is. */
  paint(wMm: number, hMm: number, draw: (p: Painter) => void, pxPerMm = this.pxPerMm): AtlasRegion {
    const pad = 4;
    const w = Math.ceil(wMm * pxPerMm);
    const h = Math.ceil(hMm * pxPerMm);
    // The shelf that fits it with the least wasted height, else a new one.
    let shelf: { y: number; h: number; x: number } | undefined;
    for (const sh of this.shelves) {
      if (sh.h >= h && sh.x + w <= this.width && (!shelf || sh.h < shelf.h)) shelf = sh;
    }
    if (!shelf) {
      if (this.nextY + h > this.height) throw new Error(`cockpit PanelAtlas is full (${w}x${h})`);
      shelf = { y: this.nextY, h, x: 0 };
      this.shelves.push(shelf);
      this.nextY += h + pad;
    }
    const x0 = shelf.x;
    const y0 = shelf.y;
    shelf.x += w + pad;

    const k = pxPerMm;
    const g = this.glowScale;
    const cx = this.cx;
    const gx = this.gx;
    cx.save();
    gx.save();
    cx.beginPath();
    cx.rect(x0, y0, w, h);
    cx.clip();
    gx.beginPath();
    gx.rect(x0 * g, y0 * g, w * g, h * g);
    gx.clip();
    cx.translate(x0, y0);
    cx.scale(k, k);
    gx.translate(x0 * g, y0 * g);
    gx.scale(k * g, k * g);
    const both = (glow: boolean | undefined, f: (c: CanvasRenderingContext2D, isGlow: boolean) => void): void => {
      f(cx, false);
      if (glow) f(gx, true);
    };
    const p: Painter = {
      wMm,
      hMm,
      fill(color) {
        cx.fillStyle = color;
        cx.fillRect(0, 0, wMm, hMm);
      },
      rect(x, y, rw, rh, color) {
        cx.fillStyle = color;
        cx.fillRect(x, y, rw, rh);
      },
      strokeRect(x, y, rw, rh, color, lineMm = 0.5, glow) {
        both(glow, (c, isGlow) => {
          c.strokeStyle = isGlow ? '#fff' : color;
          c.lineWidth = lineMm;
          c.strokeRect(x, y, rw, rh);
        });
      },
      line(x0, y0, x1, y1, color, lineMm = 0.5, glow) {
        both(glow, (c, isGlow) => {
          c.strokeStyle = isGlow ? '#fff' : color;
          c.lineWidth = lineMm;
          c.beginPath();
          c.moveTo(x0, y0);
          c.lineTo(x1, y1);
          c.stroke();
        });
      },
      circle(x, y, r, color, fill = false, lineMm = 0.5, glow) {
        both(glow, (c, isGlow) => {
          c.beginPath();
          c.arc(x, y, r, 0, Math.PI * 2);
          if (fill) {
            c.fillStyle = isGlow ? '#fff' : color;
            c.fill();
          } else {
            c.strokeStyle = isGlow ? '#fff' : color;
            c.lineWidth = lineMm;
            c.stroke();
          }
        });
      },
      text(s, x, y, sizeMm, opts = {}) {
        both(opts.glow ?? true, (c, isGlow) => {
          c.save();
          c.translate(x, y);
          if (opts.rotate) c.rotate(opts.rotate);
          c.font = `${opts.bold ? 'bold ' : ''}${sizeMm}px ${LEGEND_FONT}`;
          c.textAlign = opts.align ?? 'center';
          c.textBaseline = 'middle';
          c.fillStyle = isGlow ? '#fff' : (opts.color ?? '#f2f2ee');
          c.fillText(s, 0, 0);
          c.restore();
        });
      },
      stripes(x, y, sw, sh, band = 4) {
        cx.save();
        cx.beginPath();
        cx.rect(x, y, sw, sh);
        cx.clip();
        cx.fillStyle = '#e0b818';
        cx.fillRect(x, y, sw, sh);
        cx.fillStyle = '#151515';
        for (let t = -sh; t < sw + sh; t += band * 2) {
          cx.beginPath();
          cx.moveTo(x + t, y + sh);
          cx.lineTo(x + t + band, y + sh);
          cx.lineTo(x + t + band + sh, y);
          cx.lineTo(x + t + sh, y);
          cx.closePath();
          cx.fill();
        }
        cx.restore();
      },
      fasteners(inset) {
        for (const [fx, fy] of [
          [inset, inset],
          [wMm - inset, inset],
          [inset, hMm - inset],
          [wMm - inset, hMm - inset],
        ] as const) {
          const grad = cx.createRadialGradient(fx - 0.4, fy - 0.4, 0.2, fx, fy, 1.9);
          grad.addColorStop(0, 'rgba(210,212,214,0.9)');
          grad.addColorStop(1, 'rgba(40,42,44,0.9)');
          cx.fillStyle = grad;
          cx.beginPath();
          cx.arc(fx, fy, 1.9, 0, Math.PI * 2);
          cx.fill();
          cx.strokeStyle = 'rgba(20,20,20,0.8)';
          cx.lineWidth = 0.45;
          cx.beginPath();
          cx.moveTo(fx - 1.2, fy);
          cx.lineTo(fx + 1.2, fy);
          cx.stroke();
        }
      },
      wear(amount) {
        // Faint mottling and edge grime (deterministic per panel).
        let seed = (x0 * 73856093) ^ (y0 * 19349663);
        const rnd = (): number => {
          seed = (seed * 1664525 + 1013904223) | 0;
          return ((seed >>> 0) % 10000) / 10000;
        };
        for (let i = 0; i < 40; i++) {
          const rx = rnd() * wMm;
          const ry = rnd() * hMm;
          const rr = 2 + rnd() * 10;
          const grad = cx.createRadialGradient(rx, ry, 0, rx, ry, rr);
          const dark = rnd() < 0.7;
          grad.addColorStop(0, dark ? `rgba(0,0,0,${0.05 * amount})` : `rgba(255,255,255,${0.04 * amount})`);
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          cx.fillStyle = grad;
          cx.fillRect(rx - rr, ry - rr, rr * 2, rr * 2);
        }
        const edge = cx.createLinearGradient(0, 0, 0, hMm);
        edge.addColorStop(0, `rgba(0,0,0,${0.07 * amount})`);
        edge.addColorStop(0.08, 'rgba(0,0,0,0)');
        edge.addColorStop(0.92, 'rgba(0,0,0,0)');
        edge.addColorStop(1, `rgba(0,0,0,${0.1 * amount})`);
        cx.fillStyle = edge;
        cx.fillRect(0, 0, wMm, hMm);
      },
    };
    draw(p);
    cx.restore();
    gx.restore();
    this.colorTexture.needsUpdate = true;
    this.glowTexture.needsUpdate = true;
    const W = this.width;
    const H = this.height;
    return { u0: x0 / W, u1: (x0 + w) / W, v0: 1 - (y0 + h) / H, v1: 1 - y0 / H, wMm, hMm };
  }
}

/** A flat rectangle (local x right, y up, facing +z) showing an atlas region, centred at the origin. */
export function decalGeometry(r: AtlasRegion): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(r.wMm / 1000, r.hMm / 1000);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
  }
  return g;
}

// -----------------------------------------------------------------------------
// Static batching.
// -----------------------------------------------------------------------------

export interface BatchOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
}

export class Batcher {
  private groups = new Map<THREE.Material, { geoms: THREE.BufferGeometry[]; cast: boolean }>();

  /** Adds geometry (in `matrix`'s frame) for merging. The geometry is consumed. */
  add(geom: THREE.BufferGeometry, mat: THREE.Material, matrix: THREE.Matrix4, opts: BatchOptions = {}): void {
    let g = geom.index ? geom.toNonIndexed() : geom;
    if (g !== geom) geom.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.getAttribute('uv')) {
      const n = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g = g.applyMatrix4(matrix);
    let e = this.groups.get(mat);
    if (!e) {
      e = { geoms: [], cast: false };
      this.groups.set(mat, e);
    }
    e.geoms.push(g);
    e.cast ||= opts.castShadow !== false;
  }

  /** Merges everything into one mesh per material, added to `parent`. */
  flush(parent: THREE.Object3D): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [mat, e] of this.groups) {
      if (e.geoms.length === 0) continue;
      const merged = mergeGeometries(e.geoms, false);
      for (const g of e.geoms) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = 'batch';
      mesh.castShadow = e.cast;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      out.push(mesh);
    }
    this.groups.clear();
    return out;
  }
}

// -----------------------------------------------------------------------------
// Placement and geometry helpers.
// -----------------------------------------------------------------------------

const vN = new THREE.Vector3();
const vR = new THREE.Vector3();
const vU = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * A frame at `pos` whose +z points at `towards` (normally the eye) and whose x is level (right as
 * the pilot sees it). Optional extra tilt (rad) leans the top away from the pilot.
 */
export function facing(pos: Vec3, towards: Vec3, tiltBackRad = 0): THREE.Matrix4 {
  vN.set(towards.x - pos.x, towards.y - pos.y, towards.z - pos.z).normalize();
  vR.crossVectors(UP, vN).normalize();
  if (vR.lengthSq() < 1e-6) vR.set(0, 0, 1);
  vU.crossVectors(vN, vR).normalize();
  const m = new THREE.Matrix4().makeBasis(vR, vU, vN);
  if (tiltBackRad) m.multiply(new THREE.Matrix4().makeRotationX(-tiltBackRad));
  m.setPosition(pos.x, pos.y, pos.z);
  return m;
}

/**
 * A frame at `pos` for a panel whose normal points along `normal` (need not be unit), right level.
 */
export function oriented(pos: Vec3, normal: Vec3): THREE.Matrix4 {
  return facing(pos, { x: pos.x + normal.x, y: pos.y + normal.y, z: pos.z + normal.z });
}

/** Local transform helper: translation, then rotations about local x, y, z (rad). */
export function local(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
  m.setPosition(x, y, z);
  return m;
}

export const mul = (a: THREE.Matrix4, b: THREE.Matrix4): THREE.Matrix4 => new THREE.Matrix4().multiplyMatrices(a, b);

/**
 * A rounded-corner slab w x h, `depth` thick, front face at z = +depth/2 (local frame). With
 * `hole`, a centred rounded opening goes through it (a display bezel).
 */
export function roundedSlab(w: number, h: number, depth: number, radius: number, bevel = 0.0015, hole?: { w: number; h: number; r: number }): THREE.BufferGeometry {
  // A bevel eats into the thickness from both faces: keep thin slabs as thin as asked.
  bevel = Math.min(bevel, depth * 0.3);
  const r = Math.min(radius, w / 2 - 1e-4, h / 2 - 1e-4);
  const s = new THREE.Shape();
  const x = -w / 2 + bevel;
  const y = -h / 2 + bevel;
  const W = w - 2 * bevel;
  const H = h - 2 * bevel;
  const rr = Math.max(1e-4, r - bevel);
  s.moveTo(x + rr, y);
  s.lineTo(x + W - rr, y);
  s.quadraticCurveTo(x + W, y, x + W, y + rr);
  s.lineTo(x + W, y + H - rr);
  s.quadraticCurveTo(x + W, y + H, x + W - rr, y + H);
  s.lineTo(x + rr, y + H);
  s.quadraticCurveTo(x, y + H, x, y + H - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  if (hole) {
    const hw = hole.w / 2 + bevel;
    const hh = hole.h / 2 + bevel;
    const hr = Math.min(hole.r + bevel, hw, hh);
    const p = new THREE.Path();
    p.moveTo(-hw + hr, -hh);
    p.quadraticCurveTo(-hw, -hh, -hw, -hh + hr);
    p.lineTo(-hw, hh - hr);
    p.quadraticCurveTo(-hw, hh, -hw + hr, hh);
    p.lineTo(hw - hr, hh);
    p.quadraticCurveTo(hw, hh, hw, hh - hr);
    p.lineTo(hw, -hh + hr);
    p.quadraticCurveTo(hw, -hh, hw - hr, -hh);
    p.closePath();
    s.holes.push(p);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(1e-4, depth - 2 * bevel), bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 4 });
  g.translate(0, 0, -depth / 2 + bevel);
  return g;
}

/** A flat polygon (local xy, counter-clockwise) extruded `depth` towards -z from z = 0. */
export function extrudePolygon(pts: readonly (readonly [number, number])[], depth: number, bevel = 0): THREE.BufferGeometry {
  const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1 });
  g.translate(0, 0, -depth);
  return g;
}

export function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

/** A cylinder along local z, from z = 0 to z = length (e.g. a knob standing out of a panel). */
export function cylZ(rStart: number, rEnd: number, length: number, seg = 20): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rEnd, rStart, length, seg);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, length / 2);
  return g;
}

/** A cylinder between two points (local frame). */
export function rod(a: Vec3, b: Vec3, r0: number, r1 = r0, seg = 12): THREE.BufferGeometry {
  const va = new THREE.Vector3(a.x, a.y, a.z);
  const vb = new THREE.Vector3(b.x, b.y, b.z);
  const len = va.distanceTo(vb);
  const g = new THREE.CylinderGeometry(r1, r0, len, seg);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  g.applyQuaternion(q);
  g.translate(va.x, va.y, va.z);
  return g;
}

/** A knurled/ribbed knob along local z. */
export function knob(radius: number, height: number, ribs = 16): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  pts.push(new THREE.Vector2(0, 0));
  pts.push(new THREE.Vector2(radius * 1.08, 0));
  pts.push(new THREE.Vector2(radius * 1.08, height * 0.18));
  pts.push(new THREE.Vector2(radius, height * 0.24));
  pts.push(new THREE.Vector2(radius * 0.97, height * 0.9));
  pts.push(new THREE.Vector2(radius * 0.85, height));
  pts.push(new THREE.Vector2(0, height));
  const g = new THREE.LatheGeometry(pts, Math.max(12, ribs * 2));
  // Ribs: push alternate lathe columns in a little.
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = pos.getY(i);
    if (y < height * 0.25 || y > height * 0.92) continue;
    const a = Math.atan2(z, x);
    const k = 1 - 0.07 * (0.5 + 0.5 * Math.cos(a * ribs));
    pos.setX(i, x * k);
    pos.setZ(i, z * k);
  }
  g.computeVertexNormals();
  g.rotateX(Math.PI / 2);
  return g;
}
