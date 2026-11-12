/**
 * src/render/aircraftModels/gltfModel.ts — an AircraftModelTemplate from an imported glTF model
 * (tools/models/build_tejas.py makes public/models/tejas.glb from the CC BY Sketchfab "HAL Tejas"
 * by dimal965).
 *
 * The GLB is authored for this loader: vertices already in the body frame (x forward, y up,
 * z right; same datums as the procedural model), meshes named for their role —
 * - `body`: the fixed airframe; `cockpit`: interior + canopy frame (hidden from inside the 3D
 *   cockpit); `glass`: canopy and windscreen;
 * - every other mesh is a moving part whose node extras carry `driver`, `pivot`, `axis`,
 *   `travelRad` and optionally `keepVisible`, `travelWindow`, `parent` + `radiusM` (wheels) (ArticulatedPart's fields and sign conventions);
 * - scene extras `marut`: pylons, lights, nozzle {exitX, axisY}, canopyInterior, credit.
 * Everything else (stores, lights, flame, team colours) works as for the procedural model.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cap, circle, loft, PART, range } from './meshBuild';
import type { V3 } from './meshBuild';
import { TEJAS_GLB_HASH } from './tejasGlbVersion';
import { buildFlame, INTAKE_STATION, NOZZLE_AXIS_Y, NOZZLE_EXIT_X, type AircraftModelTemplate, type ArticulatedPart, type FormationLamp, type LIGHTS, type PartDriver, type Pylon } from './tejasModel';

/** The imported Tejas (relative to the page, so it works under /play/ and in the Android build);
 *  versioned by content so a rebuilt model is never served from a stale cache. */
export const TEJAS_GLB_URL = new URL(`../models/tejas.glb?v=${TEJAS_GLB_HASH}`, document.baseURI).href;

interface SceneExtras {
  pylons: Pylon[];
  /** The sensor-pod station under the port intake. */
  podMount?: V3;
  lights: Omit<typeof LIGHTS, never>;
  /** The nozzle's exit and axis; hinge/exit radii when the source's own nozzle was cut out for ours. */
  nozzle: { exitX: number; axisY: number; hingeX?: number; hingeR?: number; exitR?: number };
  canopyInterior: { min: V3; max: V3 };
  credit?: string;
}

const DRIVERS: readonly PartDriver[] = ['elevonL', 'elevonR', 'rudder', 'gear', 'slat', 'airbrake', 'wheel', 'oleo', 'brace'];

/** A mesh's geometry in its node's frame baked out, with the attributes the aircraft shader reads. */
function prepare(mesh: THREE.Mesh, part: number): THREE.BufferGeometry {
  mesh.updateWorldMatrix(true, false);
  const g = mesh.geometry.clone();
  g.applyMatrix4(mesh.matrixWorld);
  const n = g.getAttribute('position').count;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  const tan = g.getAttribute('tangent');
  g.setAttribute('aTangent', tan ? tan.clone() : new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
  g.deleteAttribute('tangent');
  for (const name of Object.keys(g.attributes)) {
    if (!['position', 'normal', 'uv', 'aTangent'].includes(name)) g.deleteAttribute(name);
  }
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(part), 1));
  g.setAttribute('aNoz', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  return g.index ? g : g.setIndex([...Array(n).keys()]);
}

/** A lamp lens: a small ellipsoid (radii, m) at c, as part `part` (the shader lights it). */
function lens(c: readonly number[], r: V3, part: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 14, 10);
  g.scale(r[0], r[1], r[2]);
  g.translate(c[0]!, c[1]!, c[2]!);
  const n = g.getAttribute('position').count;
  g.setAttribute('aTangent', new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(part), 1));
  g.setAttribute('aNoz', new THREE.Float32BufferAttribute(new Float32Array(n), 1));
  return g;
}

/**
 * The lamps' lenses (the source model has none: its lights were painted on): navigation lights and
 * strobes on the wingtips, the tail light on the fin's trailing edge. Each sits just inboard of the
 * light's point so it is half buried in the tip.
 */
function lampLenses(L: SceneExtras['lights']): THREE.BufferGeometry[] {
  const inboard = (p: readonly number[], dz: number): number[] => [p[0]!, p[1]!, p[2]! - Math.sign(p[2]!) * dz];
  return [
    lens(inboard(L.navLeft, 0.012), [0.06, 0.02, 0.026], PART.lightRed),
    lens(inboard(L.navRight, 0.012), [0.06, 0.02, 0.026], PART.lightGreen),
    lens(inboard(L.strobeLeft, 0.012), [0.04, 0.017, 0.022], PART.lightStrobe),
    lens(inboard(L.strobeRight, 0.012), [0.04, 0.017, 0.022], PART.lightStrobe),
    lens([L.navTail[0]! + 0.008, L.navTail[1]!, 0], [0.02, 0.03, 0.022], PART.lightWhite),
  ];
}

/**
 * Formation (covert) light strips, starboard side (mirrored to port): each runs from a to b, found on
 * the skin by casting rays along `ray` from outside. Electroluminescent panels as on most modern
 * fighters: under the cockpit on the forward fuselage, on the aft fuselage spine, on the fin
 * (parallel to its leading edge) and on the upper wing near the tip, just aft of the slats.
 * Body frame of the imported model (nose +x, tail -x).
 */
const FORMATION_STRIPS: readonly { a: V3; b: V3; ray: V3 }[] = [
  { a: [4.55, 0.12, 2], b: [4.05, 0.12, 2], ray: [0, 0, -1] },
  { a: [-2.2, 0.45, 2], b: [-2.75, 0.45, 2], ray: [0, 0, -1] },
  { a: [-3.25, 1.6, 2], b: [-3.75, 2.0, 2], ray: [0, 0, -1] },
  { a: [-1.49, 3, 3.05], b: [-2.01, 3, 3.35], ray: [0, -1, 0] },
];
const FORMATION_WIDTH_M = 0.05;
const FORMATION_STANDOFF_M = 0.004;
const FORMATION_SAMPLES = 7;

/** First hit of a ray on the candidate triangles (vertex index triples), with the face normal facing the ray. */
function castOnto(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, tris: Uint32Array, o: THREE.Vector3, d: THREE.Vector3): { p: THREE.Vector3; n: THREE.Vector3 } | undefined {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), h = new THREE.Vector3(), q = new THREE.Vector3(), sv = new THREE.Vector3();
  const n = new THREE.Vector3();
  let best = Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    a.fromBufferAttribute(pos, tris[i]!);
    b.fromBufferAttribute(pos, tris[i + 1]!);
    c.fromBufferAttribute(pos, tris[i + 2]!);
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    h.crossVectors(d, e2);
    const det = e1.dot(h);
    if (Math.abs(det) < 1e-12) continue;
    const f = 1 / det;
    sv.subVectors(o, a);
    const u = f * sv.dot(h);
    if (u < 0 || u > 1) continue;
    q.crossVectors(sv, e1);
    const v = f * d.dot(q);
    if (v < 0 || u + v > 1) continue;
    const t = f * e2.dot(q);
    if (t > 1e-6 && t < best) {
      best = t;
      n.crossVectors(e1, e2).normalize();
    }
  }
  if (!Number.isFinite(best)) return undefined;
  if (n.dot(d) > 0) n.negate();
  return { p: o.clone().addScaledVector(d, best), n };
}

/**
 * The formation strips laid on the airframe's skin (a thin ribbon following its curve, just proud of
 * it), and a lamp at each strip's centre for its glow. A strip whose rays miss the skin is left out
 * (a reshaped model loses that strip rather than getting one floating in the air).
 */
function formationStrips(body: THREE.BufferGeometry): { geometry: THREE.BufferGeometry[]; lamps: FormationLamp[] } {
  const pos = body.getAttribute('position');
  const index = body.getIndex();
  const vertCount = index ? index.count : pos.count;
  const vi = (t: number): number => (index ? index.getX(t) : t);
  const geometry: THREE.BufferGeometry[] = [];
  const lamps: FormationLamp[] = [];
  const o = new THREE.Vector3(), d = new THREE.Vector3(), along = new THREE.Vector3(), across = new THREE.Vector3();
  for (const side of [1, -1]) {
    for (const st of FORMATION_STRIPS) {
      const m = (v: V3): THREE.Vector3 => new THREE.Vector3(v[0], v[1], v[2] * side);
      const A = m(st.a), B = m(st.b);
      d.copy(m(st.ray)).normalize();
      // Only the triangles near the strip's path: those whose bounds overlap a box round it, open
      // along the ray (bounds, not corners: a flat fin is a few big triangles with no corner near).
      const lo = A.clone().min(B).subScalar(0.15), hi = A.clone().max(B).addScalar(0.15);
      for (const k of ['x', 'y', 'z'] as const) {
        if (d[k] !== 0) {
          lo[k] = -1e9;
          hi[k] = 1e9;
        }
      }
      const near: number[] = [];
      for (let t = 0; t + 2 < vertCount; t += 3) {
        const i0 = vi(t), i1 = vi(t + 1), i2 = vi(t + 2);
        const x0 = pos.getX(i0), x1 = pos.getX(i1), x2 = pos.getX(i2);
        if (Math.max(x0, x1, x2) < lo.x || Math.min(x0, x1, x2) > hi.x) continue;
        const y0 = pos.getY(i0), y1 = pos.getY(i1), y2 = pos.getY(i2);
        if (Math.max(y0, y1, y2) < lo.y || Math.min(y0, y1, y2) > hi.y) continue;
        const z0 = pos.getZ(i0), z1 = pos.getZ(i1), z2 = pos.getZ(i2);
        if (Math.max(z0, z1, z2) < lo.z || Math.min(z0, z1, z2) > hi.z) continue;
        near.push(i0, i1, i2);
      }
      const tris = new Uint32Array(near);
      const hits: { p: THREE.Vector3; n: THREE.Vector3 }[] = [];
      for (let k = 0; k < FORMATION_SAMPLES; k++) {
        o.lerpVectors(A, B, k / (FORMATION_SAMPLES - 1));
        const h = castOnto(pos, tris, o, d);
        if (h) hits.push(h);
      }
      if (hits.length < FORMATION_SAMPLES) continue;
      const verts: number[] = [], norms: number[] = [], idx: number[] = [];
      for (let k = 0; k < hits.length; k++) {
        const h = hits[k]!;
        along.subVectors(hits[Math.min(k + 1, hits.length - 1)]!.p, hits[Math.max(k - 1, 0)]!.p).normalize();
        across.crossVectors(h.n, along).normalize().multiplyScalar(FORMATION_WIDTH_M / 2);
        for (const sgn of [-1, 1]) {
          const p = h.p.clone().addScaledVector(h.n, FORMATION_STANDOFF_M).addScaledVector(across, sgn);
          verts.push(p.x, p.y, p.z);
          norms.push(h.n.x, h.n.y, h.n.z);
        }
      }
      // Two triangles per segment, each wound to face out along the skin's normal.
      const P = new THREE.Vector3(), Q = new THREE.Vector3(), R = new THREE.Vector3();
      const face = (p: number, q: number, r: number, n: THREE.Vector3): void => {
        P.fromArray(verts, p * 3);
        Q.fromArray(verts, q * 3).sub(P);
        R.fromArray(verts, r * 3).sub(P);
        if (Q.cross(R).dot(n) >= 0) idx.push(p, q, r);
        else idx.push(p, r, q);
      };
      for (let k = 1; k < hits.length; k++) {
        const i = 2 * k;
        face(i - 2, i - 1, i, hits[k]!.n);
        face(i - 1, i + 1, i, hits[k]!.n);
      }
      const g = new THREE.BufferGeometry();
      const count = verts.length / 3;
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
      g.setAttribute('aTangent', new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4));
      g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(count).fill(PART.lightFormation), 1));
      g.setAttribute('aNoz', new THREE.Float32BufferAttribute(new Float32Array(count), 1));
      g.setIndex(idx);
      geometry.push(g);
      const mid = hits[(hits.length - 1) >> 1]!;
      const c = mid.p.clone().addScaledVector(mid.n, FORMATION_STANDOFF_M);
      lamps.push({ p: [c.x, c.y, c.z], n: [mid.n.x, mid.n.y, mid.n.z] });
    }
  }
  return { geometry, lamps };
}

/** The nose leg with the landing/taxi lamp's lens on it, facing along the light. */
function withLandingLens(leg: THREE.BufferGeometry, L: SceneExtras['lights']): THREE.BufferGeometry {
  const l = lens(L.landing, [0.022, 0.045, 0.045], PART.lightLanding);
  const merged = mergeGeometries([leg.index ? leg.toNonIndexed() : leg, l.toNonIndexed()]);
  if (!merged) return leg;
  const n = merged.getAttribute('position').count;
  return merged.setIndex([...Array(n).keys()]);
}

/**
 * The renderer's own nozzle (as the procedural model's), fitted to the imported tailpipe: a shroud
 * lip at the hinge, petals (aNoz 0 at the hinge .. 1 at the exit: they open with uNozzle and are
 * heat-blued towards the exit) and the engine interior, glowing with throttle and afterburner.
 */
function buildNozzle(n: Required<SceneExtras['nozzle']>): THREE.BufferGeometry {
  const { exitX: xe, axisY: cy, hingeX: x0, hingeR: rh, exitR: re } = n;
  const t = (x: number): number => Math.min(1, Math.max(0, (x0 - x) / (x0 - xe)));
  const petalR = (x: number): number => rh + (re - rh) * t(x);
  const xi = x0 + 0.12;
  const gs = [
    loft([x0 - 0.02, x0 + 0.03, x0 + 0.06], (x) => circle(cy, 0, rh + 0.012 - 0.004 * ((x - x0) / 0.06)), 48, PART.metal),
    loft(range(xe, x0, 0.04), (x) => circle(cy, 0, petalR(x)), 56, PART.metal, { noz: t }),
    loft(range(xe, xi, 0.05), (x) => circle(cy, 0, xi - x > 0 ? 0.72 * rh + (re - 0.012 - 0.72 * rh) * ((xi - x) / (xi - xe)) : 0.72 * rh), 48, PART.engine, { inward: true, noz: t }),
    cap(xi, circle(cy, 0, 0.72 * rh), 48, PART.engine, [-1, 0, 0]),
  ];
  return mergeGeometries(gs.map((g) => {
    const c = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(c * 2), 2));
    g.setAttribute('aTangent', new THREE.Float32BufferAttribute(new Float32Array(c * 4), 4));
    return g;
  }))!;
}

function v3(a: unknown): V3 {
  const r = a as number[];
  return [Number(r[0]), Number(r[1]), Number(r[2])];
}

/** Builds the template from a parsed GLB (exported for tests and the dev preview). */
export function templateFromGltf(scene: THREE.Object3D): AircraftModelTemplate {
  const extras = (scene.userData as { marut?: SceneExtras }).marut;
  if (!extras) throw new Error('aircraft GLB has no "marut" scene extras');
  const meshes = new Map<string, THREE.Mesh>();
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.set(o.name || o.parent?.name || '', o as THREE.Mesh);
  });
  const need = (name: string): THREE.Mesh => {
    const m = meshes.get(name);
    if (!m) throw new Error(`aircraft GLB has no "${name}" mesh`);
    return m;
  };
  const bodyMesh = need('body');
  const fixed = [prepare(bodyMesh, PART.textured)];
  const formation = formationStrips(fixed[0]!);
  if (formation.lamps.length < 2 * FORMATION_STRIPS.length) console.warn(`aircraft GLB: ${2 * FORMATION_STRIPS.length - formation.lamps.length} formation light strip(s) missed the skin`);
  if (meshes.has('cockpit')) fixed.push(prepare(meshes.get('cockpit')!, PART.texturedCockpit));
  if (meshes.has('glass')) fixed.push(prepare(meshes.get('glass')!, PART.canopy));
  const nz = extras.nozzle;
  if (nz.hingeX !== undefined && nz.hingeR !== undefined && nz.exitR !== undefined) fixed.push(buildNozzle(nz as Required<SceneExtras['nozzle']>));
  fixed.push(...lampLenses(extras.lights), ...formation.geometry);
  const body = mergeGeometries(fixed);
  if (!body) throw new Error('aircraft GLB: body geometries do not merge');

  const parts: ArticulatedPart[] = [];
  for (const [name, mesh] of meshes) {
    const ud = mesh.userData as { driver?: string; pivot?: unknown; axis?: unknown; travelRad?: number; keepVisible?: boolean; travelWindow?: unknown; parent?: string; radiusM?: number; leg?: string; steer?: boolean; follows?: string; target?: unknown };
    if (!ud.driver) continue;
    if (!DRIVERS.includes(ud.driver as PartDriver)) throw new Error(`aircraft GLB: part "${name}" has unknown driver ${ud.driver}`);
    parts.push({
      name,
      geometry: name === 'noseGear' ? withLandingLens(prepare(mesh, PART.textured), extras.lights) : prepare(mesh, PART.textured),
      pivot: v3(ud.pivot),
      axis: v3(ud.axis),
      driver: ud.driver as PartDriver,
      travelRad: Number(ud.travelRad ?? 0),
      ...(ud.keepVisible ? { keepVisible: true } : {}),
      ...(ud.parent ? { parent: ud.parent } : {}),
      ...(ud.radiusM ? { radiusM: Number(ud.radiusM) } : {}),
      ...(ud.leg === 'nose' || ud.leg === 'mainLeft' || ud.leg === 'mainRight' ? { leg: ud.leg } : {}),
      ...(ud.steer ? { steer: true } : {}),
      ...(ud.follows ? { follows: ud.follows, target: v3(ud.target) } : {}),
      ...(Array.isArray(ud.travelWindow) ? { travelWindow: [Number(ud.travelWindow[0]), Number(ud.travelWindow[1])] as [number, number] } : {}),
    });
  }

  const mat = bodyMesh.material as THREE.MeshStandardMaterial;
  if (!mat.map || !mat.metalnessMap || !mat.normalMap) throw new Error('aircraft GLB: body material needs base colour, metal-roughness and normal maps');
  // Sampled raw: the shader decodes sRGB itself (cheaper uploads on some GPUs, see the cockpit notes).
  for (const t of [mat.map, mat.metalnessMap, mat.normalMap]) {
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 4;
    t.needsUpdate = true;
  }

  // The afterburner flame, moved from the procedural nozzle to this one.
  const flame = buildFlame().translate(extras.nozzle.exitX - NOZZLE_EXIT_X, extras.nozzle.axisY - NOZZLE_AXIS_Y, 0);
  const L = extras.lights;
  return {
    offsetX: 0,
    body,
    parts,
    flame,
    nozzleAxisY: extras.nozzle.axisY,
    nozzleExitX: extras.nozzle.exitX,
    pylons: extras.pylons,
    podMounts: [extras.podMount ? v3(extras.podMount) : INTAKE_STATION],
    lights: {
      navLeft: v3(L.navLeft),
      navRight: v3(L.navRight),
      navTail: v3(L.navTail),
      strobeLeft: v3(L.strobeLeft),
      strobeRight: v3(L.strobeRight),
      landing: v3(L.landing),
      landingDir: v3(L.landingDir),
      formation: formation.lamps,
    },
    landingPart: 'noseGear',
    canopyInterior: { min: v3(extras.canopyInterior.min), max: v3(extras.canopyInterior.max) },
    textures: { base: mat.map, metalRough: mat.metalnessMap, normal: mat.normalMap },
  };
}

/** Loads and builds an imported aircraft model. */
export async function loadGltfAircraftModel(url: string): Promise<AircraftModelTemplate> {
  const gltf = await new GLTFLoader().loadAsync(url);
  return templateFromGltf(gltf.scene);
}
