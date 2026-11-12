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
import { buildFlame, INTAKE_STATION, NOZZLE_AXIS_Y, NOZZLE_EXIT_X, type AircraftModelTemplate, type ArticulatedPart, type LIGHTS, type PartDriver, type Pylon } from './tejasModel';

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
  if (meshes.has('cockpit')) fixed.push(prepare(meshes.get('cockpit')!, PART.texturedCockpit));
  if (meshes.has('glass')) fixed.push(prepare(meshes.get('glass')!, PART.canopy));
  const nz = extras.nozzle;
  if (nz.hingeX !== undefined && nz.hingeR !== undefined && nz.exitR !== undefined) fixed.push(buildNozzle(nz as Required<SceneExtras['nozzle']>));
  fixed.push(...lampLenses(extras.lights));
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
