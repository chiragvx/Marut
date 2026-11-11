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
 *   `travelRad` and optionally `keepVisible` (ArticulatedPart's fields and sign conventions);
 * - scene extras `marut`: pylons, lights, nozzle {exitX, axisY}, canopyInterior, credit.
 * Everything else (stores, lights, flame, team colours) works as for the procedural model.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PART } from './meshBuild';
import type { V3 } from './meshBuild';
import { buildFlame, INTAKE_STATION, NOZZLE_AXIS_Y, NOZZLE_EXIT_X, type AircraftModelTemplate, type ArticulatedPart, type LIGHTS, type PartDriver, type Pylon } from './tejasModel';

/** The imported Tejas (relative to the page, so it works under /play/ and in the Android build). */
export const TEJAS_GLB_URL = new URL('../models/tejas.glb', document.baseURI).href;

interface SceneExtras {
  pylons: Pylon[];
  lights: Omit<typeof LIGHTS, never>;
  nozzle: { exitX: number; axisY: number };
  canopyInterior: { min: V3; max: V3 };
  credit?: string;
}

const DRIVERS: readonly PartDriver[] = ['elevonL', 'elevonR', 'rudder', 'gear', 'slat', 'airbrake'];

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
  const body = mergeGeometries(fixed);
  if (!body) throw new Error('aircraft GLB: body geometries do not merge');

  const parts: ArticulatedPart[] = [];
  for (const [name, mesh] of meshes) {
    const ud = mesh.userData as { driver?: string; pivot?: unknown; axis?: unknown; travelRad?: number; keepVisible?: boolean };
    if (!ud.driver) continue;
    if (!DRIVERS.includes(ud.driver as PartDriver)) throw new Error(`aircraft GLB: part "${name}" has unknown driver ${ud.driver}`);
    parts.push({
      name,
      geometry: prepare(mesh, PART.textured),
      pivot: v3(ud.pivot),
      axis: v3(ud.axis),
      driver: ud.driver as PartDriver,
      travelRad: Number(ud.travelRad ?? 0),
      ...(ud.keepVisible ? { keepVisible: true } : {}),
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
    podMounts: [INTAKE_STATION],
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
