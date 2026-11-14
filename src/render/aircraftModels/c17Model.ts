/**
 * src/render/aircraftModels/c17Model.ts — the C-17A Globemaster III's 3D model (public/models/c17.glb,
 * tools/models/build_c17.py from the CC BY "c17 Globemaster with animation" by pilotcandle5470).
 *
 * Unlike the fighters' GLBs (gltfModel.ts: meshes named by role, one hinge per part), this one keeps
 * its source's node tree and its one 10 s animation, in which every part group moves in turn from
 * fully out (t = 0: gear down, flaps and slats out, spoilers up, reversers open, ramp and doors
 * open) to clean (t = 10). Each moving node becomes a rig node (trackRig.ts) in a pose group; the
 * renderer samples its keyframes at the time the group's pose value picks (c17Pose.ts):
 * - gear: legs, wheels and bay doors (the main gear's twist-and-lift up into its pods);
 * - flaps, slats, spoilers ('airbreak' in the source);
 * - reverser0..3: the translating sleeves (one mesh for all four engines in the source, split here
 *   by engine) and the blocker vanes inside them;
 * - ramp: the cargo ramp with its toes, the aft door and the beam between;
 * - troopDoors (the paratroop doors), crewDoor (the forward entry door);
 * - fan0..3: the fans, spun about their own axis by N1 (not the keyframes' speed);
 * - aileronL/R: hinges about the axis their keyframes droop them about, by the roll command.
 * The source has no separate elevators or rudder (its tail is one piece): they do not move.
 *
 * Frames: the GLB is in its model frame (nose +x, up +y, right +z, wheel bottoms at y ≈ 1.13 with
 * the gear down, centred along x); C17_FIT.modelToBody moves it to the body frame (origin at the
 * centre of gravity the flight model uses). Everything here is baked in the body frame.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PART } from './meshBuild';
import type { V3 } from './meshBuild';
import { C17_GLB_HASH } from './c17GlbVersion';
import { lens, prepare } from './gltfModel';
import { buildFlame, type AircraftModelTemplate } from './tejasModel';
import { activeSpan, rigLocal, rotationBetween, sampleQuat, type RigNodeDef, type RigTrack } from './trackRig';
export type { AircraftRig } from './trackRig';
import { C17_ENGINES, c17GroupOf, type C17RigGroup as Group } from './c17Pose';

/** The imported C-17 (as TEJAS_GLB_URL: relative to the page, versioned by content). */
export const C17_GLB_URL = new URL(`../models/c17.glb?v=${C17_GLB_HASH}`, document.baseURI).href;

/**
 * What the GLB doesn't say: where it sits in the body frame, and its lamps.
 *
 * modelToBody: the body origin is the flight model's centre of gravity. Estimated here at 0.30 of
 * the mean aerodynamic chord (docs/spec/c17-data.md 1.3: MAC 7.73 m, its leading edge 4.69 m aft of
 * the wing apex, which the model puts at x ≈ 14.1) and 4.5 m above the wheel bottoms (about the
 * fuselage's mid-height). With it, the gear's ground contacts (body frame, gear down, static) are:
 * nose wheels x 17.3, y -3.37, z 0; main wheels (four legs, three wheels each) x -2.7 (-4.9 .. -0.5),
 * y -3.35, z ±3.7 (the pods' centres). MERGE: when the C-17 flight model fixes its CG and gear
 * points, set this so the model's wheels sit on them (one line).
 */
export const C17_FIT = {
  // Matched to the flight model (aircraft/c17Data.ts c17Gear): nose x 18.2, mains x -1.8, the wheel
  // bottoms 4.25 m below the CG at rest (contacts at y -4.5, ~0.25 m static compression).
  modelToBody: [-5.6, -5.38, 0] as V3,
  /** Lamps, model frame: navigation lights on the wingtips' leading edges (under the winglets),
   *  white strobes just aft of them, the tail light on the tailplane's trailing edge, the
   *  landing/taxi lamp on the nose leg (it rides on the leg's rig node). */
  lights: {
    navRight: [-0.45, 5.08, 24.62] as V3,
    strobeRight: [-1.6, 5.05, 24.66] as V3,
    navTail: [-25.85, 15.55, 0] as V3,
    landing: [23.75, 2.65, 0] as V3,
    landingDir: [Math.cos(0.06), -Math.sin(0.06), 0] as V3,
  },
  /** The flight deck (model frame): the camera inside it hides nothing yet (no 3D cockpit for the C-17). */
  cockpit: { min: [21.4, 5.0, -1.7] as V3, max: [26.2, 7.9, 1.7] as V3 },
  /** Engine fan speed draws from N1; length overall, m (the outside cameras scale with it). */
  lengthM: 53.04,
};

/** The nose leg's rig node (the landing lamp rides on it). */
const NOSE_LEG = /^frontlandgear1/i;

/** Mirrored nodes (negative scale) bake inside out: turn their triangles and tangents round. */
function prepareBaked(mesh: THREE.Mesh, part: number, bodyFromModel: THREE.Matrix4): THREE.BufferGeometry {
  const g = prepare(mesh, part);
  g.applyMatrix4(bodyFromModel);
  if (mesh.matrixWorld.determinant() < 0) {
    const idx = g.getIndex()!;
    for (let i = 0; i + 2 < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, b);
    }
    const tan = g.getAttribute('aTangent');
    for (let i = 0; i < tan.count; i++) tan.setW(i, -tan.getW(i));
  }
  return g;
}

/** A geometry's triangles split by `bin(centroid)` (0..n-1). */
function splitTriangles(g: THREE.BufferGeometry, n: number, bin: (c: THREE.Vector3) => number): (THREE.BufferGeometry | undefined)[] {
  const pos = g.getAttribute('position');
  const idx = g.getIndex()!;
  const lists: number[][] = Array.from({ length: n }, () => []);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i + 2 < idx.count; i += 3) {
    a.fromBufferAttribute(pos, idx.getX(i));
    b.fromBufferAttribute(pos, idx.getX(i + 1));
    c.fromBufferAttribute(pos, idx.getX(i + 2));
    lists[bin(a.add(b).add(c).divideScalar(3))]!.push(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
  }
  return lists.map((l) => {
    if (!l.length) return undefined;
    const part = g.clone();
    part.setIndex(l);
    return part;
  });
}

function mergeAll(gs: THREE.BufferGeometry[]): THREE.BufferGeometry | undefined {
  if (!gs.length) return undefined;
  if (gs.length === 1) return gs[0];
  const m = mergeGeometries(gs);
  if (!m) throw new Error('C-17 GLB: part geometries do not merge');
  return m;
}

/** Builds the C-17 template from a parsed GLB (scene + its animation clip). */
export function templateFromC17Gltf(scene: THREE.Object3D, clips: readonly THREE.AnimationClip[]): AircraftModelTemplate {
  const fit = C17_FIT;
  const bodyFromModel = new THREE.Matrix4().makeTranslation(...fit.modelToBody);
  scene.updateMatrixWorld(true);

  // Keyframe channels by node.
  const channels = new Map<THREE.Object3D, { t?: RigTrack; r?: RigTrack; s?: RigTrack; span?: [number, number] }>();
  for (const clip of clips) {
    for (const track of clip.tracks) {
      const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name);
      const obj = scene.getObjectByName(nodeName);
      if (!obj) continue;
      const size = propertyName === 'quaternion' ? 4 : 3;
      const tr: RigTrack = { times: Float32Array.from(track.times), values: Float32Array.from(track.values) };
      const span = activeSpan(tr, size);
      if (!span) continue;
      const ch = channels.get(obj) ?? {};
      if (propertyName === 'position') ch.t = tr;
      else if (propertyName === 'quaternion') ch.r = tr;
      else if (propertyName === 'scale') ch.s = tr;
      else continue;
      ch.span = ch.span ? [Math.min(ch.span[0], span[0]), Math.max(ch.span[1], span[1])] : span;
      channels.set(obj, ch);
    }
  }

  // Rig nodes, parents first (depth-first order).
  const nodes: RigNodeDef[] = [];
  const objs: THREE.Object3D[] = [];
  const meta: Group[] = [];
  const index = new Map<THREE.Object3D, number>();
  const restWorld: THREE.Matrix4[] = [];
  const nearestRig = (o: THREE.Object3D | null): number => {
    for (let p = o; p; p = p.parent) {
      const i = index.get(p);
      if (i !== undefined) return i;
    }
    return -1;
  };
  scene.traverse((o) => {
    const ch = channels.get(o);
    if (!ch) return;
    const g = c17GroupOf(o.name);
    if (!g) {
      console.warn(`C-17 GLB: moving node "${o.name}" has no pose group; held clean`);
    }
    const parent = nearestRig(o.parent);
    const w = new THREE.Matrix4().multiplyMatrices(bodyFromModel, o.matrixWorld);
    // Static chain from the parent rig node (or the body frame) to this node's parent.
    const parentWorld = o.parent ? new THREE.Matrix4().multiplyMatrices(bodyFromModel, o.parent.matrixWorld) : bodyFromModel.clone();
    const base = parent >= 0 ? restWorld[parent]!.clone().invert().multiply(parentWorld) : parentWorld;
    const def: RigNodeDef = {
      name: o.name,
      group: g?.group ?? 'misc',
      mode: g?.mode ?? 'track',
      parent,
      base,
      restT: o.position.clone(),
      restR: o.quaternion.clone(),
      restS: o.scale.clone(),
      ...(ch.t ? { t: ch.t } : {}),
      ...(ch.r ? { r: ch.r } : {}),
      ...(ch.s ? { s: ch.s } : {}),
      invRest: w.clone().invert(),
      ...(g?.hide ? { hideAt: 0 } : {}),
    };
    index.set(o, nodes.length);
    nodes.push(def);
    objs.push(o);
    meta.push(g ?? { group: 'misc', mode: 'track' });
    restWorld.push(w);
  });

  // Geometry: each mesh to its nearest rig node, the rest to the fixed airframe.
  const bodyParts: THREE.BufferGeometry[] = [];
  const nodeParts: THREE.BufferGeometry[][] = nodes.map(() => []);
  let textures: AircraftModelTemplate['textures'];
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const glass = mat.name === 'glass';
    if (!glass && !textures && mat.map && mat.metalnessMap && mat.normalMap) {
      for (const t of [mat.map, mat.metalnessMap, mat.normalMap]) {
        // Sampled raw: the shader decodes sRGB itself (as gltfModel.ts).
        t.colorSpace = THREE.NoColorSpace;
        t.anisotropy = 4;
        t.needsUpdate = true;
      }
      textures = { base: mat.map, metalRough: mat.metalnessMap, normal: mat.normalMap };
    }
    const g = prepareBaked(mesh, glass ? PART.canopy : PART.textured, bodyFromModel);
    const owner = nearestRig(mesh);
    (owner >= 0 ? nodeParts[owner]! : bodyParts).push(g);
  });
  if (!textures) throw new Error('C-17 GLB: no textured material (base colour, metal-roughness, normal)');
  const geometry = nodeParts.map(mergeAll);

  // Engines, left to right, by their fans' positions.
  const fanIdx = nodes.map((n, i) => (n.group === 'fan' ? i : -1)).filter((i) => i >= 0);
  const engineZ = fanIdx.map((i) => restWorld[i]!.elements[14]!).sort((a, b) => a - b);
  if (engineZ.length !== C17_ENGINES) throw new Error(`C-17 GLB: ${engineZ.length} fans, expected ${C17_ENGINES}`);
  const engineAt = (z: number): number => {
    let best = 0;
    for (let e = 1; e < engineZ.length; e++) if (Math.abs(z - engineZ[e]!) < Math.abs(z - engineZ[best]!)) best = e;
    return best;
  };

  const tmpV = new THREE.Vector3();
  const tmpM = new THREE.Matrix4();
  const tmpL = new THREE.Matrix4();
  const finalNodes: RigNodeDef[] = [];
  const finalGeom: (THREE.BufferGeometry | undefined)[] = [];
  const remap: number[] = [];
  nodes.forEach((n, i) => {
    const m = meta[i]!;
    const z = restWorld[i]!.elements[14]!;
    const put = (def: RigNodeDef, g: THREE.BufferGeometry | undefined): void => {
      finalNodes.push({ ...def, parent: def.parent >= 0 ? remap[def.parent]! : -1 });
      finalGeom.push(g);
    };
    if (n.group === 'fan') {
      // Spin: the axis the keyframes turn it about (between their first two keys), from its rest.
      const r = n.r!;
      const { axis } = rotationBetween(r, r.times[0]!, r.times[1]!);
      remap[i] = finalNodes.length;
      put({ ...n, group: `fan${engineAt(z)}`, axis, from: n.restR.clone() }, geometry[i]);
      return;
    }
    if (n.group === 'aileron') {
      // Hinge: neutral at the clean end of its window, about the axis its keyframes turn it, + = trailing edge down.
      const r = n.r!;
      const [a, b] = activeSpan(r, 4)!;
      const from = sampleQuat(r, b, new THREE.Quaternion());
      const { axis } = rotationBetween(r, b, a);
      const def: RigNodeDef = { ...n, group: z < 0 ? 'aileronL' : 'aileronR', axis, from };
      const g = geometry[i];
      if (g) {
        g.computeBoundingSphere();
        const c = g.boundingSphere!.center;
        const yAt = (ang: number): number => {
          // World of the node (top-level) at angle `ang`, applied to the centroid's node-local point.
          tmpM.copy(def.base).multiply(rigLocal(def, ang, tmpL));
          return tmpV.copy(c).applyMatrix4(n.invRest).applyMatrix4(tmpM).y;
        };
        if (yAt(0.1) > yAt(0)) def.axis = axis.clone().negate();
      }
      remap[i] = finalNodes.length;
      put(def, g);
      return;
    }
    if (n.group === 'reverser' && m.split) {
      // One source mesh carries all four engines' sleeves: one node per engine.
      const pieces = geometry[i] ? splitTriangles(geometry[i]!, C17_ENGINES, (c) => engineAt(c.z)) : [];
      remap[i] = finalNodes.length;
      for (let e = 0; e < C17_ENGINES; e++) if (pieces[e]) put({ ...n, group: `reverser${e}` }, pieces[e]);
      return;
    }
    remap[i] = finalNodes.length;
    put(n.group === 'reverser' ? { ...n, group: `reverser${engineAt(z)}` } : n, geometry[i]);
  });

  // Each keyframed group's window: the union of its nodes' active spans.
  const windows: Record<string, [number, number]> = {};
  nodes.forEach((n, i) => {
    const span = channels.get(objs[i]!)!.span!;
    for (const fn of finalNodes) {
      if (fn.name !== n.name || fn.mode !== 'track') continue;
      const w = windows[fn.group];
      windows[fn.group] = w ? [Math.min(w[0], span[0]), Math.max(w[1], span[1])] : [span[0], span[1]];
    }
  });

  const toBody = (p: V3): V3 => [p[0] + fit.modelToBody[0], p[1] + fit.modelToBody[1], p[2] + fit.modelToBody[2]];
  const L = fit.lights;
  const mirror = (p: V3): V3 => [p[0], p[1], -p[2]];
  const lights = {
    navLeft: toBody(mirror(L.navRight)),
    navRight: toBody(L.navRight),
    navTail: toBody(L.navTail),
    strobeLeft: toBody(mirror(L.strobeRight)),
    strobeRight: toBody(L.strobeRight),
    landing: toBody(L.landing),
    landingDir: L.landingDir,
    formation: [],
  };
  // Lamp lenses the model lacks (bigger than the fighters': a transport's lamps are).
  bodyParts.push(
    lens(lights.navLeft, [0.12, 0.06, 0.06], PART.lightRed),
    lens(lights.navRight, [0.12, 0.06, 0.06], PART.lightGreen),
    lens(lights.navTail, [0.06, 0.06, 0.06], PART.lightWhite),
    lens(lights.strobeLeft, [0.1, 0.05, 0.05], PART.lightStrobe),
    lens(lights.strobeRight, [0.1, 0.05, 0.05], PART.lightStrobe),
  );
  const noseLeg = finalNodes.findIndex((n) => NOSE_LEG.test(n.name));
  if (noseLeg >= 0) {
    const lg = lens(lights.landing, [0.05, 0.11, 0.11], PART.lightLanding);
    finalGeom[noseLeg] = finalGeom[noseLeg] ? mergeAll([finalGeom[noseLeg]!, lg]) : lg;
  }
  const body = mergeAll(bodyParts);
  if (!body) throw new Error('C-17 GLB: no fixed airframe');

  return {
    offsetX: 0,
    body,
    parts: [],
    // No afterburner: the flame is never drawn (noAfterburner).
    flame: buildFlame(),
    noAfterburner: true,
    nozzleAxisY: 0,
    // Nothing is "aft of the nozzle" (the FLIR's hot airframe): the C-17's engines are on the wings.
    nozzleExitX: -1e4,
    pylons: [],
    podMounts: [],
    lights,
    landingPart: noseLeg >= 0 ? finalNodes[noseLeg]!.name : '',
    canopyInterior: { min: toBody(fit.cockpit.min), max: toBody(fit.cockpit.max) },
    textures,
    lengthM: fit.lengthM,
    rig: { nodes: finalNodes, geometry: finalGeom, windows },
  };
}

/** Loads and builds the C-17 model. */
export async function loadC17Model(url = C17_GLB_URL): Promise<AircraftModelTemplate> {
  const gltf = await new GLTFLoader().loadAsync(url);
  return templateFromC17Gltf(gltf.scene, gltf.animations);
}
