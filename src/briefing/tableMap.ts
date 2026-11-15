/**
 * src/briefing/tableMap.ts — the relief map on the war-room table, in three.js: the terrain mesh
 * (mapData.ts MapGrid, coloured and shaded in the worker), the rivers, faint grid squares, the
 * place names, and the story marks a script lays on it (attack pins, advance arrows, a front line,
 * the C-17's route, the drop zone). Every line carries `userData.lineKind`, one of MAP_LINE_KINDS:
 * there is no boundary kind, so no boundary can be drawn (tests/briefing/briefing.test.ts).
 *
 * The marks are drawn thin and flat, in a restrained palette (hostile red, a pale route, the UI's
 * amber for the objective): pins and rings draw on round their circle and pulse once every couple
 * of seconds; lines draw along their length with an eased pen.
 *
 * Everything animated is a function of the intro's clock (`update(t)`).
 */
import * as THREE from 'three';
import type { BriefingBeat, BriefingScript } from './script';
import { MAP_SCALE, MAP_WORLD_HALF_M, PLACES, gridHeightAt, mapRivers, roomY, smoothPath, worldOf, type MapGrid, type MapLineKind, type MapPoint } from './mapData';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const smooth = (v: number): number => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
/** Smootherstep: a pen that starts and stops gently. */
const pen = (v: number): number => {
  const x = clamp01(v);
  return x * x * x * (x * (6 * x - 15) + 10);
};
const outCubic = (v: number): number => 1 - Math.pow(1 - clamp01(v), 3);

/** A ring (RingGeometry, in its own xy plane) drawn on round its circle up to `uSweep` (0..1). */
const SWEEP_VS = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const SWEEP_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uSweep;
varying vec2 vP;
void main() {
  float f = fract(atan(vP.x, vP.y) / 6.2831853 + 1.0);
  if (f > uSweep) discard;
  gl_FragColor = vec4(uColor, uOpacity);
}`;
function sweepMaterial(color: THREE.ColorRepresentation): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SWEEP_VS,
    fragmentShader: SWEEP_FS,
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0 }, uSweep: { value: 0 } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
/** A crisp pulse: every `period` s a thin ring grows from `r0` x to `r1` x and fades. */
function pulseAt(k: number, period: number): { scale: number; alpha: number } {
  if (k < 0) return { scale: 1, alpha: 0 };
  const p = (k % period) / period;
  const grow = Math.min(1, p / 0.7);
  return { scale: 1 + 1.6 * outCubic(grow), alpha: p < 0.7 ? (1 - grow) * 0.75 : 0 };
}
/** The marks' colours: hostile, the C-17's route, the garrison's line, the objective (the UI's accent). */
const HOSTILE = 0xff4b3a;
const ROUTE = 0xeaf2f6;
const FRONT = 0xf1e7d0;
const ACCENT = 0xff9a1f;

const RIBBON_VS = /* glsl */ `
attribute float aAlong;
attribute float aAcross;
attribute float aDist;
varying float vAlong;
varying float vAcross;
varying float vDist;
void main() {
  vAlong = aAlong;
  vAcross = aAcross;
  vDist = aDist;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const RIBBON_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uProgress;
uniform float uDash;
uniform float uTime;
uniform float uGlow;
varying float vAlong;
varying float vAcross;
varying float vDist;
void main() {
  if (vAlong > uProgress) discard;
  if (uDash > 0.0 && fract(vDist * uDash - uTime * 0.5) > 0.58) discard;
  float edge = 1.0 - smoothstep(0.45, 1.0, abs(vAcross));
  float tip = (1.0 - smoothstep(0.0, 0.06, uProgress - vAlong)) * uGlow;
  gl_FragColor = vec4(uColor * (1.0 + 0.8 * tip), uOpacity * edge);
}`;

function ribbonMaterial(color: THREE.ColorRepresentation, opacity: number, opts: { dash?: number; glow?: number; depthTest?: boolean; additive?: boolean } = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: RIBBON_VS,
    fragmentShader: RIBBON_FS,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uProgress: { value: 1 },
      uDash: { value: opts.dash ?? 0 },
      uTime: { value: 0 },
      uGlow: { value: opts.glow ?? 0 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: opts.depthTest ?? false,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

/** A flat strip along `pts` (room), `width(u)` wide at fraction u of its length. */
function ribbonGeometry(pts: readonly THREE.Vector3[], width: (u: number) => number): THREE.BufferGeometry {
  const n = pts.length;
  const pos = new Float32Array(n * 2 * 3);
  const along = new Float32Array(n * 2);
  const across = new Float32Array(n * 2);
  const dist = new Float32Array(n * 2);
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1]! + pts[i]!.distanceTo(pts[i - 1]!));
  const total = Math.max(1e-6, cum[n - 1]!);
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(n - 1, i + 1)]!;
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    const u = cum[i]! / total;
    const w = width(u) / 2;
    const p = pts[i]!;
    // Left (as seen from above, north up) and right edges.
    pos.set([p.x + tz * w, p.y, p.z - tx * w, p.x - tz * w, p.y, p.z + tx * w], i * 6);
    along[i * 2] = along[i * 2 + 1] = u;
    across[i * 2] = -1;
    across[i * 2 + 1] = 1;
    dist[i * 2] = dist[i * 2 + 1] = cum[i]!;
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const k = i * 2;
    idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  g.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
  g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
  g.setIndex(idx);
  return g;
}

function tagLine<T extends THREE.Object3D>(o: T, kind: MapLineKind): T {
  o.userData.lineKind = kind;
  return o;
}

/** A place name over a dot, always facing the camera, a fixed size on screen. */
function makeLabel(text: string, kind: string): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, opacity: 0 });
  const s = new THREE.Sprite(mat);
  const W = 512, H = 112;
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    if (g) {
      const hostile = kind === 'post';
      const river = kind === 'river' || kind === 'region';
      g.font = `${river ? 'italic 400' : '500'} ${river ? 40 : 44}px "Barlow Condensed", "Arial Narrow", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      const label = river ? text : text.toUpperCase();
      const spaced = label.split('').join(' ');
      g.lineJoin = 'round';
      g.lineWidth = 6;
      g.strokeStyle = 'rgba(4, 6, 8, 0.78)';
      g.strokeText(spaced, W / 2, 62);
      g.fillStyle = hostile ? '#ffb6ab' : river ? '#a9cfe4' : kind === 'airfield' ? '#ffd9a3' : '#eef2f4';
      g.fillText(spaced, W / 2, 62);
      if (!river && !hostile) {
        g.beginPath();
        g.arc(W / 2, H - 14, kind === 'airfield' ? 9 : 7, 0, Math.PI * 2);
        g.fillStyle = 'rgba(4, 6, 8, 0.9)';
        g.fill();
        g.beginPath();
        g.arc(W / 2, H - 14, kind === 'airfield' ? 6 : 4.5, 0, Math.PI * 2);
        g.fillStyle = g.fillStyle = kind === 'airfield' ? '#ffcf70' : '#f4f6f7';
        g.fill();
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 2;
      mat.map = tex;
    }
  }
  s.center.set(0.5, kind === 'river' || kind === 'region' ? 0.5 : 14 / H);
  s.userData.aspect = W / H;
  s.renderOrder = 20;
  return s;
}

interface Timed {
  beat: BriefingBeat;
  update(t: number): void;
}

export interface TableMap {
  group: THREE.Group;
  /** Room position on the map's surface at a map point (lifted `lift` m). */
  surface(p: MapPoint, lift?: number, out?: THREE.Vector3): THREE.Vector3;
  /** Lays the terrain and the script's marks on the table (once the worker's grid is in). */
  setGrid(grid: MapGrid): void;
  ready(): boolean;
  /** Animates to the intro's clock; `labelScale` sizes the names for the screen. */
  update(t: number, labelScale: number): void;
  dispose(): void;
}

export function createTableMap(script: BriefingScript): TableMap {
  const group = new THREE.Group();
  group.name = 'table-map';
  let grid: MapGrid | null = null;
  const timed: Timed[] = [];
  const labels = new Map<string, THREE.Sprite>();
  const labelBeats = script.beats.filter((b): b is Extract<BriefingBeat, { kind: 'labels' }> => b.kind === 'labels');
  const ribbonMats: THREE.ShaderMaterial[] = [];
  let terrainMat: THREE.MeshBasicMaterial | null = null;
  /** When the grid arrived (wall clock, ms): the relief fades in from then, also under a dev hold. */
  let arrivedMs = -1;

  const heightAtWorld = (x: number, z: number): number => (grid ? gridHeightAt(grid, x, z) : 3000);
  const surface = (p: MapPoint, lift = 0, out = new THREE.Vector3()): THREE.Vector3 => {
    const w = worldOf(p);
    return out.set(w.x * MAP_SCALE, roomY(heightAtWorld(w.x, w.z)) + lift, w.z * MAP_SCALE);
  };
  /** Room points along a world path, on the surface. */
  const drape = (pts: readonly { x: number; z: number }[], lift: number): THREE.Vector3[] => pts.map((p) => new THREE.Vector3(p.x * MAP_SCALE, roomY(heightAtWorld(p.x, p.z)) + lift, p.z * MAP_SCALE));
  /**
   * As drape, with the height smoothed along the path (never below the ground): a mark drawn over
   * rough ground reads as one stroke of a pen, not a line that saws up and down every ridge.
   */
  const drapeSmooth = (pts: readonly { x: number; z: number }[], lift: number, win = 6): THREE.Vector3[] => {
    const v = drape(pts, lift);
    const ys = v.map((p) => p.y);
    for (let pass = 0; pass < 2; pass++) {
      const src = ys.slice();
      for (let i = 0; i < ys.length; i++) {
        let sum = 0, n = 0, top = -Infinity;
        for (let k = Math.max(0, i - win); k <= Math.min(ys.length - 1, i + win); k++) {
          sum += src[k]!;
          n++;
          top = Math.max(top, src[k]!);
        }
        ys[i] = Math.max(v[i]!.y, 0.4 * (sum / n) + 0.6 * top);
      }
    }
    v.forEach((p, i) => (p.y = ys[i]!));
    return v;
  };

  function buildTerrain(g: MapGrid): void {
    const n = g.n;
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    // sRGB bytes -> linear for the renderer's colour management.
    const lin = new Float32Array(256);
    for (let i = 0; i < 256; i++) lin[i] = Math.pow(i / 255, 2.2);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        pos[k * 3] = g.xs[i]! * MAP_SCALE;
        pos[k * 3 + 1] = roomY(g.h[k]!);
        pos[k * 3 + 2] = g.zs[j]! * MAP_SCALE;
        col[k * 3] = lin[g.rgb[k * 3]!]!;
        col[k * 3 + 1] = lin[g.rgb[k * 3 + 1]!]!;
        col[k * 3 + 2] = lin[g.rgb[k * 3 + 2]!]!;
      }
    }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let q = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx[q++] = a;
        idx[q++] = c;
        idx[q++] = b;
        idx[q++] = b;
        idx[q++] = c;
        idx[q++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    terrainMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0 });
    const mesh = new THREE.Mesh(geo, terrainMat);
    mesh.name = 'relief';
    group.add(mesh);

    // A side skirt down to the table, so the relief reads as a model, not a sheet.
    const skirtPts: number[] = [];
    const ring: [number, number][] = [];
    for (let i = 0; i < n; i++) ring.push([i, 0]);
    for (let j = 1; j < n; j++) ring.push([n - 1, j]);
    for (let i = n - 2; i >= 0; i--) ring.push([i, n - 1]);
    for (let j = n - 2; j >= 0; j--) ring.push([0, j]);
    for (let r = 0; r < ring.length - 1; r++) {
      const [i0, j0] = ring[r]!, [i1, j1] = ring[r + 1]!;
      const x0 = g.xs[i0]! * MAP_SCALE, z0 = g.zs[j0]! * MAP_SCALE, y0 = roomY(g.h[j0 * n + i0]!);
      const x1 = g.xs[i1]! * MAP_SCALE, z1 = g.zs[j1]! * MAP_SCALE, y1 = roomY(g.h[j1 * n + i1]!);
      const yb = roomY(0) - 0.004;
      skirtPts.push(x0, y0, z0, x0, yb, z0, x1, y1, z1, x1, y1, z1, x0, yb, z0, x1, yb, z1);
    }
    const sk = new THREE.BufferGeometry();
    sk.setAttribute('position', new THREE.BufferAttribute(new Float32Array(skirtPts), 3));
    const skirt = new THREE.Mesh(sk, new THREE.MeshBasicMaterial({ color: 0x1b2024, side: THREE.DoubleSide }));
    skirt.name = 'relief-skirt';
    group.add(skirt);

    // Grid squares every 20 km: faint, the map's reference grid (not a boundary of anything).
    const gridPts: THREE.Vector3[][] = [];
    for (let v = -MAP_WORLD_HALF_M + 20_000; v < MAP_WORLD_HALF_M; v += 20_000) {
      const a: { x: number; z: number }[] = [], b: { x: number; z: number }[] = [];
      for (let s = -MAP_WORLD_HALF_M; s <= MAP_WORLD_HALF_M; s += 2000) {
        a.push({ x: v, z: s });
        b.push({ x: s, z: v });
      }
      gridPts.push(drape(a, 0.0012), drape(b, 0.0012));
    }
    const gridMat = ribbonMaterial(0x9cc8d8, 0.16, { depthTest: true });
    ribbonMats.push(gridMat);
    for (const line of gridPts) {
      const m = new THREE.Mesh(ribbonGeometry(line, () => 0.0011), gridMat);
      m.name = 'grid-square';
      group.add(tagLine(m, 'grid'));
    }

    // Rivers.
    const riverMat = ribbonMaterial(0x4fa6d6, 0.92, { depthTest: true });
    ribbonMats.push(riverMat);
    for (const r of mapRivers()) {
      const m = new THREE.Mesh(ribbonGeometry(drape(r.pts, 0.0016), (u) => r.widthM * (0.55 + 0.45 * u)), riverMat);
      m.name = `river-${r.id}`;
      group.add(tagLine(m, 'river'));
    }

    // Place names: every place a labels beat shows.
    const ids = new Set(labelBeats.flatMap((b) => b.show));
    for (const id of ids) {
      const pl = PLACES[id];
      if (!pl) continue;
      const s = makeLabel(pl.name, pl.kind);
      // A post's name sits just over its pin; a river's or region's floats over the ground.
      surface(id, pl.kind === 'river' || pl.kind === 'region' ? 0.012 : pl.kind === 'post' ? 0.006 : 0.002, s.position);
      s.name = `label-${id}`;
      labels.set(id, s);
      group.add(s);
    }

    for (const b of script.beats) {
      const t = buildBeat(b);
      if (t) timed.push(t);
    }
  }

  function buildBeat(b: BriefingBeat): Timed | null {
    switch (b.kind) {
      case 'pin': {
        // Flat on the map: a solid dot, a thin ring drawn round it, then a crisp pulse.
        const root = new THREE.Group();
        root.name = 'pin';
        root.position.copy(surface(b.at, 0.0015));
        const dotMat = new THREE.MeshBasicMaterial({ color: HOSTILE, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
        const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0026, 28), dotMat);
        const ringMat = sweepMaterial(HOSTILE);
        const ring = tagLine(new THREE.Mesh(new THREE.RingGeometry(0.0052, 0.0059, 64), ringMat), 'ring');
        const pulseMat = new THREE.MeshBasicMaterial({ color: HOSTILE, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
        const pulse = tagLine(new THREE.Mesh(new THREE.RingGeometry(0.0052, 0.0056, 64), pulseMat), 'ring');
        for (const m of [dot, ring, pulse]) {
          m.rotation.x = -Math.PI / 2;
          m.renderOrder = 15;
        }
        root.add(dot, ring, pulse);
        root.visible = false;
        group.add(root);
        return {
          beat: b,
          update(t) {
            const k = t - b.t;
            root.visible = k >= 0;
            if (k < 0) return;
            // The dot lands small and sharp (a quick settle from a little larger).
            const d = outCubic(k / 0.35);
            dot.scale.setScalar(1.7 - 0.7 * d);
            dotMat.opacity = d;
            ringMat.uniforms.uSweep!.value = pen((k - 0.1) / 0.6);
            ringMat.uniforms.uOpacity!.value = 0.9 * clamp01((k - 0.1) / 0.2);
            const p = pulseAt(k - 0.7, 2.2);
            pulse.scale.setScalar(p.scale);
            pulseMat.opacity = p.alpha;
          },
        };
      }
      case 'arrow': {
        const hostile = b.side === 'hostile';
        const W = b.width ?? (hostile ? 0.0062 : 0.0034);
        const pts = drapeSmooth(smoothPath(b.path.map(worldOf), 300), 0.005);
        const headLen = W * (hostile ? 3.4 : 4.2);
        const color = hostile ? HOSTILE : ROUTE;
        // The body stops short of the tip; the head rides on the drawing end. A faint bright tip while it draws.
        const mat = ribbonMaterial(color, hostile ? 0.9 : 0.95, { dash: hostile ? 0 : 70, glow: 0.4 });
        ribbonMats.push(mat);
        const body = tagLine(new THREE.Mesh(ribbonGeometry(pts, (u) => W * (hostile ? 0.35 + 0.65 * smooth(u / 0.25) : 1)), mat), hostile ? 'arrow' : 'route');
        body.name = hostile ? 'advance-arrow' : 'route';
        body.renderOrder = 12;
        const shape = new THREE.Shape();
        shape.moveTo(0, headLen);
        shape.lineTo(-W * 1.5, 0);
        shape.lineTo(0, headLen * 0.32);
        shape.lineTo(W * 1.5, 0);
        shape.closePath();
        const headMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
        const head = tagLine(new THREE.Mesh(new THREE.ShapeGeometry(shape), headMat), hostile ? 'arrow' : 'route');
        head.renderOrder = 13;
        group.add(body, head);
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + pts[i]!.distanceTo(pts[i - 1]!));
        const total = cum[cum.length - 1]!;
        const tip = new THREE.Vector3();
        const dir = new THREE.Vector3();
        return {
          beat: b,
          update(t) {
            const k = t - b.t;
            body.visible = head.visible = k >= 0;
            if (k < 0) return;
            const prog = pen(k / b.dur);
            mat.uniforms.uProgress!.value = prog;
            mat.uniforms.uTime!.value = t;
            mat.uniforms.uGlow!.value = 0.4 * (1 - clamp01((k - b.dur) / 0.8));
            // The head at the drawing end, pointing along the line.
            const d = prog * total;
            let i = 1;
            while (i < cum.length - 1 && cum[i]! < d) i++;
            const f = clamp01((d - cum[i - 1]!) / Math.max(1e-6, cum[i]! - cum[i - 1]!));
            tip.lerpVectors(pts[i - 1]!, pts[i]!, f);
            dir.subVectors(pts[i]!, pts[i - 1]!);
            head.position.copy(tip);
            head.position.y += 0.0005;
            head.rotation.set(-Math.PI / 2, 0, Math.atan2(-dir.x, -dir.z));
            headMat.opacity = clamp01(k / 0.3) * 0.95;
          },
        };
      }
      case 'front': {
        const world = smoothPath(b.path.map(worldOf), 150);
        const pts = drapeSmooth(world, 0.005, 8);
        const mat = ribbonMaterial(FRONT, 0.92, { glow: 0.3 });
        ribbonMats.push(mat);
        const line = tagLine(new THREE.Mesh(ribbonGeometry(pts, () => 0.0024), mat), 'front');
        line.name = 'front-line';
        line.renderOrder = 12;
        // Fine teeth on the enemy side (left of the path), drawn with the line.
        const tp: number[] = [], ta: number[] = [], tc: number[] = [], td: number[] = [];
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + pts[i]!.distanceTo(pts[i - 1]!));
        const total = cum[cum.length - 1]!;
        const STEP = 0.012, TW = 0.0034, TH = 0.0048;
        for (let s = STEP / 2; s < total; s += STEP) {
          let i = 1;
          while (i < cum.length - 1 && cum[i]! < s) i++;
          const f = (s - cum[i - 1]!) / Math.max(1e-6, cum[i]! - cum[i - 1]!);
          const p = new THREE.Vector3().lerpVectors(pts[i - 1]!, pts[i]!, f);
          const dx = pts[i]!.x - pts[i - 1]!.x, dz = pts[i]!.z - pts[i - 1]!.z;
          const l = Math.hypot(dx, dz) || 1;
          const tx = dx / l, tz = dz / l;
          // Left of the direction of travel, seen from above with north up: (tz, -tx).
          const lx = tz, lz = -tx;
          tp.push(p.x - tx * TW / 2, p.y, p.z - tz * TW / 2, p.x + tx * TW / 2, p.y, p.z + tz * TW / 2, p.x + lx * TH, p.y, p.z + lz * TH);
          const u = s / total;
          ta.push(u, u, u);
          tc.push(0, 0, 0);
          td.push(s, s, s);
        }
        const tg = new THREE.BufferGeometry();
        tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tp), 3));
        tg.setAttribute('aAlong', new THREE.BufferAttribute(new Float32Array(ta), 1));
        tg.setAttribute('aAcross', new THREE.BufferAttribute(new Float32Array(tc), 1));
        tg.setAttribute('aDist', new THREE.BufferAttribute(new Float32Array(td), 1));
        const teeth = tagLine(new THREE.Mesh(tg, mat), 'front');
        teeth.renderOrder = 12;
        group.add(line, teeth);
        return {
          beat: b,
          update(t) {
            const k = t - b.t;
            line.visible = teeth.visible = k >= 0;
            if (k < 0) return;
            mat.uniforms.uProgress!.value = pen(k / b.dur);
            mat.uniforms.uGlow!.value = 0.3 * (1 - clamp01((k - b.dur) / 0.8));
          },
        };
      }
      case 'objective': {
        // The accent: a thin ring drawn round the strip, the strip picked out, a slow crisp pulse.
        const root = new THREE.Group();
        root.position.copy(surface(b.at, 0.003));
        const ringMat = sweepMaterial(ACCENT);
        const ring = tagLine(new THREE.Mesh(new THREE.RingGeometry(0.0118, 0.0127, 96), ringMat), 'ring');
        const pulseMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
        const pulse = tagLine(new THREE.Mesh(new THREE.RingGeometry(0.0118, 0.0123, 96), pulseMat), 'ring');
        // The strip itself (650 m would be a speck at true scale).
        const stripMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
        const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.0105, 0.0012), stripMat);
        strip.rotation.x = -Math.PI / 2;
        strip.rotation.z = -((103.6 - 90) * Math.PI) / 180;
        ring.rotation.x = pulse.rotation.x = -Math.PI / 2;
        for (const o of [ring, pulse, strip]) o.renderOrder = 16;
        root.add(ring, pulse, strip);
        const label = makeLabel(b.label, 'airfield');
        label.center.set(-0.08, 0.5);
        label.position.set(0.006, 0.004, 0);
        root.add(label);
        root.visible = false;
        group.add(root);
        return {
          beat: b,
          update(t) {
            const k = t - b.t;
            root.visible = k >= 0;
            if (k < 0) return;
            ringMat.uniforms.uSweep!.value = pen(k / 0.9);
            ringMat.uniforms.uOpacity!.value = 0.95 * clamp01(k / 0.2);
            stripMat.opacity = 0.95 * smooth((k - 0.5) / 0.5);
            const p = pulseAt(k - 1, 2.6);
            pulse.scale.setScalar(p.scale);
            pulseMat.opacity = p.alpha;
            (label.material as THREE.SpriteMaterial).opacity = smooth((k - 0.7) / 0.7);
          },
        };
      }
      default:
        return null;
    }
  }

  function labelOpacity(id: string, t: number): number {
    let cur = -1;
    for (let i = 0; i < labelBeats.length; i++) if (labelBeats[i]!.t <= t) cur = i;
    if (cur < 0) return 0;
    const c = labelBeats[cur]!;
    const p = cur > 0 ? labelBeats[cur - 1] : undefined;
    const was = !!p?.show.includes(id);
    const is = c.show.includes(id);
    const k = clamp01((t - c.t) / 0.7);
    return is ? (was ? 1 : k) : was ? 1 - k : 0;
  }

  return {
    group,
    surface,
    setGrid(g) {
      if (grid) return;
      grid = g;
      buildTerrain(g);
    },
    ready: () => grid !== null,
    update(t, labelScale) {
      if (!grid) return;
      if (arrivedMs < 0) arrivedMs = performance.now();
      if (terrainMat) {
        // Fades in as it arrives (on a slow PC the grid may come a second into the intro).
        const a = clamp01((performance.now() - arrivedMs) / 800);
        terrainMat.opacity = a;
        terrainMat.transparent = a < 1;
      }
      for (const m of ribbonMats) m.uniforms.uTime!.value = t;
      for (const x of timed) x.update(t);
      for (const [id, s] of labels) {
        const o = labelOpacity(id, t);
        (s.material as THREE.SpriteMaterial).opacity = o;
        s.visible = o > 0.01;
        s.scale.set(labelScale * (s.userData.aspect as number), labelScale, 1);
      }
      group.traverse((o) => {
        if (o instanceof THREE.Sprite && !labels.has(o.name.replace('label-', '')) && o.userData.aspect) o.scale.set(labelScale * 1.05 * (o.userData.aspect as number), labelScale * 1.05, 1);
      });
    },
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
          o.geometry.dispose();
          const m = o.material as THREE.Material & { map?: THREE.Texture | null };
          m.map?.dispose();
          m.dispose();
        }
      });
    },
  };
}

